'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  deleteExternalChatSession,
  listExternalChatSessions,
  renameExternalChatSession,
} from '@/lib/external-chat-sessions'
import { useAgentStore } from '@/stores/agent-store'
import { writeLastSession } from '../last-session'
import type { SessionController } from '../session-controller'
import type { SessionMeta } from '../types'

function toSessionMeta(sessions: ReturnType<typeof listExternalChatSessions>) {
  return sessions.map(
    (s): SessionMeta => ({
      key: s.sessionId,
      friendlyId: s.sessionId,
      title: s.title,
      updatedAt: new Date(s.lastMessageAt).getTime(),
      lastMessage: null,
    }),
  )
}

/**
 * Session controller backed by localStorage external-chat index.
 * Used by Claude Code (and other managed runtimes) inside ChatScreen's
 * shared ChatSessionSidebar — no AgentWorkspace outer sidebar.
 */
export function useExternalAgentSessions(
  agentId: string | null,
): SessionController {
  const activeSessionId = useAgentStore((s) => s.activeSessionId)
  const setActiveSessionId = useAgentStore((s) => s.setActiveSessionId)
  const sessionsByAgentId = useAgentStore((s) => s.sessionsByAgentId)
  const setSessions = useAgentStore((s) => s.setSessions)
  const upsertSession = useAgentStore((s) => s.upsertSession)
  const removeSession = useAgentStore((s) => s.removeSession)
  const sessionsLoading = useAgentStore((s) =>
    agentId ? s.sessionsLoading.has(agentId) : false,
  )
  const sessionsError = useAgentStore((s) => s.agentsError)

  const storeSessions = agentId
    ? (sessionsByAgentId.get(agentId) ?? [])
    : []

  const sessions = useMemo(
    () => toSessionMeta(storeSessions),
    [storeSessions],
  )

  // Keep store in sync on mount / agent switch.
  useEffect(() => {
    if (!agentId) return
    setSessions(agentId, listExternalChatSessions(agentId))
  }, [agentId, setSessions])

  const onNewChat = useCallback(() => {
    setActiveSessionId(null)
  }, [setActiveSessionId])

  const onRetry = useCallback(() => {
    if (!agentId) return
    setSessions(agentId, listExternalChatSessions(agentId))
  }, [agentId, setSessions])

  const onActivateSession = useCallback(
    (session: SessionMeta) => {
      if (agentId) writeLastSession(session.friendlyId, agentId)
      setActiveSessionId(session.friendlyId)
    },
    [agentId, setActiveSessionId],
  )

  const onRename = useCallback(
    (session: SessionMeta, title: string) => {
      if (!agentId) return
      const updated = renameExternalChatSession(
        agentId,
        session.friendlyId,
        title,
      )
      if (updated) upsertSession(agentId, updated)
    },
    [agentId, upsertSession],
  )

  const onDelete = useCallback(
    (session: SessionMeta) => {
      if (!agentId) return
      deleteExternalChatSession(agentId, session.friendlyId)
      removeSession(agentId, session.friendlyId)
    },
    [agentId, removeSession],
  )

  const onActiveSessionDelete = useCallback(() => {
    setActiveSessionId(null)
  }, [setActiveSessionId])

  return {
    sessions,
    loading: sessionsLoading,
    fetching: false,
    error: sessionsError,
    activeFriendlyId: activeSessionId ?? 'new',
    onNewChat,
    onRetry,
    onActivateSession,
    onRename,
    onDelete,
    onActiveSessionDelete,
  }
}
