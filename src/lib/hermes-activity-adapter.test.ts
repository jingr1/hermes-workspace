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
    ;({ state } = hermesSseToActivityEvents(ctx, state, 'started', {
      runId: 'run-9',
    }))
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
        content: { operation: 'append_text', text: 'Hello' },
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
        content: { operation: 'append_text', text: 'Plan A' },
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
})
