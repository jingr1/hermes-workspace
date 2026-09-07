/**
 * Shared Hermes profile gateway health probe for agent status surfaces.
 *
 * Short TTL cache avoids hammering /health when Mission Control / agent list
 * poll status every few seconds.
 */
import type { AgentProbeResult } from './types'

const CACHE_TTL_MS = 2_000
const HEALTH_TIMEOUT_MS = 250

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
    const { getProfileGatewayUrl } = await import('../gateway-ports')
    const healthy = await probeProfileGateway(name)
    const url = getProfileGatewayUrl(name)
    result = healthy
      ? {
          available: true,
          detail: `hermes gateway ${url}`,
        }
      : {
          available: false,
          detail: `hermes gateway unreachable (${url})`,
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

  cache.set(name, { result, expiresAt: now + CACHE_TTL_MS })
  return result
}

/** @internal exposed for tests that want a deterministic timeout constant */
export const HERMES_GATEWAY_PROBE_TIMEOUT_MS = HEALTH_TIMEOUT_MS
