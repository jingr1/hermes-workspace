import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../../../../../../server/auth-middleware'
import { AgoraxManagedAgentHttpClient } from '../../../../../../../server/agent-runtime/agorax-managed-agent-http-client'

export const Route = createFileRoute('/api/agents/$agentId/engine/session/$sessionId/input')({ server: { handlers: { POST: async ({ request, params }) => {
  if (!isAuthenticated(request)) return json({ error: 'Unauthorized' }, { status: 401 })
  const body = await request.json() as { clientSubmitId?: string; content?: string; promptContent?: never[] }
  const baseUrl = process.env.AGORAX_MANAGED_AGENT_URL?.trim(); const workspaceId = process.env.AGORAX_WORKSPACE_ID?.trim()
  if (!baseUrl || !workspaceId || !body.clientSubmitId || !body.content) return json({ error: 'Invalid managed input' }, { status: 400 })
  try {
    const client = new AgoraxManagedAgentHttpClient({ baseUrl, workspaceId })
    const result = await client.sendInput(params.sessionId, { clientSubmitId: body.clientSubmitId, content: body.content, ...(body.promptContent ? { promptContent: body.promptContent } : {}) })
    return json({ result, activity: await client.getActivitySnapshot(params.sessionId) })
  }
  catch (error) { return json({ error: error instanceof Error ? error.message : String(error) }, { status: 502 }) }
} } } })
