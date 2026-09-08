'use client'

import { useEffect, useRef } from 'react'
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
  const { activateProfile, activeProfileName } = useProfiles()
  const queryClient = useQueryClient()
  const targetProfile = agent?.runtimeConfig.profile ?? agentId
  const pendingSwitchRef = useRef(false)

  // Activate in the background — never unmount ChatScreen for this, or the
  // chat pane flashes empty (reads as a black screen in dark theme).
  useEffect(() => {
    if (!agent || activeProfileName === targetProfile) return
    pendingSwitchRef.current = true
    activateProfile(targetProfile)
  }, [activateProfile, activeProfileName, targetProfile, agent])

  useEffect(() => {
    if (!pendingSwitchRef.current || activeProfileName !== targetProfile) return
    pendingSwitchRef.current = false
    void queryClient.invalidateQueries({ queryKey: ['chat', 'sessions'] })
  }, [activeProfileName, targetProfile, queryClient])

  if (!agent) {
    return (
      <div className="flex h-full flex-col items-center justify-center">
        <ChatRouteLoading />
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
