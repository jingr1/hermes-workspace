/**
 * Shared Hermes profile gateway probe for agent status surfaces.
 *
 * Availability follows port ownership (same signal as gateway-pool `healthy`).
 * Detail distinguishes not-running vs port-not-owned. Short TTL cache avoids
 * hammering ownership checks when Mission Control / agent list poll often;
 * negative results use a shorter TTL so recovery shows up quickly.
 */
import type { AgentProbeResult } from './types'

const POSITIVE_CACHE_TTL_MS = 2_000
const NEGATIVE_CACHE_TTL_MS = 250

type CacheEntry = { result: AgentProbeResult; expiresAt: number }

const CACHE_KEY = '__hermes_gateway_probe_cache__' as const

function getCache(): Map<string, CacheEntry> {
  const g = globalThis as Record<string, unknown>
  if (!g[CACHE_KEY]) g[CACHE_KEY] = new Map<string, CacheEntry>()
  return g[CACHE_KEY] as Map<string, CacheEntry>
}

/** Test helper: drop cached probe results. */
export function clearHermesGatewayProbeCache(): void {
  getCache().clear()
}

export async function probeHermesProfileGateway(
  profileName: string,
): Promise<AgentProbeResult> {
  const name = (profileName || 'default').trim() || 'default'
  const cache = getCache()
  const cached = cache.get(name)
  const now = Date.now()
  if (cached && cached.expiresAt > now) return cached.result

  let result: AgentProbeResult
  try {
    const { probeProfileGateway } = await import('../gateway-pool')
    const { getProfileGatewayUrl, resolveProfileGatewayPort } =
      await import('../gateway-ports')
    const owned = await probeProfileGateway(name)
    const url = getProfileGatewayUrl(name)
    if (owned) {
      result = {
        available: true,
        detail: `hermes gateway ${url}`,
      }
    } else {
      const { isPortInUse } = await import('../gateway-port-owner')
      const port = resolveProfileGatewayPort(name)
      const inUse = isPortInUse(port)
      result = {
        available: false,
        detail: inUse
          ? `hermes gateway port not owned (${url})`
          : `hermes gateway not running (${url})`,
      }
    }
  } catch (error) {
    result = {
      available: false,
      detail:
        error instanceof Error
          ? error.message
          : `hermes gateway probe failed: ${String(error)}`,
    }
  }

  const ttl = result.available ? POSITIVE_CACHE_TTL_MS : NEGATIVE_CACHE_TTL_MS
  cache.set(name, { result, expiresAt: now + ttl })
  return result
}

/** @deprecated Ownership probe no longer uses a health fetch timeout. */
export const HERMES_GATEWAY_PROBE_TIMEOUT_MS = 250
