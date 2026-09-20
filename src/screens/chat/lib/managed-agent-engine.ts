import {
  createAgentSessionEngine,
  selectEngineActiveTurn,
  selectEngineLatestTurn,
  selectEngineInteractionsForSession,
  selectEngineSession,
  selectSessionMessages,
  type AgentActivityMessage,
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
  const request = async (
    path: string,
    body?: unknown,
    method: 'POST' | 'PATCH' | 'DELETE' = 'POST',
  ): Promise<unknown> => {
    const response = await fetch(path, {
      method,
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
  const mapActivitySession = async (
    agentSessionId: string,
    activityPayload: unknown,
  ) => {
    const detail = mapManagedAgentActivitySnapshot(activityPayload)
    if (!detail) throw new Error('Managed Agent mutation returned an invalid snapshot')
    onActivity(detail)
    const session = detail.session
    if (session.agentSessionId !== agentSessionId && !session.agentSessionId) {
      throw new Error('Managed Agent mutation returned no session')
    }
    return { detail, session }
  }
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
            ...(input.settings?.reasoningEffort
              ? { reasoningEffort: input.settings.reasoningEffort }
              : {}),
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
      deleteSessions: async (input) => {
        const removedSessionIds: string[] = []
        for (const agentSessionId of input.agentSessionIds) {
          await request(
            `/api/agents/${encodeURIComponent(agentId)}/engine/session/${encodeURIComponent(agentSessionId)}`,
            undefined,
            'DELETE',
          )
          removedSessionIds.push(agentSessionId)
        }
        return {
          removedSessionIds,
          removedSessions: removedSessionIds.length,
          removedMessages: 0,
          cleanupFailedSessionIds: [],
        }
      },
      renameSession: async (input) => {
        const payload = await request(
          `/api/agents/${encodeURIComponent(agentId)}/engine/session/${encodeURIComponent(input.agentSessionId)}/title`,
          { title: input.title },
          'PATCH',
        )
        const activity =
          payload && typeof payload === 'object' && 'activity' in payload
            ? (payload as { activity: unknown }).activity
            : null
        const { session } = await mapActivitySession(input.agentSessionId, activity)
        return { session }
      },
      setSessionPinned: async (input) => {
        const payload = await request(
          `/api/agents/${encodeURIComponent(agentId)}/engine/session/${encodeURIComponent(input.agentSessionId)}/pin`,
          { pinned: input.pinned },
        )
        const activity =
          payload && typeof payload === 'object' && 'activity' in payload
            ? (payload as { activity: unknown }).activity
            : null
        const { session } = await mapActivitySession(input.agentSessionId, activity)
        return { session }
      },
      updateSessionSettings: async (input) => {
        await request(
          `/api/agents/${encodeURIComponent(agentId)}/engine/session/${encodeURIComponent(input.agentSessionId)}/settings`,
          {
            ...(input.settings.model ? { model: input.settings.model } : {}),
            ...(input.settings.reasoningEffort
              ? { reasoningEffort: input.settings.reasoningEffort }
              : {}),
          },
        )
        return {}
      },
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
    executePlanDecision: async (command) => {
      const payload = await request(
        `/api/agents/${encodeURIComponent(agentId)}/engine/session/${encodeURIComponent(command.agentSessionId)}/turns/${encodeURIComponent(command.turnId)}/plan-decisions/${encodeURIComponent(command.requestId)}`,
        {
          promptKind: command.promptKind,
          action: command.action,
          idempotencyKey: command.idempotencyKey,
        },
      )
      const operation =
        payload &&
        typeof payload === 'object' &&
        'result' in payload &&
        (payload as { result?: { operation?: Record<string, unknown> } }).result
          ?.operation
          ? (payload as { result: { operation: Record<string, unknown> } }).result
              .operation
          : payload &&
              typeof payload === 'object' &&
              'result' in payload &&
              (payload as { result?: Record<string, unknown> }).result
            ? (payload as { result: Record<string, unknown> }).result
            : null
      if (!operation || typeof operation !== 'object') {
        throw new Error('Managed Agent plan decision returned no operation')
      }
      const activity =
        payload && typeof payload === 'object' && 'activity' in payload
          ? (payload as { activity: unknown }).activity
          : null
      if (activity) {
        const detail = mapManagedAgentActivitySnapshot(activity)
        if (detail) onActivity(detail)
      }
      const statusRaw = String(
        (operation as { Status?: unknown; status?: unknown }).Status ??
          (operation as { status?: unknown }).status ??
          'completed',
      ).toLowerCase()
      const status =
        statusRaw === 'prepared' ||
        statusRaw === 'leased' ||
        statusRaw === 'completed' ||
        statusRaw === 'failed'
          ? statusRaw
          : 'completed'
      return {
        operation: {
          agentSessionId: command.agentSessionId,
          idempotencyKey: command.idempotencyKey,
          operationId: String(
            (operation as { OperationID?: unknown; operationId?: unknown })
              .OperationID ??
              (operation as { operationId?: unknown }).operationId ??
              command.commandId,
          ),
          requestId: command.requestId,
          status,
          turnId: command.turnId,
          workspaceId: command.workspaceId,
          result:
            typeof (operation as { Result?: unknown }).Result === 'string'
              ? ((operation as { Result: string }).Result as string)
              : typeof (operation as { result?: unknown }).result === 'string'
                ? ((operation as { result: string }).result as string)
                : null,
          error:
            typeof (operation as { LastError?: unknown }).LastError === 'string'
              ? ((operation as { LastError: string }).LastError as string)
              : typeof (operation as { error?: unknown }).error === 'string'
                ? ((operation as { error: string }).error as string)
                : null,
        },
      }
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
  options?: {
    /**
     * Optimistic / live overlay messages from
     * `coordinator.project(projectSnapshot(engineState))`. Engine selectors
     * still own turns/interactions; only the message lane is overridable.
     */
    sessionMessages?: readonly AgentActivityMessage[]
  },
) {
  const sessionMessages =
    options?.sessionMessages ??
    (agentSessionId ? selectSessionMessages(state, agentSessionId) : [])
  const messages = sessionMessages.map((message) =>
    toChatMessage({
      messageId: message.messageId,
      role: message.role,
      kind: message.kind,
      payload: message.payload,
      occurredAtUnixMs: message.occurredAtUnixMs,
      status: message.status,
      semantics: message.semantics ?? null,
    }),
  )
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
    latestTurn,
    fileChanges: latestTurn?.fileChanges ?? null,
    usage: agentSessionId
      ? selectEngineSession(state, agentSessionId)?.usage ?? null
      : null,
    sessionTitle: agentSessionId
      ? selectEngineSession(state, agentSessionId)?.title?.trim() || null
      : null,
    isStreaming: activeTurn !== null && activeTurn.phase !== 'settled',
    error: terminalError ??
      (visibleError
        ? visibleErrorText(visibleError.payload)
        : providerNotice && terminalTurn?.phase === 'settled'
          ? systemNoticeText(providerNotice.payload)
        : null),
    interactions: selectEngineInteractionsForSession(state, agentSessionId),
    activeToolCalls: agentSessionId
      ? sessionMessages
          .filter((message) =>
            isToolCallKind(message.kind) &&
            !isTerminalToolStatus(message.status)
          )
          .map((message) => ({
            id: message.messageId,
            name: toolNameFromPayload(message.payload),
            phase: message.status ?? 'running',
            args: record(message.payload.input ?? message.payload.arguments),
          }))
      : [],
  }
}

function toChatMessage(message: {
  messageId: string
  role: string
  kind: string
  payload: Record<string, unknown>
  occurredAtUnixMs: number
  status?: string | null
  semantics?: {
    noticeCommand?: string
    noticeCommandStatus?: string
  } | null
}): ChatMessage {
  const notice = noticeCommandSystemLine(message.semantics)
  if (notice) {
    return {
      role: 'system',
      content: [{ type: 'text', text: notice }],
      timestamp: message.occurredAtUnixMs,
    }
  }
  if (isToolCallKind(message.kind)) {
    const error = firstNonEmptyString(
      message.payload.error,
      message.payload.errorMessage,
    )
    const rawOutput = message.payload.output
    return {
      role: message.role,
      content: [{
        type: 'toolCall',
        id: message.messageId,
        name: toolNameFromPayload(message.payload),
        arguments: record(message.payload.input ?? message.payload.arguments),
      }],
      timestamp: message.occurredAtUnixMs,
      // Legacy top-level contract consumed by the chat list's attached-tool
      // rendering (toolName/type resolution and readToolArgs(details)).
      toolName: toolNameFromPayload(message.payload),
      details: {
        input: record(message.payload.input ?? message.payload.arguments),
        ...(rawOutput != null ? { output: rawOutput } : {}),
        ...(error ? { error } : {}),
      },
      ...(message.status === 'failed' || error ? { isError: true } : {}),
    }
  }
  if (message.kind === 'reasoning') {
    return {
      role: message.role,
      content: [{ type: 'thinking', thinking: reasoningTextFromPayload(message.payload) }],
      timestamp: message.occurredAtUnixMs,
      ...(message.status === 'failed' ? { isError: true } : {}),
    }
  }
  const text = message.kind === 'text'
    ? visibleErrorText(message.payload)
    : typeof message.payload.text === 'string'
      ? message.payload.text
      : ''
  return {
    role: message.role,
    content: [{ type: 'text', text }],
    timestamp: message.occurredAtUnixMs,
    ...(message.status === 'failed' ? { isError: true } : {}),
  }
}

// Daemon canonical kinds: "tool_call" (payload toolName/input); "tool" with
// name/arguments is the legacy shim shape kept for replayed durable rows.
function isToolCallKind(kind: string): boolean {
  return kind === 'tool_call' || kind === 'tool'
}

function isTerminalToolStatus(status: string | null | undefined): boolean {
  return status === 'completed' || status === 'failed' ||
    status === 'canceled' || status === 'error'
}

function toolNameFromPayload(payload: Record<string, unknown>): string {
  const toolName = firstNonEmptyString(payload.toolName, payload.name)
  return toolName ?? 'Tool'
}

function reasoningTextFromPayload(payload: Record<string, unknown>): string {
  return firstNonEmptyString(
    payload.text,
    payload.content,
    payload.message,
    payload.body,
    payload.displayPrompt,
    payload.title,
  ) ?? ''
}

function firstNonEmptyString(...values: Array<unknown>): string | null {
  for (const value of values) {
    if (typeof value !== 'string') continue
    const trimmed = value.trim()
    if (trimmed) return trimmed
  }
  return null
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

function noticeCommandSystemLine(
  semantics:
    | {
        noticeCommand?: string
        noticeCommandStatus?: string
      }
    | null
    | undefined,
): string | null {
  const command = semantics?.noticeCommand?.trim()
  if (!command) return null
  const status = semantics?.noticeCommandStatus?.trim()
  const labels: Record<string, string> = {
    compact: 'Compacting context',
    review: 'Reviewing changes',
    undo: 'Undoing last action',
    goal: 'Updating goal',
  }
  const label = labels[command] ?? command
  if (!status || status === 'running' || status === 'started') {
    return `${label}…`
  }
  if (status === 'completed' || status === 'succeeded') {
    return `${label} complete`
  }
  if (status === 'failed' || status === 'error') {
    return `${label} failed`
  }
  return `${label} (${status})`
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}