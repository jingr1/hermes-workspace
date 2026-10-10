/**
 * Hermes runtime adapter → unified Agent Activity events.
 *
 * Layering (see docs/chat-turn-identity-contract.md):
 *   Runtime (Hermes SSE) → this adapter → AgentSessionEngine contract
 *   Runtime (managed CLI) → daemon → same contract
 *
 * Pure translation only — no store, no UI, no fetch.
 */

import type { AgentActivityUpdatedEvent } from '@agorax/agent-activity-core'
import { assistantMessageIdForRun } from './chat-turn-identity'

export type HermesSseEventName =
  | 'started'
  | 'chunk'
  | 'assistant'
  | 'thinking'
  | 'tool'
  | 'done'
  | 'error'
  | string

export type HermesActivityAdapterContext = {
  workspaceId: string
  /** Engine / Agorax session id (not necessarily gateway session key). */
  agentSessionId: string
  /** Engine turn id for this send. */
  turnId: string
  /** Gateway / send-stream run id once known. */
  runId: string | null
  nowUnixMs?: () => number
}

export type HermesActivityAdapterState = {
  runId: string | null
  assistantMessageId: string | null
  thinkingMessageId: string | null
  /** Last full text seen (Hermes chunk is often fullReplace cumulative). */
  lastText: string
  lastThinking: string
}

export function createHermesActivityAdapterState(): HermesActivityAdapterState {
  return {
    runId: null,
    assistantMessageId: null,
    thinkingMessageId: null,
    lastText: '',
    lastThinking: '',
  }
}

function nowMs(ctx: HermesActivityAdapterContext): number {
  return ctx.nowUnixMs?.() ?? Date.now()
}

