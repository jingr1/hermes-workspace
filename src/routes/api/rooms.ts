import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../server/auth-middleware'
import { createRoom, listRooms } from '../../server/group-chat/room-store'

export const Route = createFileRoute('/api/rooms')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return json({ ok: false, error: 'Unauthorized' }, { status: 401 })
        }
        return json({ ok: true, rooms: listRooms() })
      },
      POST: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return json({ ok: false, error: 'Unauthorized' }, { status: 401 })
        }
        const body = await request.json().catch(() => ({}))
        const room = createRoom({
          title: body.title ? String(body.title) : undefined,
          taskId: body.taskId ? String(body.taskId) : undefined,
          missionId: body.missionId ? String(body.missionId) : undefined,
        })
        return json({ ok: true, room }, { status: 201 })
      },
    },
  },
})
