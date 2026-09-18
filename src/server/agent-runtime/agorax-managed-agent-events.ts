import type { AgentStreamEvent } from './types'
import type { AgentActivityUpdatedEvent } from '@agorax/agent-activity-core'

export type AgoraxManagedAgentActivity = AgentActivityUpdatedEvent

/**
 * Converts only canonical Managed Agent activity facts into the legacy stream shape
 * consumed by the current Agorax chat shell. Unknown activity is ignored so
 * the adapter cannot invent provider output or terminal state.
 */
export function agoraxEventsFromManagedActivity(
  runId: string,
  activity: AgoraxManagedAgentActivity,
  workspaceId = 'default',
): AgentStreamEvent[] {
  const canonicalEvent: AgentStreamEvent = {
    type: 'activity',
    runId,
    workspaceId,
    activity,
  }
  if (activity.eventType === 'message_delta') {
    const content = activity.data.content
    const text = content?.operation === 'append_text' ? content.text : ''
    if (activity.data.role === 'assistant' && text) {
      return [canonicalEvent, { type: 'text_delta', runId, text }]
    }
    return [canonicalEvent]
  }

  if (activity.eventType !== 'turn_update') return [canonicalEvent]
  if (activity.data.turn.phase !== 'settled') return [canonicalEvent]
  const outcome = activity.data.turn.outcome
  if (!outcome) return [canonicalEvent]
  return [
    canonicalEvent,
    {
      type: 'run_exited',
      runId,
      exitCode: outcome === 'completed' ? 0 : 1,
    },
  ]
}
