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

export type Participant = {
  id: string
  room_id: string
  kind: 'human' | 'agent'
  participant_id: string
  display_name: string
  mention_name: string
  description: string | null
  runtime: string | null
  is_owner: number
  online: number
  joined_at: number
  removed_at: number
}

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

export async function fetchRooms(): Promise<Room[]> {
  const res = await fetch('/api/rooms')
  const body = await res.json()
  if (!body.ok) throw new Error(body.error || 'Failed to fetch rooms')
  return body.rooms as Room[]
}

export async function createRoom(opts: {
  title?: string
  taskId?: string
  missionId?: string
}): Promise<Room> {
  const res = await fetch('/api/rooms', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(opts),
  })
  const body = await res.json()
  if (!body.ok) throw new Error(body.error || 'Failed to create room')
  return body.room as Room
}

export async function fetchRoomDetail(roomId: string): Promise<{
  room: Room
  participants: Participant[]
  messages: RoomMessage[]
}> {
  const res = await fetch(`/api/rooms/${roomId}`)
  const body = await res.json()
  if (!body.ok) throw new Error(body.error || 'Failed to fetch room')
  return body
}

export async function sendRoomMessage(
  roomId: string,
  content: string,
  opts?: {
    fromParticipantId?: string
    fromName?: string
    senderKind?: 'human' | 'agent' | 'system'
    mentionDepth?: number
    answersPendingTurnId?: string
  },
): Promise<RoomMessage> {
  const res = await fetch(`/api/rooms/${roomId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      content,
      fromParticipantId: opts?.fromParticipantId,
      fromName: opts?.fromName,
      senderKind: opts?.senderKind,
      mentionDepth: opts?.mentionDepth,
      answersPendingTurnId: opts?.answersPendingTurnId,
    }),
  })
  const body = await res.json()
  if (!body.ok) throw new Error(body.error || 'Failed to send message')
  return body.message as RoomMessage
}

export async function fetchPendingTurns(opts?: {
  status?: PendingTurn['status']
  roomId?: string
}): Promise<PendingTurn[]> {
  const params = new URLSearchParams()
  if (opts?.status) params.set('status', opts.status)
  if (opts?.roomId) params.set('roomId', opts.roomId)
  const res = await fetch(`/api/pending-turns?${params.toString()}`)
  const body = await res.json()
  if (!body.ok) throw new Error(body.error || 'Failed to fetch pending turns')
  return body.turns as PendingTurn[]
}

export async function answerPendingTurn(
  id: string,
  text: string,
  roomId: string,
): Promise<{ turn: PendingTurn; message: RoomMessage }> {
  const res = await fetch(`/api/pending-turns/${id}/answer`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, roomId }),
  })
  const body = await res.json()
  if (!body.ok) throw new Error(body.error || 'Failed to answer')
  return body
}

export async function dismissPendingTurn(id: string): Promise<PendingTurn> {
  const res = await fetch(`/api/pending-turns/${id}/dismiss`, {
    method: 'POST',
  })
  const body = await res.json()
  if (!body.ok) throw new Error(body.error || 'Failed to dismiss')
  return body.turn as PendingTurn
}

export async function addRoomParticipant(
  roomId: string,
  input: {
    kind: 'human' | 'agent'
    participantId: string
    displayName: string
    mentionName: string
    description?: string | null
    runtime?: string | null
  },
): Promise<Participant> {
  const res = await fetch(`/api/rooms/${roomId}/participants`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      kind: input.kind,
      participantId: input.participantId,
      displayName: input.displayName,
      mentionName: input.mentionName,
      description: input.description,
      runtime: input.runtime,
    }),
  })
  const body = await res.json()
  if (!body.ok) throw new Error(body.error || 'Failed to add participant')
  return body.participant as Participant
}
