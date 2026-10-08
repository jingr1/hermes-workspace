'use client'

import type { ReactNode } from 'react'
import { ChatMessageList } from './chat-message-list'
import type { ChatMessage } from '../types'

/**
 * Shared message pane for AgentChatFrame children.
 * Always uses ChatMessageList's own scroll root — do not wrap in another
 * ChatContainer (nested viewports break wheel scrolling).
 */
export function AgentChatMessagePane({
  messages,
  showProcessingIndicator,
  isStreaming = false,
  streamingMessageId = null,
  sessionKey,
  emptyState,
  headerHeight = 48,
  activeToolCalls,
}: {
  messages: Array<ChatMessage>
  showProcessingIndicator: boolean
  /** Turn-active: message-level live chrome / Stop, not the bottom pill. */
  isStreaming?: boolean
  streamingMessageId?: string | null
  sessionKey: string
  emptyState?: ReactNode
  headerHeight?: number
  activeToolCalls?: Array<{ id: string; name: string; phase: string; args?: unknown }>
}) {
  const empty = messages.length === 0

  return (
    <ChatMessageList
      messages={messages}
      showProcessingIndicator={showProcessingIndicator}
      researchCard={undefined}
      loading={false}
      empty={empty}
      emptyState={emptyState}
      pinToTop={false}
      pinGroupMinHeight={0}
      headerHeight={headerHeight}
      sessionKey={sessionKey}
      isStreaming={isStreaming}
      streamingMessageId={streamingMessageId}
      activeToolCalls={activeToolCalls}
    />
  )
}
