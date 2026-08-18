import { describe, expect, it } from 'vitest'
import { stripInternalTags, useChatStore } from './chat-store'
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
