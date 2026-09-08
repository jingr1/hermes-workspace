'use client'

import { useEffect, useState } from 'react'
import { ChatWorkspace } from './components/chat-workspace'
import { ChatSessionSidebar } from './components/chat-session-sidebar'
import { useAgentWorkspace } from './hooks/use-agent-workspace'
import { useAgentStore } from '@/stores/agent-store'

export function AgentWorkspace() {
  useAgentWorkspace()

  const activeAgentId = useAgentStore((s) => s.activeAgentId)
  const activeAgent = useAgentStore((s) =>
    s.agents.find((a) => a.agentId === s.activeAgentId),
  )
  const sessionsByAgentId = useAgentStore((s) => s.sessionsByAgentId)
  const sessionsLoading = useAgentStore((s) =>
    activeAgentId ? s.sessionsLoading.has(activeAgentId) : false,
  )
  const sessionsError = useAgentStore((s) => s.agentsError)
  const activeSessionId = useAgentStore((s) => s.activeSessionId)
  const setActiveSessionId = useAgentStore((s) => s.setActiveSessionId)

  const sessions = activeAgentId
    ? (sessionsByAgentId.get(activeAgentId) ?? []).map((s) => ({
        key: s.sessionId,
        friendlyId: s.sessionId,
        title: s.title,
        updatedAt: new Date(s.lastMessageAt).getTime(),
        lastMessage: null,
      }))
    : []

  // SidebarSessions expects a stable reference; avoid remapping every render.
  const [stableSessions, setStableSessions] = useState(sessions)
  useEffect(() => {
    setStableSessions(sessions)
  }, [sessions])

  // Hermes agents render their own session sidebar inside ChatScreen, so adding
  // another one here would create a double sidebar and break the ratio. External
  // runtimes (claude-code, codex, etc.) do not have an internal sidebar, so we
  // provide the agent/session list at the workspace level.
  const isHermesRuntime = activeAgent?.runtime === 'hermes'

  return (
    <div className="flex h-full w-full overflow-hidden">
      {!isHermesRuntime && (
        <ChatSessionSidebar
          activeFriendlyId={activeSessionId ?? 'new'}
          sessions={stableSessions}
          sessionsLoading={sessionsLoading}
          sessionsFetching={false}
          sessionsError={sessionsError}
          onRetrySessions={() => {
            // Re-trigger by clearing the cached sessions for the active agent.
            if (!activeAgentId) return
            useAgentStore.getState().setSessions(activeAgentId, [])
          }}
          onNewChat={() => setActiveSessionId(null)}
          onActiveSessionDelete={() => setActiveSessionId(null)}
        />
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <ChatWorkspace />
      </div>
    </div>
  )
}
