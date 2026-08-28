/**
 * lane-sync — Mission/Assignment state → kanban card lane (plan 模块 1
 * «Lane 同步规则», 单向：流水线为准；人工拖拽仅改 backlog/todo/ready).
 *
 * Mapping (plan table):
 *   no mission                    → backlog / todo   (untouched here)
 *   any assignment queued         → ready
 *   any dispatched                → running
 *   any blocked / needs_input     → blocked
 *   current ready/running stage is kind: review → review
 *   mission complete              → done
 */
import { getSwarmMission } from '../swarm-missions'
import type { SwarmMission } from '../swarm-missions'

export type KanbanLane =
  | 'backlog'
  | 'todo'
  | 'ready'
  | 'running'
  | 'review'
  | 'blocked'
  | 'done'

export function laneFromMission(mission: SwarmMission): KanbanLane {
  if (mission.state === 'complete') return 'done'
  const assignments = mission.assignments
  if (
    assignments.some((a) => a.state === 'blocked' || a.state === 'needs_input')
  )
    return 'blocked'
  if (assignments.some((a) => a.state === 'dispatched')) return 'running'
  if (assignments.some((a) => a.state === 'reviewing')) return 'review'
  if (assignments.some((a) => a.state === 'queued')) return 'ready'
  if (assignments.some((a) => a.state === 'checkpointed')) return 'review'
  return 'todo'
}

export async function syncLaneFromMission(input: {
  cardId: string
  missionId: string
  updateCard: (cardId: string, lane: KanbanLane) => unknown | Promise<unknown>
}): Promise<KanbanLane | null> {
  const mission = getSwarmMission(input.missionId)
  if (!mission) return null
  const lane = laneFromMission(mission)
  await input.updateCard(input.cardId, lane)
  return lane
}
