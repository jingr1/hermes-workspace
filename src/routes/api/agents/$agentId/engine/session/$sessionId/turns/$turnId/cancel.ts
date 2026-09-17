import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../../../../../../../../server/auth-middleware'
import { AgoraxManagedAgentHttpClient } from '../../../../../../../../../server/agent-runtime/agorax-managed-agent-http-client'

export const Route = createFileRoute('/api/agents/$agentId/engine/session/$sessionId/turns/$turnId/cancel')({ server: { handlers: { POST: async ({ request, params }) => {
  if (!isAuthenticated(request)) return json({ error: 'Unauthorized' }, { status: 401 })
  const baseUrl = process.env.AGORAX_MANAGED_AGENT_URL?.trim(); const workspaceId = process.env.AGORAX_WORKSPACE_ID?.trim()
  if (!baseUrl || !workspaceId) return json({ error: 'Managed Agent transport is not configured' }, { status: 503 })
  try {
    const client = new AgoraxManagedAgentHttpClient({ baseUrl, workspaceId })
    const result = await client.cancelTurn(params.sessionId, params.turnId)
    return json({ result, activity: await client.getActivitySnapshot(params.sessionId) })
  }
  catch (error) { return json({ error: error instanceof Error ? error.message : String(error) }, { status: 502 }) }
} } } })