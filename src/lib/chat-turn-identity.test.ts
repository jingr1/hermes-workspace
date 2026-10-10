import { describe, expect, it } from 'vitest'
import {
  assistantMessageIdForRun,
  foldOpenTurnIntoLiveHost,
  preferLiveAssistantOnCollision,
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

describe('foldOpenTurnIntoLiveHost', () => {
  it('collapses mid-turn text + tool-only orphans into one streaming host', () => {
    const live = projectLiveAssistantMessage({
      messageId: 'assistant:r1',
      runId: 'r1',
      text: '分析结论',
      thinking: '',
      toolCalls: [{ id: 't2', name: 'read_file', phase: 'complete' }],
      streaming: true,
      timestamp: 3,
    })
    const folded = foldOpenTurnIntoLiveHost(
      [
        {
          role: 'user',
          id: 'u1',
          content: [{ type: 'text', text: 'fix' }],
        },
        {
          role: 'assistant',
          id: 'orphan-tool',
          content: [
            { type: 'toolCall', id: 't1', name: 'explore', arguments: {} },
          ],
        },
        {
          role: 'assistant',
          id: 'hist-text',
          content: [{ type: 'text', text: '分析结论' }],
        },
        live,
      ],
      {
        liveMessageId: 'assistant:r1',
        isStreaming: true,
        streamingText: '分析结论',
        toolCalls: [{ id: 't2', name: 'read_file', phase: 'complete' }],
        runId: 'r1',
      },
    )

    expect(folded).toHaveLength(2)
    expect(folded[0]!.role).toBe('user')
    expect(readDurableMessageId(folded[1]!)).toBe('assistant:r1')
    expect(folded[1]!.__streamingStatus).toBe('streaming')
    expect(folded[1]!.__streamToolCalls?.map((t) => t.id).sort()).toEqual([
      't1',
      't2',
    ])
  })
})

describe('preferLiveAssistantOnCollision', () => {
  it('keeps the streaming durable row over a settled history echo', () => {
    const history = {
      role: 'assistant' as const,
      id: 'msg-hist',
      content: [{ type: 'text', text: 'same' }],
    }
    const live = projectLiveAssistantMessage({
      messageId: 'assistant:r1',
      runId: 'r1',
      text: 'same',
      thinking: '',
      toolCalls: [],
      streaming: true,
      timestamp: 1,
    })
    expect(
      preferLiveAssistantOnCollision(history, live, 'assistant:r1'),
    ).toBe(live)
  })
})
