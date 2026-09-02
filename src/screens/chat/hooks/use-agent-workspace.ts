'use client'

import { useEffect, useRef } from 'react'
import { writeLastAgent } from '../last-session'
import type { AgentWithStatus } from '@/lib/agent-types'
import {
  fetchAgents,
  fetchSessionsForAgent,
  subscribeAgentEvents,
} from '@/lib/agent-api'
import { useAgentStore } from '@/stores/agent-store'

export function useAgentWorkspace() {
  // Select stable action references and individual state slices instead of the
  // entire store object. Subscribing to the whole store would cause every
  // setState to recreate this hook's `store` reference, re-running effects and
  // triggering an infinite render loop (Maximum update depth exceeded).
  const activeAgentId = useAgentStore((state) => state.activeAgentId)
  const sessionsByAgentId = useAgentStore((state) => state.sessionsByAgentId)
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
            data.agents.find((a) => a.status === 'online') ?? data.agents[0]
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

  // Load sessions whenever active agent changes
  useEffect(() => {
    const agentId = activeAgentId
    if (!agentId) return
    if (sessionsByAgentId.has(agentId)) return
    setSessionsLoading(agentId, true)
    fetchSessionsForAgent(agentId)
      .then((data) => setSessions(agentId, data.sessions))
      .catch(() => setSessions(agentId, []))
      .finally(() => setSessionsLoading(agentId, false))
  }, [activeAgentId, sessionsByAgentId, setSessions, setSessionsLoading])

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
      updateAgent({
        agentId,
        status: statusSnapshot?.state ?? 'unknown',
        currentTaskId: statusSnapshot?.taskId ?? undefined,
        currentMissionId: statusSnapshot?.missionId ?? undefined,
        statusSnapshot,
      })
    })
  }, [updateAgent])
}
