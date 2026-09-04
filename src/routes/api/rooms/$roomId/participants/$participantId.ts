import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../../../../server/auth-middleware'
import {
  getParticipant,
  getRoom,
  removeParticipant,
} from '../../../../../server/group-chat/room-store'

export const Route = createFileRoute(
  '/api/rooms/$roomId/participants/$participantId',
)({
  server: {
    handlers: {
      DELETE: async ({ request, params }) => {
        if (!isAuthenticated(request)) {
          return json({ ok: false, error: 'Unauthorized' }, { status: 401 })
        }
        const room = getRoom(params.roomId)
        if (!room) {
          return json({ ok: false, error: 'Not found' }, { status: 404 })
        }
        const participant = getParticipant(params.participantId)
        if (!participant || participant.roomId !== params.roomId) {
          return json({ ok: false, error: 'Not found' }, { status: 404 })
        }
        removeParticipant(params.participantId)
        return json({ ok: true })
      },
    },
  },
})
