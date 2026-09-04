/**
 * Execute a single group-chat member turn.
 *
 * - Maintains canonical session via agent-session-manager (per-profile gateway).
 * - Submits the prompt via SSE stream and collects the reply from
 *   `assistant.delta` / `assistant.completed` events — NOT from getMessages,
 *   because the gateway's /chat/stream endpoint does NOT persist assistant
 *   messages to the DB that getMessages reads.
 * - Detects pass vs reply vs failure vs timeout.
 * - Self-heals once when a poisoned session (persisted model) yields
 *   "No LLM provider configured" by retiring it and retrying on a bare session.
 */
import { getClaudeApiClient } from '../claude-api-profile'
import { ensureProfileGateway } from '../gateway-pool'
import { GROUP_TURN_TIMEOUT_MS } from './constants'
import {
  forgetSession,
  getOrCreateSession,
} from './agent-session-manager'
import { isGroupPassText } from './responder-utils'
import type { GroupMember, GroupTurnResult } from './types'

export type TurnExecutorOptions = {
  roomId: string
  roomTitle: string
  member: GroupMember
  prompt: string
  model?: string
  dbPath?: string
  onEvent?: (event: string, data: Record<string, unknown>) => void
}

const PROVIDER_CONFIG_RE = /No LLM provider configured/i

class StreamTimeoutError extends Error {
  constructor() {
    super('stream timeout')
  }
}

type StreamCapture = {
  replyText: string
  streamError: string | null
}

async function streamOnce(
  opts: TurnExecutorOptions,
  sessionId: string,
  profile: string | null,
): Promise<StreamCapture> {
  const client =
    opts.member.runtime === 'hermes' && profile
      ? getClaudeApiClient(profile)
      : undefined

  let replyAccum = ''
  let completedText: string | null = null
  let streamError: string | null = null
  const startedAt = Date.now()

  const handleStreamEvent = (event: string, data: Record<string, unknown>) => {
    opts.onEvent?.(event, data)

    if (event === 'assistant.delta' && typeof data.delta === 'string') {
      replyAccum += data.delta
    }
    if (event === 'assistant.completed' && typeof data.content === 'string') {
      completedText = data.content
    }
    if (event === 'error') {
      const msg =
        typeof data.message === 'string'
          ? data.message
          : typeof data.error === 'string'
            ? data.error
            : 'stream error'
      streamError = msg
      console.warn(
        `[turn-executor] member=${opts.member.displayName} sse error: ${msg}`,
      )
    }
  }

  // IMPORTANT: do NOT pin profile default model/provider onto /chat/stream.
  // A request model override forces route_source=raw_request and fails with
  // "No LLM provider configured". Omitting both uses config.yaml via global.
  const effectiveModel = opts.model
  console.log(
    `[turn-executor] member=${opts.member.displayName} profile=${profile ?? 'n/a'} url=${client?.baseUrl ?? 'global'} model=${effectiveModel ?? '(profile default)'} starting stream...`,
  )

  try {
    await Promise.race([
      client
        ? client.streamChat(
            sessionId,
            {
              message: opts.prompt,
              ...(effectiveModel ? { model: effectiveModel } : {}),
            },
            {
              onEvent: (payload) => handleStreamEvent(payload.event, payload.data),
            },
          )
        : import('../claude-api').then((m) =>
            m.streamChat(
              sessionId,
              {
                message: opts.prompt,
                ...(effectiveModel ? { model: effectiveModel } : {}),
              },
              {
                onEvent: (payload) =>
                  handleStreamEvent(payload.event, payload.data),
              },
            ),
          ),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new StreamTimeoutError()), GROUP_TURN_TIMEOUT_MS)
      }),
    ])
    console.log(
      `[turn-executor] member=${opts.member.displayName} stream done in ${Date.now() - startedAt}ms`,
    )
  } catch (error) {
    if (error instanceof StreamTimeoutError) {
      console.log(`[turn-executor] member=${opts.member.displayName} stream TIMEOUT`)
      const partial = (completedText ?? replyAccum).trim()
      return { replyText: partial, streamError: streamError ?? 'stream timeout' }
    }
    throw error
  }

  return {
    replyText: (completedText ?? replyAccum).trim(),
    streamError,
  }
}

function toTurnResult(
  memberName: string,
  capture: StreamCapture,
  timedOut: boolean,
): GroupTurnResult {
  console.log(
    `[turn-executor] member=${memberName} replyText=${capture.replyText ? capture.replyText.slice(0, 80) : 'EMPTY'}`,
  )
  if (capture.replyText) {
    return isGroupPassText(capture.replyText)
      ? { kind: 'pass' }
      : { kind: 'reply', text: capture.replyText }
  }
  if (timedOut && !capture.streamError) {
    return { kind: 'timeout' }
  }
  return {
    kind: 'failed',
    reason:
      capture.streamError ?? 'empty reply (no assistant content in stream)',
  }
}

export async function executeMemberTurn(
  opts: TurnExecutorOptions,
): Promise<GroupTurnResult> {
  let { sessionId, profile } = await getOrCreateSession(opts.roomId, opts.member, {
    dbPath: opts.dbPath,
    // Do NOT override title here — let agent-session-manager use its own
    // deterministic groupSessionTitle(roomId, participantId) so each member
    // gets a unique session and they never conflict.
  })

  if (profile) {
    await ensureProfileGateway(profile).catch((error) => {
      console.warn(
        `[turn-executor] could not ensure gateway for ${profile}:`,
        error instanceof Error ? error.message : String(error),
      )
    })
  }

  console.log(
    `[turn-executor] member=${opts.member.displayName} profile=${profile ?? 'n/a'} session=${sessionId}`,
  )

  try {
    let capture = await streamOnce(opts, sessionId, profile)

    // Poisoned sessions (persisted model, often has_model_config=false) fail
    // instantly with this error. Retire and retry once on a bare session.
    if (
      !capture.replyText &&
      capture.streamError &&
      PROVIDER_CONFIG_RE.test(capture.streamError)
    ) {
      console.warn(
        `[turn-executor] member=${opts.member.displayName} retiring poisoned session ${sessionId} and retrying once`,
      )
      const client =
        opts.member.runtime === 'hermes' && profile
          ? getClaudeApiClient(profile)
          : undefined
      forgetSession(opts.roomId, opts.member.participantId)
      await client?.deleteSession(sessionId).catch(() => undefined)

      const fresh = await getOrCreateSession(opts.roomId, opts.member, {
        dbPath: opts.dbPath,
      })
      sessionId = fresh.sessionId
      profile = fresh.profile
      console.log(
        `[turn-executor] member=${opts.member.displayName} retry session=${sessionId}`,
      )
      capture = await streamOnce(opts, sessionId, profile)
    }

    const timedOut =
      !capture.replyText && capture.streamError === 'stream timeout'
    return toTurnResult(opts.member.displayName, capture, timedOut)
  } catch (error) {
    console.error(
      `[turn-executor] member=${opts.member.displayName} stream error:`,
      error,
    )
    return {
      kind: 'failed',
      reason:
        'submit failed: ' +
        (error instanceof Error ? error.message : String(error)),
    }
  }
}
