import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../../server/auth-middleware'
import { getAgentRuntimeRouter } from '../../../server/agent-runtime/router'
import {
  getAgentStatusSnapshot,
  startAgentStatusWatcher,
} from '../../../server/agent-status-watcher'
import type { AgentDeclaration } from '../../../server/agent-runtime/agents-config'
import type { AgentRuntime, AgentStatus, AgentWithStatus } from '../../../lib/agent-types'

function deriveStatus(
  probeAvailable: boolean,
  snapshot?: ReturnType<typeof getAgentStatusSnapshot>,
): AgentStatus {
  if (snapshot?.needsHuman) return 'blocked'
  if (snapshot?.state === 'running') return 'busy'
  if (snapshot?.state === 'idle') return 'online'
  if (snapshot?.state) return snapshot.state as AgentStatus
  return probeAvailable ? 'online' : 'offline'
}

function buildStatusSnapshot(
  snapshot: NonNullable<ReturnType<typeof getAgentStatusSnapshot>>,
): NonNullable<AgentWithStatus['statusSnapshot']> {
  return {
    state: snapshot.state as AgentStatus,
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
  probe: { available: boolean; version?: string; detail?: string },
): AgentWithStatus {
  const snapshot = decl.runtime === 'hermes' ? getAgentStatusSnapshot(decl.id) : undefined
  const status = deriveStatus(probe.available, snapshot)
  return {
    agentId: decl.id,
    name: decl.displayName ?? decl.mentionName ?? decl.id,
    runtime: decl.runtime as AgentRuntime,
    status,
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
    probe,
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

        const agents: Array<AgentWithStatus> = []
        for (const decl of router.registry.agents) {
          const probe = probeById.get(decl.id) ?? { available: false, detail: 'probe missing' }
          agents.push(buildAgentPayload(decl, probe))
        }

        // Orphan Hermes profiles are still usable as hermes-runtime agents.
        for (const profile of router.registry.orphanProfiles) {
          const probe = { available: true, detail: `hermes profile ${profile}` }
          const snapshot = getAgentStatusSnapshot(profile)
          const status = deriveStatus(probe.available, snapshot)
          agents.push({
            agentId: profile,
            name: profile,
            runtime: 'hermes',
            status,
            execution: 'local',
            currentTaskId: snapshot?.taskId ?? undefined,
            currentMissionId: snapshot?.missionId ?? undefined,
            runtimeConfig: {
              profile,
              capabilities: [],
            },
            probe,
            statusSnapshot: snapshot ? buildStatusSnapshot(snapshot) : undefined,
          })
        }

        return json({ agents, checkedAt: Date.now() })
      },
    },
  },
})
