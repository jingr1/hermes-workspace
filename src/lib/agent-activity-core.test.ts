import { describe, expect, it } from 'vitest'
import {
  applyAgentActivityEvent,
  createAgentActivitySnapshot,
} from './agent-activity-core'

describe('agent activity core', () => {
  it('projects message deltas and preserves a terminal turn outcome', () => {
    const snapshot = createAgentActivitySnapshot({
      workspaceId: 'workspace-1',
      agentSessionId: 'session-1',
    })
    const withMessage = applyAgentActivityEvent(snapshot, {
      eventType: 'message_delta',
      data: {
        agentSessionId: 'session-1',
        messageId: 'message-1',
        turnId: 'turn-1',
        role: 'assistant',
        kind: 'text',
        content: { operation: 'append_text', text: 'hello' },
      },
    })
    const settled = applyAgentActivityEvent(withMessage, {
      eventType: 'turn_update',
      data: {
        agentSessionId: 'session-1',
        activeTurnId: null,
        turn: { turnId: 'turn-1', phase: 'settled', outcome: 'completed' },
      },
    })
    const replayed = applyAgentActivityEvent(settled, {
      eventType: 'turn_update',
      data: {
        agentSessionId: 'session-1',
        activeTurnId: 'turn-1',
        turn: { turnId: 'turn-1', phase: 'running', outcome: null },
      },
    })

    expect(replayed.messagesById['message-1']?.content).toBe('hello')
    expect(replayed.turnsById['turn-1']).toEqual({
      turnId: 'turn-1',
      phase: 'settled',
      outcome: 'completed',
    })
  })
})