import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../../server/auth-middleware'
import { AgoraxManagedAgentHttpClient } from '../../../server/agent-runtime/agorax-managed-agent-http-client'
import { AGENT_PROVIDER_IDS } from '@/lib/managed-agent-runtime/provider-status'

const PROVIDER_ID_SET = new Set<string>(AGENT_PROVIDER_IDS)

/**
 * POST /api/agent-runtime/install — triggers a managed npm install/upgrade
 * for one provider runtime through the embedded Managed Agent daemon. Body:
 * `{ provider: string, version?: string }`. Idempotent on the daemon side
 * (an already-satisfied install returns 200 "already").
 */
export const Route = createFileRoute('/api/agent-runtime/install')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return json({ error: 'Unauthorized' }, { status: 401 })
        }
        const body = (await request.json().catch(() => null)) as Record<
          string,
          unknown
        > | null
        const provider = typeof body?.provider === 'string' ? body.provider.trim() : ''
        const version = typeof body?.version === 'string' ? body.version.trim() : ''
        if (!provider) {
          return json({ error: 'provider is required' }, { status: 400 })
        }
        if (!PROVIDER_ID_SET.has(provider)) {
          return json(
            { error: `unknown provider ${provider}` },
            { status: 400 },
          )
        }
        const baseUrl = process.env.AGORAX_MANAGED_AGENT_URL?.trim()
        if (!baseUrl) {
          return json(
            { error: 'Managed Agent daemon is not configured' },
            { status: 503 },
          )
        }
        try {
          const result = await new AgoraxManagedAgentHttpClient({
            baseUrl,
            workspaceId: process.env.AGORAX_WORKSPACE_ID?.trim() || 'default',
          }).installProvider(provider, version ? { version } : undefined)
          return json(result)
        } catch (error) {
          const status =
            error instanceof Error && 'status' in error
              ? Number((error as { status?: number }).status) || 502
              : 502
          return json(
            {
              error: `Managed Agent install failed: ${
                error instanceof Error ? error.message : String(error)
              }`,
            },
            { status },
          )
        }
      },
    },
  },
})
