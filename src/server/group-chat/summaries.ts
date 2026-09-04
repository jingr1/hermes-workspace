/**
 * Rolling summary generation for group chat rooms.
 *
 * Keeps context windows bounded by summarizing older messages. When the number
 * of messages since the last summary reaches GROUP_SUMMARY_THRESHOLD, a new
 * summary is generated from the un-summarized tail and persisted.
 */
import { sendChat } from '../claude-api'
import { getLatestMessages, getLatestSummary, saveSummary } from './room-store'
import { GROUP_SUMMARY_THRESHOLD } from './constants'
import type { RoomSummary } from './types'

const SUMMARY_PROMPT = `Summarize the following group chat messages concisely. Capture the key decisions, open questions, and who is responsible for what. Do not include greetings or meta-commentary.`

export async function maybeSummarizeRoom(
  roomId: string,
  input?: { dbPath?: string; model?: string },
): Promise<RoomSummary | null> {
  const latest = getLatestSummary(roomId, input)
  const messages = getLatestMessages(roomId, { dbPath: input?.dbPath, limit: 200 })

  // Find first message after the last summary.
  let startIndex = 0
  if (latest?.throughMessageId) {
    const idx = messages.findIndex((m) => m.id === latest.throughMessageId)
    if (idx >= 0) startIndex = idx + 1
  }

  const unsummarized = messages.slice(startIndex)
  if (unsummarized.length < GROUP_SUMMARY_THRESHOLD) {
    return null
  }

  const transcript = unsummarized
    .map((m) => `${m.senderName}: ${m.content}`)
    .join('\n')
  const fullPrompt = `${SUMMARY_PROMPT}\n\n${transcript}`

  // We generate the summary via a throwaway session to avoid polluting any
  // member's canonical session. Use a deterministic title; if a previous
  // summary session was orphaned, retry once with a nonce.
  const { createSession } = await import('../claude-api')
  let session
  try {
    session = await createSession({
      title: `Summary for room ${roomId}`,
    })
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    if (msg.includes('Title already in use')) {
      session = await createSession({
        title: `Summary for room ${roomId} ${Date.now()}`,
      })
    } else {
      throw error
    }
  }
  const result = await sendChat(session.id, {
    message: fullPrompt,
    model: input?.model,
  })
  const text = extractText(result)
  const lastMessage = unsummarized[unsummarized.length - 1]
  return saveSummary(
    roomId,
    text,
    lastMessage.id,
    unsummarized.length,
    input,
  )
}

function extractText(result: Record<string, unknown>): string {
  const messages = Array.isArray(result.messages)
    ? (result.messages as Array<Record<string, unknown>>)
    : []
  const lastAssistant = [...messages]
    .reverse()
    .find((m) => String(m.role) === 'assistant')
  if (lastAssistant && typeof lastAssistant.content === 'string') {
    return lastAssistant.content
  }
  return String(result.response ?? result.text ?? '(no summary)')
}

/**
 * Return the active summary text plus the list of messages that should be
 * included in a member's delta (everything after the summary).
 */
export function getContextForMember(
  roomId: string,
  input?: { dbPath?: string },
): { summary: string | null; messages: Array<{ senderName: string; content: string; createdAt: number }> } {
  const summary = getLatestSummary(roomId, input)
  const all = getLatestMessages(roomId, { dbPath: input?.dbPath, limit: 200 })
  if (!summary?.throughMessageId) {
    return { summary: null, messages: all }
  }
  const idx = all.findIndex((m) => m.id === summary.throughMessageId)
  const messages = idx >= 0 ? all.slice(idx + 1) : all
  return { summary: summary.content, messages }
}
