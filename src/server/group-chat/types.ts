/**
 * Group chat domain types.
 *
 * These are runtime representations of the collab.db tables. They are kept
 * close to the DB schema but add convenience fields (parsed JSON arrays) for
 * the runner.
 */

export type ParticipantKind = 'human' | 'agent' | 'system'

export type RoomRuntime = 'hermes' | 'claude-code' | 'codex' | 'deepseek-harness' | 'human'

export type RoomState =
  | 'active'
  | 'paused'
  | 'needs_human'
  | 'complete'
  | 'disbanded'

export type Room = {
  id: string
  title: string
  state: RoomState
  taskId: string | null
  missionId: string | null
  workspacePath: string | null
  ownerParticipantId: string | null
  createdAt: number
  updatedAt: number
}

export type RoomParticipant = {
  id: string
  roomId: string
  kind: ParticipantKind
  participantId: string
  displayName: string
  mentionName: string
  description: string | null
  /** Hermes profile name (runtime = 'hermes'). Null for non-Hermes runtimes. */
  profile: string | null
  runtime: RoomRuntime
  isOwner: boolean
  online: boolean
  joinedAt: number
  removedAt: number | null
}

export type MentionTarget =
  | { type: 'agent'; participantId: string }
  | { type: 'human'; participantId?: string }
  | { type: 'all' }

export type RoomMessage = {
  id: string
  roomId: string
  senderKind: ParticipantKind
  senderParticipantId: string | null
  senderName: string
  content: string
  mentions: Array<MentionTarget>
  mentionDepth: number
  autoHandoff: boolean
  taskRefs: Array<string>
  answersPendingTurnId: string | null
  runId: string | null
  taskId: string | null
  createdAt: number
}

export type RoomSummary = {
  roomId: string
  content: string
  throughMessageId: string | null
  throughAt: number
  turnCount: number
  version: number
  generatedAt: number
}

export type PendingTurnKind = 'needs_input' | 'blocked' | 'approval' | 'review'
export type PendingTurnStatus = 'pending' | 'answered' | 'dismissed' | 'expired'

export type PendingTurn = {
  id: string
  roomId: string
  taskId: string | null
  assignmentId: string | null
  requestedBy: string
  targetParticipantId: string | null
  messageId: string | null
  kind: PendingTurnKind
  reason: string | null
  options: Array<{ id: string; label: string; replyText: string }> | null
  status: PendingTurnStatus
  createdAt: number
  answeredAt: number | null
  answeredMessageId: string | null
}

/** Per-participant watermark: how many messages this participant has seen. */
export type RoomWatermark = {
  roomId: string
  participantId: string
  messageCount: number
  updatedAt: number
}

/** Turn result surfaced by the executor to the runner. */
export type GroupTurnResult =
  | { kind: 'reply'; text: string; runId?: string }
  | { kind: 'pass' }
  | { kind: 'failed'; reason: string }
  | { kind: 'blocked'; pendingTurnId: string }
  | { kind: 'timeout' }

/** Minimal participant shape used by the runner/mention resolver. */
export type GroupMember = Pick<
  RoomParticipant,
  'id' | 'participantId' | 'displayName' | 'mentionName' | 'runtime' | 'kind' | 'profile'
> & {
  /** Alias for displayName to match upstream naming. */
  name: string
  /** True if the member is a bot that can take turns. */
  isBot: boolean
  /**
   * Hermes profile name that owns this participant's runtime.
   * For runtime === 'hermes' this is the profile whose gateway the turn
   * must hit. For other runtimes it is null/undefined.
   */
  profile: string | null
}

/** Room activity event published on chat-event-bus. */
export type GroupActivityEvent =
  | { kind: 'turn_started'; member: string; roomId: string }
  | { kind: 'turn_ended'; member: string; roomId: string; result: GroupTurnResult['kind'] }
  | { kind: 'reply'; member: string; roomId: string; text: string }
  | { kind: 'failed'; member: string; roomId: string; reason?: string }
  | { kind: 'held'; member: string; roomId: string }
  | { kind: 'human_attention'; roomId: string; pendingTurnId: string }
  | { kind: 'settled'; roomId: string }
  | { kind: 'capped'; roomId: string }
  | { kind: 'cancelled'; roomId: string }
