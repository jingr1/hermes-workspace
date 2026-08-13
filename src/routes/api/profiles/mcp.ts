/**
 * Per-profile MCP server management.
 *
 *   GET /api/profiles/mcp?name=<profile>
 *     → reads config.yaml mcp_servers map, returns normalized list
 *
 *   POST /api/profiles/mcp
 *     body: { name: string, action: 'toggle'|'remove', server: string, enabled?: boolean }
 *     → toggles or removes an MCP server in the target profile's config.yaml
 *
 * Works against the local filesystem via profiles-browser (same as
 * /api/profiles/update). No dashboard proxy needed — the workspace
 * can read/write any profile on the same machine.
 */
import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../../server/auth-middleware'
import {
  readProfile,
  updateProfileConfig,
} from '../../../server/profiles-browser'
import { normalizeMcpListFromConfig } from '../../../server/mcp-normalize'
import { requireJsonContentType } from '../../../server/rate-limit'
import { maskSecretsInPlace } from '../../../server/mcp-normalize'

const PROFILE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/

export const Route = createFileRoute('/api/profiles/mcp')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return json({ error: 'Unauthorized' }, { status: 401 })
        }
        try {
          const url = new URL(request.url)
          const name = (url.searchParams.get('name') || '').trim()
          if (!name || !PROFILE_NAME_RE.test(name)) {
            return json(
              { error: 'A valid profile name is required' },
              { status: 400 },
            )
          }
          const profile = readProfile(name)
          const servers = normalizeMcpListFromConfig(profile.config)
          // Mask secrets before sending to client
          for (const s of servers) maskSecretsInPlace(s)
          return json({ profile: name, servers })
        } catch (error) {
          return json(
            {
              error:
                error instanceof Error
                  ? error.message
                  : 'Failed to read profile MCP config',
            },
            { status: 500 },
          )
        }
      },
      POST: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return json({ ok: false, error: 'Unauthorized' }, { status: 401 })
        }
        const csrfCheck = requireJsonContentType(request)
        if (csrfCheck) return csrfCheck

        try {
          const body = (await request.json()) as {
            name?: string
            action?: 'toggle' | 'remove'
            server?: string
            enabled?: boolean
          }
          const profileName = (body.name || '').trim()
          const action = body.action
          const serverName = (body.server || '').trim()
          if (!profileName || !PROFILE_NAME_RE.test(profileName)) {
            return json(
              { ok: false, error: 'A valid profile name is required' },
              { status: 400 },
            )
          }
          if (!serverName) {
            return json(
              { ok: false, error: 'Server name is required' },
              { status: 400 },
            )
          }
          if (action !== 'toggle' && action !== 'remove') {
            return json(
              { ok: false, error: 'action must be "toggle" or "remove"' },
              { status: 400 },
            )
          }

          // Read current config to get the mcp_servers map
          const profile = readProfile(profileName)
          const mcpServers = (profile.config.mcp_servers ?? {}) as Record<
            string,
            unknown
          >
          const serverEntry = mcpServers[serverName]
          if (!serverEntry) {
            return json(
              { ok: false, error: `MCP server "${serverName}" not found` },
              { status: 404 },
            )
          }

          if (action === 'remove') {
            delete mcpServers[serverName]
            updateProfileConfig(profileName, {
              mcp_servers: mcpServers,
            })
          } else {
            // toggle
            const currentEnabled =
              typeof serverEntry === 'object' && serverEntry !== null
                ? !(
                    (serverEntry as Record<string, unknown>).enabled === false
                  )
                : true
            const nextEnabled = body.enabled ?? !currentEnabled
            const updated =
              typeof serverEntry === 'object' && serverEntry !== null
                ? { ...(serverEntry as Record<string, unknown>), enabled: nextEnabled }
                : { enabled: nextEnabled }
            mcpServers[serverName] = updated
            updateProfileConfig(profileName, {
              mcp_servers: mcpServers,
            })
          }

          return json({ ok: true, profile: profileName, server: serverName })
        } catch (error) {
          return json(
            {
              ok: false,
              error:
                error instanceof Error
                  ? error.message
                  : 'Failed to update profile MCP config',
            },
            { status: 500 },
          )
        }
      },
    },
  },
})
