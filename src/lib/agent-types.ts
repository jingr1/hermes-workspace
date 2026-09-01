/**
 * Shared agent / workspace types for the unified Agent Workspace UI.
 *
 * These types intentionally decouple UI concerns from the server-side adapter
 * contracts so the chat screen can talk about "agents" and "sessions" without
 * leaking runtime internals.
 */

export type AgentRuntime =
  | 'hermes'
  | 'claude-code'
  | 'codex'
  | 'deepseek-harness'
  | 'opencode'

export type AgentStatus =
  | 'online'
  | 'offline'
  | 'busy'
  | 'blocked'
  | 'idle'
  | 'unknown'

export interface Agent {
  agentId: string
  name: string
  runtime: AgentRuntime
  status: AgentStatus
  execution: 'local' | 'ssh' | 'unknown'
  currentTaskId?: string
  currentMissionId?: string
  /** Display-only config; secrets are stored server-side only. */
  runtimeConfig: {
    profile?: string
    command?: string
    args?: Array<string>
    capabilities: Array<string>
    maxConcurrentTasks?: number
  }
}

export type AgentSessionState =
  | 'idle'
  | 'running'
  | 'completed'
  | 'error'
  | 'paused'

export interface AgentSession {
  sessionId: string
  agentId: string
  title: string
  state: AgentSessionState
  lastMessageAt: string
  summary?: string
}

export interface AgentWithStatus extends Agent {
  probe: {
    available: boolean
    version?: string
    detail?: string
  }
  statusSnapshot?: {
    state: AgentStatus
    currentTask?: string | null
    taskId?: string | null
    missionId?: string | null
    needsHuman?: boolean
    checkpointStatus?: string
    lastSummary?: string | null
    updatedAt: number | string
  }
}
