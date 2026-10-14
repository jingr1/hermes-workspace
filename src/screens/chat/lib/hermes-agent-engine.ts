/**
 * Hermes 1:1 AgentSessionEngine host — Phase C/D.
 *
 * Send/Stop go through commandPort → /api/send-stream + /api/runs/:id/stop.
 * SSE frames → hermesSseToActivityEvents → coordinator.ingestEvent.
 * Busy / open-turn projection: selectHermesChatState (Engine + overlay).
 */

import {
  createAgentSessionEngine,
  normalizeAgentActivitySession,
  selectEngineActiveTurn,
  selectEngineLatestTurn,
  selectEngineSession,
  selectSessionMessages,
  type AgentActivityMessage,
  type AgentActivitySendInputResult,
  type AgentActivitySession,
  type AgentActivityTurn,
  type AgentActivityTurnCancelResponse,
  type AgentActivityUpdatedEvent,
  type AgentSessionActivateEffectResult,
  type AgentSessionEngine,
  type AgentSessionEngineState,
  type EngineTypedCommandPort,
} from '@agorax/agent-activity-core'
import {
  createHermesActivityAdapterState,
  hermesSseToActivityEvents,
  type HermesActivityAdapterState,
  type HermesSseEventName,
} from '@/lib/hermes-activity-adapter'
import { readResolvedSessionHeaders } from '@/lib/send-stream-session-headers'
import type { AgoraxRunMapping } from '@/server/agent-runtime/hermes-native-bridge'
import type { ChatMessage } from '../types'

export type HermesPendingSendOptions = {
  friendlyId?: string
  history?: Array<{ role: string; content: string }>
  thinking?: string
  fastMode?: boolean
  attachments?: unknown[]
  model?: string
}

export type HermesCommandPortOptions = {
  workspaceId: string
  profileName?: string | null
  /** Resolve mapping (memory cache + DB). */
  getMapping: (agentSessionId: string) => Promise<AgoraxRunMapping | null>
  /** Persist mapping after activate/send/cancel. */
  putMapping: (mapping: AgoraxRunMapping) => Promise<AgoraxRunMapping>
  /** Every translated activity event (coordinator.ingestEvent). */
  onActivityEvent: (event: AgentActivityUpdatedEvent) => void
  /** Extra send-stream fields stashed before submitPrompt. */
  takePendingSendOptions?: (
    clientSubmitId: string,
  ) => HermesPendingSendOptions | null
  /**
   * Optional legacy SSE side-channel for history/display write-through.
   * Must not be used as busy/settle authority.
   */
  onSseFrame?: (input: {
    agentSessionId: string
    event: HermesSseEventName
    data: Record<string, unknown>
  }) => void
  onSessionResolved?: (payload: {
    sessionKey: string
    friendlyId: string
  }) => void
  /** Notify UI waiters when sendInput finishes (success or throw). */
  onSendCompleted?: (clientSubmitId: string, error?: unknown) => void
  shouldPromoteResolvedSession?: (input: {
    requestedSessionKey: string
    resolvedSessionKey: string
  }) => boolean
}

function unavailable(name: string): () => Promise<never> {
  return async () => {
    throw new Error(`Unsupported Hermes command: ${name}`)
  }
}

function promptTextFromContent(
  content: ReadonlyArray<{ type?: string; text?: string }>,
): string {
  return content
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text!.trim())
    .filter(Boolean)
    .join('\n')
}

export function createHermesSessionSkeleton(input: {
  workspaceId: string
  agentSessionId: string
  title?: string
  providerSessionId?: string | null
  cwd?: string
  nowUnixMs?: number
}): AgentActivitySession {
  const now = input.nowUnixMs ?? Date.now()
  return normalizeAgentActivitySession({
    workspaceId: input.workspaceId,
    agentSessionId: input.agentSessionId,
    provider: 'hermes',
    providerSessionId: input.providerSessionId ?? input.agentSessionId,
    agentTargetId: 'hermes-native',
    cwd: input.cwd ?? '',
    title: input.title?.trim() || 'Chat',
    activeTurnId: null,
    latestTurnInteractions: [],
    pendingInteractions: [],
    createdAtUnixMs: now,
    updatedAtUnixMs: now,
    startedAtUnixMs: now,
    lastEventUnixMs: now,
  })
}

