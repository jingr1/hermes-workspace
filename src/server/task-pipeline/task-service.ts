/**
 * task-service — create Mission (pipeline | assignee XOR) + worktree setup.
 *
 * Create rules (Mission domain plan):
 *   - pipeline: instantiate stages → Tasks, auto-dispatch; do NOT create room
 *   - assignee+agent: single Task + auto-dispatch
 *   - assignee+chat_group: bind roomId; no auto-decompose
 *   - room: only via manual ensureRoomForMission later
 */
import {
  appendMissionContinuation,
  cancelSwarmMission,
  createOrUpdateMission,
  deleteSwarmMission,
  getSwarmMission,
  readyQueuedAssignments,
  rewriteAssignmentDependencies,
  type MissionAssignee,
  type MissionExecutionMode,
} from '../swarm-missions'
import { ensureMissionWorktree, releaseMissionWorktree } from '../git-ops'
import { getPipelineTemplate } from './pipeline-templates'
import { generateStageBrief } from './stage-brief'
import { getProject } from './projects'
import {
  dispatchReadyAssignments,
  type DispatchedAssignmentSummary,
} from './dispatch-ready'
import { getRoom } from '../group-chat/room-store'
import type { PipelineTemplate } from './pipeline-templates'
import type { SwarmMission } from '../swarm-missions'
import type { KanbanLane } from './lane-sync'

type CreateMissionBase = {
  title: string
  spec: string
  acceptanceCriteria?: Array<string>
  projectId?: string | null
  /** Human gate: dispatch ready stages immediately (default true). */
  autoDispatch?: boolean
  priority?: number | null
  labels?: Array<string>
}

export type CreateMissionInput = CreateMissionBase &
  (
    | { executionMode: 'pipeline'; pipelineId: string }
    | {
        executionMode: 'assignee'
        assignee: MissionAssignee
      }
  )

/** @deprecated Prefer CreateMissionInput; kept for callers that only pass pipelineId. */
export type CreateTaskInput = CreateMissionBase & {
  pipelineId?: string
  executionMode?: MissionExecutionMode
  assignee?: MissionAssignee
}

export type CreatedMission = {
  missionId: string
  pipelineId: string | null
  executionMode: MissionExecutionMode
  assignee: MissionAssignee | null
  roomId: string | null
  projectId: string | null
  workspaceMode: string
  worktreePath: string | null
  firstAssignmentIds: Array<string>
  dispatched: Array<DispatchedAssignmentSummary>
}

/** @deprecated alias */
export type CreatedTask = CreatedMission

function normalizeCreateInput(input: CreateTaskInput): CreateMissionInput {
  if (input.executionMode === 'assignee') {
    if (!input.assignee?.id?.trim() || !input.assignee?.type) {
      throw new Error('assignee mode requires assignee.type and assignee.id')
    }
    if (input.pipelineId) {
      throw new Error('pipelineId and assignee are mutually exclusive')
    }
    return {
      title: input.title,
      spec: input.spec,
      acceptanceCriteria: input.acceptanceCriteria,
      projectId: input.projectId,
      autoDispatch: input.autoDispatch,
      priority: input.priority,
      labels: input.labels,
      executionMode: 'assignee',
      assignee: input.assignee,
    }
  }
  if (input.executionMode === 'pipeline' || input.pipelineId) {
    if (!input.pipelineId) throw new Error('pipeline mode requires pipelineId')
    if (input.assignee) {
      throw new Error('pipelineId and assignee are mutually exclusive')
    }
    return {
      title: input.title,
      spec: input.spec,
      acceptanceCriteria: input.acceptanceCriteria,
      projectId: input.projectId,
      autoDispatch: input.autoDispatch,
      priority: input.priority,
      labels: input.labels,
      executionMode: 'pipeline',
      pipelineId: input.pipelineId,
    }
  }
  throw new Error('Provide executionMode pipeline (with pipelineId) or assignee')
}

