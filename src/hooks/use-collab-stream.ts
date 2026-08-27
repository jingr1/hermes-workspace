import { useEffect, useRef, useState } from 'react'

export type CollabEvent = {
  event: string
  data: Record<string, unknown>
}

export type UseCollabStreamOptions = {
  sessionKey?: string
  roomId?: string
  scope?: string
  /** Called for every matching event. Return false to stop the stream. */
  onEvent: (evt: CollabEvent) => boolean | void
  /** Maximum reconnect delay in ms. Default 30_000. */
  maxDelayMs?: number
  /** Initial reconnect delay in ms. Default 500. */
  initialDelayMs?: number
}

/**
 * SSE hook for /api/collab-events with exponential backoff reconnection.
 * Automatically unsubscribes on unmount.
 */
export function useCollabStream(options: UseCollabStreamOptions): void {
  const {
    sessionKey,
    roomId,
    scope,
    onEvent,
    maxDelayMs = 30_000,
    initialDelayMs = 500,
  } = options

  const onEventRef = useRef(onEvent)
  onEventRef.current = onEvent

  useEffect(() => {
    let eventSource: EventSource | null = null
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null
    let stopped = false
    let delay = initialDelayMs

    const params = new URLSearchParams()
    if (sessionKey) params.set('sessionKey', sessionKey)
    if (roomId) params.set('roomId', roomId)
    if (scope) params.set('scope', scope)
    const url = `/api/collab-events?${params.toString()}`

    const connect = () => {
      if (stopped) return
      eventSource = new EventSource(url)

      eventSource.onmessage = (msg) => {
        try {
          const parsed = JSON.parse(msg.data) as Record<string, unknown>
          const shouldContinue = onEventRef.current({
            event: msg.type,
            data: parsed,
          })
          if (shouldContinue === false) stop()
        } catch {
          // malformed event — ignore
        }
      }

      // Handle named events (e.g. "agent_status", "human_attention", "heartbeat")
      eventSource.onopen = () => {
        delay = initialDelayMs
      }

      eventSource.onerror = () => {
        eventSource?.close()
        if (stopped) return
        reconnectTimer = setTimeout(connect, delay)
        delay = Math.min(delay * 2, maxDelayMs)
      }
    }

    const stop = () => {
      stopped = true
      if (reconnectTimer) clearTimeout(reconnectTimer)
      if (eventSource) eventSource.close()
    }

    connect()

    return stop
  }, [sessionKey, roomId, scope, initialDelayMs, maxDelayMs])
}