function makeTurn(input: {
  agentSessionId: string
  turnId: string
  phase: AgentActivityTurn['phase']
  outcome?: AgentActivityTurn['outcome']
  errorMessage?: string
  nowUnixMs: number
}): AgentActivityTurn {
  return {
    agentSessionId: input.agentSessionId,
    turnId: input.turnId,
    phase: input.phase,
    origin: 'user_prompt',
    outcome: input.outcome ?? null,
    error: input.errorMessage ? { message: input.errorMessage } : null,
    startedAtUnixMs: input.nowUnixMs,
    settledAtUnixMs: input.phase === 'settled' ? input.nowUnixMs : null,
    updatedAtUnixMs: input.nowUnixMs,
  }
}

async function parseSseStream(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal | undefined,
  onFrame: (event: string, data: Record<string, unknown>) => void | Promise<void>,
): Promise<void> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
      if (signal?.aborted) {
        try {
          await reader.cancel()
        } catch {
          // ignore
        }
        break
      }
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const events = buffer.split('\n\n')
      buffer = events.pop() ?? ''
      for (const eventBlock of events) {
        if (!eventBlock.trim()) continue
        const lines = eventBlock.split('\n')
        let currentEvent = ''
        let currentData = ''
        for (const line of lines) {
          if (line.startsWith('event: ')) {
            currentEvent = line.slice(7).trim()
          } else if (line.startsWith('data: ')) {
            currentData += line.slice(6)
          } else if (line.startsWith('data:')) {
            currentData += line.slice(5)
          }
        }
        if (!currentEvent || !currentData) continue
        try {
          const parsed = JSON.parse(currentData) as Record<string, unknown>
          await onFrame(currentEvent, parsed)
        } catch {
          // ignore malformed SSE
        }
      }
    }
  } finally {
    try {
      reader.releaseLock()
    } catch {
      // ignore
    }
  }
}

