/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import {
  buildMissionSummary,
  buildTaskRuntimeSnapshot,
  serializeMissionTask,
} from './mission-serialize'
import type {
  SwarmMission,
  SwarmMissionAssignment,
} from '../swarm-missions'

function makeAssignment(
  overrides: Partial<SwarmMissionAssignment> = {},
): SwarmMissionAssignment {
  return {
    id: 'task-1',
    workerId: 'developer',
    task: 'Implement feature',
    rationale: null,
    dependsOn: [],
    reviewRequired: false,
    state: 'dispatched',
    dispatchedAt: 1_700_000_000_000,
    completedAt: null,
    reviewedAt: null,
    reviewedBy: null,
    checkpoint: null,
    createdByWorkerId: 'system:pipeline',
    dispatchable: true,
    externalRef: null,
    workspacePath: '/tmp/ws',
    stageKey: 'build',
    ...overrides,
  }
}

function makeMission(
  assignment: SwarmMissionAssignment,
): SwarmMission {
  return {
    id: 'mission-1',
    title: 'Demo',
    state: 'executing',
    createdAt: 1,
    updatedAt: 2,
    pipelineId: 'rad',
    taskId: null,
    projectId: null,
    workspaceMode: 'canonical',
    executionMode: 'pipeline',
    assignee: null,
    roomId: null,
    assignments: [assignment],
    events: [],
  }
}

describe('mission-serialize runtime stub', () => {
  it('buildTaskRuntimeSnapshot matches Symphony-aligned shape', () => {
    const assignment = makeAssignment()
    const snap = buildTaskRuntimeSnapshot({
      mission: makeMission(assignment),
      assignment,
    })
    expect(snap).toEqual({
      task_id: 'task-1',
      mission_id: 'mission-1',
      status: 'dispatched',
      external_ref: null,
      dispatchable: true,
      workspace: { path: '/tmp/ws' },
      worker_id: 'developer',
      created_by: 'system:pipeline',
      stage_key: 'build',
      running: {
        started_at: 1_700_000_000_000,
        worker_id: 'developer',
      },
      retry: null,
    })
  })

  it('serializeMissionTask exposes Symphony Task fields', () => {
    const row = serializeMissionTask(makeAssignment({ state: 'queued' }))
    expect(row.createdByWorkerId).toBe('system:pipeline')
    expect(row.dispatchable).toBe(true)
    expect(row.externalRef).toBeNull()
    expect(row.workspacePath).toBe('/tmp/ws')
  })

  it('buildMissionSummary exposes currentAssignee and currentStage', () => {
    const assignment = makeAssignment({
      state: 'dispatched',
      workerId: 'researcher',
      stageKey: 'research',
    })
    const summary = buildMissionSummary({
      cardTitle: 'Demo',
      cardStatus: 'running',
      mission: makeMission(assignment),
    })
    expect(summary.currentAssignee).toBe('researcher')
    expect(summary.currentStage).toBe('research')
    expect(summary.missionId).toBe('mission-1')
  })
})
