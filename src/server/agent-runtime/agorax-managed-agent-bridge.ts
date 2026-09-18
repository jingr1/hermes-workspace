import type {
  AgentProbeResult,
  AgentRunInput,
  AgentStreamEvent,
  McpHandshake,
} from './types'
import {
  AGORAX_MANAGED_AGENT_BACKENDS,
  isAgoraxManagedAgentBackend,
  type AgoraxManagedAgentBackend,
} from '@/lib/managed-agent-runtime/agent-targets'

export {
  AGORAX_MANAGED_AGENT_BACKENDS,
  isAgoraxManagedAgentBackend,
  type AgoraxManagedAgentBackend,
}

export type AgoraxManagedAgentTransport = {
  probe: (
    backend: AgoraxManagedAgentBackend,
  ) => Promise<AgentProbeResult>
  startRun: (input: {
    backend: AgoraxManagedAgentBackend
    run: AgentRunInput
    mcp: McpHandshake
  }) => Promise<{ runId: string }>
  streamEvents: (input: {
    backend: AgoraxManagedAgentBackend
    runId: string
  }) => AsyncIterable<AgentStreamEvent>
  interrupt: (input: {
    backend: AgoraxManagedAgentBackend
    runId: string
    reason: string
  }) => Promise<void>
}

/** Minimal surface the fallback needs (matches AgentRuntimeAdapter). */
type FallbackRunAdapter = {
  probe: () => Promise<AgentProbeResult>
  startRun: (
    input: AgentRunInput & { mcp: McpHandshake },
  ) => Promise<{ runId: string }>
  streamEvents: (runId: string) => AsyncIterable<AgentStreamEvent>
  interrupt: (runId: string, reason: string) => Promise<void>
}

const PROBE_CACHE_MS = 5_000

/**
 * Adapter boundary for the Agorax Managed Agent runtime backed by the embedded
 * Agorax Host/runtime implementation.
 *
 * This class deliberately owns no process, session, or turn state. The
 * transport must delegate those operations to Tutti's canonical Host runtime.
 */
export class AgoraxManagedAgentBridge {
  readonly kind: AgoraxManagedAgentBackend
  private readonly fallback: FallbackRunAdapter | null
  private readonly fallbackRunIds = new Set<string>()
  private probeCache: { at: number; result: AgentProbeResult } | null = null

  constructor(
    private readonly backend: AgoraxManagedAgentBackend,
    private readonly transport: AgoraxManagedAgentTransport,
    options?: { fallback?: FallbackRunAdapter | null },
  ) {
    this.kind = backend
    this.fallback = options?.fallback ?? null
  }

  /**
   * True when the daemon actually serves this backend's target. Some backends
   * are intentionally NOT daemon-hosted (claude-code is served by the direct
   * CLI adapter) — those report unavailable so callers fall back.
   */
  private async daemonAvailable(): Promise<boolean> {
    if (this.probeCache && Date.now() - this.probeCache.at < PROBE_CACHE_MS) {
      return this.probeCache.result.available
    }
    let result: AgentProbeResult
    try {
      result = await this.transport.probe(this.backend)
    } catch (error) {
      result = {
        available: false,
        detail: error instanceof Error ? error.message : String(error),
      }
    }
    this.probeCache = { at: Date.now(), result }
    return result.available
  }

  async probe(): Promise<AgentProbeResult> {
    if (await this.daemonAvailable()) {
      return this.transport.probe(this.backend)
    }
    if (this.fallback) return this.fallback.probe()
    return (
      this.probeCache?.result ?? {
        available: false,
        detail: `Agorax managed target for ${this.backend} is unavailable`,
      }
    )
  }

  async startRun(
    input: AgentRunInput & { mcp: McpHandshake },
  ): Promise<{ runId: string }> {
    if (this.fallback && !(await this.daemonAvailable())) {
      const started = await this.fallback.startRun(input)
      this.fallbackRunIds.add(started.runId)
      return started
    }
    const { mcp, ...run } = input
    return this.transport.startRun({
      backend: this.backend,
      run,
      mcp,
    })
  }

  streamEvents(runId: string): AsyncIterable<AgentStreamEvent> {
    if (this.fallbackRunIds.has(runId)) {
      return this.fallback!.streamEvents(runId)
    }
    return this.transport.streamEvents({ backend: this.backend, runId })
  }

  async interrupt(runId: string, reason: string): Promise<void> {
    if (this.fallbackRunIds.has(runId)) {
      return this.fallback!.interrupt(runId, reason)
    }
    return this.transport.interrupt({
      backend: this.backend,
      runId,
      reason,
    })
  }
}