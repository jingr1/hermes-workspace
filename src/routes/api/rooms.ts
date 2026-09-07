import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../server/auth-middleware'
import {
  createRoom,
  listRooms,
} from '../../server/group-chat/room-store'
import { getSwarmMission } from '../../server/swarm-missions'

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
        let body: { title?: string; missionId?: string | null; taskId?: string | null }
        try {
          body = (await request.json()) as typeof body
        } catch {
          return json({ ok: false, error: 'Invalid JSON' }, { status: 400 })
        }
        const title = String(body.title ?? '').trim()
        if (!title) {
          return json({ ok: false, error: 'title required' }, { status: 400 })
        }
        const taskId = body.taskId ?? null
        const existingMission = taskId ? getSwarmMission(taskId) : null
        const room = createRoom({
          title,
          missionId: existingMission ? taskId : (body.missionId ?? null),
          taskId,
        })
        return json({ ok: true, room })
      },
    },
  },
})
