/**
 * Shared builder for GET /api/agents/status and /api/agents/snapshot.
 */
import { getAgentRuntimeRouter } from './agent-runtime/router'
import {
  getAgentStatusSnapshot,
  startAgentStatusWatcher,
} from './agent-status-watcher'
import type { AgentStatusEntry } from '../lib/mission-control-api'
import {
  deriveUnifiedStatusForAgent,
  loadGroupChatActivity,
} from '../lib/agent-status'

export type AgentsStatusPayload = {
  agents: Array<AgentStatusEntry>
  orphanProfiles: Array<string>
  checkedAt: number
}

export type AgentsHealthSummary = {
  online: number
  active: number
  blocked: number
  needsHuman: number
  offline: number
  needsSetup: number
  degraded: boolean
}

export type AgentsSnapshotPayload = AgentsStatusPayload & {
  health: AgentsHealthSummary
}

function summarizeHealth(
  agents: Array<AgentStatusEntry>,
): AgentsHealthSummary {
  let online = 0
  let active = 0
  let blocked = 0
  let needsHuman = 0
  let offline = 0
  let needsSetup = 0
  for (const agent of agents) {
    const unified = agent.status?.unifiedStatus
    if (unified === 'active' || unified === 'idle') online += 1
    if (unified === 'active') active += 1
    if (unified === 'blocked' || unified === 'error') blocked += 1
    if (agent.status?.needsHuman || unified === 'blocked') needsHuman += 1
    if (unified === 'offline') offline += 1
    if (unified === 'needsSetup' || agent.status?.needsSetup) needsSetup += 1
  }
  return {
    online,
    active,
    blocked,
    needsHuman,
    offline,
    needsSetup,
    degraded: blocked > 0 || needsHuman > 0,
  }
}

export async function buildAgentsStatusPayload(): Promise<AgentsStatusPayload> {
  startAgentStatusWatcher()
  const router = getAgentRuntimeRouter()
  const agents = await router.probeAll()
  const groupChatMap = loadGroupChatActivity()

  const hermesAgentIds = new Set([
    ...router.registry.agents
      .filter((a) => a.runtime === 'hermes')
      .map((a) => a.id),
    ...router.registry.orphanProfiles,
  ])

  const statuses = new Map<
    string,
    ReturnType<typeof getAgentStatusSnapshot>
  >()
  for (const agentId of hermesAgentIds) {
    statuses.set(agentId, getAgentStatusSnapshot(agentId))
  }

  const entries: Array<AgentStatusEntry> = agents.map((agent) => {
    const isHermes = hermesAgentIds.has(agent.agentId)
    const snapshot = isHermes ? (statuses.get(agent.agentId) ?? null) : null
    const unified = deriveUnifiedStatusForAgent(
      agent.agentId,
      snapshot,
      Boolean(agent.available),
      groupChatMap,
      router.registry.byId.get(agent.agentId)?.profile,
    )
    const runtime = agent.runtime as AgentStatusEntry['runtime']
    const status: AgentStatusEntry['status'] = snapshot
      ? {
          agentId: snapshot.agentId,
          runtime,
          state: snapshot.state,
          currentTask: snapshot.currentTask,
          taskId: snapshot.taskId,
          missionId: snapshot.missionId,
          needsHuman: snapshot.needsHuman,
          checkpointStatus: snapshot.checkpointStatus,
          lastSummary: snapshot.lastSummary,
          updatedAt: snapshot.updatedAt,
          unifiedStatus: unified,
          needsSetup: unified === 'needsSetup',
        }
      : {
          agentId: agent.agentId,
          runtime,
          state: 'offline',
          currentTask: null,
          taskId: null,
          missionId: null,
          needsHuman: false,
          checkpointStatus: 'none',
          lastSummary: null,
          updatedAt: Date.now(),
          unifiedStatus: unified,
          needsSetup: unified === 'needsSetup',
        }
    return {
      agentId: agent.agentId,
      runtime,
      execution: agent.execution,
      probe: {
        available: agent.available,
        version: agent.version,
        detail: agent.detail,
      },
      status,
    }
  })

  const { probeHermesProfileGateway } =
    await import('./agent-runtime/hermes-gateway-probe')
  const orphanEntries = await Promise.all(
    router.registry.orphanProfiles.map(async (profile) => {
      const probe = await probeHermesProfileGateway(profile)
      const snapshot = statuses.get(profile) ?? null
      const unified = deriveUnifiedStatusForAgent(
        profile,
        snapshot,
        Boolean(probe.available),
        groupChatMap,
        profile,
      )
      return {
        agentId: profile,
        runtime: 'hermes' as const,
        execution: 'local' as const,
        probe: {
          available: probe.available,
          version: probe.version,
          detail:
            probe.detail ?? `hermes profile ${profile} (unmanaged path)`,
        },
        status: snapshot
          ? {
              ...snapshot,
              runtime: 'hermes' as const,
              unifiedStatus: unified,
              needsSetup: unified === 'needsSetup',
            }
          : null,
      }
    }),
  )
  entries.push(...orphanEntries)

  return {
    agents: entries,
    orphanProfiles: router.registry.orphanProfiles,
    checkedAt: Date.now(),
  }
}

export async function buildAgentsSnapshotPayload(): Promise<AgentsSnapshotPayload> {
  const status = await buildAgentsStatusPayload()
  return {
    ...status,
    health: summarizeHealth(status.agents),
  }
}
