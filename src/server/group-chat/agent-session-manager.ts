/**
 * Canonical session manager for group-chat participants.
 *
 * Each bot participant in a room gets one persistent "Bot Chat" session on
 * the gateway. We create it lazily, cache the session id by
 * (roomId, participantId), and resume it on subsequent turns. This mirrors
 * upstream Bot Mode's canonical "Bot Chat" sessions but uses workspace's
 * claude-api instead of Desktop RPC.
 */
import { createSession, getMessages, sendChat } from '../claude-api'
import { getCollabDbPath } from '../collab-db'
import { openSqliteDatabase } from '../sqlite-helper'
import type { ClaudeMessage } from '../claude-api'
import type { GroupMember } from './types'

const SESSION_KEY_PREFIX = 'group-chat-session'

function sessionCacheKey(roomId: string, participantId: string): string {
  return `${SESSION_KEY_PREFIX}:${roomId}:${participantId}`
}

/** In-memory cache (HMR-safe via globalThis). */
function getCache(): Map<string, string> {
  const g = globalThis as Record<string, unknown>
  const key = '__group_chat_session_cache__'
  if (!g[key]) {
    g[key] = new Map<string, string>()
  }
  return g[key] as Map<string, string>
}

/** Persist the mapping to a tiny SQLite table for crash recovery. */
function ensureSessionTable(databasePath: string): void {
  const db = openSqliteDatabase(databasePath, false)
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS group_chat_sessions (
        room_id TEXT NOT NULL,
        participant_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        updated_at INTEGER,
        PRIMARY KEY (room_id, participant_id)
      );
    `)
  } finally {
    db.close()
  }
}

function dbPath(input?: { dbPath?: string }): string {
  return input?.dbPath ?? getCollabDbPath()
}

/** Canonical deterministic title for a member's group session.
 *  Mirrors Desktop's `Group: ${roomId}` but scopes uniqueness per participant
 *  because workspace runs all agents on the same gateway, which rejects
 *  duplicate titles globally. */
export function groupSessionTitle(roomId: string, participantId: string): string {
  return `Group: ${roomId}:${participantId}`
}

export function rememberSession(
  roomId: string,
  participantId: string,
  sessionId: string,
  input?: { dbPath?: string },
): void {
  const path = dbPath(input)
  ensureSessionTable(path)
  getCache().set(sessionCacheKey(roomId, participantId), sessionId)
  const db = openSqliteDatabase(path, false)
  try {
    db.prepare(
      `INSERT INTO group_chat_sessions (room_id, participant_id, session_id, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(room_id, participant_id) DO UPDATE SET session_id = excluded.session_id, updated_at = excluded.updated_at`,
    ).run(roomId, participantId, sessionId, Date.now())
  } finally {
    db.close()
  }
}

export function forgetSession(roomId: string, participantId: string): void {
  getCache().delete(sessionCacheKey(roomId, participantId))
  const path = dbPath()
  ensureSessionTable(path)
  const db = openSqliteDatabase(path, false)
  try {
    db.prepare(
      'DELETE FROM group_chat_sessions WHERE room_id = ? AND participant_id = ?',
    ).run(roomId, participantId)
  } finally {
    db.close()
  }
}

/** Result of verifying a stored session id. */
type SessionCheckResult =
  | { kind: 'ok'; sessionId: string }
  | { kind: 'missing' }
  | { kind: 'error'; error: Error }

/** Verify a stored session id. Fail closed on transient errors: only a 404-style
 *  "not found" means the session is genuinely gone. */
async function checkStoredSession(
  sessionId: string,
): Promise<SessionCheckResult> {
  try {
    await getMessages(sessionId)
    return { kind: 'ok', sessionId }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    if (/\b404\b|Not found|not found|invalid session|session not found/i.test(msg)) {
      return { kind: 'missing' }
    }
    return { kind: 'error', error: error instanceof Error ? error : new Error(String(error)) }
  }
}

export async function getOrCreateSession(
  roomId: string,
  member: GroupMember,
  input?: { dbPath?: string; title?: string },
): Promise<{ sessionId: string; existed: boolean }> {
  const cacheKey = sessionCacheKey(roomId, member.participantId)
  const title = input?.title ?? groupSessionTitle(roomId, member.participantId)

  // 1. Try in-memory cache first.
  let cached = getCache().get(cacheKey)

  // 2. Try persisted mapping.
  if (!cached) {
    const path = dbPath(input)
    ensureSessionTable(path)
    const db = openSqliteDatabase(path, true)
    try {
      const rows = db
        .prepare(
          'SELECT session_id FROM group_chat_sessions WHERE room_id = ? AND participant_id = ?',
        )
        .all(roomId, member.participantId)
      if (rows.length > 0) {
        cached = String(rows[0].session_id)
      }
    } finally {
      db.close()
    }
  }

  // 3. If we have a stored session id, verify it still exists.
  if (cached) {
    const check = await checkStoredSession(cached)
    if (check.kind === 'ok') {
      getCache().set(cacheKey, check.sessionId)
      return { sessionId: check.sessionId, existed: true }
    }
    if (check.kind === 'error') {
      throw new Error(
        `Could not verify ${member.name}'s group session (${check.error.message}) — not starting a new one`,
      )
    }
    // missing -> fall through to create
    getCache().delete(cacheKey)
  }

  // 4. Create a new session. The deterministic title already encodes room+member,
  //    so duplicate-title collisions should only happen if a previous session was
  //    orphaned. Retry once with a timestamp nonce on that specific error.
  try {
    const session = await createSession({ title })
    const sessionId = session.id
    rememberSession(roomId, member.participantId, sessionId, input)
    return { sessionId, existed: false }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    if (msg.includes('Title already in use')) {
      const fallbackTitle = `${title} ${Date.now()}`
      const session = await createSession({ title: fallbackTitle })
      const sessionId = session.id
      rememberSession(roomId, member.participantId, sessionId, input)
      return { sessionId, existed: false }
    }
    throw error
  }
}

export async function submitPrompt(
  roomId: string,
  member: GroupMember,
  prompt: string,
  input?: { dbPath?: string; title?: string; model?: string },
): Promise<{ sessionId: string; message?: ClaudeMessage }> {
  const { sessionId } = await getOrCreateSession(roomId, member, input)
  const result = await sendChat(sessionId, {
    message: prompt,
    model: input?.model,
  })
  const message = extractAssistantMessage(result, sessionId)
  return { sessionId, message }
}

function extractAssistantMessage(
  result: Record<string, unknown>,
  sessionId: string,
): ClaudeMessage | undefined {
  const messages = Array.isArray(result.messages)
    ? (result.messages as Array<Record<string, unknown>>)
    : []
  const lastAssistant = [...messages]
    .reverse()
    .find((m) => String(m.role) === 'assistant')
  if (!lastAssistant) return undefined
  return {
    id: Number(lastAssistant.id) || 0,
    session_id: sessionId,
    role: 'assistant',
    content: String(lastAssistant.content ?? ''),
    timestamp: Number(lastAssistant.timestamp) || Date.now(),
  }
}

export function clearSessionCache(): void {
  getCache().clear()
}
