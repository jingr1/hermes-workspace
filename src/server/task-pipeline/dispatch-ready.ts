/**
 * dispatch-ready — Mission Control kickoff / continuation dispatcher.
 *
 * Reads a mission's `readyQueuedAssignments`, splits them by runtime declared
 * in agents.yaml, and dispatches via the appropriate path:
 *   - hermes      → dispatchSwarmAssignments (allowAsync: true)
 *   - non-hermes  → dispatchAssignment (managed CLI runtime)
 *
 * After dispatching it refreshes the kanban lane so the Mission Control board
 * reflects the new state. This module also registers a checkpoint hook so that
 * when a pipeline mission reaches a terminal DONE/HANDOFF checkpoint the next
 * ready stage is dispatched automatically.
 */
import { dispatchSwarmAssignments } from '../../routes/api/swarm-dispatch'
import { dispatchAssignment } from '../agent-runtime/dispatch'
import { getAgentRuntimeRouter } from '../agent-runtime/router'
import {
  getSwarmMission,
  readyQueuedAssignments,
  setOnCheckpointTerminalHook,
  type ParsedSwarmCheckpoint,
} from '../swarm-missions'
import { updateKanbanCard } from '../kanban-backend'
import { syncLaneFromMission, type KanbanLane } from './lane-sync'

export type DispatchedAssignmentSummary = {
  assignmentId: string
  workerId: string
  ok: boolean
  error?: string
}

export type DispatchReadyResult = {
  ok: boolean
  dispatched: Array<DispatchedAssignmentSummary>
}

/** Prevent concurrent dispatch loops for the same mission. */
const dispatchingMissions = new Set<string>()

function isHermesRuntime(workerId: string): boolean {
  try {
    const router = getAgentRuntimeRouter()
    const decl = router.registry.byId.get(workerId)
    return decl?.runtime === 'hermes'
  } catch {
    // If the runtime router is unavailable, fall back to the historical
    // default: hermes workers are dispatched via swarm-dispatch.
    return true
  }
}

/**
 * Dispatch every queued assignment whose dependencies are satisfied.
 * Partial failure does not roll back already-dispatched assignments
 * (matches swarm-dispatch semantics). Returns a per-assignment summary.
 */
export async function dispatchReadyAssignments(
  missionId: string,
): Promise<DispatchReadyResult> {
  if (dispatchingMissions.has(missionId)) {
    return { ok: true, dispatched: [] }
  }
  dispatchingMissions.add(missionId)

  try {
    const mission = getSwarmMission(missionId)
    if (!mission) return { ok: true, dispatched: [] }

    const ready = readyQueuedAssignments(missionId)
    if (ready.length === 0) {
      return { ok: true, dispatched: [] }
    }

    const hermesAssignments = ready.filter((a) => isHermesRuntime(a.workerId))
    const managedAssignments = ready.filter((a) => !isHermesRuntime(a.workerId))

    const dispatched: Array<DispatchedAssignmentSummary> = []

    if (hermesAssignments.length > 0) {
      try {
        const result = await dispatchSwarmAssignments({
          missionId,
          assignments: hermesAssignments.map((a) => ({
            workerId: a.workerId,
            task: a.task,
            rationale: a.rationale ?? undefined,
            assignmentId: a.id,
            dependsOn: a.dependsOn,
            reviewRequired: a.reviewRequired,
          })),
          allowAsync: true,
        })
        for (const assignment of hermesAssignments) {
          const workerResult = result.results.find(
            (r) => r.workerId === assignment.workerId,
          )
          dispatched.push({
            assignmentId: assignment.id,
            workerId: assignment.workerId,
            ok: workerResult?.ok ?? true,
            error: workerResult?.error ?? undefined,
          })
        }
      } catch (error) {
        const message =
          error instanceof Error ? error.message : String(error)
        for (const assignment of hermesAssignments) {
          dispatched.push({
            assignmentId: assignment.id,
            workerId: assignment.workerId,
            ok: false,
            error: message,
          })
        }
      }
    }

    for (const assignment of managedAssignments) {
      try {
        const result = await dispatchAssignment({
          missionId,
          assignmentId: assignment.id,
        })
        dispatched.push({
          assignmentId: assignment.id,
          workerId: assignment.workerId,
          ok: result.ok,
          error: result.ok ? undefined : result.error,
        })
      } catch (error) {
        dispatched.push({
          assignmentId: assignment.id,
          workerId: assignment.workerId,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }

    // Refresh the board lane so the card moves from ready → running.
    if (mission.taskId) {
      await syncLaneFromMission({
        cardId: mission.taskId,
        missionId,
        updateCard: (id: string, lane: KanbanLane) =>
          updateKanbanCard(id, { status: lane }),
      })
    }

    return { ok: true, dispatched }
  } finally {
    dispatchingMissions.delete(missionId)
  }
}

function isTerminalContinuationCheckpoint(
  checkpoint: ParsedSwarmCheckpoint,
): boolean {
  // DONE completes a stage; HANDOFF explicitly hands off to the next stage.
  // BLOCKED/NEEDS_INPUT are terminal but require human intervention first.
  return checkpoint.stateLabel === 'DONE' || checkpoint.stateLabel === 'HANDOFF'
}

/**
 * Register a fire-and-forget continuation: when a pipeline mission reaches a
 * terminal DONE/HANDOFF checkpoint, dispatch the next ready assignments.
 * The in-flight Set inside dispatchReadyAssignments prevents duplicate loops.
 */
setOnCheckpointTerminalHook(({ missionId }) => {
  void dispatchReadyAssignments(missionId).catch((error) => {
    console.error(
      '[dispatch-ready] pipeline continuation failed:',
      error instanceof Error ? error.message : String(error),
    )
  })
})
