import { describe, expect, it } from 'vitest'
import {
  assistantMessageIdForRun,
  projectLiveAssistantMessage,
  readDurableMessageId,
  stableChatMessageKey,
  upsertMessageByDurableId,
} from './chat-turn-identity'

describe('assistantMessageIdForRun', () => {
  it('uses runId when present', () => {
    expect(assistantMessageIdForRun('run-abc', 'sess')).toBe('assistant:run-abc')
  })

  it('falls back to pending session key', () => {
    expect(assistantMessageIdForRun(null, 'sess-1')).toBe(
      'assistant:pending:sess-1',
    )
  })
})

describe('upsertMessageByDurableId', () => {
  it('replaces the same durable row instead of appending', () => {
    const first = projectLiveAssistantMessage({
      messageId: 'assistant:r1',
      runId: 'r1',
      text: 'Hi',
      thinking: 'plan',
      toolCalls: [],
      streaming: true,
      timestamp: 1,
    })
    const second = projectLiveAssistantMessage({
      messageId: 'assistant:r1',
      runId: 'r1',
      text: 'Hi there',
      thinking: 'plan',
      toolCalls: [{ id: 't1', name: 'read_file', phase: 'complete' }],
      streaming: false,
      timestamp: 2,
    })
    type Row = ReturnType<typeof projectLiveAssistantMessage>
    const messages = upsertMessageByDurableId<Row>(
      upsertMessageByDurableId<Row>([], first),
      second,
    )
    expect(messages).toHaveLength(1)
    expect(readDurableMessageId(messages[0]!)).toBe('assistant:r1')
    expect(messages[0]!.__streamingStatus).toBe('complete')
    expect(messages[0]!.__streamToolCalls).toHaveLength(1)
  })
})

describe('stableChatMessageKey', () => {
  it('prefers durable messageId over text fingerprint', () => {
    const key = stableChatMessageKey(
      {
        messageId: 'assistant:r1',
        role: 'assistant',
        content: [{ type: 'text', text: 'growing text' }],
      },
      0,
      () => 'growing text',
    )
    expect(key).toBe('assistant:r1')
  })
})
