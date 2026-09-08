/**
 * Execute a single group-chat member turn.
 *
 * Bot Mode semantics (Desktop hermes-bots/group-turns.ts):
 * - Soft deadline (3 min) that EXTENDS while the stream is still producing
 *   events, capped by GROUP_TURN_HARD_CAP_MS (20 min).
 * - On true timeout: do NOT post partial early-ack text. Return `timeout`
 *   with the pre-submit message baseline so the runner can stranded-harvest
 *   the finished reply later. Leave the gateway stream running (no abort).
 * - On success: prefer pickGroupTurnReply over the session transcript so the
 *   newest substantive (non-pass) assistant message wins — not the first ack.
 * - Self-heals once when a poisoned session yields "No LLM provider configured".
 */
import { getClaudeApiClient } from '../claude-api-profile'
import {
  GROUP_TURN_HARD_CAP_MS,
  GROUP_TURN_POLL_MS,
  GROUP_TURN_TIMEOUT_MS,
} from './constants'
import { forgetSession, getOrCreateSession } from './agent-session-manager'
import { isGroupPassText, pickGroupTurnReply } from './responder-utils'
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

type StreamCapture = {
  replyText: string
  streamError: string | null
  /** True when the soft/hard deadline elapsed before streamChat resolved. */
  timedOut: boolean
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function extendDeadline(startedAt: number, deadline: number): number {
  return Math.min(
    startedAt + GROUP_TURN_HARD_CAP_MS,
    Math.max(deadline, Date.now() + GROUP_TURN_TIMEOUT_MS),
  )
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
  let deadline = startedAt + GROUP_TURN_TIMEOUT_MS

  const handleStreamEvent = (event: string, data: Record<string, unknown>) => {
    // Any activity means the turn is still visibly working — extend soft deadline.
    deadline = extendDeadline(startedAt, deadline)
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

  let streamSettled = false
  let streamRejected: unknown = null

  const streamPromise = (
    client
      ? client.streamChat(
          sessionId,
          {
            message: opts.prompt,
            ...(effectiveModel ? { model: effectiveModel } : {}),
          },
          {
            onEvent: (payload) =>
              handleStreamEvent(payload.event, payload.data),
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
        )
  )
    .then(() => {
      streamSettled = true
    })
    .catch((error) => {
      streamSettled = true
      streamRejected = error
    })

  // Soft-deadline loop: tick until stream settles or hard/soft deadline elapses.
  // On timeout we deliberately do NOT abort the fetch — the gateway turn keeps
  // running so stranded harvest can pick up the finished reply later.
  while (!streamSettled) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) {
      console.log(
        `[turn-executor] member=${opts.member.displayName} soft/hard deadline elapsed after ${Date.now() - startedAt}ms — stranding (stream left running)`,
      )
      // Detach: swallow late settle so it doesn't become an unhandled rejection.
      void streamPromise.catch(() => undefined)
      return {
        replyText: (completedText ?? replyAccum).trim(),
        streamError: streamError ?? 'stream timeout',
        timedOut: true,
      }
    }
    await Promise.race([
      streamPromise.then(() => undefined),
      sleep(Math.min(remaining, GROUP_TURN_POLL_MS)),
    ])
  }

  if (
    streamRejected &&
    !(
      streamRejected instanceof Error && /timeout/i.test(streamRejected.message)
    )
  ) {
    // Real stream failure (not our soft timeout).
    if (streamRejected instanceof Error) throw streamRejected
    throw new Error(String(streamRejected))
  }

  console.log(
    `[turn-executor] member=${opts.member.displayName} stream done in ${Date.now() - startedAt}ms`,
  )

  return {
    replyText: (completedText ?? replyAccum).trim(),
    streamError,
    timedOut: false,
  }
}

async function pickReplyFromSession(
  opts: TurnExecutorOptions,
  sessionId: string,
  profile: string | null,
  before: number,
  streamFallback: string,
): Promise<string> {
  try {
    const client =
      opts.member.runtime === 'hermes' && profile
        ? getClaudeApiClient(profile)
        : undefined
    const messages = client
      ? await client.getMessages(sessionId)
      : await import('../claude-api').then((m) => m.getMessages(sessionId))
    const picked = pickGroupTurnReply(
      messages.map((m) => ({ role: m.role, content: m.content })),
      before,
    )
    if (picked && !isGroupPassText(picked)) return picked
    if (picked) return picked
  } catch (error) {
    console.warn(
      `[turn-executor] member=${opts.member.displayName} session pick failed:`,
      error instanceof Error ? error.message : String(error),
    )
  }
  return streamFallback
}

async function toTurnResult(
  opts: TurnExecutorOptions,
  sessionId: string,
  profile: string | null,
  before: number,
  capture: StreamCapture,
): Promise<GroupTurnResult> {
  console.log(
    `[turn-executor] member=${opts.member.displayName} replyText=${capture.replyText ? capture.replyText.slice(0, 80) : 'EMPTY'} timedOut=${capture.timedOut}`,
  )

  // Bot Mode: timeout → null/pass + stranded marker. Never post partial ack.
  if (capture.timedOut) {
    return { kind: 'timeout', before, sessionId }
  }

  const replyText = await pickReplyFromSession(
    opts,
    sessionId,
    profile,
    before,
    capture.replyText,
  )

  if (replyText) {
    return isGroupPassText(replyText)
      ? { kind: 'pass' }
      : { kind: 'reply', text: replyText }
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
  // getOrCreateSession ensures the profile gateway before verifying/creating
  // the session — do not call ensureProfileGateway again here (avoids a second
  // health probe on every turn).
  let { sessionId, profile } = await getOrCreateSession(
    opts.roomId,
    opts.member,
    {
      dbPath: opts.dbPath,
      // Do NOT override title here — let agent-session-manager use its own
      // deterministic groupSessionTitle(roomId, participantId) so each member
      // gets a unique session and they never conflict.
    },
  )

  console.log(
    `[turn-executor] member=${opts.member.displayName} profile=${profile ?? 'n/a'} session=${sessionId}`,
  )

  try {
    // Baseline message count before submit — harvest/pick scan from here.
    let before = 0
    try {
      const client =
        opts.member.runtime === 'hermes' && profile
          ? getClaudeApiClient(profile)
          : undefined
      const pre = client
        ? await client.getMessages(sessionId)
        : await import('../claude-api').then((m) => m.getMessages(sessionId))
      before = pre.length
    } catch {
      before = 0
    }

    let capture = await streamOnce(opts, sessionId, profile)

    // Poisoned sessions (persisted model, often has_model_config=false) fail
    // instantly with this error. Retire and retry once on a bare session.
    if (
      !capture.replyText &&
      !capture.timedOut &&
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
      before = 0
      capture = await streamOnce(opts, sessionId, profile)
    }

    return await toTurnResult(opts, sessionId, profile, before, capture)
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
