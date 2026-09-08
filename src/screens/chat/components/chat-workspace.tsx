'use client'

import { useEffect, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { ChatScreen } from '../chat-screen'
import { useProfiles } from '../hooks/use-profiles'
import { ChatRouteLoading } from '../chat-route-loading'
import { ManagedRuntimePanel } from './managed-runtime-panel'
import { ManagedAgentChatView } from './managed-agent-chat-view'
import { useAgentStore } from '@/stores/agent-store'
import { useExternalAgentSessions } from '../hooks/use-external-agent-sessions'

export function ChatWorkspace() {
  const agent = useAgentStore((state) =>
    state.agents.find((a) => a.agentId === state.activeAgentId),
  )
  const activeAgentId = useAgentStore((state) => state.activeAgentId)
  const agentsLoading = useAgentStore((state) => state.agentsLoading)
  const agentsCount = useAgentStore((state) => state.agents.length)
  const sessionId = useAgentStore((state) => state.activeSessionId)

  if (!agent) {
    // Avoid a flash of "Select an agent" while the list is still loading or
    // the URL agent id has not been resolved into the store yet.
    if (agentsLoading || (activeAgentId && agentsCount === 0)) {
      return (
        <div className="flex h-full flex-col items-center justify-center">
          <ChatRouteLoading />
        </div>
      )
    }
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

  if (agent.runtime === 'claude-code') {
    return (
      <ManagedAgentChatView agent={agent} sessionId={sessionId ?? null} />
    )
  }

  return (
    <ManagedPlaceholderShell
      agentId={agent.agentId}
      sessionId={sessionId ?? null}
    />
  )
}

function ManagedPlaceholderShell({
  agentId,
  sessionId,
}: {
  agentId: string
  sessionId: string | null
}) {
  const agent = useAgentStore((state) =>
    state.agents.find((a) => a.agentId === agentId),
  )
  const sessionController = useExternalAgentSessions(agentId)
  const activeFriendlyId = sessionId ?? 'new'
  const isNewChat = activeFriendlyId === 'new'

  if (!agent) return null

  return (
    <ChatScreen
      activeFriendlyId={activeFriendlyId}
      isNewChat={isNewChat}
      sessionController={sessionController}
      hermesChrome={false}
      renderMain={
        <ManagedRuntimePanel agent={agent} sessionId={sessionId} />
      }
      onSessionResolved={(payload) => {
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
      hermesChrome
      onSessionResolved={(payload) => {
        void payload
      }}
    />
  )
}
