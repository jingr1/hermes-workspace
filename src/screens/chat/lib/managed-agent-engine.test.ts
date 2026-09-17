import { describe, expect, it } from 'vitest'
import { createManagedAgentEngine, hydrateManagedAgentEngine, managedAgentTargetId, selectManagedAgentChatState } from './managed-agent-engine'

describe('Managed Agent Engine adapter', () => {
  it('hydrates messages, turns, and interactions into one Engine owner', () => {
    const engine = createManagedAgentEngine({
      workspaceId: 'workspace-1',
      commandPort: { kind: 'typed', effects: unsupportedEffects(), execute: async () => undefined },
    })
    hydrateManagedAgentEngine(engine, {
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

  it('derives active tool calls from canonical messages', () => {
    const engine = createManagedAgentEngine({
      workspaceId: 'workspace-1',
      commandPort: { kind: 'typed', effects: unsupportedEffects(), execute: async () => undefined },
    })
    hydrateManagedAgentEngine(engine, {
      workspaceId: 'workspace-1',
      session: session(),
      turns: [turn()],
      messages: [{ workspaceId: 'workspace-1', agentSessionId: 'session-1', messageId: 'tool-1', turnId: 'turn-1', role: 'assistant', kind: 'tool', payload: { name: 'read_file', arguments: { path: 'README.md' } }, version: 1, sequence: 1, occurredAtUnixMs: 1 }],
      interactions: [],
    })

    expect(selectManagedAgentChatState(engine.getSnapshot(), 'session-1').activeToolCalls).toEqual([
      { id: 'tool-1', name: 'read_file', phase: 'running', args: { path: 'README.md' } },
    ])
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
    expect(managedAgentTargetId('kimi')).toBe('extension:kimi-code')
  })
})

function session() {
  return { workspaceId: 'workspace-1', agentSessionId: 'session-1', kind: 'root' as const, rootAgentSessionId: null, rootTurnId: null, parentAgentSessionId: null, parentTurnId: null, parentToolCallId: null, agentTargetId: 'local:codex', provider: 'codex', providerSessionId: null, cwd: '', title: 'Chat', activeTurnId: 'turn-1', activeTurn: turn(), latestTurn: turn(), latestTurnInteractions: [], pendingInteractions: [], settings: {}, permissionConfig: { configurable: false, modes: [] }, capabilities: null, lifecycleCapabilities: { fork: false, forkThroughTurn: false }, forkedFrom: null, usage: null, goal: null, agoraxModeActivation: null, imported: false, visible: true, resumable: true, messageVersion: 1, lastEventUnixMs: 1, startedAtUnixMs: 1, endedAtUnixMs: null, pinnedAtUnixMs: null, createdAtUnixMs: 1, updatedAtUnixMs: 1 }
}
function turn() { return { agentSessionId: 'session-1', turnId: 'turn-1', phase: 'running' as const, origin: 'user_prompt' as const, outcome: null, error: null, startedAtUnixMs: 1, settledAtUnixMs: null, updatedAtUnixMs: 1 } }
function unsupportedEffects() { const unsupported = async () => { throw new Error('unsupported') }; return { activateSession: unsupported, cancelTurn: unsupported, deleteSessions: unsupported, respondToInteraction: unsupported, renameSession: unsupported, sendInput: unsupported, setSessionPinned: unsupported, updateSessionSettings: unsupported } }