export function instantiatePipeline(input: {
  template: PipelineTemplate
  title: string
  spec: string
  acceptanceCriteria: Array<string>
  projectId?: string | null
  priority?: number | null
  labels?: Array<string>
}): SwarmMission {
  const specVersion = 1
  const stages = input.template.stages
  const stageIdByKey = new Map<string, string>()

  const first = stages[0]
  const firstBrief = generateStageBrief({
    stage: first,
    taskTitle: input.title,
    spec: input.spec,
    acceptanceCriteria: input.acceptanceCriteria,
    specVersion,
  })
  const mission = createOrUpdateMission({
    title: input.title,
    spec: input.spec,
    acceptanceCriteria: input.acceptanceCriteria,
    projectId: input.projectId ?? null,
    workspaceMode: input.template.workspaceMode,
    executionMode: 'pipeline',
    assignee: null,
    roomId: null,
    pipelineId: input.template.id,
    priority: input.priority ?? null,
    labels: input.labels ?? [],
    assignments: [
      {
        workerId: first.agent,
        task: firstBrief.instruction,
        rationale: `pipeline ${input.template.id} stage ${first.key}`,
        reviewRequired: false,
        createdByWorkerId: 'system:pipeline',
        dispatchable: true,
        stageKey: first.key,
      },
    ],
  })
  stageIdByKey.set(first.key, mission.assignments[0].id)

  for (const stage of stages.slice(1)) {
    const brief = generateStageBrief({
      stage,
      taskTitle: input.title,
      spec: input.spec,
      acceptanceCriteria: input.acceptanceCriteria,
      specVersion,
    })
    const updated = appendMissionContinuation({
      missionId: mission.id,
      workerId: stage.agent,
      task: brief.instruction,
      rationale: `pipeline ${input.template.id} stage ${stage.key}`,
      stageKey: stage.key,
    })
    const created = updated!.assignments[updated!.assignments.length - 1]
    stageIdByKey.set(stage.key, created.id)
  }

  const final = rewriteAssignmentDependencies({
    missionId: mission.id,
    dependsOnByAssignmentId: Object.fromEntries(
      stages.map((s) => [
        stageIdByKey.get(s.key)!,
        s.dependsOn.map((k) => stageIdByKey.get(k)!),
      ]),
    ),
    stageKeyByAssignmentId: Object.fromEntries(
      stages.map((s) => [stageIdByKey.get(s.key)!, s.key]),
    ),
    requiresByAssignmentId: Object.fromEntries(
      stages.map((s) => [stageIdByKey.get(s.key)!, s.requires]),
    ),
    briefSpecVersion: specVersion,
    pipelineId: input.template.id,
    taskId: null,
    specVersion,
    executionMode: 'pipeline',
    createdByWorkerId: 'system:pipeline',
  })

  return final!
}

