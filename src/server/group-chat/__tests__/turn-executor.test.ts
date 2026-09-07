/** @vitest-environment node */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const streamChat = vi.fn()
const getMessages = vi.fn()
const getOrCreateSession = vi.fn()
const forgetSession = vi.fn()
const ensureProfileGateway = vi.fn(async () => undefined)

vi.mock('../../claude-api-profile', () => ({
  getClaudeApiClient: () => ({
    baseUrl: 'http://127.0.0.1:8644',
    streamChat,
    getMessages,
    deleteSession: vi.fn(),
  }),
}))

vi.mock('../../claude-api', () => ({
  streamChat,
  getMessages,
}))

vi.mock('../../gateway-pool', () => ({
  ensureProfileGateway,
}))

vi.mock('../agent-session-manager', () => ({
  getOrCreateSession,
  forgetSession,
}))

vi.mock('../constants', async () => {
  const actual = await vi.importActual<typeof import('../constants')>('../constants')
  return {
    ...actual,
    GROUP_TURN_TIMEOUT_MS: 50,
    GROUP_TURN_POLL_MS: 10,
    GROUP_TURN_HARD_CAP_MS: 200,
  }
})

describe('executeMemberTurn timeout / stranded', () => {
  beforeEach(() => {
    vi.resetModules()
    streamChat.mockReset()
    getMessages.mockReset()
    getOrCreateSession.mockReset()
    forgetSession.mockReset()
    ensureProfileGateway.mockClear()
  })

  it('returns timeout without treating early ack as reply when soft deadline elapses', async () => {
    getOrCreateSession.mockResolvedValue({
      sessionId: 'sess_dev',
      existed: true,
      profile: 'developer',
    })
    getMessages.mockResolvedValue([
      { role: 'user', content: 'prior' },
      { role: 'assistant', content: 'prior reply' },
    ])

    // Stream that keeps emitting activity but never settles within soft deadline.
    let settle!: () => void
    const gate = new Promise<void>((resolve) => {
      settle = resolve
    })
    streamChat.mockImplementation(
      async (
        _sid: string,
        _body: unknown,
        opts: { onEvent: (p: { event: string; data: Record<string, unknown> }) => void },
      ) => {
        opts.onEvent({
          event: 'assistant.delta',
          data: { delta: '我先去查一下' },
        })
        await gate
      },
    )

    const { executeMemberTurn } = await import('../turn-executor')
    const result = await executeMemberTurn({
      roomId: 'room1',
      roomTitle: 'test',
      member: {
        id: 'row',
        kind: 'agent',
        participantId: 'developer',
        displayName: 'developer',
        name: 'developer',
        mentionName: 'developer',
        runtime: 'hermes',
        isBot: true,
        profile: 'developer',
      },
      prompt: 'please investigate',
    })

    expect(result.kind).toBe('timeout')
    if (result.kind === 'timeout') {
      expect(result.sessionId).toBe('sess_dev')
      expect(result.before).toBe(2)
    }
    settle()
    await Promise.resolve()
  })

  it('picks newest substantive session reply on successful stream', async () => {
    getOrCreateSession.mockResolvedValue({
      sessionId: 'sess_dev',
      existed: true,
      profile: 'developer',
    })
    getMessages
      .mockResolvedValueOnce([
        { role: 'user', content: 'prior' },
      ])
      .mockResolvedValueOnce([
        { role: 'user', content: 'prior' },
        { role: 'user', content: 'prompt' },
        { role: 'assistant', content: 'early ack' },
        { role: 'assistant', content: '', tool_calls: [{ id: 't1' }] },
        { role: 'tool', content: '{}' },
        { role: 'assistant', content: 'final conclusion' },
      ])

    streamChat.mockImplementation(
      async (
        _sid: string,
        _body: unknown,
        opts: { onEvent: (p: { event: string; data: Record<string, unknown> }) => void },
      ) => {
        opts.onEvent({
          event: 'assistant.delta',
          data: { delta: 'early ack' },
        })
        opts.onEvent({
          event: 'assistant.completed',
          data: { content: 'early ack' },
        })
      },
    )

    const { executeMemberTurn } = await import('../turn-executor')
    const result = await executeMemberTurn({
      roomId: 'room1',
      roomTitle: 'test',
      member: {
        id: 'row',
        kind: 'agent',
        participantId: 'developer',
        displayName: 'developer',
        name: 'developer',
        mentionName: 'developer',
        runtime: 'hermes',
        isBot: true,
        profile: 'developer',
      },
      prompt: 'please investigate',
    })

    expect(result).toEqual({ kind: 'reply', text: 'final conclusion' })
  })
})
