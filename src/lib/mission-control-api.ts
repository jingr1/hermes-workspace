/**
 * Mission Control API client — P3 三视图数据源.
 *
 * 数据来源:
 *   GET /api/agents/status   — Agent 列表 + probe + 实时 snapshot
 *   GET /api/tasks           — 任务概要（卡片 + mission + lane + 进度）
 *   GET /api/tasks/:taskId   — 单任务详情（卡片 + 流水线 stages + runs + events）
 *   GET /api/collab-events?scope=global — SSE 增量更新
 */

export type AgentRuntimeLabel =
  | 'hermes'
  | 'claude-code'
  | 'codex'
  | 'deepseek-harness'

export type AgentProbeResult = {
  available: boolean
  version?: string | null
  detail?: string | null
}

export type AgentStatusEntry = {
  agentId: string
  runtime: AgentRuntimeLabel
  execution: string
  probe: AgentProbeResult
  status: {
    agentId: string
    runtime: AgentRuntimeLabel
    state: string
    currentTask: string | null
    taskId: string | null
    missionId: string | null
    needsHuman: boolean
    checkpointStatus: string
    lastSummary: string | null
    updatedAt: number
  } | null
}

export type AgentsStatusResponse = {
  agents: Array<AgentStatusEntry>
  orphanProfiles: Array<string>
  checkedAt: number
}

export type KanbanLane =
  | 'backlog'
  | 'todo'
  | 'ready'
  | 'running'
  | 'review'
  | 'blocked'
  | 'done'

export type TaskSummary = {
  cardId: string
  title: string
  lane: KanbanLane
  missionId: string | null
  missionState: string | null
  derivedLane: KanbanLane | null
  currentAssignee: string | null
  progress: number
}

export type TasksResponse = {
  tasks: Array<TaskSummary>
}

export type PipelineStage = {
  assignmentId: string
  stageKey: string | null
  agent: string
  state: string
  stale: boolean
  dependsOn: Array<string>
  dispatchedAt: number | null
  completedAt: number | null
}

export type TaskRun = {
  id: string
  mission_id: string
  assignment_id: string
  agent_id: string
  status: string
  summary: string | null
  started_at: number | null
  finished_at: number | null
}

export type TaskDetail = {
  task: {
    id: string
    title: string
    spec: string
    acceptanceCriteria: Array<string>
    status: KanbanLane
    missionId: string | null
    [key: string]: unknown
  }
  pipeline: {
    id: string | null
    specVersion: number
    stages: Array<PipelineStage>
  } | null
  runs: Array<TaskRun>
  events: Array<{
    type: string
    at: number
    [key: string]: unknown
  }>
}

export async function fetchAgentsStatus(): Promise<AgentsStatusResponse> {
  const res = await fetch('/api/agents/status')
  if (!res.ok) throw new Error(`Failed to fetch agents status: ${res.status}`)
  return res.json()
}

export async function fetchTasks(): Promise<TasksResponse> {
  const res = await fetch('/api/tasks')
  if (!res.ok) throw new Error(`Failed to fetch tasks: ${res.status}`)
  return res.json()
}

export async function fetchTaskDetail(taskId: string): Promise<TaskDetail> {
  const res = await fetch(`/api/tasks/${taskId}`)
  if (!res.ok) throw new Error(`Failed to fetch task detail: ${res.status}`)
  return res.json()
}

export type CollabEvent = {
  event: string
  data: Record<string, unknown>
}

/**
 * 订阅 /api/collab-events SSE，支持 scope / roomId / sessionKey 过滤.
 */
export function subscribeCollabEvents(
  params: { scope?: string; roomId?: string; sessionKey?: string },
  onEvent: (event: CollabEvent) => void,
  onError?: (error: Error) => void,
): () => void {
  const q = new URLSearchParams()
  if (params.scope) q.set('scope', params.scope)
  if (params.roomId) q.set('roomId', params.roomId)
  if (params.sessionKey) q.set('sessionKey', params.sessionKey)
  const url = `/api/collab-events?${q.toString()}`

  const source = new EventSource(url)
  source.onmessage = (message) => {
    try {
      const parsed = JSON.parse(message.data) as Record<string, unknown>
      onEvent({ event: message.lastEventId || 'message', data: parsed })
    } catch (err) {
      onError?.(
        err instanceof Error ? err : new Error('Failed to parse SSE message'),
      )
    }
  }
  source.onerror = () => {
    onError?.(new Error('SSE connection error'))
  }

  return () => {
    source.close()
  }
}
