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
  waitingForResponse,
  sessionKey,
  emptyState,
  headerHeight = 48,
  activeToolCalls,
}: {
  messages: Array<ChatMessage>
  waitingForResponse: boolean
  sessionKey: string
  emptyState?: ReactNode
  headerHeight?: number
  activeToolCalls?: Array<{ id: string; name: string; phase: string; args?: unknown }>
}) {
  const empty = messages.length === 0

  return (
    <ChatMessageList
      messages={messages}
      waitingForResponse={waitingForResponse}
      researchCard={undefined}
      loading={false}
      empty={empty}
      emptyState={emptyState}
      pinToTop={false}
      pinGroupMinHeight={0}
      headerHeight={headerHeight}
      sessionKey={sessionKey}
      isStreaming={waitingForResponse}
      activeToolCalls={activeToolCalls}
    />
  )
}
