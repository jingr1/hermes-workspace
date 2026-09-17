import { createFileRoute } from '@tanstack/react-router'
import { isAuthenticated } from '../../../../../../../server/auth-middleware'
import WebSocket from 'ws'

export const Route = createFileRoute('/api/agents/$agentId/engine/session/$sessionId/events')({
  server: { handlers: { GET: async ({ request, params }) => {
    if (!isAuthenticated(request)) return new Response('Unauthorized', { status: 401 })
    const baseUrl = process.env.AGORAX_MANAGED_AGENT_URL?.trim()
    if (!baseUrl) return new Response('Managed Agent transport is not configured', { status: 503 })
    const encoder = new TextEncoder()
    let socket: WebSocket | null = null
    return new Response(new ReadableStream({
      start(controller) {
        socket = new WebSocket(baseUrl.replace(/\/+$/, '').replace(/^http/, 'ws') + '/v1/events/ws')
        socket.on('message', (raw) => {
          try {
            const frame = JSON.parse(String(raw)) as { event?: { payload?: { agentSessionId?: string } } }
            if (frame.event?.payload?.agentSessionId !== params.sessionId) return
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'activity_changed' })}\n\n`))
          } catch { /* malformed daemon frame */ }
        })
        socket.on('error', () => controller.close())
        socket.on('close', () => controller.close())
        request.signal.addEventListener('abort', () => socket?.close(), { once: true })
      },
      cancel() { socket?.close() },
    }), { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' } })
  } } },
})
