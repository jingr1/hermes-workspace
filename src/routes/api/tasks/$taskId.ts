import { existsSync } from 'node:fs'
import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../../server/auth-middleware'
import { listKanbanCards } from '../../../server/kanban-backend'
import {
  getSwarmMission,
  listSwarmMissions,
} from '../../../server/swarm-missions'
import { getCollabDbPath } from '../../../server/collab-db'
import { openSqliteDatabase } from '../../../server/sqlite-helper'

/**
 * GET /api/tasks/:taskId → card + pipeline stages (from mission) + runs + events
 */
export const Route = createFileRoute('/api/tasks/$taskId')({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        if (!isAuthenticated(request))
          return json({ error: 'Unauthorized' }, { status: 401 })
        const taskId = params.taskId
        const cards = await listKanbanCards()
        const card = cards.find((c) => c.id === taskId)
        if (!card)
          return json({ error: `Task not found: ${taskId}` }, { status: 404 })

        // The native kanban store does not persist missionId on the card, but
        // swarm missions record the bound card id in taskId. Try missionId first,
        // then fall back to taskId lookup so pipeline/timeline work for all
        // bound missions (including backfilled ones).
        let mission = card.missionId ? getSwarmMission(card.missionId) : null
        if (!mission) {
          const missions = listSwarmMissions(500)
          mission = missions.find((m) => m.taskId === taskId) ?? null
        }
        if (!mission) {
          return json({ task: card, pipeline: null, runs: [], events: [] })
        }

        // task_runs for this mission (collab.db may not exist in P2a tests).
        const dbPath = getCollabDbPath()
        let runs: Array<Record<string, unknown>> = []
        if (existsSync(dbPath)) {
          const db = openSqliteDatabase(dbPath, true)
          try {
            runs = db
              .prepare(
                'SELECT * FROM task_runs WHERE mission_id = ? ORDER BY started_at',
              )
              .all(mission.id)
          } finally {
            db.close()
          }
        }

        return json({
          task: {
            ...card,
            title: mission.title?.trim() ? mission.title.trim() : card.title,
          },
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
