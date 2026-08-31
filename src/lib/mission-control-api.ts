/**
 * Mission Control API client (P3).
 */

export type AgentStatus = {
  agentId: string
  displayName: string
  runtime: 'hermes' | 'claude-code' | 'codex' | 'deepseek-harness'
  execution: 'local' | 'ssh'
  state: string
  currentTask: string | null
  taskId: string | null
  missionId: string | null
  needsHuman: boolean
  checkpointStatus: string
  lastOutputAt: number | null
  startedAt: number | null
  capabilities: string[]
  online: boolean
  profile?: string
}

export type AgentsStatusResponse = {
  ok: boolean
  agents: AgentStatus[]
  onlineCount: number
  executingCount: number
  blockedCount: number
}

export type MissionStage = {
  key: string
  agent: string
  state: string
  dependsOn: string[]
  reviewRequired: boolean
}

export type MissionPipeline = {
  missionId: string
  title: string
  state: string
  stages: MissionStage[]
}

export async function fetchAgentStatuses(): Promise<AgentsStatusResponse> {
  const res = await fetch('/api/agents/status')
  if (!res.ok) throw new Error(`Failed to fetch agent statuses: ${res.status}`)
  return res.json()
}

export type CostSummaryResponse = {
  ok: boolean
  total: {
    input: number
    output: number
    cache_read: number
    cache_write: number
    reasoning: number
    totalTokens: number
    costEstimate: number
    count: number
  }
  topProjects: Array<{ id: string; tokens: number; cost: number; runs: number }>
  gate: {
    state: 'ok' | 'warn' | 'hard_stop'
    reason: string
    consumedTokens: number
    consumedCost: number
  }
}

export async function fetchCostSummary(): Promise<CostSummaryResponse> {
  const res = await fetch('/api/cost')
  if (!res.ok) throw new Error(`Failed to fetch cost summary: ${res.status}`)
  return res.json()
}

export async function fetchMissionPipeline(
  missionId: string,
): Promise<MissionPipeline | null> {
  const res = await fetch(
    `/api/swarm-missions?id=${encodeURIComponent(missionId)}&sync=1`,
  )
  if (!res.ok) return null
  const data = (await res.json()) as { mission?: { id: string; title: string; state: string; assignments: Array<{ id: string; workerId: string; state: string; dependsOn: string[]; reviewRequired: boolean }> } }
  if (!data.mission) return null
  return {
    missionId: data.mission.id,
    title: data.mission.title,
    state: data.mission.state,
    stages: data.mission.assignments.map((a) => ({
      key: a.id,
      agent: a.workerId,
      state: a.state,
      dependsOn: a.dependsOn ?? [],
      reviewRequired: a.reviewRequired ?? false,
    })),
  }
}
