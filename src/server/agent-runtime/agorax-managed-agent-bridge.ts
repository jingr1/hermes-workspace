import type {
  AgentProbeResult,
  AgentRunInput,
  AgentStreamEvent,
  McpHandshake,
} from './types'

export const AGORAX_MANAGED_AGENT_BACKENDS = [
  'claude-code',
  'codex',
  'cursor',
  'opencode',
  'kimi',
] as const

export type AgoraxManagedAgentBackend =
  (typeof AGORAX_MANAGED_AGENT_BACKENDS)[number]

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

export function isAgoraxManagedAgentBackend(
  value: string,
): value is AgoraxManagedAgentBackend {
  return (AGORAX_MANAGED_AGENT_BACKENDS as readonly string[]).includes(value)
}

/**
 * Adapter boundary for the Agorax Managed Agent runtime backed by Tutti Host/tuttid.
 *
 * This class deliberately owns no process, session, or turn state. The
 * transport must delegate those operations to Tutti's canonical Host runtime.
 */
export class AgoraxManagedAgentBridge {
  constructor(
    private readonly backend: AgoraxManagedAgentBackend,
    private readonly transport: AgoraxManagedAgentTransport,
  ) {}

  probe(): Promise<AgentProbeResult> {
    return this.transport.probe(this.backend)
  }

  startRun(
    run: AgentRunInput,
    mcp: McpHandshake,
  ): Promise<{ runId: string }> {
    return this.transport.startRun({ backend: this.backend, run, mcp })
  }

  streamEvents(runId: string): AsyncIterable<AgentStreamEvent> {
    return this.transport.streamEvents({ backend: this.backend, runId })
  }

  interrupt(runId: string, reason: string): Promise<void> {
    return this.transport.interrupt({
      backend: this.backend,
      runId,
      reason,
    })
  }
}