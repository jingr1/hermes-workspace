import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createAgentActivitySnapshotProjector,
  createAgentActivityWorkspaceEventCoordinator,
  selectEngineActiveTurn,
} from '@agorax/agent-activity-core'
import {
  createHermesAgentEngine,
  createHermesCommandPort,
  createHermesSessionSkeleton,
  hydrateHermesAgentEngine,
  selectHermesChatState,
} from './hermes-agent-engine'
import type { AgoraxRunMapping } from '@/server/agent-runtime/hermes-native-bridge'

function mappingStore() {
  const map = new Map<string, AgoraxRunMapping>()
  return {
    get: async (id: string) => map.get(id) ?? null,
    put: async (m: AgoraxRunMapping) => {
      map.set(m.agentSessionId, m)
      return m
    },
    map,
  }
}

describe('hermes-agent-engine', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        if (url.includes('/api/sessions') && init?.method === 'POST') {
          return new Response(
            JSON.stringify({
              sessionKey: 'gw-session-1',
              friendlyId: 'friendly-1',
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          )
        }
        if (url.includes('/api/send-stream')) {
          const encoder = new TextEncoder()
          const stream = new ReadableStream({
            start(controller) {
              controller.enqueue(
                encoder.encode(
                  `event: started\ndata: ${JSON.stringify({ runId: 'run-1' })}\n\n`,
                ),
              )
              controller.enqueue(
                encoder.encode(
                  `event: chunk\ndata: ${JSON.stringify({ text: 'hi', fullReplace: true, runId: 'run-1' })}\n\n`,
                ),
              )
              controller.enqueue(
                encoder.encode(
                  `event: done\ndata: ${JSON.stringify({ state: 'complete', runId: 'run-1' })}\n\n`,
                ),
              )
              controller.close()
            },
          })
          return new Response(stream, {
            status: 200,
            headers: {
              'Content-Type': 'text/event-stream',
              'X-Hermes-Session-Key': 'gw-session-1',
            },
          })
        }
        if (url.includes('/api/runs/') && url.includes('/stop')) {
          return new Response(JSON.stringify({ ok: true }), { status: 200 })
        }
        return new Response('not found', { status: 404 })
      }),
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('activate → send → ingest → busy then settle', async () => {
    const store = mappingStore()
    const events: unknown[] = []
    const workspaceId = 'ws-test'
    const commandPort = createHermesCommandPort({
      workspaceId,
      getMapping: store.get,
      putMapping: store.put,
      onActivityEvent: (event) => events.push(event),
    })
    const engine = createHermesAgentEngine({ workspaceId, commandPort })
    const projectSnapshot = createAgentActivitySnapshotProjector(workspaceId)
    const coordinator = createAgentActivityWorkspaceEventCoordinator({
      engine,
      notificationScheduler: {
        schedule(delayMs, task) {
          const timer = setTimeout(task, delayMs)
          return { cancel: () => clearTimeout(timer) }
        },
      },
      readCanonicalSnapshot: () => projectSnapshot(engine.getSnapshot()),
      workspaceId,
    })
    engine.dispatch({
      status: 'connected',
      type: 'engine/connectionChanged',
      workspaceId,
    })

    const activated = await commandPort.effects.activateSession(
      {
        mode: 'new',
        activationId: 'act-1',
        agentSessionId: 'agent-1',
        agentTargetId: 'hermes-native',
        clientSubmitId: 'c-1',
        workspaceId,
      },
      { commandId: 'cmd-act', origin: 'engine' },
    )
    expect(activated.activation.mode).toBe('new')
    hydrateHermesAgentEngine(engine, activated.session)
    expect(store.map.get('agent-1')?.gatewaySessionId).toBe('gw-session-1')

    for (const event of events.splice(0)) {
      coordinator.ingestEvent(event as never)
    }

    const sendPromise = commandPort.effects.sendInput(
      {
        clientSubmitId: 'c-send-1',
        workspaceId,
        agentSessionId: 'agent-1',
        content: [{ type: 'text', text: 'hello' }],
      },
      { commandId: 'cmd-send', origin: 'engine' },
    )

    // Allow microtasks so ingest runs during stream
    await Promise.resolve()
    const result = (await sendPromise) as {
      kind?: 'turn' | 'goalControl'
      turn: { phase: string }
    }
    expect(result.kind === undefined || result.kind === 'turn').toBe(true)
    if (result.kind === 'goalControl') throw new Error('unexpected')
    expect(result.turn.phase).toBe('settled')
    expect(store.map.get('agent-1')?.hermesRunId).toBe('run-1')

    for (const event of events) {
      coordinator.ingestEvent(event as never)
    }

    const chat = selectHermesChatState(engine.getSnapshot(), 'agent-1')
    expect(chat.turnBusy).toBe(false)
    expect(selectEngineActiveTurn(engine.getSnapshot(), 'agent-1')).toBeNull()
    coordinator.dispose()
  })

  it('cancelTurn stops run and settles canceled', async () => {
    const store = mappingStore()
    await store.put({
      agentSessionId: 'agent-2',
      turnId: 'turn-x',
      gatewaySessionId: 'gw-2',
      assignmentId: null,
      hermesRunId: 'run-live',
      bridgeKind: 'hermes-native',
      updatedAtUnixMs: Date.now(),
    })
    const events: unknown[] = []
    const commandPort = createHermesCommandPort({
      workspaceId: 'ws',
      getMapping: store.get,
      putMapping: store.put,
      onActivityEvent: (event) => events.push(event),
    })
    const cancel = await commandPort.effects.cancelTurn(
      {
        workspaceId: 'ws',
        agentSessionId: 'agent-2',
        turnId: 'turn-x',
      },
      { commandId: 'cmd-cancel', origin: 'engine' },
    )
    expect(cancel).toMatchObject({
      cancel: { canceled: true, reason: 'turn_canceled' },
    })
    expect(
      (cancel as { turn?: { outcome?: string } }).turn?.outcome,
    ).toBe('canceled')
    expect(events.some((e) => (e as { eventType?: string }).eventType === 'turn_update')).toBe(
      true,
    )
    expect(String(fetch).length).toBeGreaterThan(0)
    const calls = vi.mocked(fetch).mock.calls.map((c) => String(c[0]))
    expect(calls.some((u) => u.includes('/api/runs/run-live/stop'))).toBe(true)
  })

  it('selectHermesChatState lights busy while submitting', () => {
    const workspaceId = 'ws'
    const commandPort = createHermesCommandPort({
      workspaceId,
      getMapping: async () => null,
      putMapping: async (m) => m,
      onActivityEvent: () => undefined,
    })
    const engine = createHermesAgentEngine({ workspaceId, commandPort })
    hydrateHermesAgentEngine(
      engine,
      createHermesSessionSkeleton({
        workspaceId,
        agentSessionId: 's1',
      }),
    )
    const busy = selectHermesChatState(engine.getSnapshot(), 's1', {
      isSubmitting: true,
    })
    expect(busy.turnBusy).toBe(true)
    const idle = selectHermesChatState(engine.getSnapshot(), 's1')
    expect(idle.turnBusy).toBe(false)
  })
})
