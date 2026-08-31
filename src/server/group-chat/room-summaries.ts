import { openSqliteDatabase } from '../sqlite-helper'
import { createCollabId, ensureCollabDb, getCollabDbPath } from '../collab-db'
import { buildRoomContext } from './context-projection'
import { openaiChat } from '../openai-compat-api'

export type RoomSummary = {
  room_id: string
  summary: string
  through_message_id: string | null
  through_at: number | null
  turn_count: number
  version: number
  updated_at: number
}

function dbPath(): string {
  ensureCollabDb()
  return getCollabDbPath()
}

export function getRoomSummary(roomId: string): RoomSummary | null {
  const db = openSqliteDatabase(dbPath(), false)
  try {
    return (
      (
        db
          .prepare('SELECT * FROM room_summaries WHERE room_id = ?')
          .all(roomId) as RoomSummary[]
      )[0] ?? null
    )
  } finally {
    db.close()
  }
}

export function summarizeRoom(input: {
  roomId: string
  summary: string
  throughMessageId: string
  throughAt: number
  turnCount: number
}): RoomSummary {
  const now = Date.now()
  const existing = getRoomSummary(input.roomId)
  const version = existing ? existing.version + 1 : 1

  const db = openSqliteDatabase(dbPath(), false)
  try {
    db.prepare(
      `INSERT INTO room_summaries
        (room_id, summary, through_message_id, through_at, turn_count, version, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(room_id) DO UPDATE SET
        summary = excluded.summary,
        through_message_id = excluded.through_message_id,
        through_at = excluded.through_at,
        turn_count = excluded.turn_count,
        version = excluded.version,
        updated_at = excluded.updated_at`,
    ).run(
      input.roomId,
      input.summary,
      input.throughMessageId,
      input.throughAt,
      input.turnCount,
      version,
      now,
    )
  } finally {
    db.close()
  }
  return {
    room_id: input.roomId,
    summary: input.summary,
    through_message_id: input.throughMessageId,
    through_at: input.throughAt,
    turn_count: input.turnCount,
    version,
    updated_at: now,
  }
}

export function deleteRoomSummary(roomId: string): void {
  const db = openSqliteDatabase(dbPath(), false)
  try {
    db.prepare('DELETE FROM room_summaries WHERE room_id = ?').run(roomId)
  } finally {
    db.close()
  }
}

export function generateSummaryFromRoom(roomId: string): RoomSummary {
  const ctx = buildRoomContext(roomId)
  const tailText = ctx.tail
    .slice(-20)
    .map((m) => `${m.senderName}: ${m.content}`)
    .join('\n')
  const summary = ctx.summary
    ? `${ctx.summary}\n\n[Continuation]\n${tailText}`
    : tailText || 'No activity yet.'

  const lastMessage = ctx.tail[ctx.tail.length - 1]
  return summarizeRoom({
    roomId,
    summary,
    throughMessageId: lastMessage?.id ?? roomId,
    throughAt: lastMessage?.createdAt ?? Date.now(),
    turnCount: ctx.totalMessages,
  })
}

/**
 * Generate a rolling summary using an LLM. Falls back to the rule-based
 * summary if the LLM call fails or no API key is configured.
 */
export async function generateSummaryFromRoomWithLlm(
  roomId: string,
  opts?: { force?: boolean },
): Promise<RoomSummary> {
  const existing = getRoomSummary(roomId)
  if (!opts?.force && existing && existing.turn_count > 0) {
    // Only re-summarize when there is new activity after the existing boundary.
    const ctx = buildRoomContext(roomId)
    const lastTail = ctx.tail[ctx.tail.length - 1]
    if (lastTail && existing.through_at && lastTail.createdAt <= existing.through_at) {
      return existing
    }
  }

  const ctx = buildRoomContext(roomId)
  const tail = ctx.tail.slice(-20)
  const tailText = tail.map((m) => `${m.senderName}: ${m.content}`).join('\n')

  const prompt = `Summarize the following room conversation concisely in 2-4 sentences. Preserve key decisions, open questions, and who is responsible for what next. Do not include timestamps or meta commentary.\n\n${ctx.summary ? `Previous summary:\n${ctx.summary}\n\nRecent messages:\n` : ''}${tailText || 'No activity yet.'}`

  try {
    const summary = await openaiChat(
      [{ role: 'user', content: prompt }],
      {
        model: 'default',
        stream: false,
        temperature: 0.3,
        usageContext: {
          taskId: roomId,
          agentId: 'room-summary',
          runtime: 'workspace-llm',
        },
      },
    )

    const lastMessage = tail[tail.length - 1]
    return summarizeRoom({
      roomId,
      summary: summary.trim() || 'No activity yet.',
      throughMessageId: lastMessage?.id ?? roomId,
      throughAt: lastMessage?.createdAt ?? Date.now(),
      turnCount: ctx.totalMessages,
    })
  } catch (error) {
    console.error('[room-summaries] LLM summary failed, falling back', error)
    return generateSummaryFromRoom(roomId)
  }
}

