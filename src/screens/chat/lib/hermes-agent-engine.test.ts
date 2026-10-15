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
  ingestHermesUserPromptMessage,
  reconcileHermesHistoryIntoEngine,
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

  it('approval SSE projects pending interaction and respond relays choice', async () => {
    const store = mappingStore()
    await store.put({
      agentSessionId: 'agent-appr',
      turnId: null,
      gatewaySessionId: 'gw-appr',
      assignmentId: null,
      hermesRunId: 'run-appr',
      bridgeKind: 'hermes-native',
      updatedAtUnixMs: Date.now(),
    })
    const fetchMock = vi.mocked(fetch)
    fetchMock.mockImplementation(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        if (url.includes('/api/send-stream')) {
          const encoder = new TextEncoder()
          const stream = new ReadableStream({
            start(controller) {
              controller.enqueue(
                encoder.encode(
                  `event: started\ndata: ${JSON.stringify({ runId: 'run-appr' })}\n\n`,
                ),
              )
              controller.enqueue(
                encoder.encode(
                  `event: approval\ndata: ${JSON.stringify({
                    event: 'approval.request',
                    run_id: 'run-appr',
                    approval_id: 'appr-1',
                    command: 'rm -rf /tmp/x',
                    choices: ['once', 'deny'],
                  })}\n\n`,
                ),
              )
              controller.enqueue(
                encoder.encode(
                  `event: done\ndata: ${JSON.stringify({ state: 'complete', runId: 'run-appr' })}\n\n`,
                ),
              )
              controller.close()
            },
          })
          return new Response(stream, { status: 200 })
        }
        if (url.includes('/api/runs/') && url.includes('/approval')) {
          expect(init?.method).toBe('POST')
          expect(JSON.parse(String(init?.body))).toMatchObject({
            choice: 'once',
            approval_id: 'appr-1',
          })
          return new Response(JSON.stringify({ ok: true }), { status: 200 })
        }
        return new Response('not found', { status: 404 })
      },
    )

    const workspaceId = 'ws-appr'
    let engineRef: ReturnType<typeof createHermesAgentEngine> | null = null
    let coordinatorRef: ReturnType<
      typeof createAgentActivityWorkspaceEventCoordinator
    > | null = null

    const commandPort = createHermesCommandPort({
      workspaceId,
      getMapping: store.get,
      putMapping: store.put,
      onActivityEvent: (event) => {
        coordinatorRef?.ingestEvent(event)
      },
    })
    const engine = createHermesAgentEngine({ workspaceId, commandPort })
    engineRef = engine
    const projectSnapshot = createAgentActivitySnapshotProjector(workspaceId)
    coordinatorRef = createAgentActivityWorkspaceEventCoordinator({
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
    hydrateHermesAgentEngine(
      engine,
      createHermesSessionSkeleton({
        workspaceId,
        agentSessionId: 'agent-appr',
        providerSessionId: 'gw-appr',
      }),
    )

    await commandPort.effects.sendInput(
      {
        workspaceId,
        agentSessionId: 'agent-appr',
        clientSubmitId: 'submit-appr',
        content: [{ type: 'text', text: 'please run' }],
      },
      { commandId: 'cmd-appr', origin: 'engine', signal: undefined },
    )

    const chat = selectHermesChatState(engine.getSnapshot(), 'agent-appr')
    expect(chat.interactions.map((i) => i.requestId)).toContain('appr-1')
    const turnId = chat.interactions[0]!.turnId

    const accepted = engine.submitInteractionResponse({
      agentSessionId: 'agent-appr',
      turnId,
      requestId: 'appr-1',
      optionId: 'once',
    })
    expect(accepted).toBe(true)

    await vi.waitFor(() => {
      const after = selectHermesChatState(engineRef!.getSnapshot(), 'agent-appr')
      expect(
        after.interactions.find((i) => i.requestId === 'appr-1'),
      ).toBeUndefined()
    })
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

  it('reconcileHermesHistoryIntoEngine hydrates list from history ids', () => {
    const workspaceId = 'ws'
    const commandPort = createHermesCommandPort({
      workspaceId,
      getMapping: async () => null,
      putMapping: async (m) => m,
      onActivityEvent: () => undefined,
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
    const count = reconcileHermesHistoryIntoEngine({
      engine,
      coordinator,
      workspaceId,
      agentSessionId: 'hist-1',
      historyMessages: [
        {
          role: 'user',
          id: 'u1',
          content: [{ type: 'text', text: 'ping' }],
          timestamp: 1,
        },
        {
          role: 'assistant',
          id: 'assistant:run-h',
          messageId: 'assistant:run-h',
          content: [{ type: 'text', text: 'pong' }],
          timestamp: 2,
        },
      ],
    })
    expect(count).toBe(2)
    const chat = selectHermesChatState(engine.getSnapshot(), 'hist-1', {
      sessionMessages: coordinator.project(projectSnapshot(engine.getSnapshot()))
        .sessionMessagesById['hist-1'],
    })
    expect(chat.messages.map((m) => m.id)).toEqual(['u1', 'assistant:run-h'])
    expect(chat.messages[1]?.content).toEqual([{ type: 'text', text: 'pong' }])
    coordinator.dispose()
  })

  it('reconcileHermesHistoryIntoEngine retains live Engine rows missing from stale history', () => {
    const workspaceId = 'ws'
    const commandPort = createHermesCommandPort({
      workspaceId,
      getMapping: async () => null,
      putMapping: async (m) => m,
      onActivityEvent: () => undefined,
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
    ingestHermesUserPromptMessage({
      engine,
      workspaceId,
      agentSessionId: 'stale-1',
      clientSubmitId: 'fresh',
      text: 'new prompt',
    })
    const count = reconcileHermesHistoryIntoEngine({
      engine,
      coordinator,
      workspaceId,
      agentSessionId: 'stale-1',
      historyMessages: [
        {
          role: 'user',
          id: 'old-u',
          content: [{ type: 'text', text: 'old' }],
          timestamp: 1,
        },
      ],
    })
    expect(count).toBe(2)
    const chat = selectHermesChatState(engine.getSnapshot(), 'stale-1', {
      sessionMessages: coordinator.project(projectSnapshot(engine.getSnapshot()))
        .sessionMessagesById['stale-1'],
    })
    expect(chat.messages.map((m) => m.id)).toEqual(['old-u', 'user:fresh'])
    // Same text under a gateway id collapses the optimistic user row.
    reconcileHermesHistoryIntoEngine({
      engine,
      coordinator,
      workspaceId,
      agentSessionId: 'stale-1',
      historyMessages: [
        {
          role: 'user',
          id: 'old-u',
          content: [{ type: 'text', text: 'old' }],
          timestamp: 1,
        },
        {
          role: 'user',
          id: 'gw-user',
          content: [{ type: 'text', text: 'new prompt' }],
          timestamp: 2,
        },
      ],
    })
    const after = selectHermesChatState(engine.getSnapshot(), 'stale-1')
    expect(after.messages.map((m) => m.id)).toEqual(['old-u', 'gw-user'])
    coordinator.dispose()
  })

  it('ingestHermesUserPromptMessage seeds Engine user row', () => {
    const workspaceId = 'ws'
    const commandPort = createHermesCommandPort({
      workspaceId,
      getMapping: async () => null,
      putMapping: async (m) => m,
      onActivityEvent: () => undefined,
    })
    const engine = createHermesAgentEngine({ workspaceId, commandPort })
    ingestHermesUserPromptMessage({
      engine,
      workspaceId,
      agentSessionId: 'send-1',
      clientSubmitId: 'c-99',
      text: 'hello engine',
    })
    const chat = selectHermesChatState(engine.getSnapshot(), 'send-1')
    expect(chat.messages).toEqual([
      expect.objectContaining({
        id: 'user:c-99',
        role: 'user',
        content: [{ type: 'text', text: 'hello engine' }],
      }),
    ])
  })
})
