import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../../../../server/auth-middleware'
import { AgoraxManagedAgentHttpClient } from '../../../../../server/agent-runtime/agorax-managed-agent-http-client'
import { isAgoraxManagedAgentBackend } from '../../../../../server/agent-runtime/agorax-managed-agent-bridge'
import { AgoraxManagedRunStore } from '../../../../../server/agent-runtime/agorax-managed-run-store'
import { startManagedChatRun } from '../../../../../server/agent-runtime/run-managed-turn'
import { getAgentRuntimeRouter } from '../../../../../server/agent-runtime/router'

export const Route = createFileRoute('/api/agents/$agentId/engine/activate')({
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        if (!isAuthenticated(request)) return json({ error: 'Unauthorized' }, { status: 401 })
        const agentId = params.agentId.trim()
        const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
        const displaySessionId = typeof body?.displaySessionId === 'string' ? body.displaySessionId.trim() : ''
        const agentSessionId = typeof body?.agentSessionId === 'string' ? body.agentSessionId.trim() : ''
        const message = typeof body?.message === 'string' ? body.message.trim() : ''
        if (!agentId || !displaySessionId || !agentSessionId || !message) {
          return json({ error: 'agentId, displaySessionId, agentSessionId, and message are required' }, { status: 400 })
        }
        const declaration = getAgentRuntimeRouter().registry.byId.get(agentId)
        if (!declaration || !isAgoraxManagedAgentBackend(declaration.runtime)) {
          return json({ error: 'Managed Agent is unavailable' }, { status: 404 })
        }
        const model = typeof body?.model === 'string' ? body.model.trim() : ''
        const promptContent = Array.isArray(body?.promptContent) ? body.promptContent : undefined
        const started = await startManagedChatRun({
          agentId,
          runId: agentSessionId,
          sessionId: displaySessionId,
          task: message,
          ...(promptContent ? { content: promptContent as never } : {}),
          ...(model ? { model } : {}),
        })
        if (!started.ok) return json({ error: started.error }, { status: started.status })
        const binding = await new AgoraxManagedRunStore().get(agentSessionId)
        const baseUrl = process.env.AGORAX_MANAGED_AGENT_URL?.trim()
        const workspaceId = process.env.AGORAX_WORKSPACE_ID?.trim()
        if (!binding || !baseUrl || !workspaceId) {
          return json({ error: 'Managed Agent canonical binding is unavailable' }, { status: 503 })
        }
        try {
          const activity = await new AgoraxManagedAgentHttpClient({ baseUrl, workspaceId })
            .getActivitySnapshot(binding.agentSessionId)
          return json({ runId: started.runId, activity })
        } catch (error) {
          return json({ error: error instanceof Error ? error.message : String(error) }, { status: 502 })
        }
      },
    },
  },
})
