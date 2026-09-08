'use client'

import { useCallback, useEffect, useState } from 'react'
import { ChatWorkspace } from './components/chat-workspace'
import { ChatSessionSidebar } from './components/chat-session-sidebar'
import { useAgentWorkspace } from './hooks/use-agent-workspace'
import { useAgentStore } from '@/stores/agent-store'
import {
  deleteExternalChatSession,
  listExternalChatSessions,
  renameExternalChatSession,
} from '@/lib/external-chat-sessions'
import type { SessionMeta } from './types'

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
  const setSessions = useAgentStore((s) => s.setSessions)
  const upsertSession = useAgentStore((s) => s.upsertSession)
  const removeSession = useAgentStore((s) => s.removeSession)
  const clearSessions = useAgentStore((s) => s.clearSessions)

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
  const isExternalRuntime = Boolean(
    activeAgent && activeAgent.runtime !== 'hermes',
  )

  const handleActivateSession = useCallback(
    (session: SessionMeta) => {
      setActiveSessionId(session.friendlyId)
    },
    [setActiveSessionId],
  )

  const handleRenameSession = useCallback(
    (session: SessionMeta, newTitle: string) => {
      if (!activeAgentId || !isExternalRuntime) return
      const updated = renameExternalChatSession(
        activeAgentId,
        session.friendlyId,
        newTitle,
      )
      if (updated) upsertSession(activeAgentId, updated)
    },
    [activeAgentId, isExternalRuntime, upsertSession],
  )

  const handleDeleteSession = useCallback(
    (session: SessionMeta) => {
      if (!activeAgentId || !isExternalRuntime) return
      deleteExternalChatSession(activeAgentId, session.friendlyId)
      removeSession(activeAgentId, session.friendlyId)
    },
    [activeAgentId, isExternalRuntime, removeSession],
  )

  const handleRetrySessions = useCallback(() => {
    if (!activeAgentId) return
    if (isExternalRuntime) {
      setSessions(activeAgentId, listExternalChatSessions(activeAgentId))
      return
    }
    clearSessions(activeAgentId)
  }, [activeAgentId, clearSessions, isExternalRuntime, setSessions])

  return (
    <div className="flex h-full w-full overflow-hidden">
      {!isHermesRuntime && (
        <ChatSessionSidebar
          activeFriendlyId={activeSessionId ?? 'new'}
          sessions={stableSessions}
          sessionsLoading={sessionsLoading}
          sessionsFetching={false}
          sessionsError={sessionsError}
          onRetrySessions={handleRetrySessions}
          onNewChat={() => setActiveSessionId(null)}
          onActiveSessionDelete={() => setActiveSessionId(null)}
          onActivateSession={
            isExternalRuntime ? handleActivateSession : undefined
          }
          onRenameSession={
            isExternalRuntime ? handleRenameSession : undefined
          }
          onDeleteSession={
            isExternalRuntime ? handleDeleteSession : undefined
          }
        />
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <ChatWorkspace />
      </div>
    </div>
  )
}
