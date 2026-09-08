'use client'

import { createContext, useContext, type ReactNode } from 'react'

export type AssistantAvatarConfig = {
  src: string
  alt: string
}

const DEFAULT_ASSISTANT_AVATAR: AssistantAvatarConfig = {
  src: '/claude-avatar.webp',
  alt: 'Hermes Agent',
}

const AssistantAvatarContext = createContext<AssistantAvatarConfig>(
  DEFAULT_ASSISTANT_AVATAR,
)

export function AssistantAvatarProvider({
  value,
  children,
}: {
  value: AssistantAvatarConfig
  children: ReactNode
}) {
  return (
    <AssistantAvatarContext.Provider value={value}>
      {children}
    </AssistantAvatarContext.Provider>
  )
}

export function useAssistantAvatarConfig(): AssistantAvatarConfig {
  return useContext(AssistantAvatarContext)
}
