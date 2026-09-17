import type {
  AgentActivityDurableMessage,
  AgentActivityInteraction,
  AgentActivitySession,
  AgentActivityTurn,
} from '../../../../packages/agent-activity-core/src/types'

export type ManagedAgentActivityDetail = {
  workspaceId: string
  session: AgentActivitySession
  turns: Array<AgentActivityTurn>
  messages: Array<AgentActivityDurableMessage>
  interactions: Array<AgentActivityInteraction>
}

export function mapManagedAgentActivitySnapshot(
  value: unknown,
): ManagedAgentActivityDetail | null {
  const root = record(value)
  const workspaceId = text(root?.workspaceId)
  const sessionRecord = record(root?.session)
  if (!workspaceId || !sessionRecord) return null
  const agentSessionId = text(sessionRecord.ID)
  const provider = text(sessionRecord.Provider)
  if (!agentSessionId || !provider) return null

  const turns = array(root?.turns).flatMap((turn) =>
    mapTurn(turn, agentSessionId),
  )
  const interactions = array(root?.interactions).flatMap((interaction) =>
    mapInteraction(interaction, agentSessionId),
  )
  const messages = array(root?.messages).flatMap((message) =>
    mapMessage(message, workspaceId, agentSessionId),
  )
  if (
    turns.length !== array(root?.turns).length ||
    interactions.length !== array(root?.interactions).length ||
    messages.length !== array(root?.messages).length
  ) {
    return null
  }

  const activeTurnId = nullableText(sessionRecord.ActiveTurnID)
  const activeTurn = activeTurnId
    ? turns.find((turn) => turn.turnId === activeTurnId) ?? null
    : null
  const latestTurn = [...turns].sort(
    (left, right) => right.updatedAtUnixMs - left.updatedAtUnixMs,
  )[0] ?? null
  const session: AgentActivitySession = {
    workspaceId,
    agentSessionId,
    kind: sessionRecord.Kind === 'child' ? 'child' : 'root',
    rootAgentSessionId: nullableText(sessionRecord.RootAgentSessionID),
    rootTurnId: nullableText(sessionRecord.RootTurnID),
    parentAgentSessionId: nullableText(sessionRecord.ParentAgentSessionID),
    parentTurnId: nullableText(sessionRecord.ParentTurnID),
    parentToolCallId: nullableText(sessionRecord.ParentToolCallID),
    agentTargetId: nullableText(sessionRecord.AgentTargetID),
    provider,
    providerSessionId: nullableText(sessionRecord.ProviderSessionID),
    model: nullableText(sessionRecord.Model),
    cwd: text(sessionRecord.Cwd),
    title: text(sessionRecord.Title),
    activeTurnId,
    activeTurn,
    latestTurn,
    latestTurnInteractions: latestTurn
      ? interactions.filter((interaction) => interaction.turnId === latestTurn.turnId)
      : [],
    pendingInteractions: interactions.filter(
      (interaction) => interaction.status === 'pending',
    ),
    settings: mapSettings(sessionRecord.Settings),
    permissionConfig: { configurable: false, modes: [] },
    capabilities: null,
    lifecycleCapabilities: { fork: false, forkThroughTurn: false },
    forkedFrom: null,
    usage: null,
    goal: null,
    agoraxModeActivation: null,
    imported: false,
    visible: true,
    resumable: false,
    messageVersion: number(sessionRecord.MessageVersion),
    lastEventUnixMs: number(sessionRecord.LastEventUnixMS),
    startedAtUnixMs: number(sessionRecord.StartedAtUnixMS),
    endedAtUnixMs: nullableNumber(sessionRecord.EndedAtUnixMS),
    pinnedAtUnixMs: nullableNumber(sessionRecord.PinnedAtUnixMS),
    createdAtUnixMs: number(sessionRecord.CreatedAtUnixMS),
    updatedAtUnixMs: number(sessionRecord.UpdatedAtUnixMS),
  }
  return { workspaceId, session, turns, messages, interactions }
}

