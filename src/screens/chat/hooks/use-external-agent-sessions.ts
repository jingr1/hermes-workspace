'use client'

import { useCallback, useEffect, useMemo } from 'react'
import {
  deleteManagedSession,
  fetchSessionsForAgent,
  renameManagedSession,
} from '@/lib/agent-api'
import type { AgentSession } from '@/lib/agent-types'
import { useAgentStore } from '@/stores/agent-store'
import { writeLastSession } from '../last-session'
import type { SessionController } from '../session-controller'
import type { SessionMeta } from '../types'

function toSessionMeta(sessions: Array<AgentSession>): Array<SessionMeta> {
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
 * Session controller backed by collab.db managed_chat_sessions (server API).
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
  const setSessionsLoading = useAgentStore((s) => s.setSessionsLoading)
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

  const reload = useCallback(() => {
    if (!agentId) return
    setSessionsLoading(agentId, true)
    void fetchSessionsForAgent(agentId)
      .then((data) => setSessions(agentId, data.sessions))
      .catch(() => setSessions(agentId, []))
      .finally(() => setSessionsLoading(agentId, false))
  }, [agentId, setSessions, setSessionsLoading])

  useEffect(() => {
    reload()
  }, [reload])

  const onNewChat = useCallback(() => {
    setActiveSessionId(null)
  }, [setActiveSessionId])

  const onRetry = useCallback(() => {
    reload()
  }, [reload])

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
      void renameManagedSession(agentId, session.friendlyId, title)
        .then((updated) => upsertSession(agentId, updated))
        .catch(() => undefined)
    },
    [agentId, upsertSession],
  )

  const onDelete = useCallback(
    (session: SessionMeta) => {
      if (!agentId) return
      void deleteManagedSession(agentId, session.friendlyId)
        .then(() => removeSession(agentId, session.friendlyId))
        .catch(() => undefined)
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
