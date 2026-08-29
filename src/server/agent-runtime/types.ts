/**
 * AgentRuntime type contracts — plan «AgentRuntime：控制通道与展示通道分离».
 *
 * Control channel: MCP typed tool calls (src/server/mcp/*) drive the state
 * machine. Display channel: AgentStreamEvent only feeds the UI via
 * chat-event-bus and is NEVER persisted (plan: 展示通道事件永不落库).
 */

export type AgentRuntimeKind = 'hermes' | 'claude-code' | 'codex' | 'deepseek-harness'

export type AgentStreamEvent =
  | { type: 'run_started'; runId: string; agentId: string; taskId?: string; roomId?: string }
  | { type: 'text_delta'; runId: string; text: string }
  | { type: 'thinking'; runId: string; text: string }
  | { type: 'tool'; runId: string; phase: 'start' | 'end'; name: string; args?: unknown }
  | { type: 'run_exited'; runId: string; exitCode: number | null }
  | { type: 'error'; runId: string; message: string }

export type McpHandshake = {
  /** e.g. http://127.0.0.1:<port>/api/mcp-rpc (see mcp-rpc.ts route note) */
  endpoint: string
  /** Per-run run_write token (P1.1). Injected via process env only. */
  runToken: string
  toolAllowlist: Array<string>
}

export type AgentRunInput = {
  runId: string
  agentId: string
  /** The rendered instruction text for this stage/run. */
  task: string
  /** Working directory (per-mission worktree in P2b; repo cwd today). */
  cwd?: string
  roomId?: string | null
  taskId?: string | null
  /** Extra env merged over process.env. Secrets MUST come via env, not files. */
  env?: Record<string, string>
}

export type AgentProbeResult = {
  available: boolean
  version?: string
  detail?: string
}

export interface AgentRuntimeAdapter {
  kind: AgentRuntimeKind
  probe: () => Promise<AgentProbeResult>
  /** Inject MCP endpoint + runToken, spawn the managed per-run process. */
  startRun: (input: AgentRunInput & { mcp: McpHandshake }) => Promise<{ runId: string }>
  streamEvents: (runId: string) => AsyncIterable<AgentStreamEvent>
  /** Kill the whole process group (SIGKILL). Never sends Ctrl-C. */
  interrupt: (runId: string, reason: string) => Promise<void>
}
