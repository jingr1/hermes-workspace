/**
 * task-service — P2a 任务模块的核心编排（plan 模块 1）.
 *
 * Create flow (建卡片 → 两遍建 mission → 回写 card.missionId):
 *   pass 1: create one assignment per stage (in template order) to obtain ids
 *   pass 2: translate stage-key dependsOn into assignment ids and rewrite
 *   then: bind card.missionId, set initial lane, dispatch stage-0
 *
 * P2a scope: workspaceMode canonical only. No worktree, no git model.
 */
import {
  
  appendMissionContinuation,
  createOrUpdateMission,
  getSwarmMission,
  readyQueuedAssignments,
  rewriteAssignmentDependencies
} from '../swarm-missions'
import { createKanbanCard, updateKanbanCard } from '../kanban-backend'
import {  getPipelineTemplate } from './pipeline-templates'
import { generateStageBrief } from './stage-brief'
import {  syncLaneFromMission } from './lane-sync'
import type {PipelineTemplate} from './pipeline-templates';
import type {SwarmMission} from '../swarm-missions';
import type {KanbanLane} from './lane-sync';

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
  firstAssignmentIds: Array<string>
}

/**
 * Instantiate a pipeline template into a mission. Two passes:
 *  1. createOrUpdateMission with every stage (no dependsOn yet) → ids
 *  2. rebuild each assignment's dependsOn from stage keys → assignment ids
 *
 * Because createOrUpdateMission dedupes by workerId and our stages can share
 * a worker (architect does both spec and review), we build the assignment
 * list directly instead of relying on the dedupe path.
 */
export function instantiatePipeline(input: {
  template: PipelineTemplate
  title: string
  spec: string
  acceptanceCriteria: Array<string>
  cardId: string
}): SwarmMission {
  const specVersion = 1
  // Pass 1: mint one assignment per stage. We bypass the workerId dedupe in
  // createOrUpdateMission by creating sequentially and then fixing ids — but
  // the public API dedupes same-worker, so a pipeline where one agent owns
  // two stages (architect: spec + review) collapses. To honour stage-per-
  // assignment semantics we append continuations for repeated workers.
  const stages = input.template.stages
  const stageIdByKey = new Map<string, string>()

  // First stage via create (also creates the mission).
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
    assignments: [{
      workerId: first.agent,
      task: firstBrief.instruction,
      rationale: `pipeline ${input.template.id} stage ${first.key}`,
      reviewRequired: false,
    }],
  })
  stageIdByKey.set(first.key, mission.assignments[0].id)

  // Remaining stages via continuation (bypasses same-worker dedupe).
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

  // Pass 2: rewrite dependsOn stage keys → assignment ids, and stamp
  // stageKey / briefSpecVersion / pipeline binding.
  const final = rewriteAssignmentDependencies({
    missionId: mission.id,
    dependsOnByAssignmentId: Object.fromEntries(
      stages.map((s) => [stageIdByKey.get(s.key)!, s.dependsOn.map((k) => stageIdByKey.get(k)!)]),
    ),
    stageKeyByAssignmentId: Object.fromEntries(stages.map((s) => [stageIdByKey.get(s.key)!, s.key])),
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
  })

  // Bind card → mission + initial lane.
  await updateKanbanCard(card.id, { missionId: mission.id })
  await syncLaneFromMission({
    cardId: card.id,
    missionId: mission.id,
    updateCard: (id: string, lane: KanbanLane) => updateKanbanCard(id, { status: lane }),
  })

  const firstAssignmentIds = readyQueuedAssignments(mission.id).map((a) => a.id)
  return { cardId: card.id, missionId: mission.id, pipelineId: template.id, firstAssignmentIds }
}

export { syncLaneFromMission }
export type { KanbanLane }
