import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../../server/auth-middleware'
import { getRoom, listRoomMessages } from '../../../server/group-chat/room-store'
import { getParticipants } from '../../../server/group-chat/participants'

export const Route = createFileRoute('/api/rooms/$roomId')({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        if (!isAuthenticated(request)) {
          return json({ ok: false, error: 'Unauthorized' }, { status: 401 })
        }
        const room = getRoom(params.roomId)
        if (!room) {
          return json({ ok: false, error: 'Room not found' }, { status: 404 })
        }
        return json({
          ok: true,
          room,
          participants: getParticipants(room.id),
          messages: listRoomMessages(room.id),
        })
      },
    },
  },
})
