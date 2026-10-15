import { describe, expect, it } from 'vitest'
import { hermesHistoryMessagesToActivity } from './hermes-history-to-activity'

describe('hermesHistoryMessagesToActivity', () => {
  it('preserves assistant:<runId> and expands thinking + text', () => {
    const rows = hermesHistoryMessagesToActivity({
      workspaceId: 'ws',
      agentSessionId: 'sess-1',
      messages: [
        {
          role: 'user',
          id: 'user-1',
          content: [{ type: 'text', text: 'hi' }],
          timestamp: 10,
        },
        {
          role: 'assistant',
          id: 'assistant:run-9',
          messageId: 'assistant:run-9',
          runId: 'run-9',
          content: [
            { type: 'thinking', thinking: 'plan' },
            { type: 'text', text: 'hello' },
          ],
          timestamp: 20,
        },
      ],
    })
    expect(rows.map((row) => row.messageId)).toEqual([
      'user-1',
      'assistant:run-9:thinking',
      'assistant:run-9',
    ])
    expect(rows[2]).toMatchObject({
      role: 'assistant',
      kind: 'text',
      payload: { text: 'hello' },
    })
  })

  it('maps toolCall parts to toolcall: ids', () => {
    const rows = hermesHistoryMessagesToActivity({
      workspaceId: 'ws',
      agentSessionId: 'sess-1',
      messages: [
        {
          role: 'assistant',
          id: 'assistant:run-t',
          content: [
            {
              type: 'toolCall',
              id: 'tc-1',
              name: 'read_file',
              arguments: { path: 'a.ts' },
            },
            { type: 'text', text: 'done' },
          ],
          timestamp: 1,
        },
      ],
    })
    expect(rows[0]).toMatchObject({
      messageId: 'toolcall:tc-1',
      kind: 'tool_call',
      payload: { toolName: 'read_file' },
    })
    expect(rows[1]?.messageId).toBe('assistant:run-t')
  })
})
