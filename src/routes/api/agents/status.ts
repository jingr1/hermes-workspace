import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../../server/auth-middleware'
import { getAgentRuntimeRouter } from '../../../server/agent-runtime/router'
import {
  getAgentStatusSnapshot,
  startAgentStatusWatcher,
} from '../../../server/agent-status-watcher'
import type { AgentStatusEntry } from '../../../lib/mission-control-api'
import {
  deriveUnifiedStatusForAgent,
  loadGroupChatActivity,
  type UnifiedAgentStatus,
} from '../../../lib/agent-status'

/**
 * GET /api/agents/status — first screen for the Mission Control overview
 * (plan 模块 2). Returns every declared agent with runtime/execution, a
 * live probe() result, current runtime snapshot, plus orphan hermes profiles.
 */
export const Route = createFileRoute('/api/agents/status')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return json({ error: 'Unauthorized' }, { status: 401 })
        }
        startAgentStatusWatcher()
        const router = getAgentRuntimeRouter()
        const agents = await router.probeAll()
        const groupChatMap = loadGroupChatActivity()

        // Only Hermes agents have a persistent runtime.json snapshot.
        // Non-Hermes runtimes (claude-code, codex, deepseek-harness) are
        // judged by their probe result alone.
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
          const snapshot = isHermes
            ? (statuses.get(agent.agentId) ?? null)
            : null
          const unified = deriveUnifiedStatusForAgent(
            agent.agentId,
            snapshot,
            Boolean(agent.available),
            groupChatMap,
            // Declared agents map to their hermes profile when present.
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

        // Orphan Hermes profiles are still usable agents but are not declared
        // in agents.yaml, so probeAll() does not include them. Surface them
        // here with the same shape so the UI can render them safely.
        const { probeHermesProfileGateway } = await import(
          '../../../server/agent-runtime/hermes-gateway-probe'
        )
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

        return json({
          agents: entries,
          orphanProfiles: router.registry.orphanProfiles,
          checkedAt: Date.now(),
        })
      },
    },
  },
})
