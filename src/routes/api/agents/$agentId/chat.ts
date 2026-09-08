import { createFileRoute } from '@tanstack/react-router'
import { isAuthenticated } from '../../../../server/auth-middleware'
import { getAgentRuntimeRouter } from '../../../../server/agent-runtime/router'
import { getMcpEndpoint } from '../../../../server/agent-runtime/dispatch'
import { issueRunToken } from '../../../../server/mcp/run-tokens'
import { createCollabId } from '../../../../server/collab-db'
import { publishChatEvent } from '../../../../server/chat-event-bus'
import type { AgentStreamEvent } from '../../../../server/agent-runtime/types'

/**
 * POST /api/agents/:agentId/chat
 *
 * Chat endpoint for managed non-Hermes runtimes (claude-code today, codex
 * tomorrow). Starts a single one-shot agent run and streams the adapter
 * events back as SSE.
 *
 * Body: {
 *   message: string,
 *   sessionId?: string,
 *   history?: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>
 * }
 *
 * SSE events:
 *   connected  { runId, agentId, sessionId }
 *   text_delta { runId, text }
 *   thinking   { runId, text }
 *   tool       { runId, phase, name, args }
 *   error      { runId, message }
 *   run_exited { runId, exitCode }
 */
export const Route = createFileRoute('/api/agents/$agentId/chat')({
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        if (!isAuthenticated(request)) {
          return new Response(
            JSON.stringify({ ok: false, error: 'Unauthorized' }),
            { status: 401, headers: { 'Content-Type': 'application/json' } },
          )
        }

        const agentId =
          typeof params.agentId === 'string' ? params.agentId.trim() : ''
        if (!agentId) {
          return new Response(
            JSON.stringify({ ok: false, error: 'agentId is required' }),
            { status: 400, headers: { 'Content-Type': 'application/json' } },
          )
        }

        let body: Record<string, unknown> = {}
        try {
          const raw = await request.text()
          body = JSON.parse(raw) as Record<string, unknown>
        } catch {
          return new Response(
            JSON.stringify({ ok: false, error: 'invalid JSON body' }),
            { status: 400, headers: { 'Content-Type': 'application/json' } },
          )
        }

        const message = String(body.message ?? '').trim()
        if (!message) {
          return new Response(
            JSON.stringify({ ok: false, error: 'message is required' }),
            { status: 400, headers: { 'Content-Type': 'application/json' } },
          )
        }

        const requestedModel =
          typeof body.model === 'string' ? body.model.trim() : ''

        const sessionId =
          typeof body.sessionId === 'string' ? body.sessionId.trim() : ''
        const rawHistory = body.history
        const historyLines: Array<string> = []
        if (Array.isArray(rawHistory)) {
          for (const entry of rawHistory) {
            if (!entry || typeof entry !== 'object') continue
            const role = String((entry as Record<string, unknown>).role ?? '')
            const content = String(
              (entry as Record<string, unknown>).content ?? '',
            ).trim()
            if (!content) continue
            if (role === 'user') {
              historyLines.push(`User: ${content}`)
            } else if (role === 'assistant') {
              historyLines.push(`Assistant: ${content}`)
            } else if (role === 'system') {
              historyLines.push(`System: ${content}`)
            }
          }
        }

        const router = getAgentRuntimeRouter()
        const adapter = router.getAdapter(agentId)
        if (!adapter) {
          return new Response(
            JSON.stringify({ ok: false, error: `agent not found: ${agentId}` }),
            { status: 404, headers: { 'Content-Type': 'application/json' } },
          )
        }
        if (adapter.kind === 'hermes') {
          return new Response(
            JSON.stringify({
              ok: false,
              error: 'hermes agents use /api/send-stream, not this endpoint',
            }),
            { status: 400, headers: { 'Content-Type': 'application/json' } },
          )
        }

        const probe = await adapter.probe()
        if (!probe.available) {
          return new Response(
            JSON.stringify({
              ok: false,
              error: probe.detail || `agent ${agentId} is not available`,
            }),
            {
              status: 503,
              headers: { 'Content-Type': 'application/json' },
            },
          )
        }

        const runId = createCollabId('run')
        const chatSessionId = sessionId || `cc-${Date.now()}`

        const promptParts: Array<string> = []
        if (historyLines.length > 0) {
          promptParts.push('Here is the conversation history:')
          promptParts.push(...historyLines)
          promptParts.push('')
        }
        promptParts.push(`User: ${message}`)
        promptParts.push(
          'Reply directly to the user. You may use Hermes tools via MCP if helpful.',
        )
        const task = promptParts.join('\n')

        // Issue a read/write token so the agent can call Hermes MCP tools.
        const { token } = issueRunToken({
          kind: 'run_write',
          runId,
          participantId: agentId,
          assignmentId: null,
          taskId: chatSessionId,
          roomId: null,
          toolAllowlist: ['task_start', 'task_complete'],
        })

        try {
          await adapter.startRun({
            runId,
            agentId,
            task,
            ...(requestedModel ? { model: requestedModel } : {}),
            mcp: {
              endpoint: getMcpEndpoint(),
              runToken: token,
              toolAllowlist: ['task_start', 'task_complete'],
            },
          })
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error)
          return new Response(
            JSON.stringify({ ok: false, error: `spawn failed: ${detail}` }),
            { status: 500, headers: { 'Content-Type': 'application/json' } },
          )
        }

        publishChatEvent('agent_chat_started', {
          runId,
          agentId,
          sessionId: chatSessionId,
        })

        const encoder = new TextEncoder()

        const stream = new ReadableStream({
          async start(controller) {
            let streamClosed = false
            let heartbeatTimer: ReturnType<typeof setInterval> | null = null

            const sendEvent = (
              event: string,
              data: Record<string, unknown>,
            ) => {
              if (streamClosed) return
              try {
                const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
                controller.enqueue(encoder.encode(payload))
              } catch {
                streamClosed = true
              }
            }

            const closeStream = () => {
              if (streamClosed) return
              streamClosed = true
              if (heartbeatTimer) {
                clearInterval(heartbeatTimer)
                heartbeatTimer = null
              }
              try {
                controller.close()
              } catch {
                /* ignore */
              }
            }

            request.signal.addEventListener(
              'abort',
              () => {
                void adapter.interrupt(runId, 'client disconnected')
                closeStream()
              },
              { once: true },
            )

            sendEvent('connected', {
              type: 'connected',
              runId,
              agentId,
              sessionId: chatSessionId,
            })

            // Keep under common idle proxies (e.g. 15s); first model token
            // can take longer than that on slower models (Sonnet).
            heartbeatTimer = setInterval(() => {
              sendEvent('heartbeat', {
                type: 'heartbeat',
                timestamp: Date.now(),
              })
            }, 10_000)

            try {
              for await (const event of adapter.streamEvents(runId)) {
                if (streamClosed) break
                relayEvent(sendEvent, event)
                // Only the terminal exit ends the SSE stream. Non-fatal
                // adapter `error` events (e.g. stderr diagnostics) must not
                // abort consumption — text_delta often arrives after them.
                if (event.type === 'run_exited') {
                  setTimeout(closeStream, 50)
                  break
                }
              }
            } catch (error) {
              const detail =
                error instanceof Error ? error.message : String(error)
              sendEvent('error', { runId, message: detail })
              closeStream()
            } finally {
              if (heartbeatTimer) {
                clearInterval(heartbeatTimer)
                heartbeatTimer = null
              }
              // Ensure final close if the iterator ended without run_exited.
              setTimeout(closeStream, 100)
            }
          },
        })

        return new Response(stream, {
          headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache, no-transform',
            Connection: 'keep-alive',
            'X-Accel-Buffering': 'no',
          },
        })
      },
    },
  },
})

function relayEvent(
  send: (event: string, data: Record<string, unknown>) => void,
  event: AgentStreamEvent,
): void {
  switch (event.type) {
    case 'run_started':
      send('run_started', {
        type: 'run_started',
        runId: event.runId,
        agentId: event.agentId,
        taskId: event.taskId,
        roomId: event.roomId,
      })
      break
    case 'text_delta':
      send('text_delta', {
        type: 'text_delta',
        runId: event.runId,
        text: event.text,
      })
      break
    case 'thinking':
      send('thinking', {
        type: 'thinking',
        runId: event.runId,
        text: event.text,
      })
      break
    case 'tool':
      send('tool', {
        type: 'tool',
        runId: event.runId,
        phase: event.phase,
        name: event.name,
        args: event.args,
      })
      break
    case 'run_exited':
      send('run_exited', {
        type: 'run_exited',
        runId: event.runId,
        exitCode: event.exitCode,
      })
      break
    case 'error':
      send('error', {
        type: 'error',
        runId: event.runId,
        message: event.message,
      })
      break
  }
}
