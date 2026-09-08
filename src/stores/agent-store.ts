'use client'

import { create } from 'zustand'
import type { AgentSession, AgentWithStatus } from '@/lib/agent-types'

interface AgentStore {
  agents: Array<AgentWithStatus>
  agentsLoading: boolean
  agentsError: string | null
  activeAgentId: string | null
  sessionsByAgentId: Map<string, Array<AgentSession>>
  sessionsLoading: Set<string>
  activeSessionId: string | null

  setAgents: (agents: Array<AgentWithStatus>) => void
  setAgentsLoading: (loading: boolean) => void
  setAgentsError: (error: string | null) => void
  setActiveAgentId: (
    agentId: string | null,
    options?: { sessionId?: string | null },
  ) => void
  updateAgent: (agent: Partial<AgentWithStatus> & { agentId: string }) => void
  setSessions: (agentId: string, sessions: Array<AgentSession>) => void
  upsertSession: (agentId: string, session: AgentSession) => void
  removeSession: (agentId: string, sessionId: string) => void
  clearSessions: (agentId: string) => void
  setSessionsLoading: (agentId: string, loading: boolean) => void
  setActiveSessionId: (sessionId: string | null) => void
}

export const useAgentStore = create<AgentStore>((set, get) => ({
  agents: [],
  agentsLoading: false,
  agentsError: null,
  activeAgentId: null,
  sessionsByAgentId: new Map(),
  sessionsLoading: new Set(),
  activeSessionId: null,

  setAgents: (agents) => set({ agents }),
  setAgentsLoading: (agentsLoading) => set({ agentsLoading }),
  setAgentsError: (agentsError) => set({ agentsError }),
  setActiveAgentId: (activeAgentId, options) => {
    if (activeAgentId === get().activeAgentId) {
      if (
        options &&
        'sessionId' in options &&
        options.sessionId !== get().activeSessionId
      ) {
        set({ activeSessionId: options.sessionId ?? null })
      }
      return
    }
    set({
      activeAgentId,
      activeSessionId:
        options && 'sessionId' in options ? (options.sessionId ?? null) : null,
    })
  },
  updateAgent: (update) =>
    set((state) => ({
      agents: state.agents.map((agent) =>
        agent.agentId === update.agentId ? { ...agent, ...update } : agent,
      ),
    })),
  setSessions: (agentId, sessions) =>
    set((state) => {
      const next = new Map(state.sessionsByAgentId)
      next.set(agentId, sessions)
      return { sessionsByAgentId: next }
    }),
  upsertSession: (agentId, session) =>
    set((state) => {
      const next = new Map(state.sessionsByAgentId)
      const current = next.get(agentId) ?? []
      const without = current.filter((s) => s.sessionId !== session.sessionId)
      next.set(
        agentId,
        [session, ...without].sort(
          (a, b) =>
            new Date(b.lastMessageAt).getTime() -
            new Date(a.lastMessageAt).getTime(),
        ),
      )
      return { sessionsByAgentId: next }
    }),
  removeSession: (agentId, sessionId) =>
    set((state) => {
      const next = new Map(state.sessionsByAgentId)
      const current = next.get(agentId) ?? []
      next.set(
        agentId,
        current.filter((s) => s.sessionId !== sessionId),
      )
      return { sessionsByAgentId: next }
    }),
  clearSessions: (agentId) =>
    set((state) => {
      const next = new Map(state.sessionsByAgentId)
      next.delete(agentId)
      return { sessionsByAgentId: next }
    }),
  setSessionsLoading: (agentId, loading) =>
    set((state) => {
      const next = new Set(state.sessionsLoading)
      if (loading) next.add(agentId)
      else next.delete(agentId)
      return { sessionsLoading: next }
    }),
  setActiveSessionId: (activeSessionId) => set({ activeSessionId }),
}))

export function getActiveAgent(): AgentWithStatus | undefined {
  const state = useAgentStore.getState()
  return state.agents.find((a) => a.agentId === state.activeAgentId)
}

export function getActiveSessions(): Array<AgentSession> {
  const state = useAgentStore.getState()
  if (!state.activeAgentId) return []
  return state.sessionsByAgentId.get(state.activeAgentId) ?? []
}
