/**
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

describe('deleteMission', () => {
  let prevCwd: string
  let prevHermesHome: string | undefined
  let tmp: string

  beforeEach(() => {
    prevCwd = process.cwd()
    prevHermesHome = process.env.HERMES_HOME
    tmp = mkdtempSync(join(tmpdir(), 'delete-mission-'))
    process.env.HERMES_HOME = tmp
    mkdirSync(join(tmp, '.runtime'), { recursive: true })
    writeFileSync(
      join(tmp, 'projects.yaml'),
      `version: 1
projects:
  - id: demo
    repo: ${tmp}
    defaultBranch: main
    worktreeRoot: ${join(tmp, 'worktrees')}
    setup: []
    maxConcurrentWorktrees: 1
    gitRemote: ''
    selfHosted: true
`,
    )
    process.chdir(tmp)
    vi.resetModules()
    vi.doMock('../git-ops', () => ({
      ensureMissionWorktree: vi.fn(),
      releaseMissionWorktree: vi.fn(async () => undefined),
    }))
    vi.doMock('./dispatch-ready', () => ({
      dispatchReadyAssignments: vi.fn(async () => ({
        missionId: 'x',
        dispatched: [],
      })),
    }))
    vi.doMock('./lane-sync', () => ({
      syncLaneFromMission: vi.fn(async () => undefined),
    }))
  })

  afterEach(() => {
    process.chdir(prevCwd)
    if (prevHermesHome === undefined) delete process.env.HERMES_HOME
    else process.env.HERMES_HOME = prevHermesHome
    vi.resetModules()
    vi.doUnmock('../git-ops')
    vi.doUnmock('./dispatch-ready')
    vi.doUnmock('./lane-sync')
    rmSync(tmp, { recursive: true, force: true })
  })

  it('removes mission and local kanban card', async () => {
    const { createOrUpdateMission, getSwarmMission, setMissionTaskId } =
      await import('../swarm-missions')
    const { createSwarmKanbanCard, listSwarmKanbanCards } = await import(
      '../swarm-kanban-store'
    )
    const { deleteMission } = await import('./task-service')

    const mission = createOrUpdateMission({
      title: 'to-delete',
      assignments: [
        {
          workerId: 'researcher',
          task: 'look around',
          rationale: null,
          dependsOn: [],
          reviewRequired: false,
        },
      ],
    })
    const card = createSwarmKanbanCard({
      title: 'to-delete',
      missionId: mission.id,
      status: 'todo',
    })
    setMissionTaskId({ missionId: mission.id, taskId: card.id })

    const result = await deleteMission(mission.id)
    expect(result.missionId).toBe(mission.id)
    expect(result.cardId).toBe(card.id)
    expect(result.cardDeleted).toBe(true)
    expect(getSwarmMission(mission.id)).toBeNull()
    expect(listSwarmKanbanCards().some((c) => c.id === card.id)).toBe(false)
  })

  it('deletes orphan kanban card by card id (t_… style)', async () => {
    const { createSwarmKanbanCard, listSwarmKanbanCards } = await import(
      '../swarm-kanban-store'
    )
    const { deleteMissionByRef } = await import('./task-service')

    const card = createSwarmKanbanCard({
      title: 'orphan-card',
      status: 'todo',
    })
    // Simulate Claude-style id by rewriting via local store delete+recreate is hard;
    // assert the card id path works for whatever id the store assigned.
    const result = await deleteMissionByRef(card.id)
    expect(result.missionId).toBeNull()
    expect(result.cardId).toBe(card.id)
    expect(result.cardDeleted).toBe(true)
    expect(listSwarmKanbanCards().some((c) => c.id === card.id)).toBe(false)
  })
})
