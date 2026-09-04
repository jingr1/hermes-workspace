import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../../server/auth-middleware'
import {
  deleteRoom,
  getRoom,
  updateRoom,
} from '../../../server/group-chat/room-store'

export const Route = createFileRoute('/api/rooms/$roomId')({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        if (!isAuthenticated(request)) {
          return json({ ok: false, error: 'Unauthorized' }, { status: 401 })
        }
        const room = getRoom(params.roomId)
        if (!room) {
          return json({ ok: false, error: 'Not found' }, { status: 404 })
        }
        return json({ ok: true, room })
      },
      PATCH: async ({ request, params }) => {
        if (!isAuthenticated(request)) {
          return json({ ok: false, error: 'Unauthorized' }, { status: 401 })
        }
        let body: Record<string, unknown>
        try {
          body = (await request.json()) as Record<string, unknown>
        } catch {
          return json({ ok: false, error: 'Invalid JSON' }, { status: 400 })
        }
        const patch: Record<string, unknown> = {}
        if (typeof body.title === 'string') patch.title = body.title
        if (typeof body.state === 'string') patch.state = body.state
        if (body.missionId !== undefined) patch.missionId = body.missionId
        if (body.taskId !== undefined) patch.taskId = body.taskId
        const room = updateRoom(params.roomId, patch)
        if (!room) {
          return json({ ok: false, error: 'Not found' }, { status: 404 })
        }
        return json({ ok: true, room })
      },
      DELETE: async ({ request, params }) => {
        if (!isAuthenticated(request)) {
          return json({ ok: false, error: 'Unauthorized' }, { status: 401 })
        }
        deleteRoom(params.roomId)
        return json({ ok: true })
      },
    },
  },
})
