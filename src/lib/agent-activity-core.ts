export type AgentActivityTurnPhase =
  | 'submitted'
  | 'running'
  | 'waiting'
  | 'settling'
  | 'settled'
  | 'failed'
  | 'canceled'
  | 'interrupted'

export type AgentActivityTurnOutcome =
  | 'completed'
  | 'failed'
  | 'canceled'
  | 'interrupted'

export type AgentActivityMessage = {
  messageId: string
  turnId: string
  role: string
  kind: string
  content: unknown
}

export type AgentActivityTurn = {
  turnId: string
  phase: AgentActivityTurnPhase
  outcome: AgentActivityTurnOutcome | null
}

export type AgentActivitySnapshot = {
  workspaceId: string
  agentSessionId: string
  messagesById: Record<string, AgentActivityMessage>
  turnsById: Record<string, AgentActivityTurn>
}

export type AgentActivityEvent =
  | {
      eventType: 'message_delta'
      data: {
        agentSessionId: string
        messageId: string
        turnId: string
        role: string
        kind: string
        content?: {
          operation: 'append_text' | 'set'
          text?: string
          value?: unknown
        }
        payloadSet?: Record<string, unknown>
      }
    }
  | {
      eventType: 'turn_update'
      data: {
        agentSessionId: string
        activeTurnId: string | null
        turn: AgentActivityTurn
      }
    }

export function createAgentActivitySnapshot(input: {
  workspaceId: string
  agentSessionId: string
}): AgentActivitySnapshot {
  return { ...input, messagesById: {}, turnsById: {} }
}

export function applyAgentActivityEvent(
  snapshot: AgentActivitySnapshot,
  event: AgentActivityEvent,
): AgentActivitySnapshot {
  if (event.data.agentSessionId !== snapshot.agentSessionId) return snapshot

  if (event.eventType === 'message_delta') {
    const previous = snapshot.messagesById[event.data.messageId]
    const content = applyMessageContent(previous?.content, event.data.content)
    return {
      ...snapshot,
      messagesById: {
        ...snapshot.messagesById,
        [event.data.messageId]: {
          messageId: event.data.messageId,
          turnId: event.data.turnId,
          role: event.data.role,
          kind: event.data.kind,
          content: event.data.payloadSet ?? content,
        },
      },
    }
  }

  const previous = snapshot.turnsById[event.data.turn.turnId]
  if (previous?.outcome && !event.data.turn.outcome) return snapshot
  return {
    ...snapshot,
    turnsById: {
      ...snapshot.turnsById,
      [event.data.turn.turnId]: event.data.turn,
    },
  }
}

function applyMessageContent(
  previous: unknown,
  delta: Extract<AgentActivityEvent, { eventType: 'message_delta' }>['data']['content'],
): unknown {
  if (!delta) return previous ?? ''
  if (delta.operation === 'append_text') {
    return `${typeof previous === 'string' ? previous : ''}${delta.text ?? ''}`
  }
  return delta.value ?? delta.text ?? previous ?? ''
}