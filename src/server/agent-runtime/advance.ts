/**
 * advance — P1 步骤 3 的状态推进汇合点（plan 模块 1 «advance.ts：本计划的
 * 核心新代码»，最小形态）.
 *
 * Wires the MCP control channel into the mission state machine:
 *   task_complete (run terminal) → assignment state → dispatch next ready
 *   stage (dependsOn satisfied).
 *
 * CONVERGENCE / SERIALIZATION REQUIREMENT (architect note, P1.4 review):
 * this module is THE single rendezvous point where both report channels
 * must enter readyQueuedAssignments:
 *   - MCP path:    task_complete → onRunTerminal hook → handleRunTerminal
 *   - hermes path: stdout text → parseSwarmCheckpoint → STATE=DONE
 *                  (currently recorded via recordMissionCheckpoint from the
 *                  swarm harvester, NOT yet routed through here)
 *
 * SERIALIZATION DECISION (P2a gate, architect hard requirement):
 * the advance critical section is serialized by an IN-MEMORY MUTEX
 * (promise-chain queue, `advanceQueue` below), not a db transaction.
 * Rationale: the mission store — the state machine we must not corrupt —
 * lives in swarm-missions.json (read-modify-write JSON + atomic rename),
 * NOT in SQLite, so a SQLite transaction cannot guard it. collab.db only
 * holds run/token rows. A db transaction would give the illusion of safety
 * while the JSON CAS still races. The mutex covers the whole
 * "read mission → record terminal → compute readyQueuedAssignments →
 * dispatch next" sequence so two concurrent terminal events (one MCP, one
 * hermes) can never observe the same pre-write snapshot.
 * Limit: single-process. The workspace server is single-process by design
 * (plan: 单 workspace server 进程承载 N 个托管 agent), so an in-memory
 * mutex is sufficient; multi-process would need a file lock — out of scope.
 *
 * Load-test note (P1.4 review): the 8-agent streaming soak is deferred to
 * UI integration (bottleneck is SSE fan-out / event loop, not the MCP
 * control plane). When it runs, it MUST assert «text_delta 永不落库»
 * (review item 6) — display-channel events are bus-only; collab.db must
 * show zero growth from streaming.
 *
 * Full pipeline-template features (review stages, rework loops, lane sync,
 * git mergeSiblings) belong to 模块 1 and are NOT in this file — this is the
 * minimal end-to-end spine validated in P1 步骤 3.
 */
import {
  getSwarmMission,
  readyQueuedAssignments,
  recordMissionAssignmentBlocked,
  recordMissionCheckpoint,
} from '../swarm-missions'
import {  setOnRunTerminalHook } from '../mcp/mcp-handler'
import { publishChatEvent } from '../chat-event-bus'
import type {RunTerminalEvent} from '../mcp/mcp-handler';

export type AdvanceHooks = {
  /** Called with each newly-ready assignment after a terminal event. */
  dispatchNext?: (input: { missionId: string; assignmentId: string }) => void | Promise<void>
}

let installed = false

/**
 * In-memory mutex: a promise chain serializing every advance critical
 * section (see header «SERIALIZATION DECISION»). Each terminal event is
 * appended; the chain guarantees read→record→ready→dispatch never
 * interleaves with another event's snapshot.
 */
let advanceQueue: Promise<void> = Promise.resolve()

function enqueueAdvance<T>(fn: () => T): Promise<T> {
  const run = advanceQueue.then(fn)
  // Keep the chain alive even if one section throws.
  advanceQueue = run.then(
    () => undefined,
    (error) => {
      console.error('[advance] critical section failed', error)
    },
  )
  return run
}

function handleRunTerminalSync(event: RunTerminalEvent, hooks?: AdvanceHooks): void {
  const mission = getSwarmMission(event.missionId)
  if (!mission) return

  if (event.status === 'blocked' || event.status === 'needs_input') {
    recordMissionAssignmentBlocked({
      missionId: event.missionId,
      assignmentId: event.assignmentId,
      workerId: event.agentId,
      reason: event.blocker ?? event.summary ?? event.status,
      source: 'mcp',
    })
  } else if (event.status === 'done') {
    recordMissionCheckpoint({
      missionId: event.missionId,
      assignmentId: event.assignmentId,
      workerId: event.agentId,
      checkpoint: {
        stateLabel: 'DONE',
        checkpointStatus: 'done',
        runtimeState: 'idle',
        filesChanged: null,
        commandsRun: null,
        result: event.summary,
        blocker: null,
        nextAction: event.nextAction,
        reviewOutcome: null,
        raw: event.summary ?? '',
      },
      source: 'mcp',
    })
  }
  // failed/cancelled: leave the assignment dispatched; P2a reconcile
  // decides between requeue and blocked (needs crash forensics).

  publishChatEvent('mission_advanced', {
    missionId: event.missionId,
    assignmentId: event.assignmentId,
    status: event.status,
    roomId: undefined,
  })

  // Dispatch follow-on stages whose dependsOn are now satisfied.
  const ready = readyQueuedAssignments(event.missionId)
  for (const next of ready) {
    publishChatEvent('assignment_ready', {
      missionId: event.missionId,
      assignmentId: next.id,
      workerId: next.workerId,
    })
    void hooks?.dispatchNext?.({ missionId: event.missionId, assignmentId: next.id })
  }
}

/**
 * Install the MCP → mission bridge. Idempotent. Returns an uninstaller for
 * tests.
 */
export function installAdvanceBridge(hooks?: AdvanceHooks): () => void {
  // Serialize the whole critical section through the mutex queue. The hook
  // fires synchronously from task_complete; enqueueing preserves ordering
  // and snapshot isolation across concurrent terminal events.
  setOnRunTerminalHook((event) => {
    void enqueueAdvance(() => handleRunTerminalSync(event, hooks))
  })
  installed = true
  return () => {
    setOnRunTerminalHook(null)
    installed = false
  }
}

export function isAdvanceBridgeInstalled(): boolean {
  return installed
}
