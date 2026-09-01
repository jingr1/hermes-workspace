import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../../../server/auth-middleware'
import { listSessionsForAgent } from '../../../../server/agent-sessions-service'

export const Route = createFileRoute('/api/agents/$agentId/sessions')({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        if (!isAuthenticated(request)) {
          return json({ error: 'Unauthorized' }, { status: 401 })
        }
        const agentId = typeof params.agentId === 'string' ? params.agentId : ''
        if (!agentId) {
          return json({ error: 'agentId is required' }, { status: 400 })
        }
        const sessions = listSessionsForAgent(agentId)
        return json({ sessions, agentId })
      },
    },
  },
})
