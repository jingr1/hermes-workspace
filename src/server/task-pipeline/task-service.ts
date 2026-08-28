/**
 * task-service — P2b extension: project binding + worktree setup.
 *
 * Create flow:
 *   1. Validate project (projects.yaml)
 *   2. Instantiate pipeline (two-pass mission creation)
 *   3. For workspaceMode=worktree: ensureMissionWorktree + record baseRef
 *   4. Bind card → mission, sync lane
 */
import {
  appendMissionContinuation,
  createOrUpdateMission,
  getSwarmMission,
  readyQueuedAssignments,
  rewriteAssignmentDependencies,
} from '../swarm-missions'
import { createKanbanCard, updateKanbanCard } from '../kanban-backend'
import { ensureMissionWorktree } from '../git-ops'
import { getPipelineTemplate } from './pipeline-templates'
import { generateStageBrief } from './stage-brief'
import { syncLaneFromMission } from './lane-sync'
import { getProject } from './projects'
import type { PipelineTemplate } from './pipeline-templates'
import type { SwarmMission } from '../swarm-missions'
import type { KanbanLane } from './lane-sync'

export type CreateTaskInput = {
  title: string
  spec: string
  pipelineId: string
  acceptanceCriteria?: Array<string>
  projectId?: string | null
  /** Human gate: dispatch the first stage immediately (default true). */
  autoDispatch?: boolean
}

export type CreatedTask = {
  cardId: string
  missionId: string
  pipelineId: string
  projectId: string | null
  workspaceMode: string
  worktreePath: string | null
  firstAssignmentIds: Array<string>
}

export function instantiatePipeline(input: {
  template: PipelineTemplate
  title: string
  spec: string
  acceptanceCriteria: Array<string>
  cardId: string
  projectId?: string | null
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
    projectId: input.projectId ?? null,
    workspaceMode: input.template.workspaceMode,
    assignments: [
      {
        workerId: first.agent,
        task: firstBrief.instruction,
        rationale: `pipeline ${input.template.id} stage ${first.key}`,
        reviewRequired: false,
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
    taskId: input.cardId,
    specVersion,
  })

  return final!
}

export async function createTask(input: CreateTaskInput): Promise<CreatedTask> {
  const template = getPipelineTemplate(input.pipelineId)
  if (!template) throw new Error(`Unknown pipeline: ${input.pipelineId}`)

  let project = null
  let worktreePath: string | null = null
  let baseRef: string | null = null

  if (input.projectId) {
    project = getProject(input.projectId)
    if (!project) throw new Error(`Unknown project: ${input.projectId}`)
  }

  const card = await createKanbanCard({
    title: input.title,
    spec: input.spec,
    acceptanceCriteria: input.acceptanceCriteria ?? [],
    status: 'todo',
    createdBy: 'task-service',
  })

  const mission = instantiatePipeline({
    template,
    title: input.title,
    spec: input.spec,
    acceptanceCriteria: input.acceptanceCriteria ?? [],
    cardId: card.id,
    projectId: input.projectId ?? null,
  })

  if (template.workspaceMode === 'worktree' && project) {
    const { ctx, baseRef: ref } = await ensureMissionWorktree(
      project,
      mission.id,
    )
    worktreePath = ctx.cwd
    baseRef = ref
    // Stamp baseRef onto the first (queued) assignment so dispatch has a
    // known starting ref and can compute diffRange / fan-in merges.
    if (mission.assignments[0]) {
      mission.assignments[0].baseRef = ref
      const refreshed = getSwarmMission(mission.id)
      if (refreshed && refreshed.assignments[0]) {
        refreshed.assignments[0].baseRef = ref
      }
    }
  }

  // Bind card → mission + initial lane.
  await updateKanbanCard(card.id, { missionId: mission.id })
  await syncLaneFromMission({
    cardId: card.id,
    missionId: mission.id,
    updateCard: (id: string, lane: KanbanLane) =>
      updateKanbanCard(id, { status: lane }),
  })

  const firstAssignmentIds = readyQueuedAssignments(mission.id).map((a) => a.id)
  return {
    cardId: card.id,
    missionId: mission.id,
    pipelineId: template.id,
    projectId: input.projectId ?? null,
    workspaceMode: template.workspaceMode,
    worktreePath,
    firstAssignmentIds,
  }
}

export { syncLaneFromMission }
export type { KanbanLane }
