import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../../../server/auth-middleware'
import { dismissPendingTurn } from '../../../../server/group-chat/pending-turns'
import { publishChatEvent } from '../../../../server/chat-event-bus'

export const Route = createFileRoute('/api/pending-turns/$id/dismiss')({
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        if (!isAuthenticated(request)) {
          return json({ ok: false, error: 'Unauthorized' }, { status: 401 })
        }
        const turn = dismissPendingTurn(params.id)
        if (!turn) {
          return json(
            { ok: false, error: 'Pending turn not found' },
            { status: 404 },
          )
        }
        publishChatEvent('pending_turn_dismissed', {
          roomId: turn.room_id,
          pendingTurnId: turn.id,
        })
        return json({ ok: true, turn })
      },
    },
  },
})
