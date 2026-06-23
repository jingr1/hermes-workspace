'use client'

import { useMutation, useQuery } from '@tanstack/react-query'
import { useCallback, useState } from 'react'

export type LanggraphAutopilotStatus = {
  ok: boolean
  missionId?: string
  orchestratorState?: {
    mission_id?: string
    mission_goal?: string
    iteration?: number
    max_iterations?: number
    langgraph_needs_human?: boolean
    all_done?: boolean
    log_entries?: Array<string>
  } | null
  mission?: {
    id: string
    title: string
    state: string
    events?: Array<{ message: string; at: number }>
  } | null
}

async function startLanggraphMission(input: {
  missionGoal: string
  missionId?: string
  maxIterations?: number
  mock?: boolean
}): Promise<{ ok: boolean; missionId: string }> {
  const res = await fetch(`/api/swarm-langgraph/run${input.mock ? '?mock=1' : ''}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      missionGoal: input.missionGoal,
      missionId: input.missionId,
      maxIterations: input.maxIterations,
      mock: input.mock ?? false,
    }),
  })
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(data.error || `HTTP ${res.status}`)
  }
  return res.json() as Promise<{ ok: boolean; missionId: string }>
}

async function fetchLanggraphStatus(missionId: string): Promise<LanggraphAutopilotStatus> {
  const res = await fetch(`/api/swarm-langgraph/status?missionId=${encodeURIComponent(missionId)}`)
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(data.error || `HTTP ${res.status}`)
  }
  return res.json() as Promise<LanggraphAutopilotStatus>
}

export function useLanggraphAutopilot() {
  const [activeMissionId, setActiveMissionId] = useState<string | null>(null)

  const statusQuery = useQuery({
    queryKey: ['langgraph', 'status', activeMissionId],
    queryFn: () => fetchLanggraphStatus(activeMissionId!),
    enabled: Boolean(activeMissionId),
    refetchInterval: 4_000,
    staleTime: 2_000,
  })

  const startMutation = useMutation({
    mutationFn: startLanggraphMission,
    onSuccess: (data) => {
      setActiveMissionId(data.missionId)
    },
  })

  const start = useCallback(
    (missionGoal: string, options?: { missionId?: string; maxIterations?: number; mock?: boolean }) => {
      startMutation.mutate({
        missionGoal,
        missionId: options?.missionId,
        maxIterations: options?.maxIterations,
        mock: options?.mock,
      })
    },
    [startMutation],
  )

  return {
    activeMissionId,
    setActiveMissionId,
    start,
    isStarting: startMutation.isPending,
    startError: startMutation.error,
    status: statusQuery.data,
    isLoadingStatus: statusQuery.isLoading,
    statusError: statusQuery.error,
    refetchStatus: statusQuery.refetch,
  }
}
