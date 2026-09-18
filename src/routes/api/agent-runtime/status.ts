import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../../server/auth-middleware'
import { AgoraxManagedAgentHttpClient } from '../../../server/agent-runtime/agorax-managed-agent-http-client'
import type { AgentProviderStatusListDto } from '@/lib/managed-agent-runtime/provider-status'

/**
 * GET /api/agent-runtime/status — proxies the embedded Managed Agent daemon's
 * provider runtime aggregate (install state, versions, auth, update
 * availability) for the agent list badges. The daemon is a local composition
 * dependency: when it is not configured or reachable the route fails closed
 * with 503 so the UI renders the unknown badge instead of stale state.
 */
export const Route = createFileRoute('/api/agent-runtime/status')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return json({ error: 'Unauthorized' }, { status: 401 })
        }
        const baseUrl = process.env.AGORAX_MANAGED_AGENT_URL?.trim()
        if (!baseUrl) {
          return json(
            { error: 'Managed Agent daemon is not configured' },
            { status: 503 },
          )
        }
        try {
          const status = await new AgoraxManagedAgentHttpClient({
            baseUrl,
            workspaceId: process.env.AGORAX_WORKSPACE_ID?.trim() || 'default',
          }).getProviderStatus()
          return json(status satisfies AgentProviderStatusListDto)
        } catch (error) {
          return json(
            {
              error: `Managed Agent daemon is unreachable: ${
                error instanceof Error ? error.message : String(error)
              }`,
            },
            { status: 503 },
          )
        }
      },
    },
  },
})
