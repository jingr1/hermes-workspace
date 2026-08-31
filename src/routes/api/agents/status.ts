import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../../server/auth-middleware'
import { getAgentRuntimeRouter } from '../../../server/agent-runtime/router'
import {
  getAgentStatusSnapshot,
  startAgentStatusWatcher,
} from '../../../server/agent-status-watcher'

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
        const statuses = new Map<
          string,
          ReturnType<typeof getAgentStatusSnapshot>
        >()
        for (const decl of router.registry.agents) {
          if (decl.runtime === 'hermes') {
            statuses.set(decl.id, getAgentStatusSnapshot(decl.id))
          }
        }
        const entries = agents.map((agent) => ({
          ...agent,
          status: statuses.get(agent.agentId) ?? null,
        }))
        return json({
          agents: entries,
          orphanProfiles: router.registry.orphanProfiles,
          checkedAt: Date.now(),
        })
      },
    },
  },
})
