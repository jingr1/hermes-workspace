import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../../server/auth-middleware'
import { getAgentRuntimeRouter } from '../../../server/agent-runtime/router'

/**
 * GET /api/agents/status — first screen for the Mission Control overview
 * (plan 模块 2). Returns every declared agent with runtime/execution and a
 * live probe() result, plus orphan hermes profiles discovered on disk.
 */
export const Route = createFileRoute('/api/agents/status')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return json({ error: 'Unauthorized' }, { status: 401 })
        }
        const router = getAgentRuntimeRouter()
        const agents = await router.probeAll()
        return json({
          agents,
          orphanProfiles: router.registry.orphanProfiles,
        })
      },
    },
  },
})
