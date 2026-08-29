import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { SWARM_CANONICAL_REPO } from './swarm-environment'
import { applyArtifactPathPolicy } from './swarm-mission-artifacts'
import type { ParsedSwarmCheckpoint } from './swarm-checkpoints'

export type SwarmMissionAssignmentState = 'queued' | 'dispatched' | 'checkpointed' | 'blocked' | 'needs_input' | 'reviewing' | 'done' | 'cancelled'
export type SwarmMissionState = 'planning' | 'dispatching' | 'executing' | 'reviewing' | 'blocked' | 'complete' | 'cancelled'

export type SwarmMissionAssignment = {
  id: string
  workerId: string
  task: string
  rationale: string | null
  dependsOn: Array<string>
  reviewRequired: boolean
  state: SwarmMissionAssignmentState
  dispatchedAt: number | null
  completedAt: number | null
  reviewedAt: number | null
  reviewedBy: string | null
  checkpoint: ParsedSwarmCheckpoint | null
  /** Pipeline stage key this assignment was created from (P2a task module). */
  stageKey?: string | null
  /** specVersion the instruction text was generated against (stale check). */
  briefSpecVersion?: number | null
}

export type SwarmMission = {
  id: string
  title: string
  state: SwarmMissionState
  createdAt: number
  updatedAt: number
  assignments: Array<SwarmMissionAssignment>
  events: Array<SwarmMissionEvent>
  /** Bumped on every spec edit; stale brief detection compares against this. */
  specVersion?: number
  /** Pipeline template this mission was instantiated from (P2a). */
  pipelineId?: string | null
  /** Kanban card id this mission is bound to (P2a). */
  taskId?: string | null
}

export type SwarmMissionEvent = {
  id: string
  type: 'created' | 'assignment_dispatched' | 'checkpoint' | 'continuation' | 'review' | 'blocked' | 'assignment_cancelled' | 'mission_cancelled'
  at: number
  workerId?: string
  assignmentId?: string
  message: string
  data?: Record<string, unknown>
}

export type SwarmCheckpointReport = {
  missionId: string
  assignmentId: string
  workerId: string
  recordedAt: number
  stateLabel: ParsedSwarmCheckpoint['stateLabel']
  checkpointStatus: ParsedSwarmCheckpoint['checkpointStatus']
  runtimeState: ParsedSwarmCheckpoint['runtimeState']
  filesChanged: string | null
  commandsRun: string | null
  result: string | null
  blocker: string | null
  nextAction: string | null
  source: string
}

type SwarmMissionStore = {
  version: 1
  missions: Array<SwarmMission>
}

export const SWARM_MISSIONS_PATH = join(SWARM_CANONICAL_REPO, '.runtime', 'swarm-missions.json')

function now(): number {
  return Date.now()
}

function shortId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function readStore(): SwarmMissionStore {
  if (!existsSync(SWARM_MISSIONS_PATH)) return { version: 1, missions: [] }
  try {
    const parsed = JSON.parse(readFileSync(SWARM_MISSIONS_PATH, 'utf8')) as SwarmMissionStore
    return { version: 1, missions: Array.isArray(parsed.missions) ? parsed.missions : [] }
  } catch {
    return { version: 1, missions: [] }
  }
}

