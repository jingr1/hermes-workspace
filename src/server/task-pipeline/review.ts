/**
 * review — P2a 评审节点（plan 模块 1 «review.ts»）.
 *
 * A review stage parses REVIEW_OUTCOME from its checkpoint and either
 * releases the downstream (approved) or sends work back (changes_requested)
 * with the four-step rework semantics: re-dispatch reworkTarget, downstream
 * edges inherited, retry ≤3, then Human Gate.
 *
 * P2a scope: the verdict parsing + rework dispatch + retry counter. The
 * reviewer itself is a pipeline stage agent (architect) driven by the normal
 * dispatch loop; this module decides what happens AFTER its checkpoint.
 */
import {
  
  
  appendSwarmMissionOrchestratorEvent,
  getSwarmMission,
  markMissionAssignmentReviewed,
  requeueMissionAssignment
} from '../swarm-missions'
import type {SwarmMission, SwarmMissionAssignment} from '../swarm-missions';

export type ReviewOutcome = 'approved' | 'changes_requested'

export type ReviewDecision = {
  outcome: ReviewOutcome
  feedback: string | null
}

const MAX_REWORK = 3

/** Parse REVIEW_OUTCOME from a review stage's checkpoint raw text. */
export function parseReviewOutcome(raw: string | null | undefined): ReviewDecision | null {
  if (!raw) return null
  const match = raw.match(/REVIEW_OUTCOME:\s*(approved|changes_requested)/i)
  if (!match) return null
  const outcome = match[1].toLowerCase() === 'approved' ? 'approved' : 'changes_requested'
  // Everything after the outcome line is reviewer feedback.
  const idx = raw.indexOf(match[0])
  const feedback = raw.slice(idx + match[0].length).trim() || null
  return { outcome, feedback }
}

function reworkCount(mission: SwarmMission, stageKey: string | null | undefined): number {
  if (!stageKey) return 0
  return mission.events.filter(
    (e) => e.type === 'continuation' && typeof e.data?.reworkOf === 'string' && e.data.reworkOf === stageKey,
  ).length
}

export type ReviewApplyResult =
  | { ok: true; action: 'approved' }
  | { ok: true; action: 'rework'; targetAssignmentId: string; attempt: number }
  | { ok: true; action: 'needs_human'; reason: string }
  | { ok: false; error: string }

/**
 * Apply a review verdict to the mission. Called by the advance loop when a
 * review-kind stage checkpoints.
 *
 * approved → mark the BUILD stage's assignment reviewed (done); downstream
 *            (stages depending on the review stage) become dispatchable.
 * changes_requested → requeue the reworkTarget stage with feedback,
 *            blocking downstream. Retry > MAX_REWORK → needs_human.
 */
export function applyReviewVerdict(input: {
  missionId: string
  reviewAssignmentId: string
  rawCheckpoint: string
  reviewerId: string
}): ReviewApplyResult {
  const mission = getSwarmMission(input.missionId)
  if (!mission) return { ok: false, error: `Mission not found: ${input.missionId}` }
  const reviewAssignment = mission.assignments.find((a) => a.id === input.reviewAssignmentId)
  if (!reviewAssignment) return { ok: false, error: `Assignment not found: ${input.reviewAssignmentId}` }

  const decision = parseReviewOutcome(input.rawCheckpoint)
  if (!decision) return { ok: false, error: 'No REVIEW_OUTCOME in checkpoint' }

  // The build assignment is the one the review stage depends on (reworkTarget).
  const buildAssignment = mission.assignments.find(
    (a) => a.id !== reviewAssignment.id && reviewAssignment.dependsOn.includes(a.id),
  )

  if (decision.outcome === 'approved') {
    if (buildAssignment) {
      markMissionAssignmentReviewed({
        missionId: mission.id,
        assignmentId: buildAssignment.id,
        reviewerId: input.reviewerId,
      })
    }
    return { ok: true, action: 'approved' }
  }

  // changes_requested
  const target = buildAssignment
  if (!target) return { ok: false, error: 'No rework target (review stage has no upstream build dependency)' }

  const attempts = reworkCount(mission, target.stageKey)
  if (attempts >= MAX_REWORK) {
    appendSwarmMissionOrchestratorEvent({
      missionId: mission.id,
      message: `Review rework limit (${MAX_REWORK}) reached for stage ${target.stageKey}; needs human`,
      data: { reworkOf: target.stageKey ?? target.id, needsHuman: true },
    })
    return { ok: true, action: 'needs_human', reason: `rework limit ${MAX_REWORK} reached` }
  }

  // Rework: requeue the build stage. Its downstream (review) becomes queued
  // again via deriveMissionState once the build re-checkpoints.
  requeueMissionAssignment({
    missionId: mission.id,
    assignmentId: target.id,
    reason: `changes_requested by ${input.reviewerId}: ${decision.feedback ?? '(no feedback)'}`,
  })
  appendSwarmMissionOrchestratorEvent({
    missionId: mission.id,
    message: `Rework #${attempts + 1} for stage ${target.stageKey ?? target.id}`,
    data: { reworkOf: target.stageKey ?? target.id },
  })
  return { ok: true, action: 'rework', targetAssignmentId: target.id, attempt: attempts + 1 }
}
