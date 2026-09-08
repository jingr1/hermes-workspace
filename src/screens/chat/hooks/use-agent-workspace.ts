'use client'

import { useEffect, useRef } from 'react'
import { writeLastAgent } from '../last-session'
import type { AgentWithStatus } from '@/lib/agent-types'
import {
  fetchAgents,
  fetchSessionsForAgent,
  subscribeAgentEvents,
} from '@/lib/agent-api'
import { listExternalChatSessions } from '@/lib/external-chat-sessions'
import { useAgentStore } from '@/stores/agent-store'

export function useAgentWorkspace() {
  // Select stable action references and individual state slices instead of the
  // entire store object. Subscribing to the whole store would cause every
  // setState to recreate this hook's `store` reference, re-running effects and
  // triggering an infinite render loop (Maximum update depth exceeded).
  const activeAgentId = useAgentStore((state) => state.activeAgentId)
  const agents = useAgentStore((state) => state.agents)
  const agentsLoading = useAgentStore((state) => state.agentsLoading)
  const setAgents = useAgentStore((state) => state.setAgents)
  const setAgentsLoading = useAgentStore((state) => state.setAgentsLoading)
  const setAgentsError = useAgentStore((state) => state.setAgentsError)
  const setActiveAgentId = useAgentStore((state) => state.setActiveAgentId)
  const setSessions = useAgentStore((state) => state.setSessions)
  const setSessionsLoading = useAgentStore((state) => state.setSessionsLoading)
  const updateAgent = useAgentStore((state) => state.updateAgent)

  const agentsLoadedRef = useRef(false)

  // Initial agents load
  useEffect(() => {
    if (agentsLoadedRef.current) return
    agentsLoadedRef.current = true
    setAgentsLoading(true)
    fetchAgents()
      .then((data) => {
        setAgents(data.agents)
        if (!activeAgentId && data.agents.length > 0) {
          const firstOnline =
            data.agents.find(
              (a) => a.status === 'online' || a.status === 'busy',
            ) ?? data.agents[0]
          setActiveAgentId(firstOnline.agentId)
        }
      })
      .catch((error: unknown) => {
        setAgentsError(error instanceof Error ? error.message : String(error))
      })
      .finally(() => setAgentsLoading(false))
  }, [
    activeAgentId,
    setActiveAgentId,
    setAgents,
    setAgentsError,
    setAgentsLoading,
  ])

  // Load sessions whenever active agent changes (after agents are known so we
  // can choose localStorage vs Hermes profile sessions).
  useEffect(() => {
    const agentId = activeAgentId
    if (!agentId) return
    if (agentsLoading && agents.length === 0) return

    const agent = agents.find((entry) => entry.agentId === agentId)

    // Claude Code (etc.): always rehydrate from localStorage so an earlier
    // empty server response does not leave the sidebar stuck blank.
    if (agent && agent.runtime !== 'hermes') {
      setSessions(agentId, listExternalChatSessions(agentId))
      setSessionsLoading(agentId, false)
      return
    }

    if (useAgentStore.getState().sessionsByAgentId.has(agentId)) return

    if (!agent) {
      const local = listExternalChatSessions(agentId)
      if (local.length > 0) {
        setSessions(agentId, local)
        setSessionsLoading(agentId, false)
        return
      }
    }

    setSessionsLoading(agentId, true)
    fetchSessionsForAgent(agentId)
      .then((data) => setSessions(agentId, data.sessions))
      .catch(() => setSessions(agentId, []))
      .finally(() => setSessionsLoading(agentId, false))
  }, [
    activeAgentId,
    agents,
    agentsLoading,
    setSessions,
    setSessionsLoading,
  ])

  // Persist last selected agent for /chat landing redirect.
  useEffect(() => {
    if (activeAgentId) writeLastAgent(activeAgentId)
  }, [activeAgentId])

  // Subscribe to global collab events for live status updates
  useEffect(() => {
    return subscribeAgentEvents((event) => {
      const message = event as Record<string, unknown>
      if (message.type !== 'agent_status') return
      const payload = message.payload as Record<string, unknown> | undefined
      if (!payload) return
      const agentId = typeof payload.agentId === 'string' ? payload.agentId : ''
      if (!agentId) return
      const statusSnapshot = payload.status as
        | AgentWithStatus['statusSnapshot']
        | undefined
      // Do NOT blindly adopt snapshot.state as the agent status. The snapshot
      // state is raw runtime state (e.g. 'executing', 'idle'); the canonical
      // status is derived on the server from runtime + sessions + group-chat
      // activity. Re-fetch the full agent list so the UI stays consistent.
      updateAgent({
        agentId,
        currentTaskId: statusSnapshot?.taskId ?? undefined,
        currentMissionId: statusSnapshot?.missionId ?? undefined,
        statusSnapshot,
      })
    })
  }, [updateAgent])
}
