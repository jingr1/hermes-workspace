import { openSqliteDatabase } from '../sqlite-helper'
import { createCollabId, ensureCollabDb, getCollabDbPath } from '../collab-db'
import { publishChatEvent } from '../chat-event-bus'

export type PendingTurn = {
  id: string
  room_id: string
  task_id: string | null
  assignment_id: string | null
  requested_by: string
  target_participant_id: string | null
  message_id: string | null
  kind: 'needs_input' | 'blocked' | 'approval' | 'review'
  reason: string | null
  options: Array<{ id: string; label: string; replyText?: string }>
  status: 'pending' | 'answered' | 'dismissed' | 'expired'
  created_at: number
  answered_at: number | null
  answered_message_id: string | null
}

const EXPIRY_MS = 30 * 60 * 1000

function dbPath(): string {
  return getCollabDbPath()
}

function ensureDb(): void {
  ensureCollabDb()
}

export function createPendingTurn(input: Omit<Partial<PendingTurn>, 'id' | 'status' | 'created_at' | 'answered_at' | 'answered_message_id'> & Pick<PendingTurn, 'room_id' | 'requested_by'>): PendingTurn {
  ensureDb()
  const id = createCollabId('pt')
  const now = Date.now()
  const turn: PendingTurn = {
    ...input,
    id,
    status: 'pending',
    created_at: now,
    answered_at: null,
    answered_message_id: null,
    task_id: input.task_id ?? null,
    assignment_id: input.assignment_id ?? null,
    message_id: input.message_id ?? null,
    target_participant_id: input.target_participant_id ?? null,
    reason: input.reason ?? null,
    options: input.options ?? [],
    kind: input.kind ?? 'needs_input',
  }
  const db = openSqliteDatabase(dbPath(), false)
  try {
    db.prepare(
      `INSERT INTO pending_turns
       (id, room_id, task_id, assignment_id, requested_by, target_participant_id, message_id, kind, reason, options, status, created_at, answered_at, answered_message_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      turn.id,
      turn.room_id,
      turn.task_id,
      turn.assignment_id,
      turn.requested_by,
      turn.target_participant_id,
      turn.message_id,
      turn.kind,
      turn.reason,
      JSON.stringify(turn.options ?? []),
      turn.status,
      turn.created_at,
      turn.answered_at,
      turn.answered_message_id,
    )
  } finally {
    db.close()
  }
  return turn
}

export function getPendingTurns(opts?: {
  roomId?: string
  status?: PendingTurn['status']
}): PendingTurn[] {
  ensureDb()
  const db = openSqliteDatabase(dbPath(), true)
  try {
    let rows: Array<Record<string, unknown>>
    if (opts?.roomId && opts?.status) {
      rows = db
        .prepare(
          'SELECT * FROM pending_turns WHERE room_id = ? AND status = ? ORDER BY created_at DESC',
        )
        .all(opts.roomId, opts.status)
    } else if (opts?.roomId) {
      rows = db
        .prepare(
          'SELECT * FROM pending_turns WHERE room_id = ? ORDER BY created_at DESC',
        )
        .all(opts.roomId)
    } else if (opts?.status) {
      rows = db
        .prepare(
          'SELECT * FROM pending_turns WHERE status = ? ORDER BY created_at DESC',
        )
        .all(opts.status)
    } else {
      rows = db
        .prepare('SELECT * FROM pending_turns ORDER BY created_at DESC')
        .all()
    }
    return rows.map(normalizePendingTurn)
  } finally {
    db.close()
  }
}

export function getPendingTurn(id: string): PendingTurn | null {
  ensureDb()
  const db = openSqliteDatabase(dbPath(), true)
  try {
    const rows = db
      .prepare('SELECT * FROM pending_turns WHERE id = ? LIMIT 1')
      .all(id) as Array<Record<string, unknown>>
    return rows.length ? normalizePendingTurn(rows[0]) : null
  } finally {
    db.close()
  }
}

export function answerPendingTurn(
  id: string,
  messageId: string,
): PendingTurn | null {
  ensureDb()
  const db = openSqliteDatabase(dbPath(), false)
  try {
    db.prepare(
      `UPDATE pending_turns
       SET status = 'answered', answered_at = ?, answered_message_id = ?
       WHERE id = ?`,
    ).run(Date.now(), messageId, id)
  } finally {
    db.close()
  }
  return getPendingTurn(id)
}

export function dismissPendingTurn(id: string): PendingTurn | null {
  ensureDb()
  const db = openSqliteDatabase(dbPath(), false)
  try {
    db.prepare(
      `UPDATE pending_turns
       SET status = 'dismissed', answered_at = ?
       WHERE id = ?`,
    ).run(Date.now(), id)
  } finally {
    db.close()
  }
  return getPendingTurn(id)
}

export function requestHumanAttention(input: {
  room_id: string
  task_id?: string | null
  requested_by: string
  target_participant_id?: string | null
  kind: PendingTurn['kind']
  reason: string
  options?: Array<{ id: string; label: string; replyText?: string }>
  source?: string
  message_id?: string | null
}): PendingTurn {
  const roomId = input.room_id
  const turn = createPendingTurn({
    room_id: roomId,
    task_id: input.task_id ?? null,
    assignment_id: null,
    requested_by: input.requested_by,
    target_participant_id: input.target_participant_id ?? null,
    message_id: input.message_id ?? null,
    kind: input.kind,
    reason: input.reason,
    options: input.options ?? [],
  })
  publishChatEvent('human_attention', {
    roomId,
    pendingTurnId: turn.id,
    requestedBy: input.requested_by,
    kind: input.kind,
    reason: input.reason,
    source: input.source ?? 'manual',
    messageId: turn.message_id,
  })
  return turn
}

export function expireStalePendingTurns(): PendingTurn[] {
  ensureDb()
  const now = Date.now()
  const db = openSqliteDatabase(dbPath(), false)
  try {
    db.prepare(
      `UPDATE pending_turns
       SET status = 'expired'
       WHERE status = 'pending' AND created_at < ?`,
    ).run(now - EXPIRY_MS)
  } finally {
    db.close()
  }
  return getPendingTurns({ status: 'expired' })
}

function normalizePendingTurn(row: Record<string, unknown>): PendingTurn {
  return {
    id: String(row.id),
    room_id: String(row.room_id),
    task_id: (row.task_id as string | null) ?? null,
    assignment_id: (row.assignment_id as string | null) ?? null,
    requested_by: String(row.requested_by),
    target_participant_id: (row.target_participant_id as string | null) ?? null,
    message_id: (row.message_id as string | null) ?? null,
    kind: String(row.kind) as PendingTurn['kind'],
    reason: (row.reason as string | null) ?? null,
    options: (parseJson(row.options as string) as PendingTurn['options']) ?? [],
    status: String(row.status) as PendingTurn['status'],
    created_at: Number(row.created_at),
    answered_at: (row.answered_at as number | null) ?? null,
    answered_message_id: (row.answered_message_id as string | null) ?? null,
  }
}

function parseJson(value: string | null | undefined): unknown | null {
  if (!value) return null
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}
