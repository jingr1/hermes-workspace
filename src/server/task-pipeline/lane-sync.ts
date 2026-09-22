/**
 * lane-sync — Mission/Assignment state → board lane.
 *
 * Mapping:
 *   mission complete              → done
 *   any blocked / needs_input     → blocked
 *   any dispatched                → running
 *   any reviewing / checkpointed  → review
 *   any queued                    → ready
 *   else                          → todo
 *
 * Kanban cards are no longer part of the Mission domain; callers use
 * `laneFromMission` (and optional `mission.boardLane`) only.
 */
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

/** Effective board lane: human override when set, else derived. */
export function effectiveBoardLane(mission: SwarmMission): KanbanLane {
  if (mission.boardLane) return mission.boardLane
  return laneFromMission(mission)
}

/**
 * @deprecated Cards removed from Mission domain. Returns derived lane only.
 */
export async function syncLaneFromMission(input: {
  missionId: string
}): Promise<KanbanLane | null> {
  const { getSwarmMission } = await import('../swarm-missions')
  const mission = getSwarmMission(input.missionId)
  if (!mission) return null
  return laneFromMission(mission)
}
