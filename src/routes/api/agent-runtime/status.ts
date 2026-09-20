import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../../server/auth-middleware'
import { AgoraxManagedAgentHttpClient } from '../../../server/agent-runtime/agorax-managed-agent-http-client'
import { aggregateAgentRuntimeStatus } from '../../../server/agent-runtime/aggregate-runtime-status'
import type { AgentProviderStatusListDto } from '@/lib/managed-agent-runtime/provider-status'

/**
 * GET /api/agent-runtime/status — aggregates managed daemon provider status
 * with Hermes Agent (update-system) and an honest deepseek stub. When the
 * daemon is unreachable, Hermes/deepseek rows still return so Runtimes is
 * usable; managed providers are omitted rather than faked.
 */
export const Route = createFileRoute('/api/agent-runtime/status')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return json({ error: 'Unauthorized' }, { status: 401 })
        }
        const baseUrl = process.env.AGORAX_MANAGED_AGENT_URL?.trim()
        let daemonStatus: AgentProviderStatusListDto | null = null
        if (baseUrl) {
          try {
            daemonStatus = await new AgoraxManagedAgentHttpClient({
              baseUrl,
              workspaceId: process.env.AGORAX_WORKSPACE_ID?.trim() || 'default',
            }).getProviderStatus()
          } catch {
            daemonStatus = null
          }
        }
        const status = await aggregateAgentRuntimeStatus(daemonStatus)
        return json(status satisfies AgentProviderStatusListDto)
      },
    },
  },
})
