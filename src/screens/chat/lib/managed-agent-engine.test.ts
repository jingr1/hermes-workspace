import { describe, expect, it } from 'vitest'
import { createManagedAgentEngine, hydrateManagedAgentEngine, managedAgentTargetId, selectManagedAgentChatState } from './managed-agent-engine'

describe('Managed Agent Engine adapter', () => {
  it('hydrates messages, turns, and interactions into one Engine owner', () => {
    const engine = createManagedAgentEngine({
      workspaceId: 'workspace-1',
      commandPort: { kind: 'typed', effects: unsupportedEffects(), execute: async () => undefined },
    })
    hydrateManagedAgentEngine(engine, {
      ...detailDefaults,
      workspaceId: 'workspace-1',
      session: session(),
      turns: [turn()],
      messages: [{ workspaceId: 'workspace-1', agentSessionId: 'session-1', messageId: 'message-1', turnId: 'turn-1', role: 'assistant', kind: 'text', payload: { text: 'hello' }, version: 1, sequence: 1, occurredAtUnixMs: 1 }],
      interactions: [{ agentSessionId: 'session-1', requestId: 'request-1', turnId: 'turn-1', kind: 'approval', status: 'pending', createdAtUnixMs: 1, updatedAtUnixMs: 1 }],
    })

    const state = selectManagedAgentChatState(engine.getSnapshot(), 'session-1')
    expect(state.messages).toHaveLength(1)
    expect(state.activeTurn?.turnId).toBe('turn-1')
    expect(state.isStreaming).toBe(true)
    expect(state.interactions[0]?.requestId).toBe('request-1')
    engine.dispose()
  })

  it('derives active tool calls from canonical tool_call messages', () => {
    const engine = createManagedAgentEngine({
      workspaceId: 'workspace-1',
      commandPort: { kind: 'typed', effects: unsupportedEffects(), execute: async () => undefined },
    })
    hydrateManagedAgentEngine(engine, {
      ...detailDefaults,
      workspaceId: 'workspace-1',
      session: session(),
      turns: [turn()],
      messages: [{ workspaceId: 'workspace-1', agentSessionId: 'session-1', messageId: 'tool-1', turnId: 'turn-1', role: 'assistant', kind: 'tool_call', payload: { toolName: 'read_file', input: { path: 'README.md' } }, version: 1, sequence: 1, occurredAtUnixMs: 1 }],
      interactions: [],
    })

    expect(selectManagedAgentChatState(engine.getSnapshot(), 'session-1').activeToolCalls).toEqual([
      { id: 'tool-1', name: 'read_file', phase: 'running', args: { path: 'README.md' } },
    ])
    expect(selectManagedAgentChatState(engine.getSnapshot(), 'session-1').messages).toEqual([
      {
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'tool-1', name: 'read_file', arguments: { path: 'README.md' } }],
        timestamp: 1,
        toolName: 'read_file',
        details: { input: { path: 'README.md' } },
      },
    ])
    engine.dispose()
  })

  it('still admits the legacy tool kind with name/arguments payload', () => {
    const engine = createManagedAgentEngine({
      workspaceId: 'workspace-1',
      commandPort: { kind: 'typed', effects: unsupportedEffects(), execute: async () => undefined },
    })
    hydrateManagedAgentEngine(engine, {
      ...detailDefaults,
      workspaceId: 'workspace-1',
      session: session(),
      turns: [turn()],
      messages: [{ workspaceId: 'workspace-1', agentSessionId: 'session-1', messageId: 'tool-legacy', turnId: 'turn-1', role: 'assistant', kind: 'tool', payload: { name: 'read_file', arguments: { path: 'README.md' } }, version: 1, sequence: 1, occurredAtUnixMs: 1 }],
      interactions: [],
    })

    expect(selectManagedAgentChatState(engine.getSnapshot(), 'session-1').activeToolCalls).toEqual([
      { id: 'tool-legacy', name: 'read_file', phase: 'running', args: { path: 'README.md' } },
    ])
    engine.dispose()
  })

  it('projects reasoning messages as thinking content', () => {
    const engine = createManagedAgentEngine({
      workspaceId: 'workspace-1',
      commandPort: { kind: 'typed', effects: unsupportedEffects(), execute: async () => undefined },
    })
    hydrateManagedAgentEngine(engine, {
      ...detailDefaults,
      workspaceId: 'workspace-1',
      session: session(),
      turns: [turn()],
      messages: [{ workspaceId: 'workspace-1', agentSessionId: 'session-1', messageId: 'reasoning-1', turnId: 'turn-1', role: 'assistant', kind: 'reasoning', payload: { text: 'Let me check the config first.', source: 'runtime' }, version: 1, sequence: 1, occurredAtUnixMs: 1 }],
      interactions: [],
    })

    expect(selectManagedAgentChatState(engine.getSnapshot(), 'session-1').messages).toEqual([
      { role: 'assistant', content: [{ type: 'thinking', thinking: 'Let me check the config first.' }], timestamp: 1 },
    ])
    engine.dispose()
  })

  it('projects settled tool_call output/error onto the tool card fields', () => {
    const engine = createManagedAgentEngine({
      workspaceId: 'workspace-1',
      commandPort: { kind: 'typed', effects: unsupportedEffects(), execute: async () => undefined },
    })
    hydrateManagedAgentEngine(engine, {
      ...detailDefaults,
      workspaceId: 'workspace-1',
      session: session(),
      turns: [turn()],
      messages: [
        { workspaceId: 'workspace-1', agentSessionId: 'session-1', messageId: 'tool-1', turnId: 'turn-1', role: 'assistant', kind: 'tool_call', status: 'completed', payload: { toolName: 'bash', input: { command: 'ls' }, output: 'README.md\nsrc' }, version: 2, sequence: 1, occurredAtUnixMs: 1 },
        { workspaceId: 'workspace-1', agentSessionId: 'session-1', messageId: 'tool-2', turnId: 'turn-1', role: 'assistant', kind: 'tool_call', status: 'failed', payload: { toolName: 'bash', input: { command: 'false' }, error: 'command exited 1' }, version: 2, sequence: 2, occurredAtUnixMs: 2 },
      ],
      interactions: [],
    })

    const state = selectManagedAgentChatState(engine.getSnapshot(), 'session-1')
    // Terminal tool calls leave the active list.
    expect(state.activeToolCalls).toEqual([])
    expect(state.messages).toEqual([
      {
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'tool-1', name: 'bash', arguments: { command: 'ls' } }],
        timestamp: 1,
        toolName: 'bash',
        details: { input: { command: 'ls' }, output: 'README.md\nsrc' },
      },
      {
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'tool-2', name: 'bash', arguments: { command: 'false' } }],
        timestamp: 2,
        toolName: 'bash',
        details: { input: { command: 'false' }, error: 'command exited 1' },
        isError: true,
      },
    ])
    engine.dispose()
  })

  it('projects the canonical provider error without replacing its message', () => {
    const engine = createManagedAgentEngine({
      workspaceId: 'workspace-1',
      commandPort: { kind: 'typed', effects: unsupportedEffects(), execute: async () => undefined },
    })
    const failedTurn = {
      ...turn(),
      phase: 'settled' as const,
      outcome: 'failed' as const,
      error: {
        code: 'insufficient_credits',
        message: 'Token-X quota exhausted',
        detail: 'HTTP 429: insufficient_quota',
      },
      settledAtUnixMs: 2,
      updatedAtUnixMs: 2,
    }
    hydrateManagedAgentEngine(engine, {
      ...detailDefaults,
      workspaceId: 'workspace-1',
      session: { ...session(), activeTurnId: null, activeTurn: null, latestTurn: failedTurn },
      turns: [failedTurn],
      messages: [],
      interactions: [],
    })

    expect(selectManagedAgentChatState(engine.getSnapshot(), 'session-1').error)
      .toBe('Token-X quota exhausted')
    engine.dispose()
  })

  it('projects the daemon visible error body verbatim', () => {
    const engine = createManagedAgentEngine({
      workspaceId: 'workspace-1',
      commandPort: { kind: 'typed', effects: unsupportedEffects(), execute: async () => undefined },
    })
    const completedTurn = {
      ...turn(),
      phase: 'settled' as const,
      outcome: 'completed' as const,
      settledAtUnixMs: 2,
      updatedAtUnixMs: 2,
    }
    hydrateManagedAgentEngine(engine, {
      ...detailDefaults,
      workspaceId: 'workspace-1',
      session: { ...session(), activeTurnId: null, activeTurn: null, latestTurn: completedTurn },
      turns: [completedTurn],
      messages: [{
        workspaceId: 'workspace-1',
        agentSessionId: 'session-1',
        messageId: 'error-1',
        turnId: 'turn-1',
        role: 'assistant',
        kind: 'text',
        status: 'failed',
        payload: {
          kind: 'agent_visible_error',
          origin: 'provider',
          text: 'Provider error',
          detail: 'Claude API: rate limit exceeded',
        },
        version: 1,
        sequence: 1,
        occurredAtUnixMs: 2,
      }],
      interactions: [],
    })

    expect(selectManagedAgentChatState(engine.getSnapshot(), 'session-1').error)
      .toBe('Claude API: rate limit exceeded')
    expect(selectManagedAgentChatState(engine.getSnapshot(), 'session-1').messages[0]?.content)
      .toEqual([{ type: 'text', text: 'Claude API: rate limit exceeded' }])
    engine.dispose()
  })

  it('surfaces terminal provider system notice detail when no answer exists', () => {
    const engine = createManagedAgentEngine({
      workspaceId: 'workspace-1',
      commandPort: { kind: 'typed', effects: unsupportedEffects(), execute: async () => undefined },
    })
    const completedTurn = {
      ...turn(),
      phase: 'settled' as const,
      outcome: 'completed' as const,
      settledAtUnixMs: 2,
      updatedAtUnixMs: 2,
    }
    hydrateManagedAgentEngine(engine, {
      ...detailDefaults,
      workspaceId: 'workspace-1',
      session: { ...session(), activeTurnId: null, activeTurn: null, latestTurn: completedTurn },
      turns: [completedTurn],
      messages: [{
        workspaceId: 'workspace-1',
        agentSessionId: 'session-1',
        messageId: 'notice-1',
        turnId: 'turn-1',
        role: 'assistant',
        kind: 'text',
        status: 'completed',
        payload: {
          kind: 'agent_system_notice',
          text: 'MCP server startup failed',
          detail: 'MCP handshake failed: connection closed',
        },
        version: 1,
        sequence: 1,
        occurredAtUnixMs: 2,
      }],
      interactions: [],
    })

    expect(selectManagedAgentChatState(engine.getSnapshot(), 'session-1').error)
      .toBe('MCP handshake failed: connection closed')
    engine.dispose()
  })

  it('admits the Managed Chat initial activation input', () => {
    const engine = createManagedAgentEngine({
      workspaceId: 'default',
      commandPort: { kind: 'typed', effects: unsupportedEffects(), execute: async () => undefined },
    })
    expect(engine.activateSession({
      mode: 'new',
      agentSessionId: 'session-1',
      agentTargetId: 'managed:codex',
      clientSubmitId: 'submit-1',
      requestId: 'request-1',
      initialTurnExpected: true,
      initialContent: [{ type: 'text', text: 'Hello' }],
      initialDisplayPrompt: 'Hello',
      settings: { model: 'gpt-5' },
    })).toBe(true)
    engine.dispose()
  })

  it('uses daemon catalog identities for managed targets', () => {
    expect(managedAgentTargetId('codex-impl')).toBe('local:codex')
    expect(managedAgentTargetId('claude-code')).toBe('local:claude-code')
    expect(managedAgentTargetId('kimi-impl')).toBe('extension:kimi-code')
    expect(managedAgentTargetId('kimi')).toBe('extension:kimi-code')
    expect(managedAgentTargetId('cursor-impl')).toBe('local:cursor')
    expect(managedAgentTargetId('opencode-impl')).toBe('local:opencode')
  })

  it('prefers overlay sessionMessages over the canonical engine lane', () => {
    const engine = createManagedAgentEngine({
      workspaceId: 'workspace-1',
      commandPort: { kind: 'typed', effects: unsupportedEffects(), execute: async () => undefined },
    })
    hydrateManagedAgentEngine(engine, {
      ...detailDefaults,
      workspaceId: 'workspace-1',
      session: session(),
      turns: [turn()],
      messages: [{
        workspaceId: 'workspace-1',
        agentSessionId: 'session-1',
        messageId: 'message-1',
        turnId: 'turn-1',
        role: 'assistant',
        kind: 'text',
        payload: { text: 'canonical' },
        version: 1,
        sequence: 1,
        occurredAtUnixMs: 1,
      }],
      interactions: [],
    })

    const state = selectManagedAgentChatState(engine.getSnapshot(), 'session-1', {
      sessionMessages: [{
        workspaceId: 'workspace-1',
        agentSessionId: 'session-1',
        messageId: 'message-1',
        turnId: 'turn-1',
        role: 'assistant',
        kind: 'text',
        payload: { text: 'canonical live' },
        version: 1,
        sequence: 1,
        occurredAtUnixMs: 1,
      }],
    })
    expect(state.messages).toEqual([
      { role: 'assistant', content: [{ type: 'text', text: 'canonical live' }], timestamp: 1 },
    ])
    expect(state.activeTurn?.turnId).toBe('turn-1')
    engine.dispose()
  })
})

