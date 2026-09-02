'use client'

import { useEffect, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { ChatScreen } from '../chat-screen'
import { useProfiles } from '../hooks/use-profiles'
import { ChatRouteLoading } from '../chat-route-loading'
import { ManagedRuntimePanel } from './managed-runtime-panel'
import { useAgentStore } from '@/stores/agent-store'

export function ChatWorkspace() {
  const agent = useAgentStore((state) =>
    state.agents.find((a) => a.agentId === state.activeAgentId),
  )
  const sessionId = useAgentStore((state) => state.activeSessionId)

  if (!agent) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-primary-500 dark:text-primary-400">
        Select an agent to start chatting.
      </div>
    )
  }

  if (agent.runtime === 'hermes') {
    return (
      <HermesChatShell agentId={agent.agentId} sessionId={sessionId ?? null} />
    )
  }

  const activeFriendlyId = sessionId ?? 'new'
  const isNewChat = activeFriendlyId === 'new'

  return (
    <ChatScreen
      activeFriendlyId={activeFriendlyId}
      isNewChat={isNewChat}
      renderMain={
        <ManagedRuntimePanel agent={agent} sessionId={sessionId ?? null} />
      }
      onSessionResolved={(payload) => {
        // The route handler updates the URL; no-op here to keep the workspace
        // shell stable.
        void payload
      }}
    />
  )
}

function HermesChatShell({
  agentId,
  sessionId,
}: {
  agentId: string
  sessionId: string | null
}) {
  const agent = useAgentStore((state) =>
    state.agents.find((a) => a.agentId === agentId),
  )
  const { activateProfile, isActivating, activeProfileName } = useProfiles()
  const queryClient = useQueryClient()
  const [activating, setActivating] = useState(false)

  const targetProfile = agent?.runtimeConfig.profile ?? agentId

  useEffect(() => {
    if (activeProfileName === targetProfile) return
    setActivating(true)
    activateProfile(targetProfile)
  }, [activateProfile, activeProfileName, targetProfile])

  useEffect(() => {
    if (!isActivating && activeProfileName === targetProfile) {
      setActivating(false)
      // Warm session list cache for the newly activated profile.
      void queryClient.invalidateQueries({ queryKey: ['chat', 'sessions'] })
    }
  }, [isActivating, activeProfileName, targetProfile, queryClient])

  if (
    activating ||
    isActivating ||
    activeProfileName !== targetProfile ||
    !agent
  ) {
    return (
      <div className="flex h-full flex-col items-center justify-center">
        <ChatRouteLoading />
        <p className="mt-2 text-sm text-primary-500 dark:text-primary-400">
          Activating {agent?.name ?? 'agent'}
        </p>
      </div>
    )
  }

  const activeFriendlyId = sessionId ?? 'new'
  const isNewChat = activeFriendlyId === 'new'

  return (
    <ChatScreen
      activeFriendlyId={activeFriendlyId}
      isNewChat={isNewChat}
      onSessionResolved={(payload) => {
        // The route handler updates the URL; no-op here to keep the workspace
        // shell stable.
        void payload
      }}
    />
  )
}
