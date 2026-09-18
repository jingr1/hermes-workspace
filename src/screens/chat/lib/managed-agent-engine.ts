import {
  createAgentSessionEngine,
  selectEngineActiveTurn,
  selectEngineLatestTurn,
  selectEngineInteractionsForSession,
  selectSessionMessages,
  type AgentActivitySendInputResult,
  type AgentActivitySessionDetailSnapshot,
  type AgentActivitySubmitInteractiveResult,
  type AgentActivityTurnCancelResponse,
  type AgentSessionActivateEffectResult,
  type AgentSessionEngine,
  type AgentSessionEngineState,
  type EngineEffectOptions,
  type EngineExtensionCommand,
  type EngineTypedCommandPort,
} from '@agorax/agent-activity-core'
import {
  mapManagedAgentActivitySnapshot,
  type ManagedAgentActivityDetail,
} from './managed-agent-activity-mapper'
import {
  managedAgentActivateResponseFromJson,
  managedAgentCancelResponseFromJson,
  managedAgentDaemonCancelStateFromResult,
  managedAgentErrorMessageFromResponse,
  managedAgentInputResponseFromJson,
  managedAgentInteractionResponseFromJson,
} from '@/lib/managed-agent-runtime/command-dtos'
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
    /** Host-owned extension commands (session/reconcile, engine/reconcileWorkspace). */
    executeExtensionCommand?: (
      command: EngineExtensionCommand,
      options?: EngineEffectOptions,
    ) => Promise<unknown>
  },
): EngineTypedCommandPort {
  const request = async (path: string, body?: unknown): Promise<unknown> => {
    const response = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const payload: unknown = await response.json().catch(() => null)
    if (!response.ok) {
      throw new Error(
        managedAgentErrorMessageFromResponse(payload) ??
          `Managed Agent request failed: ${response.status}`,
      )
    }
    return payload
  }
  const unavailable = async (): Promise<never> => { throw new Error('Unsupported Managed Agent command') }
  return {
    kind: 'typed',
    effects: {
      activateSession: async (input): Promise<AgentSessionActivateEffectResult> => {
        if (input.mode !== 'new') {
          // The workspace activate route only creates sessions; attaching to an
          // existing session is a read-side hydrate (detail + reconcile).
          throw new Error('Managed Agent activation supports mode "new" only')
        }
        const response = managedAgentActivateResponseFromJson(
          await request(`/api/agents/${encodeURIComponent(agentId)}/engine/activate`, {
            displaySessionId: options?.displaySessionId?.() ?? input.agentSessionId,
            agentSessionId: input.agentSessionId,
            message: input.initialDisplayPrompt ?? '',
            promptContent: input.initialContent,
            ...(input.settings?.model ? { model: input.settings.model } : {}),
          }),
        )
        const detail = mapManagedAgentActivitySnapshot(response.activity)
        if (!detail) throw new Error('Managed Agent activation returned an invalid snapshot')
        onActivity(detail)
        options?.onRunStarted?.(response.runId, detail)
        return {
          activation: { mode: 'new', status: 'attached' },
          session: detail.session,
        }
      },
      deleteSessions: unavailable,
      renameSession: unavailable,
      setSessionPinned: unavailable,
      updateSessionSettings: unavailable,
      sendInput: async (input): Promise<AgentActivitySendInputResult> => {
        const response = managedAgentInputResponseFromJson(
          await request(`/api/agents/${encodeURIComponent(agentId)}/engine/session/${encodeURIComponent(input.agentSessionId)}/input`, {
            clientSubmitId: input.clientSubmitId,
            content: input.displayPrompt ?? '',
            promptContent: input.content,
          }),
        )
        const detail = mapManagedAgentActivitySnapshot(response.activity)
        if (!detail) throw new Error('Managed Agent send returned an invalid snapshot')
        onActivity(detail)
        const turn = detail.turns.find((candidate) => candidate.turnId === detail.session.activeTurnId)
          ?? detail.session.latestTurn
        if (!turn) throw new Error('Managed Agent send returned no canonical turn')
        return { kind: 'turn', session: detail.session, turnId: turn.turnId, turn }
      },
      cancelTurn: async (input): Promise<AgentActivityTurnCancelResponse> => {
        const response = managedAgentCancelResponseFromJson(
          await request(`/api/agents/${encodeURIComponent(agentId)}/engine/session/${encodeURIComponent(input.agentSessionId)}/turns/${encodeURIComponent(input.turnId)}/cancel`),
        )
        const detail = mapManagedAgentActivitySnapshot(response.activity)
        if (!detail) throw new Error('Managed Agent cancel returned an invalid snapshot')
        onActivity(detail)
        const turn = detail.turns.find((candidate) => candidate.turnId === input.turnId) ?? null
        const state = managedAgentDaemonCancelStateFromResult(response.result)
        if (state === 'not_found') {
          return { cancel: { canceled: false, reason: 'not_found' } }
        }
        if (state === 'settled') {
          // The provider already confirmed the canceled terminal; the snapshot
          // may lag, so project the canonical settlement explicitly.
          return {
            cancel: { canceled: true, reason: 'turn_canceled' },
            ...(turn ? { turn: { ...turn, phase: 'settled', outcome: 'canceled' as const } } : {}),
          }
        }
        if (state === 'already_settled') {
          return {
            cancel: { canceled: false, reason: 'already_settled' },
            ...(turn ? { turn } : {}),
          }
        }
        if (state === 'requested') {
          // Durable intent accepted; canonical settlement arrives via events /
          // reconcile, so the turn projects as settling, never as canceled.
          return {
            cancel: { canceled: false, reason: 'cancel_requested' },
            ...(turn ? { turn: { ...turn, phase: 'settling' as const, outcome: null } } : {}),
          }
        }
        // Daemon result carried no usable state: derive the response from the
        // snapshot, keeping the same canonical projections.
        if (!turn) return { cancel: { canceled: false, reason: 'not_found' } }
        if (turn.phase === 'settled') {
          return turn.outcome === 'canceled'
            ? { cancel: { canceled: true, reason: 'turn_canceled' }, turn }
            : { cancel: { canceled: false, reason: 'already_settled' }, turn }
        }
        return {
          cancel: { canceled: false, reason: 'cancel_requested' },
          turn: { ...turn, phase: 'settling' as const, outcome: null },
        }
      },
      respondToInteraction: async (input): Promise<AgentActivitySubmitInteractiveResult> => {
        const response = managedAgentInteractionResponseFromJson(
          await request(`/api/agents/${encodeURIComponent(agentId)}/interactions/${encodeURIComponent(input.agentSessionId)}/${encodeURIComponent(input.turnId)}/${encodeURIComponent(input.requestId)}`,
          { ...(input.action ? { action: input.action } : {}), ...(input.optionId ? { optionId: input.optionId } : {}), ...(input.payload ? { payload: input.payload } : {}) }),
        )
        const detail = mapManagedAgentActivitySnapshot(response.activity)
        if (!detail) throw new Error('Managed Agent interaction returned an invalid snapshot')
        onActivity(detail)
        return { session: detail.session }
      },
    },
    execute: options?.executeExtensionCommand
      ? (command, effectOptions) => options.executeExtensionCommand!(command, effectOptions)
      : unavailable,
  }
}

