import { describe, expect, it, vi } from 'vitest'
import { handleTaskMerge } from './tasks/$taskId/merge'
import type { SwarmMission } from '../../../server/swarm-missions'
import type { SwarmKanbanCard } from '../../../server/swarm-kanban-store'
import type { ProjectDeclaration } from '../../../server/task-pipeline/projects'

function makeRequest(): Request {
  return new Request('http://localhost/api/tasks/task-1/merge', {
    method: 'POST',
  })
}

function makeCard(overrides?: Partial<SwarmKanbanCard>): SwarmKanbanCard {
  return {
    id: 'task-1',
    title: 'Test task',
    spec: '',
    acceptanceCriteria: [],
    assignedWorker: null,
    reviewer: null,
    status: 'running',
    missionId: 'mission-1',
    reportPath: null,
    createdBy: 'test',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  }
}

function makeMission(overrides?: Partial<SwarmMission>): SwarmMission {
  return {
    id: 'mission-1',
    title: 'Test mission',
    state: 'executing',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    assignments: [],
    events: [],
    projectId: 'project-1',
    workspaceMode: 'worktree',
    ...overrides,
  }
}

function makeProject(overrides?: Partial<ProjectDeclaration>): ProjectDeclaration {
  return {
    id: 'project-1',
    repo: '/tmp/repo',
    defaultBranch: 'main',
    worktreeRoot: '/tmp/worktrees',
    setup: [],
    maxConcurrentWorktrees: 2,
    gitRemote: '',
    selfHosted: false,
    remotes: [],
    ...overrides,
  }
}

describe('POST /api/tasks/$taskId/merge', () => {
  it('returns 401 when not authenticated', async () => {
    const res = await handleTaskMerge(makeRequest(), 'task-1', {
      isAuthenticated: () => false,
    })
    expect(res.status).toBe(401)
  })

  it('returns 404 when task card is missing', async () => {
    const res = await handleTaskMerge(makeRequest(), 'task-1', {
      isAuthenticated: () => true,
      listKanbanCards: async () => [],
    })
    expect(res.status).toBe(404)
  })

  it('returns 409 when mission is not in worktree mode', async () => {
    const res = await handleTaskMerge(makeRequest(), 'task-1', {
      isAuthenticated: () => true,
      listKanbanCards: async () => [makeCard()],
      getSwarmMission: () => makeMission({ workspaceMode: 'canonical' }),
    })
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.error).toBe('workspace_mode_unsupported')
  })

  it('returns 400 when assignments are still running', async () => {
    const res = await handleTaskMerge(makeRequest(), 'task-1', {
      isAuthenticated: () => true,
      listKanbanCards: async () => [makeCard()],
      getSwarmMission: () =>
        makeMission({
          assignments: [
            {
              id: 'a1',
              workerId: 'developer',
              task: 'do work',
              rationale: null,
              dependsOn: [],
              reviewRequired: false,
              state: 'dispatched',
              dispatchedAt: null,
              completedAt: null,
              reviewedAt: null,
              reviewedBy: null,
              checkpoint: null,
            },
          ],
        }),
      getProject: () => makeProject(),
    })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toBe('mission_not_terminal')
  })

  it('returns 409 with conflicts when merge fails', async () => {
    const res = await handleTaskMerge(makeRequest(), 'task-1', {
      isAuthenticated: () => true,
      listKanbanCards: async () => [makeCard()],
      getSwarmMission: () =>
        makeMission({
          assignments: [
            {
              id: 'a1',
              workerId: 'developer',
              task: 'done',
              rationale: null,
              dependsOn: [],
              reviewRequired: false,
              state: 'done',
              dispatchedAt: null,
              completedAt: null,
              reviewedAt: null,
              reviewedBy: null,
              checkpoint: null,
            },
          ],
        }),
      getProject: () => makeProject(),
      mergeMissionBranch: async () => ({ ok: false as const, conflicts: ['x.ts'] }),
    })
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.error).toBe('merge_conflict')
    expect(body.conflicts).toContain('x.ts')
  })

  it('marks mission complete, updates card, and releases worktrees on success', async () => {
    const markMissionComplete = vi.fn().mockReturnValue(makeMission())
    const updateKanbanCard = vi.fn().mockResolvedValue(makeCard())
    const releaseMissionWorktree = vi.fn().mockResolvedValue(undefined)
    const releaseRemoteMissionWorktree = vi.fn().mockResolvedValue(undefined)

    const res = await handleTaskMerge(makeRequest(), 'task-1', {
      isAuthenticated: () => true,
      listKanbanCards: async () => [makeCard()],
      getSwarmMission: () =>
        makeMission({
          assignments: [
            {
              id: 'a1',
              workerId: 'developer',
              task: 'done',
              rationale: null,
              dependsOn: [],
              reviewRequired: false,
              state: 'done',
              dispatchedAt: null,
              completedAt: null,
              reviewedAt: null,
              reviewedBy: null,
              checkpoint: null,
            },
          ],
        }),
      getProject: () =>
        makeProject({
          remotes: [
            { host: 'gpu', repo: '/tmp/repo', worktreeRoot: '/tmp/wt', setup: [] },
          ],
        }),
      mergeMissionBranch: async () => ({
        ok: true as const,
        mergedHead: 'abc123',
      }),
      markMissionComplete,
      updateKanbanCard,
      releaseMissionWorktree,
      releaseRemoteMissionWorktree,
    })

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.mergedHead).toBe('abc123')
    expect(markMissionComplete).toHaveBeenCalledWith('mission-1', expect.any(Object))
    expect(updateKanbanCard).toHaveBeenCalledWith('task-1', { status: 'done' })
    expect(releaseMissionWorktree).toHaveBeenCalled()
    expect(releaseRemoteMissionWorktree).toHaveBeenCalledWith(
      expect.any(Object),
      'gpu',
      'mission-1',
    )
  })
})
