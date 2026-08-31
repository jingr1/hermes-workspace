import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../../../server/auth-middleware'
import { getRoom } from '../../../../server/group-chat/room-store'
import { generateSummaryFromRoomWithLlm } from '../../../../server/group-chat/room-summaries'

export const Route = createFileRoute('/api/rooms/$roomId/summarize')({
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

        const summary = await generateSummaryFromRoomWithLlm(room.id)
        return json({ ok: true, summary })
      },
    },
  },
})
