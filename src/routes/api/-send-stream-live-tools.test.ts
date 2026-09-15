import { describe, expect, it } from 'vitest'

import {
  collectSyntheticLiveToolEvents,
  createSyntheticLiveToolTracker,
} from './-send-stream-live-tools'
import { extractReasoningFromToolProgress } from './send-stream'

describe('extractReasoningFromToolProgress', () => {
  it('extracts reasoning from event_type reasoning.available preview', () => {
    expect(
      extractReasoningFromToolProgress({
        event: 'reasoning.available',
        preview: 'I should check the config first',
      }),
    ).toBe('I should check the config first')
  })

  it('extracts reasoning from string tool _thinking name', () => {
    expect(
      extractReasoningFromToolProgress({
        tool: '_thinking',
        name: 'reading the plan',
      }),
    ).toBe('reading the plan')
  })

  it('extracts reasoning from tool object name _thinking', () => {
    expect(
      extractReasoningFromToolProgress({
        tool: { name: '_thinking' },
        delta: 'incremental token',
      }),
    ).toBe('incremental token')
  })

  it('returns null for a regular tool progress', () => {
    expect(
      extractReasoningFromToolProgress({
        tool: 'read_file',
        delta: '{"path":"/tmp/a"}',
      }),
    ).toBeNull()
  })
})

describe('collectSyntheticLiveToolEvents', () => {
  it('emits a live calling event as soon as an assistant tool call appears, before any tool result exists', () => {
    const tracker = createSyntheticLiveToolTracker()

    const events = collectSyntheticLiveToolEvents({
      messages: [
        {
          role: 'assistant',
          tool_calls: [
            {
              id: 'toolu_1',
              function: {
                name: 'read_file',
                arguments: '{"path":"/tmp/AGENTS.md"}',
              },
            },
          ],
        },
      ],
      tracker,
      sessionKey: 'session-1',
      runId: 'run-1',
    })

    expect(events).toEqual([
      {
        phase: 'calling',
        name: 'read_file',
        toolCallId: 'toolu_1',
        args: { path: '/tmp/AGENTS.md' },
        result: undefined,
        sessionKey: 'session-1',
        runId: 'run-1',
      },
    ])
  })

  it('upgrades the same live tool card to complete when the matching tool result lands', () => {
    const tracker = createSyntheticLiveToolTracker()

    collectSyntheticLiveToolEvents({
      messages: [
        {
          role: 'assistant',
          tool_calls: [
            {
              id: 'toolu_1',
              function: {
                name: 'read_file',
                arguments: '{"path":"/tmp/AGENTS.md"}',
              },
            },
          ],
        },
      ],
      tracker,
      sessionKey: 'session-1',
      runId: 'run-1',
    })

    const events = collectSyntheticLiveToolEvents({
      messages: [
        {
          role: 'assistant',
          tool_calls: [
            {
              id: 'toolu_1',
              function: {
                name: 'read_file',
                arguments: '{"path":"/tmp/AGENTS.md"}',
              },
            },
          ],
        },
        {
          role: 'tool',
          tool_call_id: 'toolu_1',
          content: [{ type: 'text', text: 'file contents here' }],
        },
      ],
      tracker,
      sessionKey: 'session-1',
      runId: 'run-1',
    })

    expect(events).toEqual([
      {
        phase: 'complete',
        name: 'read_file',
        toolCallId: 'toolu_1',
        args: { path: '/tmp/AGENTS.md' },
        result: 'file contents here',
        sessionKey: 'session-1',
        runId: 'run-1',
      },
    ])
  })
})
