/**
 * Execute a single group-chat member turn.
 *
 * - Maintains canonical session via agent-session-manager.
 * - Submits the prompt via SSE stream and collects the reply from
 *   `assistant.delta` / `assistant.completed` events — NOT from getMessages,
 *   because the gateway's /chat/stream endpoint does NOT persist assistant
 *   messages to the DB that getMessages reads.
 * - Detects pass vs reply vs failure vs timeout.
 */
import { streamChat } from '../claude-api'
import { GROUP_TURN_TIMEOUT_MS } from './constants'
import { getOrCreateSession } from './agent-session-manager'
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

export async function executeMemberTurn(
  opts: TurnExecutorOptions,
): Promise<GroupTurnResult> {
  const { sessionId } = await getOrCreateSession(opts.roomId, opts.member, {
    dbPath: opts.dbPath,
    // Do NOT override title here — let agent-session-manager use its own
    // deterministic groupSessionTitle(roomId, participantId) so each member
    // gets a unique session and they never conflict.
  })

  console.log(`[turn-executor] member=${opts.member.displayName} session=${sessionId}`)

  const startedAt = Date.now()

  // Accumulate the reply directly from SSE events.
  // assistant.delta  — incremental token
  // assistant.completed — full text (sent once when the turn ends)
  let replyAccum = ''
  let completedText: string | null = null

  class StreamTimeoutError extends Error {
    constructor() { super('stream timeout') }
  }

  try {
    console.log(`[turn-executor] member=${opts.member.displayName} starting stream...`)
    await Promise.race([
      streamChat(
        sessionId,
        { message: opts.prompt, model: opts.model },
        {
          onEvent: (payload) => {
            const { event, data } = payload

            // TEMP: log every unique event name so we can learn what gateway emits
            console.log(`[turn-executor][sse] member=${opts.member.displayName} event=${event} dataKeys=${Object.keys(data).join(',')}`)

            // Forward to caller (UI SSE relay)
            opts.onEvent?.(event, data)

            if (event === 'assistant.delta' && typeof data.delta === 'string') {
              replyAccum += data.delta
            }
            if (event === 'assistant.completed' && typeof data.content === 'string') {
              completedText = data.content
            }
          },
        },
      ),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new StreamTimeoutError()), GROUP_TURN_TIMEOUT_MS)
      }),
    ])
    console.log(`[turn-executor] member=${opts.member.displayName} stream done in ${Date.now() - startedAt}ms`)
  } catch (error) {
    if (error instanceof StreamTimeoutError) {
      console.log(`[turn-executor] member=${opts.member.displayName} stream TIMEOUT`)
      // Use whatever we accumulated before the timeout.
      const partial = (completedText ?? replyAccum).trim()
      if (partial) {
        return isGroupPassText(partial)
          ? { kind: 'pass' }
          : { kind: 'reply', text: partial }
      }
      return { kind: 'timeout' }
    }
    console.error(`[turn-executor] member=${opts.member.displayName} stream error:`, error)
    return {
      kind: 'failed',
      reason: 'submit failed: ' + (error instanceof Error ? error.message : String(error)),
    }
  }

  // Prefer the completed event (canonical full text); fall back to accumulated deltas.
  const replyText = (completedText ?? replyAccum).trim()
  console.log(`[turn-executor] member=${opts.member.displayName} replyText=${replyText ? replyText.slice(0, 80) : 'EMPTY'}`)

  if (!replyText) {
    return { kind: 'timeout' }
  }

  return isGroupPassText(replyText)
    ? { kind: 'pass' }
    : { kind: 'reply', text: replyText }
}
