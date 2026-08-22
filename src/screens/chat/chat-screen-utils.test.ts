import { describe, expect, it } from 'vitest'

import {
  advanceStickyStreamingText,
  buildChatNavKey,
  createResponseWaitSnapshot,
  isTerminalActiveRunStatus,
  profileNameFromNavKey,
  shouldCancelStreamOnSessionNav,
  shouldClearWaitingForAssistantMessage,
  shouldHandoffStreamOnProfileNav,
} from './chat-screen-utils'

describe('advanceStickyStreamingText', () => {
  it('preserves the last non-empty streaming text when a tool phase temporarily reports empty text', () => {
    const afterText = advanceStickyStreamingText({
      isStreaming: true,
      runId: 'run-1',
      rawText: 'Working through the task',
      smoothedText: 'Working through the task',
      previousState: { runId: null, text: '' },
    })

    const afterToolPhase = advanceStickyStreamingText({
      isStreaming: true,
      runId: 'run-1',
      rawText: '',
      smoothedText: '',
      previousState: afterText,
    })

    expect(afterToolPhase).toEqual({
      runId: 'run-1',
      text: 'Working through the task',
    })
  })

  it('resets sticky text when a new run starts', () => {
    const next = advanceStickyStreamingText({
      isStreaming: true,
      runId: 'run-2',
      rawText: '',
      smoothedText: '',
      previousState: { runId: 'run-1', text: 'Old stream text' },
    })

    expect(next).toEqual({ runId: 'run-2', text: '' })
  })

  it('clears sticky text when streaming ends', () => {
    const next = advanceStickyStreamingText({
      isStreaming: false,
      runId: null,
      rawText: '',
      smoothedText: '',
      previousState: { runId: 'run-1', text: 'Old stream text' },
    })

    expect(next).toEqual({ runId: null, text: '' })
  })
})

describe('shouldCancelStreamOnSessionNav', () => {
  it('does not cancel on the first session key', () => {
    expect(
      shouldCancelStreamOnSessionNav({
        previousNavKey: null,
        nextNavKey: '::new',
        nextFriendlyId: 'new',
      }),
    ).toBe(false)
  })

  it('does not cancel when the nav key is unchanged', () => {
    expect(
      shouldCancelStreamOnSessionNav({
        previousNavKey: 'abc::abc',
        nextNavKey: 'abc::abc',
        nextFriendlyId: 'abc',
        activeSendKey: 'abc',
      }),
    ).toBe(false)
  })

  it('keeps the first-turn stream when promoting /chat/new onto the in-flight session', () => {
    expect(
      shouldCancelStreamOnSessionNav({
        previousNavKey: 'main::new',
        nextNavKey: 'thread-1::thread-1',
        nextFriendlyId: 'thread-1',
        activeSendKey: 'thread-1',
      }),
    ).toBe(false)
  })

  it('cancels when the user leaves a streaming session for a different one', () => {
    expect(
      shouldCancelStreamOnSessionNav({
        previousNavKey: 'session-a::session-a',
        nextNavKey: 'session-b::session-b',
        nextFriendlyId: 'session-b',
        activeSendKey: 'session-a',
      }),
    ).toBe(true)
  })

  it('cancels when opening a new chat from an existing session', () => {
    expect(
      shouldCancelStreamOnSessionNav({
        previousNavKey: 'session-a::session-a',
        nextNavKey: 'main::new',
        nextFriendlyId: 'new',
        activeSendKey: 'session-a',
      }),
    ).toBe(true)
  })
})

describe('profile stream handoff navigation', () => {
  it('builds nav keys with profile prefix', () => {
    expect(
      buildChatNavKey({
        profileName: 'developer',
        canonicalSessionKey: 'thread-1',
        friendlyId: 'thread-1',
        isNewChat: false,
      }),
    ).toBe('developer::thread-1::thread-1')
  })

  it('detects profile-only navigation for handoff', () => {
    const prev = buildChatNavKey({
      profileName: 'developer',
      canonicalSessionKey: 'a',
      friendlyId: 'a',
      isNewChat: false,
    })
    const next = buildChatNavKey({
      profileName: 'architect',
      canonicalSessionKey: 'b',
      friendlyId: 'b',
      isNewChat: false,
    })
    expect(shouldHandoffStreamOnProfileNav(prev, next)).toBe(true)
    expect(shouldHandoffStreamOnProfileNav(prev, prev)).toBe(false)
    expect(profileNameFromNavKey(prev)).toBe('developer')
  })
})

describe('response wait detection', () => {
  it('treats persisted complete runs as terminal', () => {
    expect(isTerminalActiveRunStatus('complete')).toBe(true)
    expect(isTerminalActiveRunStatus('completed')).toBe(true)
    expect(isTerminalActiveRunStatus('active')).toBe(false)
  })

  it('clears waiting when a new assistant message appears after the send snapshot', () => {
    const snapshot = createResponseWaitSnapshot([
      {
        role: 'user',
        content: [{ type: 'text', text: 'remember that i like cheesecake' }],
      },
    ])

    expect(
      shouldClearWaitingForAssistantMessage(
        [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'remember that i like cheesecake' },
            ],
          },
          {
            role: 'assistant',
            content: [
              { type: 'text', text: 'Remembered: you like cheesecake.' },
            ],
            id: 'assistant-1',
          },
        ],
        snapshot,
      ),
    ).toBe(true)
  })
})
