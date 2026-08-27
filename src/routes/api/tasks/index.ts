import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../../server/auth-middleware'
import { listKanbanCards } from '../../../server/kanban-backend'
import { createTask } from '../../../server/task-pipeline/task-service'
import { getSwarmMission, listSwarmMissions } from '../../../server/swarm-missions'
import { laneFromMission } from '../../../server/task-pipeline/lane-sync'

/**
 * GET  /api/tasks           → TaskSummary[] (card + mission + lane + progress)
 * POST /api/tasks           → create card + instantiate pipeline + mission
 * GET  /api/tasks/:taskId   → card + pipeline stages + runs + events
 */
export const Route = createFileRoute('/api/tasks/')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!isAuthenticated(request)) return json({ error: 'Unauthorized' }, { status: 401 })
        const cards = await listKanbanCards()
        const missions = listSwarmMissions(500)
        const missionByCard = new Map(missions.filter((m) => m.taskId).map((m) => [m.taskId as string, m]))
        const tasks = cards.map((card) => {
          const mission = missionByCard.get(card.id) ?? (card.missionId ? getSwarmMission(card.missionId) : null)
          const done = mission ? mission.assignments.filter((a) => ['done', 'checkpointed'].includes(a.state)).length : 0
          const total = mission?.assignments.length ?? 0
          return {
            cardId: card.id,
            title: card.title,
            lane: card.status,
            missionId: mission?.id ?? null,
            missionState: mission?.state ?? null,
            derivedLane: mission ? laneFromMission(mission) : null,
            currentAssignee: mission?.assignments.find((a) => a.state === 'dispatched')?.workerId ?? null,
            progress: total > 0 ? Math.round((done / total) * 100) : 0,
          }
        })
        return json({ tasks })
      },

      POST: async ({ request }) => {
        if (!isAuthenticated(request)) return json({ error: 'Unauthorized' }, { status: 401 })
        let body: { title?: string; spec?: string; pipelineId?: string; acceptanceCriteria?: Array<string>; projectId?: string }
        try {
          body = await request.json()
        } catch {
          return json({ error: 'Invalid JSON body' }, { status: 400 })
        }
        if (!body.title?.trim()) return json({ error: 'Missing title' }, { status: 400 })
        if (!body.pipelineId) return json({ error: 'Missing pipelineId' }, { status: 400 })
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
          return json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 })
        }
      },
    },
  },
})
