import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../../../server/auth-middleware'
import { getAgentRuntimeRouter } from '../../../../server/agent-runtime/router'
import {
  addParticipant,
  getRoom,
  listParticipants,
} from '../../../../server/group-chat/room-store'
import { GROUP_CHAT_MAX_MEMBERS } from '../../../../server/group-chat/constants'
import type { RoomRuntime } from '../../../../server/group-chat/types'

const MANAGED_RUNTIMES = new Set<RoomRuntime>([
  'claude-code',
  'codex',
  'deepseek-harness',
])

function resolveParticipantRuntime(
  participantId: string,
  bodyRuntime: string | undefined,
): RoomRuntime {
  if (
    bodyRuntime === 'claude-code' ||
    bodyRuntime === 'codex' ||
    bodyRuntime === 'deepseek-harness' ||
    bodyRuntime === 'hermes'
  ) {
    return bodyRuntime
  }
  const decl = getAgentRuntimeRouter().registry.agents.find(
    (a) => a.id === participantId,
  )
  if (
    decl &&
    (decl.runtime === 'claude-code' ||
      decl.runtime === 'codex' ||
      decl.runtime === 'deepseek-harness' ||
      decl.runtime === 'hermes')
  ) {
    return decl.runtime
  }
  return 'hermes'
}

export const Route = createFileRoute('/api/rooms/$roomId/participants')({
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
        return json({
          ok: true,
          room,
          participants: listParticipants(params.roomId),
        })
      },
      POST: async ({ request, params }) => {
        if (!isAuthenticated(request)) {
          return json({ ok: false, error: 'Unauthorized' }, { status: 401 })
        }
        const room = getRoom(params.roomId)
        if (!room) {
          return json({ ok: false, error: 'Not found' }, { status: 404 })
        }
        const current = listParticipants(params.roomId)
        if (current.length >= GROUP_CHAT_MAX_MEMBERS) {
          return json(
            { ok: false, error: 'Room member limit reached' },
            { status: 400 },
          )
        }
        let body: {
          participantId?: string
          displayName?: string
          mentionName?: string
          profile?: string | null
          runtime?: string
          kind?: 'human' | 'agent'
        }
        try {
          body = (await request.json()) as typeof body
        } catch {
          return json({ ok: false, error: 'Invalid JSON' }, { status: 400 })
        }
        const participantId = String(body.participantId ?? '').trim()
        if (!participantId) {
          return json(
            { ok: false, error: 'participantId required' },
            { status: 400 },
          )
        }
        const kind = body.kind === 'human' ? 'human' : 'agent'
        const runtime = resolveParticipantRuntime(participantId, body.runtime)
        const decl = getAgentRuntimeRouter().registry.agents.find(
          (a) => a.id === participantId,
        )
        // Managed agents never carry a Hermes profile (agent id is not a gateway).
        const profile = MANAGED_RUNTIMES.has(runtime)
          ? null
          : body.profile === null
            ? null
            : String(body.profile ?? decl?.profile ?? '').trim() || null
        const participant = addParticipant({
          roomId: params.roomId,
          kind,
          participantId,
          displayName: body.displayName ?? decl?.displayName,
          mentionName: body.mentionName ?? decl?.mentionName,
          profile,
          runtime,
        })
        return json({ ok: true, room, participant })
      },
    },
  },
})
