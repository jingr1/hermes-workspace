import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../../../server/auth-middleware'
import { checkLocalEnvForAgent } from '../../../../server/local-env-check'

/**
 * GET /api/agents/$agentId/env-check
 *
 * Local environment check for any managed CLI runtime declared in agents.yaml.
 */
export const Route = createFileRoute('/api/agents/$agentId/env-check')({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        if (!isAuthenticated(request)) {
          return json({ error: 'Unauthorized' }, { status: 401 })
        }

        const result = await checkLocalEnvForAgent(params.agentId)
        if (!result) {
          return json(
            { ok: false, error: 'Unsupported agent for env check' },
            { status: 400 },
          )
        }

        return json({ ok: true, result })
      },
    },
  },
})
