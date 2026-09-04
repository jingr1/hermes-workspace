/**
 * Pending turn service — human gate for group chat.
 *
 * When an agent turn results in a blocking question or approval request, we
 * insert a pending_turn and pause the room. The user (or another authorized
 * human) can answer or dismiss it; the answer is recorded as a room message.
 *
 * This replaces upstream's clarify prompt mirroring with a workspace-native
 * pending_turn table.
 */
import { publishChatEvent } from '../chat-event-bus'
import {
  answerPendingTurn,
  createPendingTurn,
  dismissPendingTurn,
  getPendingTurn,
  insertMessage,
  listPendingTurns,
  updateRoom,
} from './room-store'
import type { PendingTurn, Room, RoomMessage } from './types'

export type HumanAnswerInput = {
  roomId: string
  turnId: string
  answerText: string
  answeredByParticipantId?: string
}

export async function requestHumanAttention(input: {
  room: Room
  requestedBy: string
  kind: 'needs_input' | 'blocked' | 'approval' | 'review'
  reason: string
  messageId?: string | null
  options?: Array<{ id: string; label: string; replyText: string }> | null
}): Promise<PendingTurn> {
  const turn = createPendingTurn({
    roomId: input.room.id,
    requestedBy: input.requestedBy,
    kind: input.kind,
    reason: input.reason,
    messageId: input.messageId ?? null,
    options: input.options ?? null,
  })

  updateRoom(input.room.id, { state: 'needs_human' })

  publishChatEvent('group_chat_human_attention', {
    roomId: input.room.id,
    pendingTurnId: turn.id,
    kind: turn.kind,
    reason: turn.reason,
  })

  return turn
}

export async function answerPendingTurnWithMessage(
  input: HumanAnswerInput,
): Promise<{ turn: PendingTurn; message: RoomMessage } | null> {
  const { roomId, turnId, answerText } = input
  const turn = getPendingTurn(turnId)
  if (!turn || turn.roomId !== roomId) return null

  const message = insertMessage({
    roomId,
    senderKind: 'human',
    senderParticipantId: input.answeredByParticipantId ?? null,
    senderName: 'User',
    content: answerText,
  })

  const updated = answerPendingTurn(turnId, { messageId: message.id })
  if (!updated) return null

  // Resume the room so the runner will pick up the human answer.
  updateRoom(roomId, { state: 'active' })

  publishChatEvent('group_chat_human_answered', {
    roomId,
    turnId,
    messageId: message.id,
  })

  return { turn: updated, message }
}

export function dismissPendingTurnForRoom(
  roomId: string,
  turnId: string,
): PendingTurn | null {
  const turn = getPendingTurn(turnId)
  if (!turn || turn.roomId !== roomId) return null
  const updated = dismissPendingTurn(turnId)
  if (!updated) return null

  // If no more open pending turns, resume the room.
  const open = listPendingTurns(roomId, { status: 'pending' })
  if (open.length === 0) {
    updateRoom(roomId, { state: 'active' })
  }

  publishChatEvent('group_chat_human_dismissed', {
    roomId,
    turnId,
  })

  return updated
}
