import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../../../../server/auth-middleware'
import { createSessionForAgent } from '../../../../../server/agent-sessions-service'

export const Route = createFileRoute('/api/agents/$agentId/sessions/')({
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        if (!isAuthenticated(request)) {
          return json({ error: 'Unauthorized' }, { status: 401 })
        }
        const agentId = typeof params.agentId === 'string' ? params.agentId : ''
        if (!agentId) {
          return json({ error: 'agentId is required' }, { status: 400 })
        }
        const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
        const title = typeof body.title === 'string' ? body.title.trim() : undefined
        const model = typeof body.model === 'string' ? body.model.trim() : undefined
        const created = createSessionForAgent(agentId, { title, model })
        return json({ sessionId: created.sessionId, agentId, title, model })
      },
    },
  },
})