function writeStore(store: SwarmMissionStore): void {
  mkdirSync(dirname(SWARM_MISSIONS_PATH), { recursive: true })
  const tmp = `${SWARM_MISSIONS_PATH}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(tmp, JSON.stringify(store, null, 2) + '\n')
  renameSync(tmp, SWARM_MISSIONS_PATH)
}

function event(type: SwarmMissionEvent['type'], message: string, extra?: Partial<SwarmMissionEvent>): SwarmMissionEvent {
  return { id: shortId('evt'), type, at: now(), message, ...extra }
}

function reportFromCheckpoint(input: {
  missionId: string
  assignmentId: string
  workerId: string
  checkpoint: ParsedSwarmCheckpoint
  source?: string | null
}): SwarmCheckpointReport {
  return {
    missionId: input.missionId,
    assignmentId: input.assignmentId,
    workerId: input.workerId,
    recordedAt: now(),
    stateLabel: input.checkpoint.stateLabel,
    checkpointStatus: input.checkpoint.checkpointStatus,
    runtimeState: input.checkpoint.runtimeState,
    filesChanged: input.checkpoint.filesChanged,
    commandsRun: input.checkpoint.commandsRun,
    result: input.checkpoint.result,
    blocker: input.checkpoint.blocker,
    nextAction: input.checkpoint.nextAction,
    source: input.source?.trim() || 'unknown',
  }
}

function deriveMissionState(assignments: Array<SwarmMissionAssignment>): SwarmMissionState {
  if (assignments.length > 0 && assignments.every((item) => item.state === 'cancelled')) return 'cancelled'
  if (assignments.some((item) => item.state === 'blocked' || item.state === 'needs_input')) return 'blocked'
  if (assignments.length > 0 && assignments.every((item) => item.state === 'done' || item.state === 'cancelled' || (item.state === 'checkpointed' && !item.reviewRequired))) return 'complete'
  if (assignments.some((item) => item.state === 'reviewing' || (item.state === 'checkpointed' && item.reviewRequired))) return 'reviewing'
  if (assignments.some((item) => item.state === 'dispatched' || item.state === 'checkpointed')) return 'executing'
  return 'planning'
}

function inferReviewRequired(task: string, rationale?: string | null): boolean {
  // Match intent-bearing task terms only. The previous loose alternation matched
  // substrings such as "patch" inside "dispatch" and left simple smoke runs in
  // review forever.
  return /\b(code|patch(?:es|ed|ing)?|implement(?:ation|ed|ing)?|pr|benchmarks?)\b/i.test(`${task} ${rationale ?? ''}`)
}

const TERMINAL_ASSIGNMENT_STATES = new Set<SwarmMissionAssignmentState>([
  'done',
  'cancelled',
  // checkpointed/blocked/needs_input are terminal for dispatch purposes: a worker
  // may receive a new assignment on re-dispatch without inheriting stale checkpoints.
  'checkpointed',
  'blocked',
  'needs_input',
])

function isTerminalAssignment(assignment: SwarmMissionAssignment): boolean {
  return TERMINAL_ASSIGNMENT_STATES.has(assignment.state)
}

export function listSwarmMissions(limit = 20): Array<SwarmMission> {
  return readStore().missions
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, Math.max(1, Math.min(100, limit)))
}

export function getSwarmMission(missionId: string): SwarmMission | null {
  return readStore().missions.find((mission) => mission.id === missionId) ?? null
}

export function archiveStaleMissions(staleMs: number = 6 * 60 * 60 * 1000): { archivedIds: Array<string>; count: number } {
  const store = readStore()
  const now = Date.now()
  const archivedIds: Array<string> = []
  for (const mission of store.missions) {
    if (mission.state !== 'executing' && mission.state !== 'planning') continue
    if ((now - mission.updatedAt) < staleMs) continue
    if (!mission.assignments.every(a => ['done', 'checkpointed', 'blocked', 'needs_input'].includes(a.state))) continue
    mission.state = 'complete'
    mission.events.push(event('continuation', `Archived as stale (>${Math.round(staleMs / 3600000)}h, all assignments terminal)`))
    archivedIds.push(mission.id)
  }
  if (archivedIds.length) {
    writeStore(store)
  }
  return { archivedIds, count: archivedIds.length }
}

export type CreateOrUpdateMissionResult = SwarmMission & { _created?: boolean }

/**
 * Kahn topological check on the assignment dependsOn graph. Throws with the
 * offending cycle members when a cycle exists. Edges pointing at unknown
 * ids are ignored here (they simply never satisfy) — only true cycles
 * deadlock the pipeline.
 */
export function assertAcyclicDependencies(assignments: Array<SwarmMissionAssignment>): void {
  const ids = new Set(assignments.map((a) => a.id))
  const indegree = new Map<string, number>()
  const edges = new Map<string, Array<string>>() // dep → dependents
  for (const a of assignments) {
    indegree.set(a.id, 0)
  }
  for (const a of assignments) {
    for (const dep of a.dependsOn) {
      if (!ids.has(dep)) continue
      indegree.set(a.id, (indegree.get(a.id) ?? 0) + 1)
      const list = edges.get(dep) ?? []
      list.push(a.id)
      edges.set(dep, list)
    }
  }
  const queue = assignments.filter((a) => (indegree.get(a.id) ?? 0) === 0).map((a) => a.id)
  let visited = 0
  while (queue.length > 0) {
    const current = queue.pop()!
    visited++
    for (const next of edges.get(current) ?? []) {
      const remaining = (indegree.get(next) ?? 0) - 1
      indegree.set(next, remaining)
      if (remaining === 0) queue.push(next)
    }
  }
  if (visited < ids.size) {
    const cyclic = assignments.filter((a) => (indegree.get(a.id) ?? 0) > 0).map((a) => a.id)
    throw new Error(`dependsOn cycle detected among assignments: ${cyclic.join(', ')}`)
  }
}

export function createOrUpdateMission(input: {
  missionId?: string | null
  title: string
  assignments: Array<{ workerId: string; task: string; rationale?: string | null; dependsOn?: Array<string>; reviewRequired?: boolean }>
}): CreateOrUpdateMissionResult {
  const store = readStore()
  const createdAt = now()
  const missionId = input.missionId?.trim() || shortId('mission')
  let mission = store.missions.find((item) => item.id === missionId)
  let createdMission = false
  if (!mission) {
    mission = {
      id: missionId,
      title: input.title || 'Untitled swarm mission',
      state: 'planning',
      createdAt,
      updatedAt: createdAt,
      assignments: [],
      events: [event('created', `Mission created: ${input.title || missionId}`)],
    }
    store.missions.push(mission)
    createdMission = true
  }

  mission.title = input.title || mission.title
  for (const assignment of input.assignments) {
    // One active assignment per worker per mission. Skip if the worker already
    // has a non-terminal assignment, regardless of task text differences.
    const existing = mission.assignments.find(
      (item) => item.workerId === assignment.workerId && !isTerminalAssignment(item)
    )
    if (existing) continue
    const id = shortId('assign')
    mission.assignments.push({
      id,
      workerId: assignment.workerId,
      task: assignment.task,
      rationale: assignment.rationale ?? null,
      dependsOn: assignment.dependsOn ?? [],
      reviewRequired: assignment.reviewRequired ?? inferReviewRequired(assignment.task, assignment.rationale),
      state: 'queued',
      dispatchedAt: null,
      completedAt: null,
      reviewedAt: null,
      reviewedBy: null,
      checkpoint: null,
    })
  }
  // Cycle guard (plan risk table): a cyclic dependsOn graph makes
  // readyQueuedAssignments return [] forever — the pipeline silently dies.
  // Reject at registration time, where the error is loud and attributable.
  assertAcyclicDependencies(mission.assignments)
  mission.updatedAt = now()
  mission.state = deriveMissionState(mission.assignments)
  writeStore(store)
  return Object.assign(mission, { _created: createdMission })
}

export function markMissionAssignmentDispatched(input: {
  missionId: string
  workerId: string
  task: string
  source?: string | null
  author?: string | null
}): SwarmMission | null {
  const store = readStore()
  const mission = store.missions.find((item) => item.id === input.missionId)
  if (!mission) return null
  if (mission.state === 'cancelled' || mission.state === 'complete') return mission
  const assignment = mission.assignments.find((item) => item.workerId === input.workerId && item.task === input.task)
  if (!assignment) return null
  if (isTerminalAssignment(assignment)) return mission
  assignment.state = 'dispatched'
  assignment.dispatchedAt = now()
  // Clearing any stale checkpoint from a previous dispatch prevents the
  // harvester from confusing the old result with output from this new run.
  assignment.checkpoint = null
  assignment.completedAt = null
  mission.events.push(event('assignment_dispatched', `Dispatched ${assignment.id} to ${input.workerId}`, {
    workerId: input.workerId,
    assignmentId: assignment.id,
    data: {
      task: assignment.task,
      source: input.source?.trim() || 'swarm-dispatch',
      author: input.author?.trim() || 'aurora',
    },
  }))
  mission.updatedAt = now()
  mission.state = deriveMissionState(mission.assignments)
  writeStore(store)
  return mission
}

export type RecordCheckpointResult = (SwarmMission & { _completed?: boolean; _ignoredReason?: string }) | null

export function recordMissionCheckpoint(input: {
  missionId?: string | null
  assignmentId?: string | null
  workerId: string
  checkpoint: ParsedSwarmCheckpoint
  source?: string | null
}): RecordCheckpointResult {
  if (!input.missionId) return null
  const store = readStore()
  const mission = store.missions.find((item) => item.id === input.missionId)
  if (!mission) return null
  if (mission.state === 'cancelled') return Object.assign(mission, { _ignoredReason: 'mission cancelled' })
  const assignment = (input.assignmentId
    ? mission.assignments.find((item) => item.id === input.assignmentId)
    : null)
    ?? [...mission.assignments].reverse().find((item) => item.workerId === input.workerId && item.state !== 'done')
    ?? [...mission.assignments].reverse().find((item) => item.workerId === input.workerId)
  if (!assignment) return null
  if (assignment.state === 'cancelled') return Object.assign(mission, { _ignoredReason: 'assignment cancelled' })
  if (assignment.state === 'done') return Object.assign(mission, { _ignoredReason: 'assignment done' })
  if (assignment.checkpoint?.raw === input.checkpoint.raw) {
    return Object.assign(mission, { _completed: mission.state === 'complete' })
  }
  const checkpoint = applyArtifactPathPolicy(input.checkpoint, input.missionId, input.workerId)
  assignment.checkpoint = checkpoint
  assignment.completedAt = now()
  assignment.state = checkpoint.stateLabel === 'BLOCKED'
    ? 'blocked'
    : checkpoint.stateLabel === 'NEEDS_INPUT'
      ? 'needs_input'
      : checkpoint.stateLabel === 'IN_PROGRESS'
        ? 'dispatched'
        : 'checkpointed'
  const report = reportFromCheckpoint({
    missionId: mission.id,
    assignmentId: assignment.id,
    workerId: input.workerId,
    checkpoint,
    source: input.source,
  })
  mission.events.push(event('checkpoint', `${input.workerId} checkpointed: ${checkpoint.stateLabel}`, {
    workerId: input.workerId,
    assignmentId: assignment.id,
    data: report,
  }))
  mission.updatedAt = now()
  const previousState = mission.state
  mission.state = deriveMissionState(mission.assignments)
  const completed = mission.state === 'complete' && previousState !== 'complete'
  writeStore(store)
  return Object.assign(mission, { _completed: completed })
}

export function recordMissionAssignmentBlocked(input: {
  missionId?: string | null
  assignmentId?: string | null
  workerId: string
  reason?: string | null
  source?: string | null
}): { mission: SwarmMission; assignment: SwarmMissionAssignment; changed: boolean } | null {
  if (!input.missionId) return null
  const store = readStore()
  const mission = store.missions.find((item) => item.id === input.missionId)
  if (!mission) return null
  if (mission.state === 'cancelled' || mission.state === 'complete') return null
  const assignment = (input.assignmentId
    ? mission.assignments.find((item) => item.id === input.assignmentId)
    : null)
    ?? [...mission.assignments].reverse().find((item) => item.workerId === input.workerId && !isTerminalAssignment(item))
    ?? [...mission.assignments].reverse().find((item) => item.workerId === input.workerId)
  if (!assignment) return null
  if (assignment.state === 'cancelled' || assignment.state === 'done') return { mission, assignment, changed: false }

  const reason = input.reason?.trim() || 'Dispatch failed before a worker checkpoint was recorded.'
  const blockedAt = now()
  const checkpoint: ParsedSwarmCheckpoint = {
    stateLabel: 'BLOCKED',
    runtimeState: 'blocked',
    checkpointStatus: 'blocked',
    filesChanged: 'none',
    commandsRun: 'none',
    result: null,
    blocker: reason,
    nextAction: 'Fix blocker and retry dispatch.',
    reviewOutcome: null,
    raw: `STATE: BLOCKED\nFILES_CHANGED: none\nCOMMANDS_RUN: none\nRESULT: none\nBLOCKER: ${reason}\nNEXT_ACTION: Fix blocker and retry dispatch.`,
  }
  const changed = assignment.state !== 'blocked' || assignment.checkpoint?.raw !== checkpoint.raw
  assignment.state = 'blocked'
  assignment.completedAt = blockedAt
  assignment.checkpoint = checkpoint
  const report = reportFromCheckpoint({
    missionId: mission.id,
    assignmentId: assignment.id,
    workerId: input.workerId,
    checkpoint,
    source: input.source,
  })
  if (changed) {
    mission.events.push(event('blocked', `${input.workerId} blocked: ${reason}`, {
      workerId: input.workerId,
      assignmentId: assignment.id,
      data: report,
    }))
  }
  mission.updatedAt = blockedAt
  mission.state = deriveMissionState(mission.assignments)
  writeStore(store)
  return { mission, assignment, changed }
}

export function appendMissionContinuation(input: {
  missionId?: string | null
  workerId: string
  task: string
  rationale: string
  dependsOn?: Array<string>
}): SwarmMission | null {
  if (!input.missionId) return null
  const store = readStore()
  const mission = store.missions.find((item) => item.id === input.missionId)
  if (!mission) return null
  if (mission.state === 'cancelled') return null
  const id = shortId('assign')
  mission.assignments.push({
    id,
    workerId: input.workerId,
    task: input.task,
    rationale: input.rationale,
    dependsOn: input.dependsOn ?? [],
    reviewRequired: false,
    state: 'queued',
    dispatchedAt: null,
    completedAt: null,
    reviewedAt: null,
    reviewedBy: null,
    checkpoint: null,
  })
  assertAcyclicDependencies(mission.assignments)
  mission.events.push(event('continuation', `Queued continuation ${id} for ${input.workerId}`, { workerId: input.workerId, assignmentId: id }))
  mission.updatedAt = now()
  mission.state = deriveMissionState(mission.assignments)
  writeStore(store)
  return mission
}

export function readyQueuedAssignments(missionId: string): Array<SwarmMissionAssignment> {
  const mission = getSwarmMission(missionId)
  if (!mission) return []
  const doneIds = new Set(mission.assignments.filter((item) => ['checkpointed', 'done'].includes(item.state)).map((item) => item.id))
  return mission.assignments.filter((item) => item.state === 'queued' && item.dependsOn.every((id) => doneIds.has(id)))
}

export function requeueMissionAssignment(input: {
  missionId: string
  assignmentId: string
  reason: string
}): SwarmMission | null {
  const store = readStore()
  const mission = store.missions.find((item) => item.id === input.missionId)
  if (!mission) return null
  const assignment = mission.assignments.find((item) => item.id === input.assignmentId)
  if (!assignment) return null
  if (assignment.state !== 'dispatched') return mission
  assignment.state = 'queued'
  assignment.dispatchedAt = null
  mission.events.push(event('continuation', `Requeued ${assignment.id}: ${input.reason}`, {
    assignmentId: assignment.id,
    data: { reason: input.reason },
  }))
  mission.updatedAt = now()
  mission.state = deriveMissionState(mission.assignments)
  writeStore(store)
  return mission
}

/**
 * P2a two-pass instantiation helper: after all stage assignments exist,
 * rewrite their dependsOn from stage keys to assignment ids, stamp
 * stageKey / briefSpecVersion, and bind the mission to its pipeline + card.
 * Re-runs the cycle guard after rewiring. Single write, one place for the
 * invariant.
 */
export function rewriteAssignmentDependencies(input: {
  missionId: string
  dependsOnByAssignmentId: Record<string, Array<string>>
  stageKeyByAssignmentId?: Record<string, string>
  briefSpecVersion?: number
  pipelineId?: string
  taskId?: string
  specVersion?: number
}): SwarmMission | null {
  const store = readStore()
  const mission = store.missions.find((item) => item.id === input.missionId)
  if (!mission) return null
  for (const assignment of mission.assignments) {
    const deps = input.dependsOnByAssignmentId[assignment.id]
    // dependsOnByAssignmentId is a full map over every stage assignment built
    // by the caller (instantiatePipeline); a missing key means caller bug.
    assignment.dependsOn = deps
    const stageKey = input.stageKeyByAssignmentId?.[assignment.id]
    if (stageKey !== undefined) assignment.stageKey = stageKey
    if (input.briefSpecVersion !== undefined) assignment.briefSpecVersion = input.briefSpecVersion
  }
  if (input.pipelineId !== undefined) mission.pipelineId = input.pipelineId
  if (input.taskId !== undefined) mission.taskId = input.taskId
  if (input.specVersion !== undefined) mission.specVersion = input.specVersion
  assertAcyclicDependencies(mission.assignments)
  mission.updatedAt = now()
  mission.state = deriveMissionState(mission.assignments)
  writeStore(store)
  return mission
}

export function cancelSwarmAssignment(input: {
  missionId?: string | null
  assignmentId?: string | null
  workerId?: string | null
  actor?: string | null
  reason?: string | null
}): { mission: SwarmMission; assignment: SwarmMissionAssignment; changed: boolean } | null {
  if (!input.missionId) return null
  const store = readStore()
  const mission = store.missions.find((item) => item.id === input.missionId)
  if (!mission) return null
  const assignment = (input.assignmentId
    ? mission.assignments.find((item) => item.id === input.assignmentId)
    : null)
    ?? (input.workerId ? [...mission.assignments].reverse().find((item) => item.workerId === input.workerId && !isTerminalAssignment(item)) : null)
    ?? null
  if (!assignment) return null
  if (assignment.state === 'cancelled') return { mission, assignment, changed: false }
  const cancelledAt = now()
  assignment.state = 'cancelled'
  assignment.completedAt = cancelledAt
  assignment.reviewedAt = cancelledAt
  assignment.reviewedBy = input.actor?.trim() || 'system-cancel'
  mission.events.push(event('assignment_cancelled', `Cancelled ${assignment.id}${input.reason ? `: ${input.reason}` : ''}`, {
    workerId: assignment.workerId,
    assignmentId: assignment.id,
    data: {
      actor: input.actor?.trim() || 'system-cancel',
      reason: input.reason?.trim() || null,
    },
  }))
  mission.updatedAt = cancelledAt
  mission.state = deriveMissionState(mission.assignments)
  writeStore(store)
  return { mission, assignment, changed: true }
}

export function appendSwarmMissionOrchestratorEvent(input: {
  missionId: string
  message: string
  data?: Record<string, unknown>
}): SwarmMission | null {
  const store = readStore()
  const mission = store.missions.find((item) => item.id === input.missionId)
  if (!mission) return null
  mission.events.push(event('continuation', input.message, {
    data: {
      source: 'langgraph-orchestrator',
      ...(input.data ?? {}),
    },
  }))
  mission.updatedAt = now()
  writeStore(store)
  return mission
}

export function cancelSwarmMission(input: {
  missionId?: string | null
  actor?: string | null
  reason?: string | null
}): { mission: SwarmMission; cancelledAssignmentIds: Array<string>; changed: boolean } | null {
  if (!input.missionId) return null
  const store = readStore()
  const mission = store.missions.find((item) => item.id === input.missionId)
  if (!mission) return null
  const cancelledAt = now()
  const cancelledAssignmentIds: Array<string> = []
  for (const assignment of mission.assignments) {
    if (isTerminalAssignment(assignment)) continue
    assignment.state = 'cancelled'
    assignment.completedAt = cancelledAt
    assignment.reviewedAt = cancelledAt
    assignment.reviewedBy = input.actor?.trim() || 'system-cancel'
    cancelledAssignmentIds.push(assignment.id)
  }
  mission.state = 'cancelled'
  mission.updatedAt = cancelledAt
  mission.events.push(event('mission_cancelled', `Cancelled mission${input.reason ? `: ${input.reason}` : ''}`, {
    data: {
      actor: input.actor?.trim() || 'system-cancel',
      reason: input.reason?.trim() || null,
      cancelledAssignmentIds,
    },
  }))
  writeStore(store)
  return { mission, cancelledAssignmentIds, changed: cancelledAssignmentIds.length > 0 }
}

export function markMissionAssignmentReviewed(input: { missionId?: string | null; assignmentId: string; reviewerId?: string }): SwarmMission | null {
  if (!input.missionId) return null
  const store = readStore()
  const mission = store.missions.find((item) => item.id === input.missionId)
  if (!mission) return null
  const assignment = mission.assignments.find((item) => item.id === input.assignmentId)
  if (!assignment) return null
  assignment.state = 'done'
  assignment.reviewedAt = now()
  assignment.reviewedBy = input.reviewerId ?? null
  mission.events.push(event('review', `Reviewed ${assignment.id}${input.reviewerId ? ` by ${input.reviewerId}` : ''}`, { workerId: input.reviewerId, assignmentId: assignment.id }))
  mission.updatedAt = now()
  mission.state = deriveMissionState(mission.assignments)
  writeStore(store)
  return mission
}

export function markMissionAssignmentsReviewedByWorker(input: {
  missionId?: string | null
  reviewerId: string
  excludeAssignmentId?: string | null
}): { mission: SwarmMission; reviewedAssignmentIds: Array<string> } | null {
  if (!input.missionId) return null
  const store = readStore()
  const mission = store.missions.find((item) => item.id === input.missionId)
  if (!mission) return null

  const reviewedAt = now()
  const reviewed = mission.assignments.filter((assignment) => (
    assignment.id !== input.excludeAssignmentId
    && assignment.workerId !== input.reviewerId
    && assignment.reviewRequired
    && assignment.state === 'checkpointed'
  ))

  if (reviewed.length === 0) return { mission, reviewedAssignmentIds: [] }

  for (const assignment of reviewed) {
    assignment.state = 'done'
    assignment.reviewedAt = reviewedAt
    assignment.reviewedBy = input.reviewerId
    mission.events.push(event('review', `Reviewed ${assignment.id} by ${input.reviewerId}`, {
      workerId: input.reviewerId,
      assignmentId: assignment.id,
    }))
  }

  mission.updatedAt = reviewedAt
  mission.state = deriveMissionState(mission.assignments)
  writeStore(store)
  return { mission, reviewedAssignmentIds: reviewed.map((assignment) => assignment.id) }
}

export function listSwarmReports(input?: {
  missionId?: string | null
  workerId?: string | null
  limit?: number
}): Array<SwarmCheckpointReport> {
  const limit = Math.max(1, Math.min(500, input?.limit ?? 100))
  const mission = input?.missionId ? getSwarmMission(input.missionId) : null
  const missions = mission ? [mission] : readStore().missions

  return missions
    .flatMap((entry) => entry.events)
    .filter((event) => event.type === 'checkpoint' && event.data)
    .map((event) => event.data as SwarmCheckpointReport)
    .filter((report) => !input?.workerId || report.workerId === input.workerId)
    .sort((a, b) => b.recordedAt - a.recordedAt)
    .slice(0, limit)
}
