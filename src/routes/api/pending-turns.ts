import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../server/auth-middleware'
import {
  expireStalePendingTurns,
  getPendingTurns,
} from '../../server/group-chat/pending-turns'

export const Route = createFileRoute('/api/pending-turns')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return json({ ok: false, error: 'Unauthorized' }, { status: 401 })
        }
        const url = new URL(request.url)
        const status = url.searchParams.get('status') as
          | 'pending'
          | 'answered'
          | 'dismissed'
          | 'expired'
          | null
        const roomId = url.searchParams.get('roomId') ?? undefined
        await expireStalePendingTurns()
        return json({
          ok: true,
          turns: getPendingTurns({ status: status ?? undefined, roomId }),
        })
      },
    },
  },
})
