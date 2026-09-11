import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../../../server/auth-middleware'
import {
  runAgentEnvAction,
  type AgentEnvAction,
} from '../../../../server/agent-env-action'

/**
 * POST /api/agents/$agentId/env-action
 *
 * Run an install or update lifecycle action for a managed CLI runtime.
 */
export const Route = createFileRoute('/api/agents/$agentId/env-action')({
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        if (!isAuthenticated(request)) {
          return json({ error: 'Unauthorized' }, { status: 401 })
        }

        let body: {
          action?: string
          useSudo?: boolean
          sudoPassword?: string
        } = {}
        try {
          body = (await request.json()) as typeof body
        } catch {
          return json({ error: 'Invalid JSON body' }, { status: 400 })
        }

        const action = body.action as AgentEnvAction | undefined
        if (action !== 'install' && action !== 'update') {
          return json(
            { ok: false, error: 'action must be install or update' },
            { status: 400 },
          )
        }

        const result = await runAgentEnvAction({
          agentId: params.agentId,
          action,
          useSudo: body.useSudo,
          sudoPassword: body.sudoPassword,
        })

        return json(result, { status: result.ok ? 200 : 500 })
      },
    },
  },
})
