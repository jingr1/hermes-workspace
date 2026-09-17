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

export type AgentActivityInteraction = {
  requestId: string
  turnId: string
  kind: 'approval' | 'question' | 'plan'
  status: 'pending' | 'answered' | 'superseded'
  toolName?: string
  input?: Record<string, unknown>
  output?: Record<string, unknown>
  metadata?: Record<string, unknown>
}

export type AgentActivitySnapshot = {
  workspaceId: string
  agentSessionId: string
  messagesById: Record<string, AgentActivityMessage>
  turnsById: Record<string, AgentActivityTurn>
  interactionsById: Record<string, AgentActivityInteraction>
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
  | {
      eventType: 'interaction_update'
      data: {
        agentSessionId: string
        interaction: AgentActivityInteraction
      }
    }

export function createAgentActivitySnapshot(input: {
  workspaceId: string
  agentSessionId: string
}): AgentActivitySnapshot {
  return { ...input, messagesById: {}, turnsById: {}, interactionsById: {} }
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

  if (event.eventType === 'interaction_update') {
    return {
      ...snapshot,
      interactionsById: {
        ...snapshot.interactionsById,
        [event.data.interaction.requestId]: event.data.interaction,
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