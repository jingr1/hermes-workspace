import { describe, expect, it } from 'vitest'
import { mapManagedAgentActivitySnapshot } from './managed-agent-activity-mapper'

describe('mapManagedAgentActivitySnapshot', () => {
  it('maps daemon canonical activity JSON into Engine DTOs', () => {
    const snapshot = mapManagedAgentActivitySnapshot({
      workspaceId: 'workspace-1',
      session: { ID: 'session-1', Provider: 'codex', ActiveTurnID: 'turn-1', Settings: { Model: 'gpt-5' }, MessageVersion: 2 },
      turns: [{ TurnID: 'turn-1', Phase: 'waiting', Origin: 'user_prompt', StartedAtUnixMS: 1, UpdatedAtUnixMS: 2 }],
      messages: [{ ID: 1, MessageID: 'message-1', TurnID: 'turn-1', Role: 'assistant', Kind: 'text', Payload: { text: 'hello' }, Version: 2, OccurredAtUnixMS: 2 }],
      interactions: [{ RequestID: 'request-1', TurnID: 'turn-1', Kind: 'approval', Status: 'pending', Input: { title: 'Allow?' }, Metadata: { actions: [] }, CreatedAtUnixMS: 2, UpdatedAtUnixMS: 2 }],
    })

    expect(snapshot?.session.activeTurn?.turnId).toBe('turn-1')
    expect(snapshot?.messages[0]?.payload).toEqual({ text: 'hello' })
    expect(snapshot?.interactions[0]?.requestId).toBe('request-1')
  })

  it('fails closed for an unknown canonical turn phase', () => {
    expect(mapManagedAgentActivitySnapshot({
      workspaceId: 'workspace-1',
      session: { ID: 'session-1', Provider: 'codex' },
      turns: [{ TurnID: 'turn-1', Phase: 'unknown', Origin: 'user_prompt' }],
      messages: [],
      interactions: [],
    })).toBeNull()
  })
})