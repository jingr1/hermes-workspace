/**
 * Unified session abstraction for the Agent Workspace UI.
 *
 * For hermes agents sessions come from the existing profile state.db.
 * For managed non-hermes runtimes (claude-code, …) sessions live in
 * collab.db via managed-chat-store (SQLite + Claude --resume).
 */
import { listSessionsForProfile } from './profiles-browser'
import { getAgentRuntimeRouter } from './agent-runtime/router'
import {
  createSessionForManagedAgent,
  deleteManagedChatSession,
  listManagedChatSessions,
  renameManagedChatSession,
} from './agent-runtime/managed-chat-store'
import type {
  AgentRuntime,
  AgentSession,
  AgentSessionState,
} from '../lib/agent-types'

function deriveSessionState(messageCount: number): AgentSessionState {
  return messageCount > 0 ? 'completed' : 'idle'
}

function listHermesSessions(agentId: string): Array<AgentSession> {
  const sessions = listSessionsForProfile(agentId)
  return sessions.map((session) => ({
    sessionId: session.friendlyId,
    agentId,
    title: session.title ?? session.friendlyId,
    state: deriveSessionState(session.messageCount ?? 0),
    lastMessageAt: new Date(session.updatedAt || Date.now()).toISOString(),
    summary: `Messages: ${session.messageCount ?? 0}`,
  }))
}

function listManagedRuntimeSessions(
  agentId: string,
  _runtime: Exclude<AgentRuntime, 'hermes'>,
): Array<AgentSession> {
  return listManagedChatSessions(agentId)
}

export function listSessionsForAgent(agentId: string): Array<AgentSession> {
  const router = getAgentRuntimeRouter()
  const decl = router.registry.byId.get(agentId)
  if (!decl) {
    // Could be an orphan hermes profile (not declared but present on disk).
    if (router.registry.orphanProfiles.includes(agentId)) {
      return listHermesSessions(agentId)
    }
    return listManagedChatSessions(agentId)
  }
  if (decl.runtime === 'hermes') {
    return listHermesSessions(decl.profile ?? decl.id)
  }
  return listManagedRuntimeSessions(decl.id, decl.runtime)
}

export function createSessionForAgent(
  agentId: string,
  payload: { title?: string; model?: string },
): { sessionId: string } {
  const router = getAgentRuntimeRouter()
  const decl = router.registry.byId.get(agentId)
  const isHermes =
    decl?.runtime === 'hermes' ||
    (!decl && router.registry.orphanProfiles.includes(agentId))
  if (isHermes) {
    // Hermes new-session creation is handled by the existing /api/sessions flow.
    return { sessionId: `new-${Date.now()}` }
  }
  return createSessionForManagedAgent(agentId, {
    runtime: decl?.runtime ?? 'claude-code',
    title: payload.title,
    model: payload.model,
  })
}

export function renameSessionForAgent(
  agentId: string,
  sessionId: string,
  title: string,
): AgentSession | null {
  const router = getAgentRuntimeRouter()
  const decl = router.registry.byId.get(agentId)
  if (!decl || decl.runtime === 'hermes') return null
  return renameManagedChatSession({ agentId, sessionId, title })
}

export function deleteSessionForAgent(
  agentId: string,
  sessionId: string,
): boolean {
  const router = getAgentRuntimeRouter()
  const decl = router.registry.byId.get(agentId)
  if (!decl || decl.runtime === 'hermes') return false
  return deleteManagedChatSession({ agentId, sessionId })
}
