import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../../../../server/auth-middleware'
import { AgoraxManagedAgentHttpClient } from '../../../../../server/agent-runtime/agorax-managed-agent-http-client'
import { isAgoraxManagedAgentBackend } from '../../../../../server/agent-runtime/agorax-managed-agent-bridge'
import { AgoraxManagedRunStore } from '../../../../../server/agent-runtime/agorax-managed-run-store'
import { startManagedChatRun } from '../../../../../server/agent-runtime/run-managed-turn'
import { getAgentRuntimeRouter } from '../../../../../server/agent-runtime/router'
import { ensureManagedChatSession } from '../../../../../server/agent-runtime/managed-chat-store'
import { resolveManagedChatWorkspaceCwd } from '../../../../../server/agent-runtime/managed-chat-workspace'
import { loadWorkspaceCatalog } from '../../../workspace'
import type { ManagedAgentActivateResponseDto } from '@/lib/managed-agent-runtime/command-dtos'
import type { AgoraxManagedPromptContentBlock } from '@/lib/managed-agent-runtime/prompt-content'
import { managedPromptContentBlocksFromUnknown } from '@/lib/managed-agent-runtime/prompt-content'

export const Route = createFileRoute('/api/agents/$agentId/engine/activate')({
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        if (!isAuthenticated(request))
          return json({ error: 'Unauthorized' }, { status: 401 })
        const agentId = params.agentId.trim()
        const body = (await request.json().catch(() => null)) as Record<
          string,
          unknown
        > | null
        const displaySessionId =
          typeof body?.displaySessionId === 'string'
            ? body.displaySessionId.trim()
            : ''
        const agentSessionId =
          typeof body?.agentSessionId === 'string'
            ? body.agentSessionId.trim()
            : ''
        const message =
          typeof body?.message === 'string' ? body.message.trim() : ''
        if (!agentId || !displaySessionId || !agentSessionId || !message) {
          return json(
            {
              error:
                'agentId, displaySessionId, agentSessionId, and message are required',
            },
            { status: 400 },
          )
        }
        const declaration = getAgentRuntimeRouter().registry.byId.get(agentId)
        if (!declaration || !isAgoraxManagedAgentBackend(declaration.runtime)) {
          return json(
            { error: 'Managed Agent is unavailable' },
            { status: 404 },
          )
        }
        const model = typeof body?.model === 'string' ? body.model.trim() : ''
        let promptContent: Array<AgoraxManagedPromptContentBlock>
        try {
          promptContent = managedPromptContentBlocksFromUnknown(
            body?.promptContent,
          )
        } catch (error) {
          return json(
            { error: error instanceof Error ? error.message : String(error) },
            { status: 400 },
          )
        }
        ensureManagedChatSession({
          id: displaySessionId,
          agentId,
          runtime: declaration.runtime,
          ...(model ? { model } : {}),
        })
        const workspace = await loadWorkspaceCatalog().catch(() => null)
        const cwd = resolveManagedChatWorkspaceCwd(workspace)
        const started = await startManagedChatRun({
          agentId,
          runId: agentSessionId,
          sessionId: displaySessionId,
          task: message,
          ...(promptContent.length ? { content: promptContent } : {}),
          ...(model ? { model } : {}),
          ...(cwd ? { cwd } : {}),
        })
        if (!started.ok)
          return json({ error: started.error }, { status: started.status })
        const runStore = new AgoraxManagedRunStore()
        const binding = await runStore.get(agentSessionId)
        const baseUrl = process.env.AGORAX_MANAGED_AGENT_URL?.trim()
        const workspaceId = process.env.AGORAX_WORKSPACE_ID?.trim()
        if (!binding || !baseUrl || !workspaceId) {
          return json(
            { error: 'Managed Agent canonical binding is unavailable' },
            { status: 503 },
          )
        }
        await runStore.bind({
          runId: binding.runId,
          backend: binding.backend,
          agentSessionId: binding.agentSessionId,
          displaySessionId,
          ...(binding.turnId ? { turnId: binding.turnId } : {}),
        })
        try {
          const activity = await new AgoraxManagedAgentHttpClient({
            baseUrl,
            workspaceId,
          }).getActivitySnapshot(binding.agentSessionId)
          const response: ManagedAgentActivateResponseDto = {
            runId: started.runId,
            activity,
          }
          return json(response)
        } catch (error) {
          return json(
            { error: error instanceof Error ? error.message : String(error) },
            { status: 502 },
          )
        }
      },
    },
  },
})
