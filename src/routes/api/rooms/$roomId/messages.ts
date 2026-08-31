import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../../../server/auth-middleware'
import { getRoom, insertRoomMessage } from '../../../../server/group-chat/room-store'
import { getParticipants } from '../../../../server/group-chat/participants'
import { parseMentions } from '../../../../server/group-chat/mention-routing'
import { createPendingTurn, requestHumanAttention } from '../../../../server/group-chat/pending-turns'
import { publishChatEvent } from '../../../../server/chat-event-bus'

export const Route = createFileRoute('/api/rooms/$roomId/messages')({
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        if (!isAuthenticated(request)) {
          return json({ ok: false, error: 'Unauthorized' }, { status: 401 })
        }
        const room = getRoom(params.roomId)
        if (!room) {
          return json({ ok: false, error: 'Room not found' }, { status: 404 })
        }
        const body = await request.json().catch(() => ({}))
        const content = String(body.content ?? '')
        if (!content.trim()) {
          return json({ ok: false, error: 'content required' }, { status: 400 })
        }

        const participants = getParticipants(room.id)
        const parsed = parseMentions(content, participants, {
          ownerParticipantId: room.owner_participant_id,
        })

        const fromParticipantId = String(body.fromParticipantId ?? 'human')
        const fromName = String(body.fromName ?? 'Human')
        const senderKind = ['human', 'agent', 'system'].includes(body.senderKind)
          ? body.senderKind
          : 'human'

        const msg = insertRoomMessage({
          room_id: room.id,
          sender_kind: senderKind,
          sender_participant_id: fromParticipantId,
          sender_name: fromName,
          content: parsed.text,
          mentions: parsed.mentions,
          mention_depth: Number(body.mentionDepth ?? 0),
          auto_handoff: 0,
          task_refs: [],
          answers_pending_turn_id: parsed.answeredPendingTurnId ?? null,
          run_id: body.runId ? String(body.runId) : null,
          task_id: body.taskId ? String(body.taskId) : null,
        })

        for (const target of parsed.mentions) {
          if (target.type !== 'human') continue
          const participant = participants.find(
            (p) => p.participant_id === target.participantId,
          )
          if (!participant || participant.kind !== 'human') continue
          requestHumanAttention({
            room_id: room.id,
            task_id: room.task_id,
            requested_by: fromParticipantId,
            target_participant_id: participant.participant_id,
            kind: 'needs_input',
            reason: parsed.text,
            options: [],
            source: 'mention',
            message_id: msg.id,
          })
        }

        publishChatEvent('room_message', {
          roomId: room.id,
          messageId: msg.id,
          senderKind: msg.sender_kind,
        })

        return json({ ok: true, message: msg })
      },
    },
  },
})
