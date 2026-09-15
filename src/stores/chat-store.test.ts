import { describe, expect, it } from 'vitest'
import { splitInlineThinking, stripInternalTags, useChatStore } from './chat-store'
import type { ChatMessage } from '../screens/chat/types'

function textMessage(
  id: string,
  role: string,
  text: string,
  historyIndex: number,
): ChatMessage {
  return {
    id,
    role,
    timestamp: 1_700_000_000_000,
    __historyIndex: historyIndex,
    content: [{ type: 'text', text }],
  }
}

describe('stripInternalTags', () => {
  it('keeps the newline between a heading and the following unlabeled fence', () => {
    const source = [
      '### ConductorPhase（UI 层）',
      '```',
      'home → preview → active → complete',
      '```',
      '',
      '### MissionPhase（hook 层）',
      '```',
      'idle → decomposing → running → complete',
      '```',
      '',
      '关键状态转换：',
      '',
    ].join('\n')

    const result = stripInternalTags(source)

    expect(result).toContain('### ConductorPhase（UI 层）\n```\n')
    expect(result).toContain('```\n\n### MissionPhase（hook 层）\n```\n')
    expect(result).not.toContain('### ConductorPhase（UI 层）```')
    expect(result).not.toContain('```### MissionPhase')
  })

  it('still strips thinking tags outside fences', () => {
    const result = stripInternalTags(
      '<thinking>secret</thinking>\n\nhello `code`\n```\nkept <thinking>x</thinking>\n```\n',
    )
    expect(result).toBe('hello `code`\n```\nkept <thinking>x</thinking>\n```')
  })
})

describe('splitInlineThinking', () => {
  it('extracts <think> reasoning and keeps the visible content', () => {
    const result = splitInlineThinking('<think>I should read the file</think>\nHere is the answer.')
    expect(result.reasoning).toBe('I should read the file')
    expect(result.content).toBe('Here is the answer.')
  })

  it('supports long-form <thinking> and <antThinking> tags', () => {
    const result = splitInlineThinking(
      '<thinking>plan</thinking><antThinking>check</antThinking>done',
    )
    expect(result.reasoning).toBe('plan\n\ncheck')
    expect(result.content).toBe('done')
  })

  it('leaves thinking tags inside fenced code blocks visible', () => {
    const result = splitInlineThinking(
      'before\n```\n<think>keep this</think>\n```\nafter',
    )
    expect(result.reasoning).toBe('')
    expect(result.content).toContain('<think>keep this</think>')
  })

  it('during streaming suppresses an unclosed leading <think> block', () => {
    const result = splitInlineThinking('<think>still reasoning', {
      streaming: true,
    })
    expect(result.reasoning).toBe('still reasoning')
    expect(result.content).toBe('')
    expect(result.inThinking).toBe(true)
  })
})

describe('chat-store history merge ordering', () => {
  it('preserves persisted history order when messages share a timestamp', () => {
    const messages: Array<ChatMessage> = [
      textMessage('m1', 'user', 'first question', 0),
      textMessage('m2', 'assistant', 'first answer', 1),
      textMessage('m3', 'user', 'follow-up', 2),
    ]

    const merged = useChatStore
      .getState()
      .mergeHistoryMessages('history-order-session', messages)

    expect(merged.map((message) => message.id)).toEqual(['m1', 'm2', 'm3'])
  })

  it('accepts local-store historyIndex as a persisted order hint', () => {
    const messages: Array<ChatMessage> = [
      {
        id: 'local-1',
        role: 'user',
        timestamp: 1_700_000_000_000,
        historyIndex: 0,
        content: [{ type: 'text', text: 'local question' }],
      },
      {
        id: 'local-2',
        role: 'assistant',
        timestamp: 1_700_000_000_000,
        historyIndex: 1,
        content: [{ type: 'text', text: 'local answer' }],
      },
      {
        id: 'local-3',
        role: 'user',
        timestamp: 1_700_000_000_000,
        historyIndex: 2,
        content: [{ type: 'text', text: 'local follow-up' }],
      },
    ]

    const merged = useChatStore
      .getState()
      .mergeHistoryMessages('local-history-order-session', messages)

    expect(merged.map((message) => message.id)).toEqual([
      'local-1',
      'local-2',
      'local-3',
    ])
  })
})

function resetStore(sessionKey: string) {
  useChatStore.getState().clearSession(sessionKey)
  useChatStore.getState().clearAllStreaming()
}

// Simulates the full upstream flow exactly as send-stream.ts emits after
// server-side thinking split + reasoning extraction:
//   tool.progress(reasoning.available) -> 'thinking' event
//   assistant.delta (visible text)     -> 'chunk' with fullReplace:true
describe('thinking + visible content through the stream store', () => {
  it('thinking event populates thinking state; chunk carries only visible text', () => {
    const sessionKey = 'e2e-1'
    resetStore(sessionKey)
    const store = useChatStore.getState()

    store.processEvent({
      type: 'thinking',
      text: 'Let me inspect the configuration first.',
      sessionKey,
      transport: 'send-stream',
    })
    store.processEvent({
      type: 'chunk',
      text: 'I checked the config. Here is the answer.',
      fullReplace: true,
      sessionKey,
      transport: 'send-stream',
    })

    const state = store.getStreamingState(sessionKey)
    expect(state?.thinking).toBe('Let me inspect the configuration first.')
    expect(state?.text).toBe('I checked the config. Here is the answer.')
  })

  it('done event builds a message that carries thinking content and clean text', () => {
    const sessionKey = 'e2e-2'
    resetStore(sessionKey)
    const store = useChatStore.getState()

    store.processEvent({
      type: 'thinking',
      text: 'reasoning trace',
      sessionKey,
      transport: 'send-stream',
    })
    store.processEvent({
      type: 'chunk',
      text: 'final answer text',
      fullReplace: true,
      sessionKey,
      transport: 'send-stream',
    })
    store.processEvent({
      type: 'done',
      state: 'complete',
      sessionKey,
      transport: 'send-stream',
    })

    const messages = store.getRealtimeMessages(sessionKey)
    const assistant = messages.find((m) => m.role === 'assistant')
    expect(assistant).toBeDefined()
    const content = assistant?.content
    expect(Array.isArray(content)).toBe(true)
    const thinkingPart = (
      content as Array<{ type: string; thinking?: string }>
    ).find((p) => p.type === 'thinking')
    const textPart = (
      content as Array<{ type: string; text?: string }>
    ).find((p) => p.type === 'text')
    expect(thinkingPart?.thinking).toBe('reasoning trace')
    expect(textPart?.text).toBe('final answer text')
  })
})