export function createHermesAgentEngine(input: {
  workspaceId: string
  commandPort: EngineTypedCommandPort
}): AgentSessionEngine {
  return createAgentSessionEngine({
    identity: {
      workspaceId: input.workspaceId,
      origin: 'AGORAX_HERMES_CHAT',
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

export function createHermesCommandPort(
  options: HermesCommandPortOptions,
): EngineTypedCommandPort {
  const profileName = options.profileName?.trim() || undefined

  const persistMapping = async (
    partial: Partial<AgoraxRunMapping> & { agentSessionId: string },
  ): Promise<AgoraxRunMapping> => {
    const existing = await options.getMapping(partial.agentSessionId)
    const mapping: AgoraxRunMapping = {
      agentSessionId: partial.agentSessionId,
      turnId: partial.turnId ?? existing?.turnId ?? null,
      gatewaySessionId:
        partial.gatewaySessionId ?? existing?.gatewaySessionId ?? null,
      assignmentId: null,
      hermesRunId: partial.hermesRunId ?? existing?.hermesRunId ?? null,
      bridgeKind: 'hermes-native',
      updatedAtUnixMs: Date.now(),
    }
    return options.putMapping(mapping)
  }

  return {
    kind: 'typed',
    effects: {
      activateSession: async (
        input,
      ): Promise<AgentSessionActivateEffectResult> => {
        if (input.mode !== 'new') {
          // Attach = hydrate existing gateway session; mapping must already exist
          // or we seed one keyed by agentSessionId === gatewaySessionId.
          const gatewaySessionId =
            (await options.getMapping(input.agentSessionId))
              ?.gatewaySessionId || input.agentSessionId
          const mapping = await persistMapping({
            agentSessionId: input.agentSessionId,
            gatewaySessionId,
            turnId: null,
            hermesRunId: null,
          })
          const session = createHermesSessionSkeleton({
            workspaceId: options.workspaceId,
            agentSessionId: input.agentSessionId,
            providerSessionId: mapping.gatewaySessionId,
            title: input.title,
          })
          return {
            activation: { mode: 'existing', status: 'already_attached' },
            detail: {
              projection: 'authoritative',
              lifecycleCapabilitiesProjected: false,
              session,
              childSessions: [],
              turns: [],
            },
            session,
          }
        }

        const res = await fetch('/api/sessions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            profileName,
            ...(input.title
              ? { title: input.title, friendlyId: input.title }
              : {}),
          }),
        })
        if (!res.ok) {
          throw new Error(
            (await res.text().catch(() => '')) ||
              `Hermes create session failed: ${res.status}`,
          )
        }
        const data = (await res.json()) as {
          sessionKey?: string
          friendlyId?: string
        }
        const gatewaySessionId =
          typeof data.sessionKey === 'string' ? data.sessionKey.trim() : ''
        if (!gatewaySessionId) {
          throw new Error('Hermes create session returned no sessionKey')
        }
        const agentSessionId = input.agentSessionId.trim() || gatewaySessionId
        await persistMapping({
          agentSessionId,
          gatewaySessionId,
          turnId: null,
          hermesRunId: null,
        })
        const friendlyId =
          typeof data.friendlyId === 'string' && data.friendlyId.trim()
            ? data.friendlyId.trim()
            : gatewaySessionId
        options.onSessionResolved?.({
          sessionKey: gatewaySessionId,
          friendlyId,
        })
        const session = createHermesSessionSkeleton({
          workspaceId: options.workspaceId,
          agentSessionId,
          providerSessionId: gatewaySessionId,
          title: input.title,
        })
        return {
          activation: { mode: 'new', status: 'attached' },
          session,
        }
      },

      sendInput: async (input): Promise<AgentActivitySendInputResult> => {
        const clientSubmitId = input.clientSubmitId.trim()
        try {
          const agentSessionId = input.agentSessionId.trim()
          const mapping = await options.getMapping(agentSessionId)
          const gatewaySessionId =
            mapping?.gatewaySessionId?.trim() || agentSessionId
          const turnId = `turn-${clientSubmitId || Date.now()}`
          const message =
            input.displayPrompt?.trim() ||
            promptTextFromContent(input.content) ||
            ''
          if (!message) {
            throw new Error('Hermes sendInput requires text content')
          }

          await persistMapping({
            agentSessionId,
            gatewaySessionId,
            turnId,
            hermesRunId: null,
          })

          let adapter: HermesActivityAdapterState =
            createHermesActivityAdapterState()
          let hermesRunId: string | null = null
          let settledOutcome: AgentActivityTurn['outcome'] = null
          let settledError: string | undefined
          const now = () => Date.now()

          const ingestFrame = async (
            event: HermesSseEventName,
            data: Record<string, unknown>,
          ) => {
            const payloadRun =
              (typeof data.runId === 'string' && data.runId.trim()) ||
              (typeof data.run_id === 'string' && data.run_id.trim()) ||
              null
            if (payloadRun) hermesRunId = payloadRun

            const ctx = {
              workspaceId: options.workspaceId,
              agentSessionId,
              turnId,
              runId: hermesRunId,
            }
            const { state: nextAdapter, events } = hermesSseToActivityEvents(
              ctx,
              adapter,
              event,
              data,
            )
            adapter = nextAdapter
            if (adapter.runId) hermesRunId = adapter.runId

            for (const activityEvent of events) {
              options.onActivityEvent(activityEvent)
              if (activityEvent.eventType === 'turn_update') {
                const turn = (
                  activityEvent.data as {
                    turn?: {
                      phase?: string
                      outcome?: string | null
                      error?: { message?: string } | null
                    }
                  }
                ).turn
                if (turn?.phase === 'settled') {
                  settledOutcome =
                    (turn.outcome as AgentActivityTurn['outcome']) ??
                    'completed'
                  settledError = turn.error?.message
                }
              }
            }
            options.onSseFrame?.({ agentSessionId, event, data })
          }

          const pending =
            options.takePendingSendOptions?.(clientSubmitId) ?? null
          const response = await fetch('/api/send-stream', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              sessionKey: gatewaySessionId,
              friendlyId: pending?.friendlyId,
              message,
              history: pending?.history,
              thinking: pending?.thinking,
              fastMode: pending?.fastMode,
              attachments: pending?.attachments,
              idempotencyKey: clientSubmitId,
              model: pending?.model || undefined,
              profileName,
              locale:
                typeof window !== 'undefined'
                  ? localStorage.getItem('hermes-workspace-locale') || 'en'
                  : 'en',
            }),
            signal: input.signal,
          })

          if (!response.ok) {
            const errorText = await response.text().catch(() => '')
            const errMsg =
              errorText || `Hermes send-stream failed: ${response.status}`
            const failEvent = hermesSseToActivityEvents(
              {
                workspaceId: options.workspaceId,
                agentSessionId,
                turnId,
                runId: null,
              },
              adapter,
              'error',
              { message: errMsg },
            )
            adapter = failEvent.state
            for (const activityEvent of failEvent.events) {
              options.onActivityEvent(activityEvent)
            }
            throw new Error(errMsg)
          }

          const resolvedHeaders = readResolvedSessionHeaders(response.headers, {
            sessionKey: gatewaySessionId,
            friendlyId: gatewaySessionId,
          })
          const shouldPromote =
            options.shouldPromoteResolvedSession?.({
              requestedSessionKey: gatewaySessionId,
              resolvedSessionKey: resolvedHeaders.sessionKey,
            }) ??
            (gatewaySessionId === 'new' || gatewaySessionId === 'main')
          if (
            resolvedHeaders.sessionKey &&
            resolvedHeaders.sessionKey !== gatewaySessionId &&
            shouldPromote
          ) {
            await persistMapping({
              agentSessionId,
              gatewaySessionId: resolvedHeaders.sessionKey,
              turnId,
            })
            options.onSessionResolved?.({
              sessionKey: resolvedHeaders.sessionKey,
              friendlyId: resolvedHeaders.friendlyId,
            })
          }

          if (!response.body) {
            throw new Error('Hermes send-stream returned no body')
          }

          await parseSseStream(response.body, input.signal, ingestFrame)

          if (hermesRunId) {
            await persistMapping({
              agentSessionId,
              gatewaySessionId:
                (await options.getMapping(agentSessionId))?.gatewaySessionId ??
                gatewaySessionId,
              turnId,
              hermesRunId,
            })
          }

          // Stream ended without a settle frame — force completed settle.
          if (!settledOutcome) {
            const { state: nextAdapter, events } = hermesSseToActivityEvents(
              {
                workspaceId: options.workspaceId,
                agentSessionId,
                turnId,
                runId: hermesRunId,
              },
              adapter,
              'done',
              { state: 'complete', runId: hermesRunId },
            )
            adapter = nextAdapter
            for (const activityEvent of events) {
              options.onActivityEvent(activityEvent)
            }
            settledOutcome = 'completed'
          }

          const ts = now()
          const turn = makeTurn({
            agentSessionId,
            turnId,
            phase: 'settled',
            outcome: settledOutcome,
            errorMessage: settledError,
            nowUnixMs: ts,
          })
          const session = createHermesSessionSkeleton({
            workspaceId: options.workspaceId,
            agentSessionId,
            providerSessionId:
              (await options.getMapping(agentSessionId))?.gatewaySessionId ??
              gatewaySessionId,
            nowUnixMs: ts,
          })
          options.onSendCompleted?.(clientSubmitId)
          return { kind: 'turn', session, turnId, turn }
        } catch (error) {
          options.onSendCompleted?.(clientSubmitId, error)
          throw error
        }
      },

      cancelTurn: async (input): Promise<AgentActivityTurnCancelResponse> => {
        const agentSessionId = input.agentSessionId.trim()
        const mapping = await options.getMapping(agentSessionId)
        const hermesRunId = mapping?.hermesRunId?.trim() || null
        const gatewaySessionId =
          mapping?.gatewaySessionId?.trim() || agentSessionId
        const turnId = input.turnId.trim() || mapping?.turnId || `turn-cancel-${Date.now()}`
        const ts = Date.now()

        if (hermesRunId) {
          await fetch(`/api/runs/${encodeURIComponent(hermesRunId)}/stop`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionKey: gatewaySessionId }),
            signal: input.signal,
          }).catch(() => {})
        } else if (gatewaySessionId) {
          await fetch(
            `/api/runs/${encodeURIComponent(`session:${gatewaySessionId}`)}/stop`,
            {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ sessionKey: gatewaySessionId }),
              signal: input.signal,
            },
          ).catch(() => {})
        }

        const { events } = hermesSseToActivityEvents(
          {
            workspaceId: options.workspaceId,
            agentSessionId,
            turnId,
            runId: hermesRunId,
          },
          createHermesActivityAdapterState(),
          'done',
          { state: 'interrupted', runId: hermesRunId },
        )
        // Force canceled outcome via explicit turn_update if adapter mapped interrupted differently
        const cancelEvent: AgentActivityUpdatedEvent = {
          workspaceId: options.workspaceId,
          agentSessionId,
          eventType: 'turn_update',
          data: {
            workspaceId: options.workspaceId,
            agentSessionId,
            eventType: 'turn_update',
            occurredAtUnixMs: ts,
            activeTurnId: null,
            turn: {
              turnId,
              agentSessionId,
              phase: 'settled',
              origin: 'user_prompt',
              outcome: 'canceled',
              error: null,
              fileChanges: null,
              completedCommand: null,
              startedAtUnixMs: ts,
              settledAtUnixMs: ts,
              updatedAtUnixMs: ts,
            },
          },
        } as AgentActivityUpdatedEvent
        for (const activityEvent of events) {
          options.onActivityEvent(activityEvent)
        }
        options.onActivityEvent(cancelEvent)

        await persistMapping({
          agentSessionId,
          gatewaySessionId,
          turnId,
          hermesRunId,
        })

        const turn = makeTurn({
          agentSessionId,
          turnId,
          phase: 'settled',
          outcome: 'canceled',
          nowUnixMs: ts,
        })
        return {
          cancel: { canceled: true, reason: 'turn_canceled' },
          turn,
        }
      },

      deleteSessions: unavailable('deleteSessions'),
      renameSession: unavailable('renameSession'),
      setSessionPinned: unavailable('setSessionPinned'),
      updateSessionSettings: unavailable('updateSessionSettings'),
      respondToInteraction: unavailable('respondToInteraction'),
    },
    execute: unavailable('execute'),
  }
}