function mapTurn(value: unknown, agentSessionId: string): Array<AgentActivityTurn> {
  const source = record(value)
  const turnId = text(source?.TurnID)
  const phase = text(source?.Phase)
  const origin = text(source?.Origin)
  if (!turnId || !isPhase(phase) || !isOrigin(origin)) return []
  const outcome = nullableText(source?.Outcome)
  if (outcome && !isOutcome(outcome)) return []
  return [{
    agentSessionId,
    turnId,
    phase,
    origin,
    outcome: outcome ?? null,
    ...(text(source?.ErrorMessage)
      ? { error: { message: text(source?.ErrorMessage), code: nullableText(source?.ErrorCode) ?? undefined } }
      : { error: null }),
    fileChanges: record(source?.FileChanges),
    startedAtUnixMs: number(source?.StartedAtUnixMS),
    settledAtUnixMs: nullableNumber(source?.SettledAtUnixMS),
    updatedAtUnixMs: number(source?.UpdatedAtUnixMS),
  }]
}

function mapInteraction(value: unknown, agentSessionId: string): Array<AgentActivityInteraction> {
  const source = record(value)
  const requestId = text(source?.RequestID)
  const turnId = text(source?.TurnID)
  const kind = text(source?.Kind)
  const status = text(source?.Status)
  if (!requestId || !turnId || !isInteractionKind(kind) || !isInteractionStatus(status)) return []
  return [{
    agentSessionId,
    requestId,
    turnId,
    kind,
    status,
    toolName: nullableText(source?.ToolName),
    input: record(source?.Input),
    output: record(source?.Output),
    metadata: record(source?.Metadata),
    createdAtUnixMs: number(source?.CreatedAtUnixMS),
    updatedAtUnixMs: number(source?.UpdatedAtUnixMS),
  }]
}

function mapMessage(value: unknown, workspaceId: string, agentSessionId: string): Array<AgentActivityDurableMessage> {
  const source = record(value)
  const messageId = text(source?.MessageID)
  const turnId = nullableText(source?.TurnID)
  const payload = record(source?.Payload)
  if (!messageId || !payload) return []
  return [{
    workspaceId,
    agentSessionId,
    messageId,
    turnId,
    role: text(source?.Role),
    kind: text(source?.Kind),
    status: nullableText(source?.Status),
    payload,
    version: number(source?.Version),
    sequence: number(source?.ID),
    occurredAtUnixMs: number(source?.OccurredAtUnixMS),
    startedAtUnixMs: number(source?.StartedAtUnixMS),
    completedAtUnixMs: number(source?.CompletedAtUnixMS),
    createdAtUnixMs: number(source?.CreatedAtUnixMS),
  }]
}

function mapSettings(value: unknown): AgentActivitySession['settings'] {
  const settings = record(value)
  return {
    ...(typeof settings?.Model === 'string' ? { model: settings.Model } : {}),
    ...(typeof settings?.ReasoningEffort === 'string' ? { reasoningEffort: settings.ReasoningEffort } : {}),
    ...(typeof settings?.PermissionModeID === 'string' ? { permissionModeId: settings.PermissionModeID } : {}),
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}
function array(value: unknown): Array<unknown> { return Array.isArray(value) ? value : [] }
function text(value: unknown): string { return typeof value === 'string' ? value.trim() : '' }
function nullableText(value: unknown): string | null { const result = text(value); return result || null }
function number(value: unknown): number { return typeof value === 'number' && Number.isFinite(value) ? value : 0 }
function nullableNumber(value: unknown): number | null { const result = number(value); return result > 0 ? result : null }
function isPhase(value: string): value is AgentActivityTurn['phase'] { return ['submitted', 'running', 'waiting', 'settling', 'settled'].includes(value) }
function isOrigin(value: string): value is AgentActivityTurn['origin'] { return ['user_prompt', 'goal_arm', 'goal_continuation', 'provider_initiated', 'legacy_unknown'].includes(value) }
function isOutcome(value: string): value is NonNullable<AgentActivityTurn['outcome']> { return ['completed', 'failed', 'canceled', 'interrupted'].includes(value) }
function isInteractionKind(value: string): value is AgentActivityInteraction['kind'] { return ['approval', 'question', 'plan'].includes(value) }
function isInteractionStatus(value: string): value is AgentActivityInteraction['status'] { return ['pending', 'answered', 'superseded'].includes(value) }