import { describe, expect, it } from 'vitest'
import {
  collapseAdjacentAssistantEchoes,
  projectActivityMessagesToChat,
} from './activity-list-projection'
import type { ChatMessage } from '../types'

describe('collapseAdjacentAssistantEchoes', () => {
  it('keeps richer pending host when a suffix echo follows', () => {
    const long =
      'Cross-compile is done. Multi-model still crashes on deinit. Integrate or fix crash first?'
    const collapsed = collapseAdjacentAssistantEchoes([
      {
        id: 'assistant:pending:s:c1',
        messageId: 'assistant:pending:s:c1',
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'check report' },
          { type: 'text', text: `I need to check.\n\n${long}` },
        ],
        timestamp: 1,
      } as ChatMessage,
      {
        id: 'msg-9',
        messageId: 'msg-9',
        role: 'assistant',
        content: [{ type: 'text', text: long }],
        timestamp: 2,
      } as ChatMessage,
    ])
    expect(collapsed).toHaveLength(1)
    expect(collapsed[0]?.id).toBe('assistant:pending:s:c1')
    expect(collapsed[0]?.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'thinking' }),
        expect.objectContaining({ type: 'text' }),
      ]),
    )
  })
})

describe('projectActivityMessagesToChat', () => {
  it('folds pending + runId text of the same turn into one host', () => {
    const messages = projectActivityMessagesToChat([
      {
        workspaceId: 'ws',
        agentSessionId: 's',
        messageId: 'user:c1',
        turnId: 'turn-c1',
        role: 'user',
        kind: 'text',
        payload: { text: 'hi' },
        version: 1,
        sequence: 1,
        occurredAtUnixMs: 1,
      },
      {
        workspaceId: 'ws',
        agentSessionId: 's',
        messageId: 'assistant:pending:s:c1',
        turnId: 'turn-c1',
        role: 'assistant',
        kind: 'text',
        status: 'streaming',
        payload: { text: '' },
        version: 2,
        sequence: 2,
        occurredAtUnixMs: 2,
      },
      {
        workspaceId: 'ws',
        agentSessionId: 's',
        messageId: 'assistant:run-9',
        turnId: 'turn-c1',
        role: 'assistant',
        kind: 'text',
        status: 'streaming',
        payload: { text: 'hello from run' },
        version: 3,
        sequence: 3,
        occurredAtUnixMs: 3,
      },
    ])
    expect(messages.map((m) => m.id)).toEqual([
      'user:c1',
      'assistant:pending:s:c1',
    ])
    expect(messages[1]?.content).toEqual([
      { type: 'text', text: 'hello from run' },
    ])
  })
})
