import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../../server/auth-middleware'
import { getAgentRuntimeRouter } from '../../../server/agent-runtime/router'
import {
  getAgentStatusSnapshot,
  startAgentStatusWatcher,
} from '../../../server/agent-status-watcher'
import type { AgentRuntime, AgentWithStatus } from '../../../lib/agent-types'
import type { AgentProbeResult } from '../../../server/agent-runtime/types'
import type { AgentDeclaration } from '../../../server/agent-runtime/agents-config'
import {
  loadGroupChatActivity,
  deriveUnifiedStatusForAgent,
  toAgentStatus,
  type UnifiedAgentStatus,
} from '../../../lib/agent-status'

function buildStatusSnapshot(
  snapshot: NonNullable<ReturnType<typeof getAgentStatusSnapshot>>,
): NonNullable<AgentWithStatus['statusSnapshot']> {
  return {
    state: toAgentStatus(snapshot.state as UnifiedAgentStatus),
    currentTask: snapshot.currentTask,
    taskId: snapshot.taskId,
    missionId: snapshot.missionId,
    needsHuman: snapshot.needsHuman,
    checkpointStatus: snapshot.checkpointStatus,
    lastSummary: snapshot.lastSummary,
    updatedAt: snapshot.updatedAt,
  }
}

function buildAgentPayload(
  decl: AgentDeclaration,
  probe: AgentProbeResult,
  groupChatMap: Map<
    string,
    import('../../../lib/agent-status').GroupChatActivity
  >,
): AgentWithStatus {
  const snapshot =
    decl.runtime === 'hermes' ? getAgentStatusSnapshot(decl.id) : undefined
  const unified = deriveUnifiedStatusForAgent(
    decl.id,
    snapshot,
    Boolean(probe.available),
    groupChatMap,
    decl.profile,
  )
  return {
    agentId: decl.id,
    name: decl.displayName ?? decl.mentionName ?? decl.id,
    runtime: decl.runtime as AgentRuntime,
    status: toAgentStatus(unified),
    execution: decl.execution,
    currentTaskId: snapshot?.taskId ?? undefined,
    currentMissionId: snapshot?.missionId ?? undefined,
    runtimeConfig: {
      profile: decl.profile,
      command: decl.command,
      args: decl.args,
      capabilities: decl.capabilities,
      maxConcurrentTasks: decl.maxConcurrentTasks,
    },
    probe: {
      available: probe.available,
      version: probe.version,
      detail: probe.detail,
    },
    statusSnapshot: snapshot ? buildStatusSnapshot(snapshot) : undefined,
  }
}

export const Route = createFileRoute('/api/agents/')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return json({ error: 'Unauthorized' }, { status: 401 })
        }
        startAgentStatusWatcher()
        const router = getAgentRuntimeRouter()
        const probes = await router.probeAll()
        const probeById = new Map(probes.map((p) => [p.agentId, p]))
        const groupChatMap = loadGroupChatActivity()

        const agents: Array<AgentWithStatus> = []
        for (const decl of router.registry.agents) {
          const probe = probeById.get(decl.id) ?? {
            available: false,
            detail: 'probe missing',
          }
          agents.push(buildAgentPayload(decl, probe, groupChatMap))
        }

        // Orphan Hermes profiles are still usable as hermes-runtime agents.
        const { probeHermesProfileGateway } =
          await import('../../../server/agent-runtime/hermes-gateway-probe')
        const orphanAgents = await Promise.all(
          router.registry.orphanProfiles.map(async (profile) => {
            const probe = await probeHermesProfileGateway(profile)
            const snapshot = getAgentStatusSnapshot(profile)
            const unified = deriveUnifiedStatusForAgent(
              profile,
              snapshot,
              Boolean(probe.available),
              groupChatMap,
              profile,
            )
            return {
              agentId: profile,
              name: profile,
              runtime: 'hermes' as const,
              status: toAgentStatus(unified),
              execution: 'local' as const,
              currentTaskId: snapshot?.taskId ?? undefined,
              currentMissionId: snapshot?.missionId ?? undefined,
              runtimeConfig: {
                profile,
                capabilities: [] as string[],
              },
              probe: {
                available: probe.available,
                version: probe.version,
                detail: probe.detail,
              },
              statusSnapshot: snapshot
                ? buildStatusSnapshot(snapshot)
                : undefined,
            }
          }),
        )
        agents.push(...orphanAgents)

        return json({ agents, checkedAt: Date.now() })
      },
    },
  },
})