export async function createMission(
  raw: CreateTaskInput,
): Promise<CreatedMission> {
  const input = normalizeCreateInput(raw)

  let project = null
  let worktreePath: string | null = null

  if (input.projectId) {
    project = getProject(input.projectId)
    if (!project) throw new Error(`Unknown project: ${input.projectId}`)
  }

  let mission: SwarmMission
  let workspaceMode = 'canonical'
  let pipelineId: string | null = null
  let assignee: MissionAssignee | null = null
  let roomId: string | null = null

  if (input.executionMode === 'pipeline') {
    const template = getPipelineTemplate(input.pipelineId)
    if (!template) throw new Error(`Unknown pipeline: ${input.pipelineId}`)
    workspaceMode = template.workspaceMode
    pipelineId = template.id
    mission = instantiatePipeline({
      template,
      title: input.title,
      spec: input.spec,
      acceptanceCriteria: input.acceptanceCriteria ?? [],
      projectId: input.projectId ?? null,
      priority: input.priority ?? null,
      labels: input.labels ?? [],
    })

    if (template.workspaceMode === 'worktree' && project) {
      const { ctx, baseRef: ref } = await ensureMissionWorktree(
        project,
        mission.id,
      )
      worktreePath = ctx.cwd
      if (mission.assignments[0]) {
        mission.assignments[0].baseRef = ref
        const refreshed = getSwarmMission(mission.id)
        if (refreshed?.assignments[0]) {
          refreshed.assignments[0].baseRef = ref
          refreshed.assignments[0].workspacePath = worktreePath
        }
      }
    }
  } else {
    assignee = input.assignee
    if (assignee.type === 'chat_group') {
      const room = getRoom(assignee.id)
      if (!room) throw new Error(`Unknown chat group room: ${assignee.id}`)
      roomId = room.id
      mission = createOrUpdateMission({
        title: input.title,
        spec: input.spec,
        acceptanceCriteria: input.acceptanceCriteria ?? [],
        projectId: input.projectId ?? null,
        workspaceMode: 'canonical',
        executionMode: 'assignee',
        assignee,
        roomId,
        pipelineId: null,
        priority: input.priority ?? null,
        labels: input.labels ?? [],
        assignments: [],
      })
      mission = getSwarmMission(mission.id) ?? mission
    } else {
      const instruction = [
        `# Mission: ${input.title}`,
        '',
        '## Spec',
        input.spec.trim() || '(no spec text)',
        '',
        '## Acceptance criteria',
        ...(input.acceptanceCriteria && input.acceptanceCriteria.length > 0
          ? input.acceptanceCriteria.map((c) => `- ${c}`)
          : ['- (none declared)']),
      ].join('\n')
      mission = createOrUpdateMission({
        title: input.title,
        spec: input.spec,
        acceptanceCriteria: input.acceptanceCriteria ?? [],
        projectId: input.projectId ?? null,
        workspaceMode: 'canonical',
        executionMode: 'assignee',
        assignee,
        roomId: null,
        pipelineId: null,
        priority: input.priority ?? null,
        labels: input.labels ?? [],
        assignments: [
          {
            workerId: assignee.id,
            task: instruction,
            rationale: 'assignee mode single task',
            reviewRequired: false,
            createdByWorkerId: 'system:assignee',
            dispatchable: true,
            stageKey: 'execute',
          },
        ],
      })
      mission = getSwarmMission(mission.id) ?? mission
    }
  }

  const live = getSwarmMission(mission.id) ?? mission
  const firstAssignmentIds = readyQueuedAssignments(live.id).map((a) => a.id)

  let dispatched: Array<DispatchedAssignmentSummary> = []
  if (
    input.autoDispatch !== false &&
    firstAssignmentIds.length > 0 &&
    !(input.executionMode === 'assignee' && input.assignee.type === 'chat_group')
  ) {
    const dispatchResult = await dispatchReadyAssignments(live.id)
    dispatched = dispatchResult.dispatched
  }

  const finalMission = getSwarmMission(live.id) ?? live

  return {
    missionId: finalMission.id,
    pipelineId: finalMission.pipelineId ?? pipelineId,
    executionMode: finalMission.executionMode ?? input.executionMode,
    assignee: finalMission.assignee ?? assignee,
    roomId: finalMission.roomId ?? roomId,
    projectId: input.projectId ?? null,
    workspaceMode,
    worktreePath,
    firstAssignmentIds,
    dispatched,
  }
}

export type DeleteMissionResult = {
  missionId: string
  worktreeReleased: boolean
}

/**
 * Delete a mission by missionId. Cancels in-flight assignments, releases
 * worktree when applicable, then hard-deletes the swarm mission record.
 * Kanban cards are not part of the Mission domain.
 */
export async function deleteMission(missionId: string): Promise<DeleteMissionResult> {
  const mission = getSwarmMission(missionId)
  if (!mission) {
    throw new Error(`Mission not found: ${missionId}`)
  }

  cancelSwarmMission({
    missionId,
    actor: 'user-delete',
    reason: 'Mission deleted',
  })

  let worktreeReleased = false
  if (mission.projectId && mission.workspaceMode === 'worktree') {
    const project = getProject(mission.projectId)
    if (project) {
      try {
        await releaseMissionWorktree(project, mission.id)
        worktreeReleased = true
      } catch (error) {
        console.warn(
          `[deleteMission] worktree release failed for ${mission.id}:`,
          error,
        )
      }
    }
  }

  deleteSwarmMission(mission.id)

  return {
    missionId: mission.id,
    worktreeReleased,
  }
}

/** @deprecated Prefer createMission */
export async function createTask(
  input: CreateTaskInput,
): Promise<CreatedMission> {
  return createMission(input)
}

export { syncLaneFromMission } from './lane-sync'
export type { KanbanLane, MissionStatus } from './lane-sync'
