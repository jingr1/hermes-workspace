import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../../server/auth-middleware'
import { applyProfileGatewayRoute } from '../../../server/gateway-capabilities'
import {
  ensureProfileGateway,
  probeProfileGateway,
} from '../../../server/gateway-pool'
import {
  getProfileGatewayUrl,
  resolveProfileGatewayPort,
} from '../../../server/gateway-ports'
import { setActiveProfile, resolveProfileHermesHome } from '../../../server/profiles-browser'
import { loadWorkspaceCatalog } from '../workspace'
import { requireJsonContentType } from '../../../server/rate-limit'
import {
  ensureGatewayLifecycleScheduler,
  touchGatewayLease,
} from '../../../server/gateway-lifecycle'

export const Route = createFileRoute('/api/profiles/activate')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return json({ error: 'Unauthorized' }, { status: 401 })
        }
        const csrfCheck = requireJsonContentType(request)
        if (csrfCheck) return csrfCheck
        try {
          const body = (await request.json()) as { name?: string }
          const name = (body.name || '').trim() || 'default'
          setActiveProfile(name)

          const port = resolveProfileGatewayPort(name)
          const url = getProfileGatewayUrl(name)
          const hermesHome = resolveProfileHermesHome(name)
          touchGatewayLease(name)
          ensureGatewayLifecycleScheduler()
          // Route chat traffic immediately; respond without probing gateway health.
          // Cold starts and port ownership checks run in the background so profile
          // switches (especially to default) are not blocked by SSH/workspace work
          // or a slow /proc scan on busy hosts.
          applyProfileGatewayRoute(url)

          void (async () => {
            try {
              if (await probeProfileGateway(name)) return
              await ensureProfileGateway(name)
            } catch (error) {
              console.warn(
                `[profiles] background gateway start for ${name} failed:`,
                error instanceof Error ? error.message : error,
              )
            }
          })()

          const workspace = await loadWorkspaceCatalog(name)

          return json({
            ok: true,
            profile: name,
            pending: true,
            workspace,
            gateway: {
              ok: true,
              message: 'starting',
              profile: name,
              hermesHome,
              port,
              url,
              started: true,
            },
          })
        } catch (error) {
          return json(
            {
              error:
                error instanceof Error
                  ? error.message
                  : 'Failed to activate profile',
            },
            { status: 500 },
          )
        }
      },
    },
  },
})
