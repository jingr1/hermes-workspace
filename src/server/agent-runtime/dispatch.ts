/**
 * dispatch — P1 步骤 3 端到端闭环：派发 → agent 调 MCP 三工具 → 状态推进。
 *
 * Write ordering (plan «双存储与崩溃恢复» 行 449-456), shrinking the
 * dangerous window where SQLite says running but JSON still says queued:
 *   1. JSON CAS:  assignment queued → dispatched (mission store is pipeline SoT)
 *   2. Token:     issue run_write token bound to (assignmentId, runId)
 *   3. SQLite:    INSERT task_runs status='running' with the SAME runId
 *   4. Spawn:     adapter.startRun (detached process group)
 * Failure between steps is recoverable: a dispatched assignment without a
 * running row is the safe direction (P2a reconcile re-queues it); a running
 * row without dispatch means manual DB tampering.
 *
 * Status advance: the agent calls MCP task_complete; mcp-handler flips
 * task_runs AND writes the mission checkpoint via the onRunTerminal hook
 * registered from this module (avoids a circular import mcp → dispatch).
 */
import { getSwarmMission, markMissionAssignmentDispatched } from '../swarm-missions'
import { issueRunToken } from '../mcp/run-tokens'
import { createCollabId } from '../collab-db'
import { getAgentRuntimeRouter } from '../agent-runtime/router'
import { publishChatEvent } from '../chat-event-bus'

export type DispatchResult =
  | { ok: true; runId: string; assignmentId: string }
  | { ok: false; error: string }

const WRITE_ALLOWLIST = ['task_get', 'task_start', 'task_complete']

/**
 * MCP endpoint handed to managed agents. Loopback by default (plan: ssh
 * locality 仅限 hermes, so managed CLI agents always run on this machine).
 * Override with HERMES_MCP_ENDPOINT in deployments that front the workspace
 * server with a different origin. Port comes from the vite dev server /
 * workspace server listen config.
 *
 * SECURITY (review note): when overridden to a non-loopback origin, that
 * origin MUST be an encrypted endpoint (reverse proxy / tunnel, e.g.
 * Tailscale Serve) — never plain http on a routable address. Tokens ride in
 * the Authorization header; plaintext off-loopback leaks them. We do not
 * terminate TLS ourselves (plan: 不自造 TLS). Warn loudly at call time.
 */
let warnedInsecureEndpoint = false

export function getMcpEndpoint(): string {
  const override = process.env.HERMES_MCP_ENDPOINT
  if (override) {
    const insecure =
      override.startsWith('http://') &&
      !/^http:\/\/(127\.|localhost|\[::1\])/.test(override)
    if (insecure && !warnedInsecureEndpoint) {
      warnedInsecureEndpoint = true
      console.warn(
        `[agent-runtime] HERMES_MCP_ENDPOINT is non-loopback plain HTTP: ${override}. ` +
          'Run tokens will traverse the network in cleartext. Front the workspace server ' +
          'with an encrypted reverse proxy / tunnel (e.g. Tailscale Serve) instead.',
      )
    }
    return override
  }
  const port = process.env.PORT ?? process.env.VITE_PORT ?? '3000'
  return `http://127.0.0.1:${port}/api/mcp-rpc`
}

/**
 * Dispatch one queued assignment to a managed CLI runtime.
 * Caller must have already verified the assignment is ready
 * (readyQueuedAssignments). Returns the runId on success.
 */
export async function dispatchAssignment(input: {
  missionId: string
  assignmentId: string
  agentId?: string // defaults to assignment.workerId; agents.yaml id = workerId
  cwd?: string
  roomId?: string | null
}): Promise<DispatchResult> {
  const mission = getSwarmMission(input.missionId)
  if (!mission) return { ok: false, error: `Mission not found: ${input.missionId}` }
  const assignment = mission.assignments.find((a) => a.id === input.assignmentId)
  if (!assignment) return { ok: false, error: `Assignment not found: ${input.assignmentId}` }
  if (assignment.state !== 'queued') {
    return { ok: false, error: `Assignment ${assignment.id} is ${assignment.state}, not queued` }
  }

  const agentId = input.agentId ?? assignment.workerId
  const router = getAgentRuntimeRouter()
  const adapter = router.getAdapter(agentId)
  if (!adapter) return { ok: false, error: `No agent declared in agents.yaml: ${agentId}` }
  // DELIBERATE rejection (architect decision, P1.4 review):
  // hermes dispatch stays with the existing swarm-dispatch route (tmux /
  // send-stream path) — that is its source of truth. Wrapping it in an
  // AgentRuntimeAdapter shell is pure code relocation with no protocol
  // validation value, so it is intentionally NOT done in P1. The natural
  // moment for the shell is P4 (group-chat auto-handoff), when hermes
  // agents need the unified streamEvents/interrupt surface to join rooms.
  if (adapter.kind === 'hermes') {
    return { ok: false, error: 'hermes runtime is dispatched via the existing swarm-dispatch path' }
  }

  const runId = createCollabId('run')

  // Step 1: JSON CAS queued → dispatched.
  const dispatched = markMissionAssignmentDispatched({
    missionId: mission.id,
    workerId: assignment.workerId,
    task: assignment.task,
    source: 'agent-runtime',
    author: 'dispatcher',
  })
  if (!dispatched) return { ok: false, error: 'Failed to CAS assignment to dispatched' }

  // Step 2: issue the per-run write token (bound to this runId).
  const { token } = issueRunToken({
    kind: 'run_write',
    runId,
    participantId: agentId,
    assignmentId: assignment.id,
    taskId: mission.id, // token.taskId carries missionId (see RunToken doc)
    roomId: input.roomId ?? null,
    toolAllowlist: WRITE_ALLOWLIST,
  })

  // Step 3: the task_runs row is created by the agent's own task_start MCP
  // call (runId comes from the token, INSERT is idempotent on PK conflict).
  // The dispatcher must NOT pre-insert with the same runId, or task_start
  // would always hit the conflict path. Crash recovery: an assignment stuck
  // in 'dispatched' with no running row is the SAFE direction — P2a
  // reconcile re-queues it (plan 行 462).
  try {
    await adapter.startRun({
      runId,
      agentId,
      task: assignment.task,
      cwd: input.cwd,
      roomId: input.roomId ?? null,
      taskId: mission.id,
      mcp: {
        endpoint: getMcpEndpoint(),
        runToken: token,
        toolAllowlist: WRITE_ALLOWLIST,
      },
    })
  } catch (error) {
    return { ok: false, error: `spawn failed: ${error instanceof Error ? error.message : String(error)}` }
  }

  publishChatEvent('agent_dispatched', {
    runId,
    agentId,
    missionId: mission.id,
    assignmentId: assignment.id,
    roomId: input.roomId ?? undefined,
  })

  return { ok: true, runId, assignmentId: assignment.id }
}
