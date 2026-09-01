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
  setActiveAgentId: (agentId: string | null) => void
  updateAgent: (agent: Partial<AgentWithStatus> & { agentId: string }) => void
  setSessions: (agentId: string, sessions: Array<AgentSession>) => void
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
  setActiveAgentId: (activeAgentId) => {
    if (activeAgentId === get().activeAgentId) return
    set({ activeAgentId, activeSessionId: null })
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
