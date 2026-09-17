import {
  createAgentSessionEngine,
  selectEngineActiveTurn,
  selectEngineInteractionsForSession,
  selectSessionMessages,
  type AgentSessionEngine,
  type AgentSessionEngineState,
  type EngineTypedCommandPort,
} from '../../../../packages/agent-activity-core/src/index'
import {
  mapManagedAgentActivitySnapshot,
  type ManagedAgentActivityDetail,
} from './managed-agent-activity-mapper'
import type { ChatMessage } from '../types'

export function createManagedAgentEngine(input: {
  workspaceId: string
  agentId?: string
  commandPort: EngineTypedCommandPort
}): AgentSessionEngine {
  return createAgentSessionEngine({
    identity: {
      workspaceId: input.workspaceId,
      origin: 'AGORAX_MANAGED_CHAT',
    },
    commandPort: input.commandPort,
    clock: { nowUnixMs: () => Date.now() },
    scheduler: {
      schedule(delayMs, task) {
        const timer = window.setTimeout(task, delayMs)
        return { cancel: () => window.clearTimeout(timer) }
      },
    },
  })
}

export function createManagedAgentCommandPort(
  agentId: string,
  onActivity: (detail: ManagedAgentActivityDetail) => void,
  options?: {
    displaySessionId?: () => string
    onRunStarted?: (runId: string, detail: ManagedAgentActivityDetail) => void
  },
): EngineTypedCommandPort {
  const request = async (path: string, body?: unknown): Promise<unknown> => {
    const response = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    if (!response.ok) throw new Error(`Managed Agent request failed: ${response.status}`)
    return response.json()
  }
  const unavailable = async (): Promise<never> => { throw new Error('Unsupported Managed Agent command') }
  return {
    kind: 'typed',
    effects: {
      activateSession: async (input) => {
        const response = await request(
          `/api/agents/${encodeURIComponent(agentId)}/engine/activate`,
          {
            displaySessionId: options?.displaySessionId?.() ?? input.agentSessionId,
            agentSessionId: input.agentSessionId,
            message: input.initialDisplayPrompt ?? '',
            promptContent: input.initialContent,
            ...(input.settings?.model ? { model: input.settings.model } : {}),
          },
        ) as { activity?: unknown; runId?: string }
        const detail = mapManagedAgentActivitySnapshot(response.activity)
        if (!detail) throw new Error('Managed Agent activation returned an invalid snapshot')
        onActivity(detail)
        if (response.runId) options?.onRunStarted?.(response.runId, detail)
        return {
          activation: { mode: 'new' as const, status: 'attached' as const },
          session: detail.session,
        }
      },
      deleteSessions: unavailable,
      renameSession: unavailable,
      setSessionPinned: unavailable,
      updateSessionSettings: unavailable,
      sendInput: async (input) => {
        const response = await request(
          `/api/agents/${encodeURIComponent(agentId)}/engine/session/${encodeURIComponent(input.agentSessionId)}/input`,
          {
            clientSubmitId: input.clientSubmitId,
            content: input.displayPrompt ?? '',
            promptContent: input.content,
          },
        ) as { result?: unknown; activity?: unknown }
        const detail = mapManagedAgentActivitySnapshot(response.activity)
        if (!detail) throw new Error('Managed Agent send returned an invalid snapshot')
        onActivity(detail)
        const turn = detail.turns.find((candidate) => candidate.turnId === detail.session.activeTurnId)
          ?? detail.session.latestTurn
        if (!turn) throw new Error('Managed Agent send returned no canonical turn')
        return { kind: 'turn', session: detail.session, turnId: turn.turnId, turn }
      },
      cancelTurn: async (input) => {
        const response = await request(
          `/api/agents/${encodeURIComponent(agentId)}/engine/session/${encodeURIComponent(input.agentSessionId)}/turns/${encodeURIComponent(input.turnId)}/cancel`,
        ) as { result?: unknown; activity?: unknown }
        const detail = mapManagedAgentActivitySnapshot(response.activity)
        if (!detail) throw new Error('Managed Agent cancel returned an invalid snapshot')
        onActivity(detail)
        const turn = detail.turns.find((candidate) => candidate.turnId === input.turnId) ?? null
        return {
          cancel: turn?.phase === 'settled' && turn.outcome === 'canceled'
            ? { canceled: true, reason: 'turn_canceled' }
            : { canceled: false, reason: turn?.phase === 'settled' ? 'already_settled' : 'cancel_requested' },
          turn,
        }
      },
      respondToInteraction: async (input) => {
        const response = await request(
          `/api/agents/${encodeURIComponent(agentId)}/interactions/${encodeURIComponent(input.agentSessionId)}/${encodeURIComponent(input.turnId)}/${encodeURIComponent(input.requestId)}`,
          { ...(input.action ? { action: input.action } : {}), ...(input.optionId ? { optionId: input.optionId } : {}), ...(input.payload ? { payload: input.payload } : {}) },
        ) as { activity?: unknown }
        const detail = mapManagedAgentActivitySnapshot(response.activity)
        if (!detail) throw new Error('Managed Agent interaction returned an invalid snapshot')
        onActivity(detail)
        return { session: detail.session }
      },
    },
    execute: unavailable,
  }
}

