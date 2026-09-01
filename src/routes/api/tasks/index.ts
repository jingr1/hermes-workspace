import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../../server/auth-middleware'
import { listKanbanCards } from '../../../server/kanban-backend'
import { createTask } from '../../../server/task-pipeline/task-service'
import { listSwarmMissions } from '../../../server/swarm-missions'
import { laneFromMission } from '../../../server/task-pipeline/lane-sync'
import type {
  SwarmMission,
  SwarmMissionAssignmentState,
} from '../../../server/swarm-missions'

// Fallback progress for cards that are not yet bound to a local Swarm mission.
// This prevents every dashboard task from showing 0% in Mission Control.
const FALLBACK_PROGRESS_BY_LANE: Record<string, number> = {
  done: 100,
  complete: 100,
  review: 75,
  running: 50,
  blocked: 50,
  ready: 25,
  todo: 10,
  backlog: 0,
}

function assignmentProgressWeight(state: SwarmMissionAssignmentState): number {
  switch (state) {
    case 'done':
    case 'checkpointed':
      return 1
    case 'reviewing':
      return 0.8
    case 'blocked':
    case 'needs_input':
      return 0.5
    case 'dispatched':
      return 0.5
    case 'queued':
    case 'cancelled':
    default:
      return 0
  }
}

function computeTaskProgress(mission: SwarmMission | null, lane: string): number {
  if (mission && mission.assignments.length > 0) {
    const weighted = mission.assignments.reduce(
      (sum, assignment) => sum + assignmentProgressWeight(assignment.state),
      0,
    )
    return Math.round((weighted / mission.assignments.length) * 100)
  }
  return FALLBACK_PROGRESS_BY_LANE[lane] ?? FALLBACK_PROGRESS_BY_LANE.backlog
}

/**
 * GET  /api/tasks           → TaskSummary[] (card + mission + lane + progress)
 * POST /api/tasks           → create card + instantiate pipeline + mission
 * GET  /api/tasks/:taskId   → card + pipeline stages + runs + events
 */
export const Route = createFileRoute('/api/tasks/')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!isAuthenticated(request))
          return json({ error: 'Unauthorized' }, { status: 401 })
        const cards = await listKanbanCards()
        const missions = listSwarmMissions(500)
        const missionById = new Map(missions.map((m) => [m.id, m]))
        const missionByTaskId = new Map(
          missions.filter((m) => m.taskId).map((m) => [m.taskId as string, m]),
        )
        const tasks = cards.map((card) => {
          const mission = card.missionId
            ? (missionById.get(card.missionId) ?? null)
            : (missionByTaskId.get(card.id) ?? null)
          const effectiveLane = mission ? laneFromMission(mission) : card.status
          return {
            cardId: card.id,
            title: card.title,
            lane: card.status,
            missionId: mission?.id ?? null,
            missionState: mission?.state ?? null,
            derivedLane: mission ? laneFromMission(mission) : null,
            currentAssignee:
              mission?.assignments.find((a) => a.state === 'dispatched')
                ?.workerId ?? null,
            progress: computeTaskProgress(mission, effectiveLane),
          }
        })
        return json({ tasks })
      },

      POST: async ({ request }) => {
        if (!isAuthenticated(request))
          return json({ error: 'Unauthorized' }, { status: 401 })
        let body: {
          title?: string
          spec?: string
          pipelineId?: string
          acceptanceCriteria?: Array<string>
          projectId?: string
        }
        try {
          body = await request.json()
        } catch {
          return json({ error: 'Invalid JSON body' }, { status: 400 })
        }
        if (!body.title?.trim())
          return json({ error: 'Missing title' }, { status: 400 })
        if (!body.pipelineId)
          return json({ error: 'Missing pipelineId' }, { status: 400 })
        try {
          const created = await createTask({
            title: body.title,
            spec: body.spec ?? '',
            pipelineId: body.pipelineId,
            acceptanceCriteria: body.acceptanceCriteria ?? [],
            projectId: body.projectId ?? null,
          })
          return json(created, { status: 201 })
        } catch (error) {
          return json(
            { error: error instanceof Error ? error.message : String(error) },
            { status: 400 },
          )
        }
      },
    },
  },
})