export function hydrateHermesAgentEngine(
  engine: AgentSessionEngine,
  session: AgentActivitySession,
): void {
  engine.dispatch({
    type: 'session/detailSnapshotReceived',
    workspaceId: session.workspaceId,
    session,
    childSessions: [],
    turns: session.activeTurn
      ? [session.activeTurn]
      : session.latestTurn
        ? [session.latestTurn]
        : [],
    messages: [],
    observedAtUnixMs: session.updatedAtUnixMs,
  })
}

/**
 * Hermes chat VM — mirrors selectManagedAgentChatState for busy / open-turn.
 */
export function selectHermesChatState(
  state: AgentSessionEngineState,
  agentSessionId: string | null,
  options?: {
    sessionMessages?: readonly AgentActivityMessage[]
    isSubmitting?: boolean
  },
) {
  const sessionMessages =
    options?.sessionMessages ??
    (agentSessionId ? selectSessionMessages(state, agentSessionId) : [])
  const messages = sessionMessages.map((message) =>
    hermesActivityMessageToChat(message),
  )
  const latestTurn = selectEngineLatestTurn(state, agentSessionId)
  const projectedActiveTurn = selectEngineActiveTurn(state, agentSessionId)
  const activeTurn =
    projectedActiveTurn &&
    latestTurn?.turnId === projectedActiveTurn.turnId &&
    latestTurn.phase === 'settled'
      ? null
      : projectedActiveTurn
  const turnActive = activeTurn !== null && activeTurn.phase !== 'settled'
  const terminalTurn = activeTurn ?? latestTurn
  const terminalError =
    terminalTurn?.phase === 'settled' && terminalTurn.outcome === 'failed'
      ? terminalTurn.error?.message ?? null
      : null

  return {
    messages,
    activeTurn,
    latestTurn,
    sessionTitle: agentSessionId
      ? selectEngineSession(state, agentSessionId)?.title?.trim() || null
      : null,
    isStreaming: turnActive,
    /** Unique busy bit for TurnActivityHost / interactionBusy. */
    turnBusy: turnActive || options?.isSubmitting === true,
    streamingMessageId: turnActive
      ? selectHermesStreamingMessageId(sessionMessages, activeTurn.turnId)
      : null,
    error: terminalError,
  }
}

export function selectHermesStreamingMessageId(
  sessionMessages: readonly AgentActivityMessage[],
  activeTurnId: string,
): string | null {
  for (let index = sessionMessages.length - 1; index >= 0; index -= 1) {
    const message = sessionMessages[index]
    if (!message || message.turnId !== activeTurnId) continue
    if (message.role === 'assistant' || message.role === 'assistant_thinking') {
      return message.messageId
    }
  }
  return null
}

function hermesActivityMessageToChat(
  message: AgentActivityMessage,
): ChatMessage {
  if (message.kind === 'reasoning' || message.role === 'assistant_thinking') {
    const text =
      typeof message.payload.text === 'string' ? message.payload.text : ''
    return {
      id: message.messageId,
      role: 'assistant',
      content: text
        ? [{ type: 'thinking' as const, thinking: text }]
        : [],
      timestamp: message.occurredAtUnixMs,
    }
  }
  const text =
    typeof message.payload.text === 'string' ? message.payload.text : ''
  return {
    id: message.messageId,
    role: message.role === 'user' ? 'user' : 'assistant',
    content: [{ type: 'text', text }],
    timestamp: message.occurredAtUnixMs,
    ...(message.status === 'failed' ? { isError: true } : {}),
  }
}
