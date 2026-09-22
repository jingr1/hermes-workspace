/**
 * Shared Mission list/detail serialization for /api/tasks and /api/missions.
 */
import type {
  SwarmMission,
  SwarmMissionAssignment,
  SwarmMissionAssignmentState,
} from '../swarm-missions'
import { laneFromMission } from '../task-pipeline/lane-sync'
import type { KanbanLane } from '../task-pipeline/lane-sync'

const FALLBACK_PROGRESS_BY_LANE: Record<string, number> = {
  done: 100,
  complete: 100,
  review: 75,
  running: 50,
  blocked: 50,
  ready: 25,
  todo: 10,
  backlog: 0,
}

function assignmentProgressWeight(state: SwarmMissionAssignmentState): number {
  switch (state) {
    case 'done':
    case 'checkpointed':
      return 1
    case 'reviewing':
      return 0.8
    case 'blocked':
    case 'needs_input':
      return 0.5
    case 'dispatched':
      return 0.5
    case 'queued':
    case 'cancelled':
    default:
      return 0
  }
}

export function computeMissionProgress(
  mission: SwarmMission | null,
  lane: string,
): number {
  if (mission && mission.assignments.length > 0) {
    const weighted = mission.assignments.reduce(
      (sum, assignment) => sum + assignmentProgressWeight(assignment.state),
      0,
    )
    return Math.round((weighted / mission.assignments.length) * 100)
  }
  return FALLBACK_PROGRESS_BY_LANE[lane] ?? FALLBACK_PROGRESS_BY_LANE.backlog
}

export function serializeMissionTask(assignment: SwarmMissionAssignment) {
  return {
    id: assignment.id,
    workerId: assignment.workerId,
    task: assignment.task,
    rationale: assignment.rationale,
    state: assignment.state,
    stageKey: assignment.stageKey ?? null,
    dependsOn: assignment.dependsOn,
    createdByWorkerId: assignment.createdByWorkerId ?? null,
    dispatchable: assignment.dispatchable !== false,
    externalRef: assignment.externalRef ?? null,
    workspacePath: assignment.workspacePath ?? null,
    dispatchedAt: assignment.dispatchedAt,
    completedAt: assignment.completedAt,
  }
}

export type MissionSummary = {
  cardId: string
  title: string
  lane: KanbanLane | string
  missionId: string | null
  missionState: string | null
  derivedLane: KanbanLane | null
  currentAssignee: string | null
  /** Active pipeline stage key (or worker id fallback) for the in-flight task. */
  currentStage: string | null
  progress: number
  executionMode: string | null
  assignee: SwarmMission['assignee']
  roomId: string | null
  pipelineId: string | null
  projectId: string | null
  priority: number | null
  labels: Array<string>
  taskCount: number
}

function pickActiveAssignment(mission: SwarmMission | null) {
  if (!mission) return null
  return (
    mission.assignments.find(
      (a) =>
        a.state === 'dispatched' ||
        a.state === 'blocked' ||
        a.state === 'needs_input' ||
        a.state === 'reviewing',
    ) ??
    mission.assignments.find((a) => a.state === 'queued') ??
    null
  )
}

export function buildMissionSummary(input: {
  cardId: string
  cardTitle: string
  cardStatus: string
  mission: SwarmMission | null
}): MissionSummary {
  const { cardId, cardTitle, cardStatus, mission } = input
  const effectiveLane = mission ? laneFromMission(mission) : cardStatus
  const active = pickActiveAssignment(mission)
  const dispatchedWorker =
    mission?.assignments.find((a) => a.state === 'dispatched')?.workerId ?? null
  return {
    cardId,
    title: mission?.title?.trim() ? mission.title.trim() : cardTitle,
    lane: cardStatus,
    missionId: mission?.id ?? null,
    missionState: mission?.state ?? null,
    derivedLane: mission ? laneFromMission(mission) : null,
    currentAssignee:
      active?.workerId ??
      dispatchedWorker ??
      (mission?.assignee?.type === 'agent' ? mission.assignee.id : null),
    currentStage: active?.stageKey ?? active?.workerId ?? null,
    progress: computeMissionProgress(mission, effectiveLane),
    executionMode: mission?.executionMode ?? null,
    assignee: mission?.assignee ?? null,
    roomId: mission?.roomId ?? null,
    pipelineId: mission?.pipelineId ?? null,
    projectId: mission?.projectId ?? null,
    priority: mission?.priority ?? null,
    labels: mission?.labels ?? [],
    taskCount: mission?.assignments.length ?? 0,
  }
}

export function buildTaskRuntimeSnapshot(input: {
  mission: SwarmMission
  assignment: SwarmMissionAssignment
}) {
  const { mission, assignment } = input
  return {
    task_id: assignment.id,
    mission_id: mission.id,
    status: assignment.state,
    external_ref: assignment.externalRef ?? null,
    dispatchable: assignment.dispatchable !== false,
    workspace: { path: assignment.workspacePath ?? null },
    worker_id: assignment.workerId,
    created_by: assignment.createdByWorkerId ?? null,
    stage_key: assignment.stageKey ?? null,
    running:
      assignment.state === 'dispatched'
        ? {
            started_at: assignment.dispatchedAt,
            worker_id: assignment.workerId,
          }
        : null,
    retry: null,
  }
}
