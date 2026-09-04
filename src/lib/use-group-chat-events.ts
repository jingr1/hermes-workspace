import { useCallback, useEffect, useRef, useState } from 'react'

type GroupChatEvent = {
  id: number
  event: string
  data: Record<string, unknown>
  receivedAt: number
}

const MAX_EVENTS = 50

export function useGroupChatEvents(roomId?: string) {
  const [events, setEvents] = useState<Array<GroupChatEvent>>([])
  const [connected, setConnected] = useState(false)
  const esRef = useRef<EventSource | null>(null)

  const pushEvent = useCallback((event: string, data: Record<string, unknown>) => {
    setEvents((prev) => {
      const next = [
        ...prev,
        {
          id: prev.length ? prev[prev.length - 1]!.id + 1 : 1,
          event,
          data,
          receivedAt: Date.now(),
        },
      ]
      if (next.length > MAX_EVENTS) next.splice(0, next.length - MAX_EVENTS)
      return next
    })
  }, [])

  useEffect(() => {
    const url = roomId
      ? `/api/chat-events?roomId=${encodeURIComponent(roomId)}`
      : '/api/chat-events'
    const es = new EventSource(url)
    esRef.current = es

    es.addEventListener('connected', () => setConnected(true))
    es.addEventListener('error', () => setConnected(false))
    es.addEventListener('group_chat_reply', (e) => {
      pushEvent('group_chat_reply', JSON.parse(e.data) as Record<string, unknown>)
    })
    es.addEventListener('group_chat_message', (e) => {
      pushEvent('group_chat_message', JSON.parse(e.data) as Record<string, unknown>)
    })
    es.addEventListener('group_chat_human_attention', (e) => {
      pushEvent('group_chat_human_attention', JSON.parse(e.data) as Record<string, unknown>)
    })
    es.addEventListener('group_chat_human_answered', (e) => {
      pushEvent('group_chat_human_answered', JSON.parse(e.data) as Record<string, unknown>)
    })
    es.addEventListener('group_chat_human_dismissed', (e) => {
      pushEvent('group_chat_human_dismissed', JSON.parse(e.data) as Record<string, unknown>)
    })
    es.addEventListener('group_chat_turn_started', (e) => {
      pushEvent('group_chat_turn_started', JSON.parse(e.data) as Record<string, unknown>)
    })
    es.addEventListener('group_chat_settled', (e) => {
      pushEvent('group_chat_settled', JSON.parse(e.data) as Record<string, unknown>)
    })
    es.addEventListener('group_chat_capped', (e) => {
      pushEvent('group_chat_capped', JSON.parse(e.data) as Record<string, unknown>)
    })
    es.addEventListener('group_chat_turn_ended', (e) => {
      pushEvent('group_chat_turn_ended', JSON.parse(e.data) as Record<string, unknown>)
    })

    return () => {
      es.close()
      esRef.current = null
    }
  }, [roomId, pushEvent])

  return { events, connected }
}
