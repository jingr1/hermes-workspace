/**
 * Map Hermes gateway history ChatMessage[] → Engine durable Activity messages.
 * Used by Phase D history reconcile (same role as managed detail.messages).
 */

import type { AgentActivityDurableMessage } from '@agorax/agent-activity-core'
import { assistantMessageIdForRun, readDurableMessageId } from './chat-turn-identity'
import type { ChatMessage } from '@/screens/chat/types'

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function messageTimestamp(message: ChatMessage, index: number): number {
  const raw = message.timestamp
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) return raw
  return index + 1
}

function contentParts(message: ChatMessage): Array<Record<string, unknown>> {
  return Array.isArray(message.content)
    ? message.content.filter(
        (part): part is Record<string, unknown> =>
          Boolean(part) && typeof part === 'object',
      )
    : []
}

function durableAssistantId(message: ChatMessage, agentSessionId: string, index: number): string {
  const existing = readDurableMessageId(message)
  if (existing) return existing
  const runId = readString(message.runId).trim()
  if (runId) return assistantMessageIdForRun(runId, agentSessionId)
  return `assistant:history:${agentSessionId}:${index}`
}

function durableUserId(message: ChatMessage, agentSessionId: string, index: number): string {
  const existing = readDurableMessageId(message)
  if (existing) return existing
  const clientSubmitId = readString(
    (message as { clientSubmitId?: unknown }).clientSubmitId,
  ).trim()
  if (clientSubmitId) return `user:${clientSubmitId}`
  return `user:history:${agentSessionId}:${index}`
}

function turnIdFor(message: ChatMessage, messageId: string): string {
  const turnId = readString((message as { turnId?: unknown }).turnId).trim()
  if (turnId) return turnId
  const runId = readString(message.runId).trim()
  if (runId) return `turn-${runId}`
  if (messageId.startsWith('assistant:')) return `turn-${messageId.slice('assistant:'.length)}`
  return `turn-${messageId}`
}

/**
 * Convert one history page into durable Activity messages (stable ids).
 * Expands combined assistant content into reasoning / tool_call / text rows.
 */
export function hermesHistoryMessagesToActivity(input: {
  workspaceId: string
  agentSessionId: string
  messages: readonly ChatMessage[]
}): AgentActivityDurableMessage[] {
  const workspaceId = input.workspaceId.trim() || 'default'
  const agentSessionId = input.agentSessionId.trim()
  if (!agentSessionId) return []

  const out: AgentActivityDurableMessage[] = []
  let sequence = 0

  for (let index = 0; index < input.messages.length; index += 1) {
    const message = input.messages[index]
    if (!message) continue
    const role = readString(message.role).trim() || 'assistant'
    const occurredAtUnixMs = messageTimestamp(message, index)
    const parts = contentParts(message)

    if (role === 'user') {
      sequence += 1
      const messageId = durableUserId(message, agentSessionId, index)
      const text =
        parts
          .map((part) => (part.type === 'text' ? readString(part.text) : ''))
          .join('')
          .trim() ||
        readString(message.text).trim()
      out.push({
        workspaceId,
        agentSessionId,
        messageId,
        version: sequence,
        sequence,
        turnId: turnIdFor(message, messageId),
        role: 'user',
        kind: 'text',
        status: null,
        payload: {
          text,
          content: text,
          ...(readString((message as { clientSubmitId?: unknown }).clientSubmitId)
            ? {
                clientSubmitId: readString(
                  (message as { clientSubmitId?: unknown }).clientSubmitId,
                ).trim(),
              }
            : {}),
        },
        occurredAtUnixMs,
      })
      continue
    }

    if (role !== 'assistant' && role !== 'assistant_thinking') continue

    const baseId = durableAssistantId(message, agentSessionId, index)
    const turnId = turnIdFor(message, baseId)
    const status =
      message.__streamingStatus === 'streaming'
        ? 'streaming'
        : message.__streamingStatus === 'error' || message.isError
          ? 'failed'
          : 'completed'

    let emittedText = false
    let emittedThinking = false

    for (const part of parts) {
      const type = readString(part.type)
      if (type === 'thinking' || type === 'redacted_thinking' || type === 'reasoning') {
        const thinking =
          readString(part.thinking) ||
          readString(part.text) ||
          readString(part.reasoning)
        if (!thinking.trim()) continue
        sequence += 1
        out.push({
          workspaceId,
          agentSessionId,
          messageId: emittedThinking ? `${baseId}:thinking:${sequence}` : `${baseId}:thinking`,
          version: sequence,
          sequence,
          turnId,
          role: 'assistant_thinking',
          kind: 'reasoning',
          status,
          payload: { text: thinking, content: thinking },
          occurredAtUnixMs,
        })
        emittedThinking = true
        continue
      }
      if (type === 'toolCall' || type === 'tool_call' || type === 'tool') {
        const toolCallId =
          readString(part.id) ||
          readString(part.toolCallId) ||
          `${baseId}:tool:${sequence + 1}`
        const name =
          readString(part.name) ||
          readString(message.toolName) ||
          'tool'
        sequence += 1
        const details = asRecord(message.details)
        out.push({
          workspaceId,
          agentSessionId,
          messageId: toolCallId.startsWith('toolcall:')
            ? toolCallId
            : `toolcall:${toolCallId}`,
          version: sequence,
          sequence,
          turnId,
          role: 'assistant',
          kind: 'tool_call',
          status: message.isError ? 'failed' : 'completed',
          payload: {
            name,
            toolName: name,
            input: asRecord(part.arguments) ?? asRecord(part.input) ?? details?.input,
            output: details?.output ?? part.result ?? part.output,
          },
          occurredAtUnixMs,
        })
        continue
      }
      if (type === 'text' || !type) {
        const text = readString(part.text)
        if (!text) continue
        sequence += 1
        out.push({
          workspaceId,
          agentSessionId,
          messageId: emittedText ? `${baseId}:text:${sequence}` : baseId,
          version: sequence,
          sequence,
          turnId,
          role: 'assistant',
          kind: 'text',
          status,
          payload: { text, content: text },
          occurredAtUnixMs,
        })
        emittedText = true
      }
    }

    // Fallback: top-level text / empty assistant host row (keep durable id).
    if (!emittedText && !emittedThinking && parts.length === 0) {
      const text =
        readString(message.text) ||
        readString((message as { __streamingText?: unknown }).__streamingText)
      sequence += 1
      out.push({
        workspaceId,
        agentSessionId,
        messageId: baseId,
        version: sequence,
        sequence,
        turnId,
        role: 'assistant',
        kind: 'text',
        status,
        payload: { text, content: text },
        occurredAtUnixMs,
      })
    }
  }

  return out
}