function ensureIds(
  ctx: HermesActivityAdapterContext,
  state: HermesActivityAdapterState,
  runId: string | null,
): HermesActivityAdapterState {
  const resolvedRun = (runId ?? state.runId ?? '').trim() || null
  const assistantMessageId =
    state.assistantMessageId ??
    (resolvedRun
      ? assistantMessageIdForRun(resolvedRun, ctx.agentSessionId)
      : assistantMessageIdForRun(null, `${ctx.agentSessionId}:${ctx.turnId}`))
  const thinkingMessageId =
    state.thinkingMessageId ?? `${assistantMessageId}:thinking`
  return {
    ...state,
    runId: resolvedRun ?? state.runId,
    assistantMessageId,
    thinkingMessageId,
  }
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/**
 * Translate one Hermes send-stream SSE frame into zero or more unified
 * activity events. Mutates adapter state for cumulative text/thinking.
 */
export function hermesSseToActivityEvents(
  ctx: HermesActivityAdapterContext,
  state: HermesActivityAdapterState,
  event: HermesSseEventName,
  data: Record<string, unknown>,
): {
  state: HermesActivityAdapterState
  events: Array<AgentActivityUpdatedEvent>
} {
  const occurredAtUnixMs = nowMs(ctx)
  const payloadRunId =
    readString(data.runId).trim() || readString(data.run_id).trim() || null
  let next = ensureIds(ctx, state, payloadRunId)
  const events: Array<AgentActivityUpdatedEvent> = []

  const base = {
    workspaceId: ctx.workspaceId,
    agentSessionId: ctx.agentSessionId,
  }

  const turnUpdate = (
    phase: 'running' | 'settled',
    outcome: 'completed' | 'failed' | 'canceled' | null,
    errorMessage?: string,
  ): AgentActivityUpdatedEvent => {
    const ts = occurredAtUnixMs
    return {
      ...base,
      eventType: 'turn_update',
      data: {
        ...base,
        eventType: 'turn_update',
        occurredAtUnixMs: ts,
        activeTurnId: phase === 'settled' ? null : ctx.turnId,
        turn: {
          turnId: ctx.turnId,
          agentSessionId: ctx.agentSessionId,
          phase,
          origin: 'user_prompt',
          outcome,
          error: errorMessage ? { message: errorMessage } : null,
          fileChanges: null,
          completedCommand: null,
          startedAtUnixMs: ts,
          settledAtUnixMs: phase === 'settled' ? ts : null,
          updatedAtUnixMs: ts,
        },
      },
    } as AgentActivityUpdatedEvent
  }

  switch (event) {
    case 'started': {
      next = ensureIds(ctx, next, payloadRunId)
      events.push(turnUpdate('running', null))
      break
    }

    case 'chunk':
    case 'assistant': {
      next = ensureIds(ctx, next, payloadRunId)
      const fullReplace = data.fullReplace === true
      const incoming =
        readString(data.text) ||
        readString(data.delta) ||
        readString(data.content) ||
        readString(data.chunk)
      if (!incoming && event === 'chunk') break

      let appendText = incoming
      if (fullReplace || event === 'assistant') {
        if (incoming.startsWith(next.lastText)) {
          appendText = incoming.slice(next.lastText.length)
        } else if (incoming === next.lastText) {
          appendText = ''
        } else {
          // Non-prefix replace: emit set via append of full text after reset.
          appendText = incoming
          next = { ...next, lastText: '' }
        }
        next = { ...next, lastText: incoming }
      } else {
        next = { ...next, lastText: next.lastText + incoming }
      }

      if (!appendText || !next.assistantMessageId) break

      events.push({
        ...base,
        eventType: 'message_delta',
        data: {
          ...base,
          messageId: next.assistantMessageId,
          turnId: ctx.turnId,
          role: 'assistant',
          kind: 'text',
          occurredAtUnixMs,
          content: { operation: 'append_text', text: appendText },
          status: 'streaming',
        },
      })
      break
    }

    case 'thinking': {
      next = ensureIds(ctx, next, payloadRunId)
      const thinking =
        readString(data.text) || readString(data.thinking)
      if (!thinking.trim() || !next.thinkingMessageId) break

      const prev = next.lastThinking
      let appendText = thinking
      if (thinking.startsWith(prev)) {
        appendText = thinking.slice(prev.length)
      } else if (thinking === prev) {
        appendText = ''
      }
      next = { ...next, lastThinking: thinking }
      if (!appendText) break

      events.push({
        ...base,
        eventType: 'message_delta',
        data: {
          ...base,
          messageId: next.thinkingMessageId,
          turnId: ctx.turnId,
          role: 'assistant_thinking',
          kind: 'reasoning',
          occurredAtUnixMs,
          content: { operation: 'append_text', text: appendText },
          status: 'streaming',
        },
      })
      break
    }

    case 'tool': {
      next = ensureIds(ctx, next, payloadRunId)
      const name = readString(data.name).trim() || 'tool'
      const toolCallId =
        readString(data.toolCallId).trim() ||
        readString(data.tool_call_id).trim() ||
        `${next.runId || ctx.turnId}:${name}`
      const phase = readString(data.phase).trim() || 'calling'
      const terminal =
        phase === 'complete' ||
        phase === 'completed' ||
        phase === 'done' ||
        phase === 'result' ||
        phase === 'error'
      const status =
        phase === 'error' ? 'failed' : terminal ? 'completed' : 'running'

      events.push({
        ...base,
        eventType: 'message_delta',
        data: {
          ...base,
          messageId: `toolcall:${toolCallId}`,
          turnId: ctx.turnId,
          role: 'assistant',
          kind: 'tool_call',
          occurredAtUnixMs,
          status,
          payloadSet: {
            name,
            toolName: name,
            phase,
            input: data.args ?? undefined,
            output: typeof data.result === 'string' ? data.result : undefined,
            preview:
              typeof data.preview === 'string' ? data.preview : undefined,
          },
          ...(typeof data.result === 'string'
            ? {
                toolOutput: {
                  operation: 'set' as const,
                  text: data.result,
                },
              }
            : {}),
        },
      })
      break
    }

    case 'done': {
      next = ensureIds(ctx, next, payloadRunId)
      const stateName = readString(data.state).trim() || 'complete'
      const failed =
        stateName === 'error' ||
        stateName === 'failed' ||
        typeof data.errorMessage === 'string'
      events.push(
        turnUpdate(
          'settled',
          failed ? 'failed' : 'completed',
          failed && typeof data.errorMessage === 'string'
            ? data.errorMessage
            : undefined,
        ),
      )
      break
    }

    case 'error': {
      next = ensureIds(ctx, next, payloadRunId)
      const message =
        readString(data.message) ||
        readString(data.errorMessage) ||
        'Hermes stream error'
      events.push(turnUpdate('settled', 'failed', message))
      break
    }

    default:
      break
  }

  return { state: next, events }
}
