import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../../../server/auth-middleware'
import { insertRoomMessage } from '../../../../server/group-chat/room-store'
import { answerPendingTurn } from '../../../../server/group-chat/pending-turns'
import { publishChatEvent } from '../../../../server/chat-event-bus'

export const Route = createFileRoute('/api/pending-turns/$id/answer')({
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        if (!isAuthenticated(request)) {
          return json({ ok: false, error: 'Unauthorized' }, { status: 401 })
        }
        const body = await request.json().catch(() => ({ text: '' }))
        const text = String(body.text ?? '')
        const roomId = String(body.roomId ?? '')
        const fromParticipantId = String(body.fromParticipantId ?? 'human')
        const fromName = String(body.fromName ?? 'Human')

        if (!roomId || !text) {
          return json(
            { ok: false, error: 'roomId and text required' },
            { status: 400 },
          )
        }

        const msg = insertRoomMessage({
          room_id: roomId,
          sender_kind: 'human',
          sender_participant_id: fromParticipantId,
          sender_name: fromName,
          content: text,
          mentions: [],
          mention_depth: 0,
          auto_handoff: 0,
          task_refs: [],
          answers_pending_turn_id: params.id,
          run_id: null,
          task_id: null,
        })

        const turn = answerPendingTurn(params.id, msg.id)
        if (!turn) {
          return json(
            { ok: false, error: 'Pending turn not found' },
            { status: 404 },
          )
        }

        publishChatEvent('pending_turn_answered', {
          roomId,
          pendingTurnId: turn.id,
          answeredMessageId: msg.id,
        })

        return json({ ok: true, turn, message: msg })
      },
    },
  },
})
