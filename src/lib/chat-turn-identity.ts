/**
 * Tutti-aligned chat turn identity helpers shared by Hermes write-through
 * and (conceptually) managed-agent messageId rows.
 *
 * See docs/chat-turn-identity-contract.md.
 */

export function assistantMessageIdForRun(
  runId: string | null | undefined,
  sessionKey: string,
): string {
  const trimmedRun = typeof runId === 'string' ? runId.trim() : ''
  if (trimmedRun) return `assistant:${trimmedRun}`
  const trimmedSession = sessionKey.trim() || 'session'
  return `assistant:pending:${trimmedSession}`
}

export function readDurableMessageId(message: {
  id?: unknown
  messageId?: unknown
}): string {
  for (const key of ['messageId', 'id'] as const) {
    const value = message[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

/**
 * Presentation key for transcript rows. Prefer durable identity so growing
 * stream text does not remount the bubble (fingerprint keys caused reload UX).
 */
export function stableChatMessageKey(
  message: {
    id?: unknown
    messageId?: unknown
    __optimisticId?: unknown
    role?: unknown
    content?: unknown
  },
  index: number,
  textFromMessage: (message: { content?: unknown; role?: unknown }) => string,
): string {
  const durable = readDurableMessageId(message)
  if (durable) return durable

  if (
    typeof message.__optimisticId === 'string' &&
    message.__optimisticId.trim()
  ) {
    return message.__optimisticId.trim()
  }

  const role =
    typeof message.role === 'string' && message.role.trim()
      ? message.role.trim()
      : 'assistant'
  const text = textFromMessage(message).trim()
  if (role === 'assistant' && text.length > 0) {
    return `assistant-fp:${djb2(`${text.length}:${text.slice(0, 160)}`)}`
  }
  if (text.length > 0) {
    return `${role}-fp:${djb2(text.slice(0, 120))}-${index}`
  }
  return `${role}-idx:${index}`
}

function djb2(str: string): string {
  let hash = 5381
  for (let i = 0; i < str.length; i += 1) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) | 0
  }
  return (hash >>> 0).toString(36)
}

export type LiveAssistantProjection = {
  messageId: string
  runId: string | null
  text: string
  thinking: string
  toolCalls: Array<{
    id: string
    name: string
    phase: string
    args?: unknown
    preview?: string
    result?: string
  }>
  streaming: boolean
  timestamp: number
}

/**
 * Build the single write-through assistant row for a live turn.
 * Same shape managed ACP keeps on one messageId across delta → settle.
 */
export function projectLiveAssistantMessage(
  projection: LiveAssistantProjection,
): {
  id: string
  messageId: string
  role: 'assistant'
  content: Array<Record<string, unknown>>
  timestamp: number
  runId: string | null
  __streamingStatus: 'streaming' | 'complete'
  __streamingText: string
  __streamingThinking: string
  __streamToolCalls: LiveAssistantProjection['toolCalls']
} {
  const content: Array<Record<string, unknown>> = []
  const thinking = projection.thinking.trim()
  if (thinking) {
    content.push({ type: 'thinking', thinking })
  }
  for (const toolCall of projection.toolCalls) {
    content.push({
      type: 'toolCall',
      id: toolCall.id,
      name: toolCall.name,
      arguments:
        toolCall.args && typeof toolCall.args === 'object'
          ? (toolCall.args as Record<string, unknown>)
          : undefined,
    })
  }
  const text = projection.text.trim()
  if (text) {
    content.push({ type: 'text', text })
  }

  return {
    id: projection.messageId,
    messageId: projection.messageId,
    role: 'assistant',
    content,
    timestamp: projection.timestamp,
    runId: projection.runId,
    __streamingStatus: projection.streaming ? 'streaming' : 'complete',
    __streamingText: projection.text,
    __streamingThinking: projection.thinking,
    __streamToolCalls: projection.toolCalls,
  }
}

/**
 * Upsert by durable messageId. Replaces the same row in place — never appends
 * a second assistant for the same turn.
 */
export function upsertMessageByDurableId<T extends { role?: string }>(
  messages: Array<T>,
  next: T & { id?: unknown; messageId?: unknown },
): Array<T> {
  const nextId = readDurableMessageId(next)
  if (!nextId) return [...messages, next]

  const index = messages.findIndex(
    (message) => readDurableMessageId(message as { id?: unknown; messageId?: unknown }) === nextId,
  )
  if (index < 0) return [...messages, next]
  const copy = messages.slice()
  copy[index] = {
    ...messages[index],
    ...next,
  }
  return copy
}
