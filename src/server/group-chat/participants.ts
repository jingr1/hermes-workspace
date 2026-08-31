import { openSqliteDatabase } from '../sqlite-helper'
import { createCollabId, ensureCollabDb, getCollabDbPath } from '../collab-db'

export type Participant = {
  id: string
  room_id: string
  kind: 'human' | 'agent'
  participant_id: string
  display_name: string
  mention_name: string
  description: string | null
  runtime: 'hermes' | 'claude-code' | 'codex' | 'deepseek-harness' | null
  is_owner: number
  online: number
  joined_at: number
  removed_at: number
}

function dbPath(): string {
  return getCollabDbPath()
}

function ensureDb(): void {
  ensureCollabDb()
}

export function addParticipant(
  roomId: string,
  input: Omit<Participant, 'id' | 'room_id' | 'joined_at' | 'removed_at' | 'is_owner' | 'online'>,
  opts?: { isOwner?: boolean },
): Participant {
  ensureDb()
  const id = createCollabId('part')
  const now = Date.now()
  const participant: Participant = {
    id,
    room_id: roomId,
    kind: input.kind,
    participant_id: input.participant_id,
    display_name: input.display_name,
    mention_name: input.mention_name.toLowerCase().replace(/\s+/g, '-'),
    description: input.description ?? null,
    runtime: input.runtime ?? null,
    is_owner: opts?.isOwner ? 1 : 0,
    online: 0,
    joined_at: now,
    removed_at: 0,
  }
  const db = openSqliteDatabase(dbPath(), false)
  try {
    db.prepare(
      `INSERT INTO room_participants
       (id, room_id, kind, participant_id, display_name, mention_name, description, runtime, is_owner, online, joined_at, removed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      participant.id,
      participant.room_id,
      participant.kind,
      participant.participant_id,
      participant.display_name,
      participant.mention_name,
      participant.description,
      participant.runtime,
      participant.is_owner,
      participant.online,
      participant.joined_at,
      participant.removed_at,
    )
  } finally {
    db.close()
  }
  return participant
}

export function getParticipants(roomId: string): Participant[] {
  ensureDb()
  const db = openSqliteDatabase(dbPath(), true)
  try {
    const rows = db
      .prepare(
        `SELECT * FROM room_participants
         WHERE room_id = ? AND removed_at = 0
         ORDER BY kind, display_name`,
      )
      .all(roomId) as Array<Record<string, unknown>>
    return rows.map(normalizeParticipant)
  } finally {
    db.close()
  }
}

export function getParticipantByMention(
  roomId: string,
  mentionName: string,
): Participant | null {
  ensureDb()
  const normalized = mentionName.toLowerCase().replace(/\s+/g, '-')
  const db = openSqliteDatabase(dbPath(), true)
  try {
    const rows = db
      .prepare(
        `SELECT * FROM room_participants
         WHERE room_id = ? AND mention_name = ? AND removed_at = 0
         LIMIT 1`,
      )
      .all(roomId, normalized) as Array<Record<string, unknown>>
    return rows.length ? normalizeParticipant(rows[0]) : null
  } finally {
    db.close()
  }
}

export function setParticipantOnline(
  participantId: string,
  online: boolean,
): void {
  ensureDb()
  const db = openSqliteDatabase(dbPath(), false)
  try {
    db.prepare(
      'UPDATE room_participants SET online = ? WHERE id = ?',
    ).run(online ? 1 : 0, participantId)
  } finally {
    db.close()
  }
}

export function removeParticipant(participantId: string): void {
  ensureDb()
  const db = openSqliteDatabase(dbPath(), false)
  try {
    db.prepare(
      'UPDATE room_participants SET removed_at = ? WHERE id = ?',
    ).run(Date.now(), participantId)
  } finally {
    db.close()
  }
}

function normalizeParticipant(row: Record<string, unknown>): Participant {
  return {
    id: String(row.id),
    room_id: String(row.room_id),
    kind: String(row.kind) as Participant['kind'],
    participant_id: String(row.participant_id),
    display_name: String(row.display_name),
    mention_name: String(row.mention_name),
    description: (row.description as string | null) ?? null,
    runtime: (row.runtime as Participant['runtime']) ?? null,
    is_owner: Number(row.is_owner ?? 0),
    online: Number(row.online ?? 0),
    joined_at: Number(row.joined_at),
    removed_at: Number(row.removed_at ?? 0),
  }
}
