import { describe, expect, it, vi } from 'vitest'
import { createAgoraxManagedAgentTransport } from './agorax-managed-agent-transport'
import { AgoraxManagedRunStore } from './agorax-managed-run-store'

describe('createAgoraxManagedAgentTransport', () => {
  it('creates a canonical session and projects activity events', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ session: { id: 'session-1', activeTurnId: 'turn-1' } }), { status: 201 }))
    const listeners: Array<(raw: unknown) => void> = []
    const root = `/tmp/agorax-transport-${Date.now()}`
    const transport = createAgoraxManagedAgentTransport({
      baseUrl: 'http://managed-agent.test',
      workspaceId: 'workspace-1',
      fetchImpl,
      runStore: new AgoraxManagedRunStore(root),
      socketFactory: () => ({
        onMessage: (listener) => listeners.push(listener),
        onError: () => undefined,
        close: () => undefined,
      }),
    })

    await transport.startRun({
      backend: 'codex',
      run: { runId: 'run-1', agentId: 'codex', task: 'hello' },
      mcp: { endpoint: 'unused', runToken: 'unused', toolAllowlist: [] },
    })
    const events = transport.streamEvents({ backend: 'codex', runId: 'run-1' })
    listeners[0]!({
      kind: 'event',
      event: {
        topic: 'agent.activity.updated',
        payload: {
          workspaceId: 'workspace-1', agentSessionId: 'session-1', eventType: 'message_delta',
          data: { agentSessionId: 'session-1', messageId: 'message-1', turnId: 'turn-1', role: 'assistant', kind: 'text', content: { operation: 'append_text', text: 'hi' } },
        },
      },
    })
    await expect(events.next()).resolves.toEqual({ value: { type: 'text_delta', runId: 'run-1', text: 'hi' }, done: false })
  })
})