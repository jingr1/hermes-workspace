import { describe, expect, it } from 'vitest'
import {
  createHermesActivityAdapterState,
  hermesSseToActivityEvents,
} from './hermes-activity-adapter'

const ctx = {
  workspaceId: 'ws-1',
  agentSessionId: 'sess-1',
  turnId: 'turn-1',
  runId: null as string | null,
  nowUnixMs: () => 1_700_000_000_000,
}

describe('hermesSseToActivityEvents', () => {
  it('maps started → turn running and allocates durable assistant id on chunks', () => {
    let state = createHermesActivityAdapterState()
    const started = hermesSseToActivityEvents(ctx, state, 'started', {
      runId: 'run-9',
    })
    state = started.state
    expect(started.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ eventType: 'turn_update' }),
        expect.objectContaining({
          eventType: 'message_delta',
          data: expect.objectContaining({
            messageId: 'assistant:run-9',
            content: { operation: 'set', value: '' },
          }),
        }),
      ]),
    )
    const mid = hermesSseToActivityEvents(ctx, state, 'chunk', {
      runId: 'run-9',
      text: 'Hello',
      fullReplace: true,
    })
    state = mid.state
    expect(mid.events).toHaveLength(1)
    expect(mid.events[0]).toMatchObject({
      eventType: 'message_delta',
      data: {
        messageId: 'assistant:run-9',
        kind: 'text',
        content: { operation: 'set', value: 'Hello' },
      },
    })

    const next = hermesSseToActivityEvents(ctx, state, 'chunk', {
      runId: 'run-9',
      text: 'Hello world',
      fullReplace: true,
    })
    expect(next.events[0]).toMatchObject({
      data: {
        messageId: 'assistant:run-9',
        content: { operation: 'append_text', text: ' world' },
      },
    })
  })

  it('keeps pre-seeded pending host across started→runId (no second row)', () => {
    const pendingId = 'assistant:pending:sess-1:c-seed'
    let state = {
      ...createHermesActivityAdapterState(),
      assistantMessageId: pendingId,
      thinkingMessageId: `${pendingId}:thinking`,
    }
    const started = hermesSseToActivityEvents(ctx, state, 'started', {
      runId: 'run-seed',
    })
    state = started.state
    expect(state.assistantMessageId).toBe(pendingId)
    expect(started.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventType: 'message_delta',
          data: expect.objectContaining({
            messageId: pendingId,
            content: { operation: 'set', value: '' },
          }),
        }),
      ]),
    )
    const chunk = hermesSseToActivityEvents(ctx, state, 'chunk', {
      runId: 'run-seed',
      text: 'Answer',
      fullReplace: true,
    })
    expect(chunk.events[0]).toMatchObject({
      data: { messageId: pendingId, content: { operation: 'set', value: 'Answer' } },
    })
    expect(chunk.events.every((e) => {
      if (e.eventType !== 'message_delta') return true
      const id = (e.data as { messageId?: string }).messageId ?? ''
      return !id.startsWith('assistant:run-')
    })).toBe(true)
  })

  it('maps thinking to assistant_thinking / reasoning deltas', () => {
    let state = createHermesActivityAdapterState()
    ;({ state } = hermesSseToActivityEvents(ctx, state, 'started', {
      runId: 'run-t',
    }))
    const out = hermesSseToActivityEvents(ctx, state, 'thinking', {
      runId: 'run-t',
      text: 'Plan A',
    })
    expect(out.events[0]).toMatchObject({
      eventType: 'message_delta',
      data: {
        messageId: 'assistant:run-t:thinking',
        role: 'assistant_thinking',
        kind: 'reasoning',
        content: { operation: 'set', value: 'Plan A' },
      },
    })
  })

  it('maps tool + done to tool_call delta and settled turn', () => {
    let state = createHermesActivityAdapterState()
    ;({ state } = hermesSseToActivityEvents(ctx, state, 'started', {
      runId: 'run-x',
    }))
    const tool = hermesSseToActivityEvents(ctx, state, 'tool', {
      runId: 'run-x',
      name: 'read_file',
      toolCallId: 'tc-1',
      phase: 'complete',
      result: 'ok',
    })
    state = tool.state
    expect(tool.events[0]).toMatchObject({
      eventType: 'message_delta',
      data: {
        messageId: 'toolcall:tc-1',
        kind: 'tool_call',
        status: 'completed',
      },
    })

    const done = hermesSseToActivityEvents(ctx, state, 'done', {
      runId: 'run-x',
      state: 'complete',
    })
    expect(done.events[0]).toMatchObject({
      eventType: 'turn_update',
      data: {
        turn: {
          turnId: 'turn-1',
          phase: 'settled',
          outcome: 'completed',
        },
      },
    })
  })

  it('maps approval SSE to a pending interaction_update', () => {
    let state = createHermesActivityAdapterState()
    ;({ state } = hermesSseToActivityEvents(ctx, state, 'started', {
      runId: 'run-appr',
    }))
    const out = hermesSseToActivityEvents(ctx, state, 'approval', {
      event: 'approval.request',
      run_id: 'run-appr',
      approval_id: 'appr-9',
      command: 'echo hi',
      description: 'Safe',
      choices: ['once', 'deny'],
    })
    expect(out.events).toHaveLength(1)
    expect(out.events[0]).toMatchObject({
      eventType: 'interaction_update',
      data: {
        interaction: {
          kind: 'approval',
          status: 'pending',
          requestId: 'appr-9',
          turnId: 'turn-1',
          metadata: { hermesRunId: 'run-appr' },
        },
      },
    })
  })
})
