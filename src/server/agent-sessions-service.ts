/**
 * Unified session abstraction for the Agent Workspace UI.
 *
 * For hermes agents sessions come from the existing profile state.db.
 * For managed non-hermes runtimes (claude-code, codex, ...) sessions are
 * derived from adapter task history once those adapters are delivered.
 */
import { listSessionsForProfile } from './profiles-browser'
import { getAgentRuntimeRouter } from './agent-runtime/router'
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
  runtime: Exclude<AgentRuntime, 'hermes'>,
): Array<AgentSession> {
  // TODO: adapter-delivered task/run history (P1 步骤 4).
  void runtime
  return []
}

export function listSessionsForAgent(agentId: string): Array<AgentSession> {
  const router = getAgentRuntimeRouter()
  const decl = router.registry.byId.get(agentId)
  if (!decl) {
    // Could be an orphan hermes profile (not declared but present on disk).
    if (router.registry.orphanProfiles.includes(agentId)) {
      return listHermesSessions(agentId)
    }
    return []
  }
  if (decl.runtime === 'hermes') {
    return listHermesSessions(decl.profile ?? decl.id)
  }
  return listManagedRuntimeSessions(decl.id, decl.runtime)
}

export function createSessionForAgent(
  agentId: string,
  _payload: { title?: string; model?: string },
): { sessionId: string } {
  const router = getAgentRuntimeRouter()
  const decl = router.registry.byId.get(agentId)
  if (!decl || decl.runtime !== 'hermes') {
    throw new Error(`Session creation for ${agentId} is not yet supported`)
  }
  // Hermes new-session creation is handled by the existing /api/sessions flow.
  // This wrapper returns a deterministic draft id until the user sends a message.
  return { sessionId: `new-${Date.now()}` }
}
