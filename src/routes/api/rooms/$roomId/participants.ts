import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../../../server/auth-middleware'
import { getRoom } from '../../../../server/group-chat/room-store'
import {
  addParticipant,
  getParticipants,
  removeParticipant,
} from '../../../../server/group-chat/participants'

export const Route = createFileRoute('/api/rooms/$roomId/participants')({
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
        return json({ ok: true, participants: getParticipants(room.id) })
      },
      POST: async ({ request, params }) => {
        if (!isAuthenticated(request)) {
          return json({ ok: false, error: 'Unauthorized' }, { status: 401 })
        }
        const room = getRoom(params.roomId)
        if (!room) {
          return json({ ok: false, error: 'Room not found' }, { status: 404 })
        }
        const body = await request.json().catch(() => ({}))
        const participant = addParticipant(room.id, {
          kind: body.kind === 'agent' ? 'agent' : 'human',
          participant_id: String(body.participantId ?? body.id ?? ''),
          display_name: String(body.displayName ?? body.display_name ?? ''),
          mention_name: String(body.mentionName ?? body.mention_name ?? ''),
          description: body.description ? String(body.description) : null,
          runtime: body.runtime || null,
        })
        return json({ ok: true, participant })
      },
    },
  },
})

export function handleGetParticipants(
  request: Request,
  roomId: string,
): Response {
  if (!isAuthenticated(request)) {
    return json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  }
  const room = getRoom(roomId)
  if (!room) {
    return json({ ok: false, error: 'Room not found' }, { status: 404 })
  }
  return json({ ok: true, participants: getParticipants(room.id) })
}
