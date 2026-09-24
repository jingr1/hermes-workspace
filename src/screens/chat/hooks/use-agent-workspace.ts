'use client'

import { useCallback, useEffect, useRef } from 'react'
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

  const loadAgents = useCallback(
    (opts?: { pickFirstWhenEmpty?: boolean }) => {
      setAgentsLoading(true)
      fetchAgents()
        .then((data) => {
          setAgents(data.agents)
          if (
            opts?.pickFirstWhenEmpty &&
            !activeAgentId &&
            data.agents.length > 0
          ) {
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
    },
    [activeAgentId, setActiveAgentId, setAgents, setAgentsError, setAgentsLoading],
  )

  // Initial agents load
  useEffect(() => {
    if (agentsLoadedRef.current) return
    agentsLoadedRef.current = true
    loadAgents({ pickFirstWhenEmpty: true })
  }, [loadAgents])

  // Settings-registry changes (create/update/delete agent) notify via a window
  // event so the chat sidebar picks new agents up without a page reload.
  useEffect(() => {
    if (typeof window === 'undefined') return
    const refresh = () => loadAgents()
    window.addEventListener('agorax:agents-changed', refresh)
    return () => window.removeEventListener('agorax:agents-changed', refresh)
  }, [loadAgents])

  // Load sessions whenever active agent changes.
  useEffect(() => {
    const agentId = activeAgentId
    if (!agentId) return
    if (agentsLoading && agents.length === 0) return

    if (useAgentStore.getState().sessionsByAgentId.has(agentId)) return

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

  // Persist last selected agent for /chat landing redirect — only when the id
  // still exists in the registry (avoids poisoning localStorage with stale ids).
  useEffect(() => {
    if (!activeAgentId) return
    if (!agents.some((agent) => agent.agentId === activeAgentId)) return
    writeLastAgent(activeAgentId)
  }, [activeAgentId, agents])

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
