import type { AgentActivityInteraction } from '@/lib/agent-activity-core'

export type ManagedAgentInteractionCard = {
  requestId: string
  turnId: string
  kind: AgentActivityInteraction['kind']
  title: string
  detail: string
  actions: Array<{ id: string; label: string }>
}

export function projectManagedAgentInteraction(
  interaction: AgentActivityInteraction,
): ManagedAgentInteractionCard | null {
  if (interaction.status !== 'pending') return null
  const metadataActions = interaction.metadata?.actions
  if (!Array.isArray(metadataActions)) return null
  const actions = metadataActions.flatMap((value) => {
    if (!value || typeof value !== 'object') return []
    const record = value as Record<string, unknown>
    const id = typeof record.id === 'string' ? record.id.trim() : ''
    const label = typeof record.label === 'string' ? record.label.trim() : ''
    return id && label ? [{ id, label }] : []
  })
  if (actions.length === 0) return null

  const toolCall = interaction.input?.toolCall
  const toolCallRecord =
    toolCall && typeof toolCall === 'object'
      ? (toolCall as Record<string, unknown>)
      : undefined
  const title =
    readText(interaction.input?.title) ||
    readText(interaction.input?.question) ||
    readText(toolCallRecord?.title) ||
    interaction.toolName ||
    interaction.kind
  const detail =
    readText(interaction.input?.description) ||
    readText(interaction.input?.message) ||
    readText(toolCallRecord?.description)
  return {
    requestId: interaction.requestId,
    turnId: interaction.turnId,
    kind: interaction.kind,
    title,
    detail,
    actions,
  }
}

function readText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}