export {
  managedAgentTargetId,
} from '@/lib/managed-agent-runtime/agent-targets'

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

/**
 * Hydrates one projection-qualified core detail snapshot (the
 * `session/detail` route payload) without message history; the reconcile
 * executor owns message hydration via `afterVersion` pagination.
 */
export function hydrateManagedAgentSessionDetail(
  engine: AgentSessionEngine,
  detail: AgentActivitySessionDetailSnapshot,
): void {
  engine.dispatch({
    type: 'session/detailSnapshotReceived',
    workspaceId: detail.session.workspaceId,
    session: detail.session,
    childSessions: [...detail.childSessions],
    editRetry: detail.editRetry,
    turns: [...detail.turns],
    observedAtUnixMs: detail.session.updatedAtUnixMs,
  })
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
  const sessionMessages = agentSessionId
    ? selectSessionMessages(state, agentSessionId)
    : []
  const messages = sessionMessages.map(toChatMessage)
  const latestTurn = selectEngineLatestTurn(state, agentSessionId)
  const projectedActiveTurn = selectEngineActiveTurn(state, agentSessionId)
  const activeTurn = projectedActiveTurn &&
    latestTurn?.turnId === projectedActiveTurn.turnId &&
    latestTurn.phase === 'settled'
    ? null
    : projectedActiveTurn
  const terminalTurn = activeTurn ?? latestTurn
  const visibleError = sessionMessages.find((message) =>
    message.role === 'assistant' &&
    message.kind === 'text' &&
    message.payload.kind === 'agent_visible_error' &&
    visibleErrorText(message.payload).length > 0,
  )
  const providerNotice = sessionMessages.find((message) =>
    message.role === 'assistant' &&
    message.kind === 'text' &&
    message.payload.kind === 'agent_system_notice' &&
    systemNoticeText(message.payload).length > 0,
  )
  const terminalError = terminalTurn?.phase === 'settled' && terminalTurn.outcome === 'failed'
    ? terminalTurn.error?.message ?? null
    : null
  return {
    messages,
    activeTurn,
    isStreaming: activeTurn !== null && activeTurn.phase !== 'settled',
    error: terminalError ??
      (visibleError
        ? visibleErrorText(visibleError.payload)
        : providerNotice && terminalTurn?.phase === 'settled'
          ? systemNoticeText(providerNotice.payload)
        : null),
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
  const text = message.kind === 'text'
    ? visibleErrorText(message.payload)
    : typeof message.payload.text === 'string'
      ? message.payload.text
      : ''
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

function visibleErrorText(payload: Record<string, unknown>): string {
  if (payload.kind !== 'agent_visible_error') {
    return typeof payload.text === 'string' ? payload.text : ''
  }
  const origin = typeof payload.origin === 'string' ? payload.origin : ''
  const detail = typeof payload.detail === 'string' ? payload.detail.trim() : ''
  if (origin === 'provider' && detail) return detail
  for (const key of ['text', 'content', 'detail', 'errorMessage', 'error']) {
    const value = payload[key]
    if (typeof value === 'string' && value.trim()) return value
  }
  return ''
}

function systemNoticeText(payload: Record<string, unknown>): string {
  for (const key of ['detail', 'content', 'errorMessage', 'error', 'text']) {
    const value = payload[key]
    if (typeof value === 'string' && value.trim()) return value
  }
  return ''
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}