import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../../../server/auth-middleware'
import { listKanbanCards, updateKanbanCard } from '../../../../server/kanban-backend'
import { getSwarmMission, markMissionComplete } from '../../../../server/swarm-missions'
import { getProject } from '../../../../server/task-pipeline/projects'
import {
  mergeMissionBranch,
  releaseMissionWorktree,
  releaseRemoteMissionWorktree,
} from '../../../../server/git-ops'

const TERMINAL_ASSIGNMENT_STATES = new Set([
  'done',
  'cancelled',
  'checkpointed',
  'blocked',
  'needs_input',
])

export async function handleTaskMerge(
  request: Request,
  taskId: string,
  deps?: {
    listKanbanCards?: typeof listKanbanCards
    updateKanbanCard?: typeof updateKanbanCard
    getSwarmMission?: typeof getSwarmMission
    markMissionComplete?: typeof markMissionComplete
    getProject?: typeof getProject
    mergeMissionBranch?: typeof mergeMissionBranch
    releaseMissionWorktree?: typeof releaseMissionWorktree
    releaseRemoteMissionWorktree?: typeof releaseRemoteMissionWorktree
    isAuthenticated?: typeof isAuthenticated
  },
): Promise<Response> {
  const _isAuthenticated = deps?.isAuthenticated ?? isAuthenticated
  if (!_isAuthenticated(request)) {
    return json({ error: 'Unauthorized' }, { status: 401 })
  }

  const _listKanbanCards = deps?.listKanbanCards ?? listKanbanCards
  const _updateKanbanCard = deps?.updateKanbanCard ?? updateKanbanCard
  const _getSwarmMission = deps?.getSwarmMission ?? getSwarmMission
  const _markMissionComplete = deps?.markMissionComplete ?? markMissionComplete
  const _getProject = deps?.getProject ?? getProject
  const _mergeMissionBranch = deps?.mergeMissionBranch ?? mergeMissionBranch
  const _releaseMissionWorktree =
    deps?.releaseMissionWorktree ?? releaseMissionWorktree
  const _releaseRemoteMissionWorktree =
    deps?.releaseRemoteMissionWorktree ?? releaseRemoteMissionWorktree

  const cards = await _listKanbanCards()
  const card = cards.find((c) => c.id === taskId)
  if (!card) {
    return json({ error: `Task not found: ${taskId}` }, { status: 404 })
  }

  const mission = card.missionId ? _getSwarmMission(card.missionId) : null
  if (!mission) {
    return json(
      { error: `Mission not found for task: ${taskId}` },
      { status: 404 },
    )
  }

  if (mission.workspaceMode !== 'worktree') {
    return json(
      {
        error: 'workspace_mode_unsupported',
        workspaceMode: mission.workspaceMode ?? null,
      },
      { status: 409 },
    )
  }

  if (!mission.projectId) {
    return json({ error: 'Mission has no projectId' }, { status: 400 })
  }

  const project = _getProject(mission.projectId)
  if (!project) {
    return json(
      { error: `Project not found: ${mission.projectId}` },
      { status: 404 },
    )
  }

  const nonTerminal = mission.assignments.filter(
    (a) => !TERMINAL_ASSIGNMENT_STATES.has(a.state),
  )
  if (nonTerminal.length > 0) {
    return json(
      {
        error: 'mission_not_terminal',
        message: 'Mission has non-terminal assignments',
        assignmentIds: nonTerminal.map((a) => a.id),
      },
      { status: 400 },
    )
  }

  const mergeResult = await _mergeMissionBranch(project, mission.id)
  if (mergeResult.ok === false) {
    return json(
      {
        error: 'merge_conflict',
        message:
          'Automatic merge failed; worktree left intact for manual resolution',
        conflicts: mergeResult.conflicts,
      },
      { status: 409 },
    )
  }

  _markMissionComplete(mission.id, {
    reason: `Merged mission branch into ${project.defaultBranch}`,
    data: { mergedHead: mergeResult.mergedHead, projectId: project.id },
  })
  await _updateKanbanCard(card.id, { status: 'done' })

  try {
    await _releaseMissionWorktree(project, mission.id)
  } catch (error) {
    console.error('[tasks/merge] failed to release local worktree', error)
  }
  for (const remote of project.remotes) {
    try {
      await _releaseRemoteMissionWorktree(project, remote.host, mission.id)
    } catch (error) {
      console.error(
        `[tasks/merge] failed to release remote worktree on ${remote.host}`,
        error,
      )
    }
  }

  return json({
    ok: true,
    taskId,
    missionId: mission.id,
    projectId: project.id,
    mergedHead: mergeResult.mergedHead,
    branch: `swarm/mission-${mission.id}`,
    defaultBranch: project.defaultBranch,
  })
}

export const Route = createFileRoute('/api/tasks/$taskId/merge')({
  server: {
    handlers: {
      POST: async ({ request, params }) => handleTaskMerge(request, params.taskId),
    },
  },
})