export function managedAgentTargetId(agentId: string): string {
  switch (agentId) {
    case 'codex-impl':
    case 'codex':
      return 'local:codex'
    case 'cursor':
      return 'local:cursor'
    case 'opencode':
      return 'local:opencode'
    case 'kimi':
      return 'extension:kimi-code'
    default:
      return 'local:claude-code'
  }
}

export function hydrateManagedAgentEngine(
  engine: AgentSessionEngine,
  detail: ManagedAgentActivityDetail,
): void {
  engine.dispatch({
    type: 'session/detailSnapshotReceived',
    workspaceId: detail.workspaceId,
    session: detail.session,
    childSessions: [],
    turns: detail.turns,
    messages: detail.messages,
    observedAtUnixMs: detail.session.updatedAtUnixMs,
  })
  for (const interaction of detail.interactions) {
    engine.dispatch({ type: 'interaction/upserted', interaction })
  }
}

export function subscribeManagedAgentEngine(
  engine: AgentSessionEngine,
  listener: () => void,
): () => void {
  return engine.subscribe(() => listener())
}

export function selectManagedAgentChatState(
  state: AgentSessionEngineState,
  agentSessionId: string | null,
) {
  const messages = agentSessionId
    ? selectSessionMessages(state, agentSessionId).map(toChatMessage)
    : []
  const activeTurn = selectEngineActiveTurn(state, agentSessionId)
  return {
    messages,
    activeTurn,
    isStreaming: activeTurn !== null && activeTurn.phase !== 'settled',
    interactions: selectEngineInteractionsForSession(state, agentSessionId),
    activeToolCalls: agentSessionId
      ? selectSessionMessages(state, agentSessionId)
          .filter((message) => message.kind === 'tool' && message.status !== 'completed')
          .map((message) => ({
            id: message.messageId,
            name: typeof message.payload.name === 'string' ? message.payload.name : 'Tool',
            phase: message.status ?? 'running',
            args: message.payload.arguments,
          }))
      : [],
  }
}

function toChatMessage(message: {
  role: string
  kind: string
  payload: Record<string, unknown>
  occurredAtUnixMs: number
  status?: string | null
}): ChatMessage {
  const text = typeof message.payload.text === 'string' ? message.payload.text : ''
  if (message.kind === 'tool') {
    return {
      role: message.role,
      content: [{
        type: 'toolCall',
        name: typeof message.payload.name === 'string' ? message.payload.name : 'Tool',
        arguments: record(message.payload.arguments),
      }],
      timestamp: message.occurredAtUnixMs,
    }
  }
  return {
    role: message.role,
    content: [{ type: 'text', text }],
    timestamp: message.occurredAtUnixMs,
    ...(message.status === 'failed' ? { isError: true } : {}),
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}