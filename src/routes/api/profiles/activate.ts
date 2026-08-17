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
import { requireJsonContentType } from '../../../server/rate-limit'

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
          // Route chat traffic immediately; do not wait for a cold gateway spawn
          // here — Squid and some browsers drop the connection on long POSTs.
          applyProfileGatewayRoute(url)

          if (await probeProfileGateway(name)) {
            return json({
              ok: true,
              profile: name,
              gateway: {
                ok: true,
                message: 'already running',
                profile: name,
                hermesHome,
                port,
                url,
                started: false,
              },
            })
          }

          void ensureProfileGateway(name).catch((error) => {
            console.warn(
              `[profiles] background gateway start for ${name} failed:`,
              error instanceof Error ? error.message : error,
            )
          })

          return json({
            ok: true,
            profile: name,
            pending: true,
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
