import { listRoomMessages } from './room-store'
import { getRoomSummary } from './room-summaries'

export const CONTEXT_TAIL_COUNT = 200

export type ProjectedContext = {
  roomId: string
  summary: string | null
  tail: Array<{
    id: string
    senderName: string
    senderKind: string
    content: string
    createdAt: number
  }>
  hasMore: boolean
  totalMessages: number
}

export function buildRoomContext(roomId: string): ProjectedContext {
  const summary = getRoomSummary(roomId)
  const after = summary?.through_at ?? 0

  const allTail = listRoomMessages(roomId, {
    after,
    limit: CONTEXT_TAIL_COUNT + 1,
  })
  const hasMore = allTail.length > CONTEXT_TAIL_COUNT
  const tail = allTail.slice(0, CONTEXT_TAIL_COUNT).map((m) => ({
    id: m.id,
    senderName: m.sender_name,
    senderKind: m.sender_kind,
    content: m.content,
    createdAt: m.created_at,
  }))

  return {
    roomId,
    summary: summary?.summary ?? null,
    tail,
    hasMore,
    totalMessages: tail.length + (summary?.turn_count ?? 0),
  }
}

export function projectContextForAgent(
  roomId: string,
  agentName: string,
): string {
  const ctx = buildRoomContext(roomId)
  const parts: string[] = []
  if (ctx.summary) {
    parts.push(`[Summary]\n${ctx.summary}`)
  }
  if (ctx.tail.length > 0) {
    parts.push(`[Recent messages (${ctx.tail.length})]`)
    for (const m of ctx.tail) {
      parts.push(`${m.senderName}: ${m.content}`)
    }
  } else if (!ctx.summary) {
    parts.push('No messages yet.')
  }
  parts.push(`\n@${agentName}: `)
  return parts.join('\n')
}