const detailDefaults = {
  projection: 'authoritative' as const,
  lifecycleCapabilitiesProjected: false,
  childSessions: [] as Array<never>,
}

function session() {  return { workspaceId: 'workspace-1', agentSessionId: 'session-1', kind: 'root' as const, rootAgentSessionId: null, rootTurnId: null, parentAgentSessionId: null, parentTurnId: null, parentToolCallId: null, agentTargetId: 'local:codex', provider: 'codex', providerSessionId: null, cwd: '', title: 'Chat', activeTurnId: 'turn-1', activeTurn: turn(), latestTurn: turn(), latestTurnInteractions: [], pendingInteractions: [], settings: {}, permissionConfig: { configurable: false, modes: [] }, capabilities: null, lifecycleCapabilities: { fork: false, forkThroughTurn: false }, forkedFrom: null, usage: null, goal: null, agoraxModeActivation: null, imported: false, visible: true, resumable: true, messageVersion: 1, lastEventUnixMs: 1, startedAtUnixMs: 1, endedAtUnixMs: null, pinnedAtUnixMs: null, createdAtUnixMs: 1, updatedAtUnixMs: 1 }
}
function turn() { return { agentSessionId: 'session-1', turnId: 'turn-1', phase: 'running' as const, origin: 'user_prompt' as const, outcome: null, error: null, startedAtUnixMs: 1, settledAtUnixMs: null, updatedAtUnixMs: 1 } }
function unsupportedEffects() { const unsupported = async () => { throw new Error('unsupported') }; return { activateSession: unsupported, cancelTurn: unsupported, deleteSessions: unsupported, respondToInteraction: unsupported, renameSession: unsupported, sendInput: unsupported, setSessionPinned: unsupported, updateSessionSettings: unsupported } }