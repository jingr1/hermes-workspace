import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../../../../server/auth-middleware'
import { listSessionsForAgent } from '../../../../../server/agent-sessions-service'

export const Route = createFileRoute(
  '/api/agents/$agentId/sessions/$sessionId',
)({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        if (!isAuthenticated(request)) {
          return json({ error: 'Unauthorized' }, { status: 401 })
        }
        const agentId = typeof params.agentId === 'string' ? params.agentId : ''
        const sessionId =
          typeof params.sessionId === 'string' ? params.sessionId : ''
        if (!agentId || !sessionId) {
          return json(
            { error: 'agentId and sessionId are required' },
            { status: 400 },
          )
        }
        const sessions = listSessionsForAgent(agentId)
        const session = sessions.find((s) => s.sessionId === sessionId)
        if (!session) {
          return json({ error: 'Session not found' }, { status: 404 })
        }
        return json({ session })
      },
      DELETE: async ({ request, params }) => {
        if (!isAuthenticated(request)) {
          return json({ error: 'Unauthorized' }, { status: 401 })
        }
        const agentId = typeof params.agentId === 'string' ? params.agentId : ''
        const sessionId =
          typeof params.sessionId === 'string' ? params.sessionId : ''
        if (!agentId || !sessionId) {
          return json(
            { error: 'agentId and sessionId are required' },
            { status: 400 },
          )
        }
        // Hermes session deletion goes through the existing /api/sessions endpoint.
        // For managed runtimes this will be wired once adapters are delivered.
        return json({
          deleted: false,
          reason: 'not implemented for this runtime',
        })
      },
    },
  },
})
