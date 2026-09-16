import { describe, expect, it } from 'vitest'
import { agoraxEventsFromManagedActivity } from './agorax-managed-agent-events'

describe('agoraxEventsFromManagedActivity', () => {
  it('projects assistant message deltas as text events', () => {
    expect(
      agoraxEventsFromManagedActivity('run-1', {
        eventType: 'message_delta',
        data: {
          agentSessionId: 'session-1',
          messageId: 'message-1',
          turnId: 'turn-1',
          role: 'assistant',
          kind: 'text',
          content: { operation: 'append_text', text: 'hello' },
        },
      }),
    ).toEqual([{ type: 'text_delta', runId: 'run-1', text: 'hello' }])
  })

  it('does not expose user or empty message deltas', () => {
    expect(
      agoraxEventsFromManagedActivity('run-1', {
        eventType: 'message_delta',
        data: {
          agentSessionId: 'session-1',
          messageId: 'message-1',
          turnId: 'turn-1',
          role: 'user',
          kind: 'text',
          content: { operation: 'append_text', text: 'prompt' },
        },
      }),
    ).toEqual([])
  })

  it('only projects a settled canonical turn as terminal', () => {
    const running = agoraxEventsFromManagedActivity('run-1', {
      eventType: 'turn_update',
      data: {
        agentSessionId: 'session-1',
        activeTurnId: 'turn-1',
        turn: { turnId: 'turn-1', phase: 'running', outcome: null },
      },
    })
    const failed = agoraxEventsFromManagedActivity('run-1', {
      eventType: 'turn_update',
      data: {
        agentSessionId: 'session-1',
        activeTurnId: null,
        turn: { turnId: 'turn-1', phase: 'settled', outcome: 'failed' },
      },
    })

    expect(running).toEqual([])
    expect(failed).toEqual([{ type: 'run_exited', runId: 'run-1', exitCode: 1 }])
  })
})