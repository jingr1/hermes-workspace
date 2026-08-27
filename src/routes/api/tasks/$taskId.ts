import { existsSync } from 'node:fs'
import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../../server/auth-middleware'
import { listKanbanCards } from '../../../server/kanban-backend'
import { getSwarmMission } from '../../../server/swarm-missions'
import { getCollabDbPath } from '../../../server/collab-db'
import { openSqliteDatabase } from '../../../server/sqlite-helper'

/**
 * GET /api/tasks/:taskId → card + pipeline stages (from mission) + runs + events
 */
export const Route = createFileRoute('/api/tasks/$taskId')({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        if (!isAuthenticated(request)) return json({ error: 'Unauthorized' }, { status: 401 })
        const taskId = params.taskId
        const cards = await listKanbanCards()
        const card = cards.find((c) => c.id === taskId)
        if (!card) return json({ error: `Task not found: ${taskId}` }, { status: 404 })

        const mission = card.missionId ? getSwarmMission(card.missionId) : null
        if (!mission) {
          return json({ task: card, pipeline: null, runs: [], events: [] })
        }

        // task_runs for this mission (collab.db may not exist in P2a tests).
        const dbPath = getCollabDbPath()
        let runs: Array<Record<string, unknown>> = []
        if (existsSync(dbPath)) {
          const db = openSqliteDatabase(dbPath, true)
          try {
            runs = db.prepare('SELECT * FROM task_runs WHERE mission_id = ? ORDER BY started_at').all(mission.id)
          } finally {
            db.close()
          }
        }

        return json({
          task: card,
          pipeline: {
            id: mission.pipelineId ?? null,
            specVersion: mission.specVersion ?? 1,
            stages: mission.assignments.map((a) => ({
              assignmentId: a.id,
              stageKey: a.stageKey ?? null,
              agent: a.workerId,
              state: a.state,
              stale:
                a.briefSpecVersion != null && mission.specVersion != null
                  ? a.briefSpecVersion !== mission.specVersion
                  : false,
              dependsOn: a.dependsOn,
              dispatchedAt: a.dispatchedAt,
              completedAt: a.completedAt,
            })),
          },
          runs,
          events: mission.events,
        })
      },
    },
  },
})
