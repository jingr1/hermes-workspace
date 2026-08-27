/**
 * AgentRuntimeRouter — resolves agent id → adapter, owns probe() and
 * status aggregation. hermes agents are intentionally NOT adapted here:
 * they keep their existing send-stream / swarm-dispatch path (plan:
 * «hermes：完全不动») and appear in status via a read-only stub.
 */
import { ClaudeCodeAdapter } from './claude-code-adapter'
import {   loadAgentsRegistry } from './agents-config'
import type {AgentDeclaration, AgentsRegistry} from './agents-config';
import type { AgentProbeResult, AgentRuntimeAdapter } from './types'

/** Read-only stand-in for hermes-runtime agents (they are not spawned here). */
class HermesAdapterStub implements AgentRuntimeAdapter {
  readonly kind = 'hermes' as const
  constructor(private readonly decl: AgentDeclaration) {}
  async probe(): Promise<AgentProbeResult> {
    return { available: true, detail: `hermes profile ${this.decl.profile} (unmanaged path)` }
  }
  async startRun(): Promise<{ runId: string }> {
    throw new Error('hermes runtime is dispatched via the existing swarm-dispatch path, not AgentRuntime')
  }
  streamEvents(): AsyncIterable<never> {
    throw new Error('hermes runtime has no managed stream')
  }
  async interrupt(): Promise<void> {
    throw new Error('hermes runtime is interrupted via the existing swarm path')
  }
}

const UNSUPPORTED_RUNTIMES = new Set(['codex', 'deepseek-harness'])

/** Adapter slot for declared runtimes whose adapter ships in a later step. */
class UnavailableAdapter implements AgentRuntimeAdapter {
  constructor(private readonly decl: AgentDeclaration) {}
  get kind() {
    return this.decl.runtime
  }
  async probe(): Promise<AgentProbeResult> {
    return { available: false, detail: `adapter for ${this.decl.runtime} not yet delivered (P1 步骤 4)` }
  }
  async startRun(): Promise<{ runId: string }> {
    throw new Error(`adapter for ${this.decl.runtime} not yet delivered`)
  }
  streamEvents(): AsyncIterable<never> {
    throw new Error(`adapter for ${this.decl.runtime} not yet delivered`)
  }
  async interrupt(): Promise<void> {}
}

export class AgentRuntimeRouter {
  private readonly adapters = new Map<string, AgentRuntimeAdapter>()
  readonly registry: AgentsRegistry

  constructor(input?: { repoRoot?: string; rawYaml?: string }) {
    this.registry = loadAgentsRegistry(input)
    for (const decl of this.registry.agents) {
      this.adapters.set(decl.id, this.buildAdapter(decl))
    }
  }

  private buildAdapter(decl: AgentDeclaration): AgentRuntimeAdapter {
    switch (decl.runtime) {
      case 'hermes':
        return new HermesAdapterStub(decl)
      case 'claude-code':
        return new ClaudeCodeAdapter(decl)
      default:
        if (UNSUPPORTED_RUNTIMES.has(decl.runtime)) {
          return new UnavailableAdapter(decl)
        }
        throw new Error(`No adapter for runtime ${decl.runtime}`)
    }
  }

  getAdapter(agentId: string): AgentRuntimeAdapter | null {
    return this.adapters.get(agentId) ?? null
  }

  async probeAll(): Promise<
    Array<{ agentId: string; runtime: string; execution: string; probe: AgentProbeResult }>
  > {
    const results = []
    for (const decl of this.registry.agents) {
      const adapter = this.adapters.get(decl.id)
      if (!adapter) continue
      let probe: AgentProbeResult
      try {
        probe = await adapter.probe()
      } catch (error) {
        probe = { available: false, detail: error instanceof Error ? error.message : String(error) }
      }
      results.push({ agentId: decl.id, runtime: decl.runtime, execution: decl.execution, probe })
    }
    return results
  }
}

// ─── Singleton (HMR-safe via globalThis) ────────────────────────────────

const ROUTER_KEY = '__agent_runtime_router__' as const

export function getAgentRuntimeRouter(): AgentRuntimeRouter {
  const g = globalThis as Record<string, unknown>
  if (!g[ROUTER_KEY]) {
    g[ROUTER_KEY] = new AgentRuntimeRouter()
  }
  return g[ROUTER_KEY] as AgentRuntimeRouter
}

/** Test hook: replace the singleton. */
export function setAgentRuntimeRouterForTests(router: AgentRuntimeRouter | null): void {
  const g = globalThis as Record<string, unknown>
  if (router) g[ROUTER_KEY] = router
  else delete g[ROUTER_KEY]
}
