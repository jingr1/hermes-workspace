import { openSqliteDatabase } from '../sqlite-helper'
import { createCollabId, ensureCollabDb, getCollabDbPath } from '../collab-db'

export type Room = {
  id: string
  title: string | null
  task_id: string | null
  mission_id: string | null
  workspace_path: string | null
  owner_participant_id: string | null
  created_at: number
  updated_at: number
}

export type RoomMessage = {
  id: string
  room_id: string
  sender_kind: 'human' | 'agent' | 'system'
  sender_participant_id: string | null
  sender_name: string | null
  content: string
  mentions: Array<{ type: 'human' | 'agent' | 'all'; participantId?: string }>
  mention_depth: number
  auto_handoff: number
  task_refs: string[]
  answers_pending_turn_id: string | null
  run_id: string | null
  task_id: string | null
  created_at: number
}

function dbPath(): string {
  return getCollabDbPath()
}

export function ensureRoomStore(): void {
  ensureCollabDb()
}

export function createRoom(opts: {
  title?: string
  taskId?: string
  missionId?: string
  workspacePath?: string
  ownerParticipantId?: string
}): Room {
  ensureRoomStore()
  const id = createCollabId('room')
  const now = Date.now()
  const room: Room = {
    id,
    title: opts.title ?? null,
    task_id: opts.taskId ?? null,
    mission_id: opts.missionId ?? null,
    workspace_path: opts.workspacePath ?? null,
    owner_participant_id: opts.ownerParticipantId ?? null,
    created_at: now,
    updated_at: now,
  }
  const db = openSqliteDatabase(dbPath(), false)
  try {
    db.prepare(
      `INSERT INTO rooms (id, title, task_id, mission_id, workspace_path, owner_participant_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      room.id,
      room.title,
      room.task_id,
      room.mission_id,
      room.workspace_path,
      room.owner_participant_id,
      room.created_at,
      room.updated_at,
    )
  } finally {
    db.close()
  }
  return room
}

export function getRoom(roomId: string): Room | null {
  ensureRoomStore()
  const db = openSqliteDatabase(dbPath(), true)
  try {
    const rows = db
      .prepare('SELECT * FROM rooms WHERE id = ? LIMIT 1')
      .all(roomId) as Array<Record<string, unknown>>
    if (!rows.length) return null
    return normalizeRoom(rows[0])
  } finally {
    db.close()
  }
}

export function listRooms(): Room[] {
  ensureRoomStore()
  const db = openSqliteDatabase(dbPath(), true)
  try {
    const rows = db
      .prepare('SELECT * FROM rooms ORDER BY updated_at DESC')
      .all() as Array<Record<string, unknown>>
    return rows.map(normalizeRoom)
  } finally {
    db.close()
  }
}

export function getRoomsByMissionId(missionId: string): Room[] {
  ensureRoomStore()
  const db = openSqliteDatabase(dbPath(), true)
  try {
    const rows = db
      .prepare('SELECT * FROM rooms WHERE mission_id = ? ORDER BY created_at DESC')
      .all(missionId) as Array<Record<string, unknown>>
    return rows.map(normalizeRoom)
  } finally {
    db.close()
  }
}

export function touchRoom(roomId: string): void {
  ensureRoomStore()
  const db = openSqliteDatabase(dbPath(), false)
  try {
    db.prepare('UPDATE rooms SET updated_at = ? WHERE id = ?').run(
      Date.now(),
      roomId,
    )
  } finally {
    db.close()
  }
}

export function insertRoomMessage(message: Omit<RoomMessage, 'id' | 'created_at'>): RoomMessage {
  ensureRoomStore()
  const id = createCollabId('msg')
  const now = Date.now()
  const msg: RoomMessage = {
    ...message,
    id,
    created_at: now,
  }
  const db = openSqliteDatabase(dbPath(), false)
  try {
    db.prepare(
      `INSERT INTO room_messages
        (id, room_id, sender_kind, sender_participant_id, sender_name, content, mentions, mention_depth, auto_handoff, task_refs, answers_pending_turn_id, run_id, task_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      msg.id,
      msg.room_id,
      msg.sender_kind,
      msg.sender_participant_id,
      msg.sender_name,
      msg.content,
      JSON.stringify(msg.mentions ?? []),
      msg.mention_depth,
      msg.auto_handoff,
      JSON.stringify(msg.task_refs ?? []),
      msg.answers_pending_turn_id,
      msg.run_id,
      msg.task_id,
      msg.created_at,
    )
  } finally {
    db.close()
  }
  touchRoom(msg.room_id)
  return msg
}

export function listRoomMessages(roomId: string, opts?: { limit?: number; before?: number; after?: number }): RoomMessage[] {
  ensureRoomStore()
  const limit = opts?.limit ?? 200
  const before = opts?.before ?? Number.MAX_SAFE_INTEGER
  const after = opts?.after ?? 0
  const db = openSqliteDatabase(dbPath(), true)
  try {
    const rows = db
      .prepare(
        `SELECT * FROM room_messages
         WHERE room_id = ? AND created_at < ? AND created_at > ?
         ORDER BY created_at DESC
         LIMIT ?`,
      )
      .all(roomId, before, after, limit) as Array<Record<string, unknown>>
    return rows.reverse().map(normalizeMessage)
  } finally {
    db.close()
  }
}

function normalizeRoom(row: Record<string, unknown>): Room {
  return {
    id: String(row.id),
    title: (row.title as string | null) ?? null,
    task_id: (row.task_id as string | null) ?? null,
    mission_id: (row.mission_id as string | null) ?? null,
    workspace_path: (row.workspace_path as string | null) ?? null,
    owner_participant_id: (row.owner_participant_id as string | null) ?? null,
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at),
  }
}

function normalizeMessage(row: Record<string, unknown>): RoomMessage {
  return {
    id: String(row.id),
    room_id: String(row.room_id),
    sender_kind: String(row.sender_kind) as RoomMessage['sender_kind'],
    sender_participant_id: (row.sender_participant_id as string | null) ?? null,
    sender_name: (row.sender_name as string | null) ?? null,
    content: String(row.content),
    mentions: parseJson(row.mentions as string) as RoomMessage['mentions'] ?? [],
    mention_depth: Number(row.mention_depth ?? 0),
    auto_handoff: Number(row.auto_handoff ?? 0),
    task_refs: (parseJson(row.task_refs as string) as string[] | null) ?? [],
    answers_pending_turn_id: (row.answers_pending_turn_id as string | null) ?? null,
    run_id: (row.run_id as string | null) ?? null,
    task_id: (row.task_id as string | null) ?? null,
    created_at: Number(row.created_at),
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
