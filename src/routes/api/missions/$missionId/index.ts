import { existsSync } from 'node:fs'
import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../../../server/auth-middleware'
import {
  listKanbanCards,
  updateKanbanCard,
} from '../../../../server/kanban-backend'
import {
  getSwarmMission,
  listSwarmMissions,
  patchMissionFields,
  readyQueuedAssignments,
  type MissionAssignee,
} from '../../../../server/swarm-missions'
import { dispatchReadyAssignments } from '../../../../server/task-pipeline/dispatch-ready'
import {
  deleteMissionByRef,
} from '../../../../server/task-pipeline/task-service'
import { getCollabDbPath } from '../../../../server/collab-db'
import { openSqliteDatabase } from '../../../../server/sqlite-helper'
import {
  buildMissionSummary,
  serializeMissionTask,
} from '../../../../server/task-pipeline/mission-serialize'
import type { DispatchReadyResult } from '../../../../server/task-pipeline/dispatch-ready'
import { getProject } from '../../../../server/task-pipeline/projects'

async function resolveMission(id: string) {
  // Accept missionId or cardId (legacy taskId).
  let mission = getSwarmMission(id)
  if (mission) {
    const cards = await listKanbanCards()
    const card =
      cards.find((c) => c.missionId === mission!.id) ??
      (mission.taskId ? cards.find((c) => c.id === mission!.taskId) : null) ??
      null
    return { card, mission }
  }
  const cards = await listKanbanCards()
  const card = cards.find((c) => c.id === id)
  if (!card) return { card: null, mission: null }
  mission = card.missionId ? getSwarmMission(card.missionId) : null
  if (!mission) {
    const missions = listSwarmMissions(500)
    mission = missions.find((m) => m.taskId === id) ?? null
  }
  return { card, mission }
}

/**
 * GET    /api/missions/:missionId → mission detail + tasks
 * POST   /api/missions/:missionId → dispatch ready tasks
 * PATCH  /api/missions/:missionId → update configurable fields
 * DELETE /api/missions/:missionId → delete mission + card
 */
export const Route = createFileRoute('/api/missions/$missionId/')({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        if (!isAuthenticated(request))
          return json({ error: 'Unauthorized' }, { status: 401 })
        const { card, mission } = await resolveMission(params.missionId)
        if (!card && !mission) {
          return json(
            { error: `Mission not found: ${params.missionId}` },
            { status: 404 },
          )
        }
        if (!mission) {
          return json({
            mission: card
              ? buildMissionSummary({
                  cardId: card.id,
                  cardTitle: card.title,
                  cardStatus: card.status,
                  mission: null,
                })
              : null,
            tasks: [],
            pipeline: null,
            runs: [],
            events: [],
          })
        }

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

        const summary = buildMissionSummary({
          cardId: card?.id ?? mission.taskId ?? mission.id,
          cardTitle: card?.title ?? mission.title,
          cardStatus: card?.status ?? 'todo',
          mission,
        })

        return json({
          mission: summary,
          task: card
            ? {
                ...card,
                title: mission.title.trim() ? mission.title.trim() : card.title,
              }
            : null,
          tasks: mission.assignments.map(serializeMissionTask),
          pipeline: {
            id: mission.pipelineId ?? null,
            specVersion: mission.specVersion ?? 1,
            stages: mission.assignments.map((a) => ({
              assignmentId: a.id,
              stageKey: a.stageKey ?? null,
              agent: a.workerId,
              state: a.state,
              createdByWorkerId: a.createdByWorkerId ?? null,
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

      POST: async ({ request, params }) => {
        if (!isAuthenticated(request))
          return json({ error: 'Unauthorized' }, { status: 401 })
        const { mission } = await resolveMission(params.missionId)
        if (!mission) {
          return json(
            { error: `Mission not found: ${params.missionId}` },
            { status: 404 },
          )
        }
        const ready = readyQueuedAssignments(mission.id)
        if (ready.length === 0) {
          return json(
            {
              error: 'No ready assignments to dispatch',
              missionId: mission.id,
              states: mission.assignments.map(
                (a) => `${a.workerId}:${a.state}`,
              ),
            },
            { status: 400 },
          )
        }
        try {
          const result: DispatchReadyResult = await dispatchReadyAssignments(
            mission.id,
          )
          return json(result, { status: 200 })
        } catch (error) {
          return json(
            { error: error instanceof Error ? error.message : String(error) },
            { status: 500 },
          )
        }
      },

      PATCH: async ({ request, params }) => {
        if (!isAuthenticated(request))
          return json({ error: 'Unauthorized' }, { status: 401 })
        const { card, mission } = await resolveMission(params.missionId)
        if (!mission) {
          return json(
            { error: `Mission not found: ${params.missionId}` },
            { status: 404 },
          )
        }

        let body: {
          title?: string
          assignee?: MissionAssignee | null
          roomId?: string | null
          projectId?: string | null
          priority?: number | null
          labels?: Array<string>
        }
        try {
          body = await request.json()
        } catch {
          return json({ error: 'Invalid JSON body' }, { status: 400 })
        }

        if (body.projectId != null && body.projectId !== '') {
          if (!getProject(body.projectId)) {
            return json(
              { error: `Unknown project: ${body.projectId}` },
              { status: 400 },
            )
          }
        }

        if (
          body.assignee != null &&
          (!body.assignee.type || !body.assignee.id?.trim())
        ) {
          return json(
            { error: 'assignee requires type and id' },
            { status: 400 },
          )
        }

        if (
          body.priority !== undefined &&
          body.priority !== null &&
          (!Number.isFinite(body.priority) ||
            body.priority < 0 ||
            body.priority > 4)
        ) {
          return json(
            { error: 'priority must be 0–4 or null' },
            { status: 400 },
          )
        }

        const patched = patchMissionFields({
          missionId: mission.id,
          title: body.title,
          assignee: body.assignee,
          roomId: body.roomId,
          projectId: body.projectId,
          priority: body.priority,
          labels: body.labels,
        })
        if (!patched) {
          return json({ error: 'Failed to patch mission' }, { status: 500 })
        }

        const cardId = card?.id ?? patched.taskId
        if (cardId && body.title?.trim()) {
          try {
            await updateKanbanCard(cardId, { title: body.title.trim() })
          } catch (error) {
            console.warn(
              `[missions PATCH] card title sync failed for ${cardId}:`,
              error,
            )
          }
        }

        const cards = await listKanbanCards()
        const nextCard =
          cards.find((c) => c.missionId === patched.id) ??
          (patched.taskId
            ? cards.find((c) => c.id === patched.taskId)
            : null) ??
          card

        return json({
          ok: true,
          mission: buildMissionSummary({
            cardId: nextCard?.id ?? patched.taskId ?? patched.id,
            cardTitle: nextCard?.title ?? patched.title,
            cardStatus: nextCard?.status ?? 'todo',
            mission: patched,
          }),
        })
      },

      DELETE: async ({ request, params }) => {
        if (!isAuthenticated(request))
          return json({ error: 'Unauthorized' }, { status: 401 })
        try {
          const result = await deleteMissionByRef(params.missionId)
          return json({ ok: true, ...result })
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error)
          const notFound = message.startsWith('Mission not found:')
          return json(
            { error: message },
            { status: notFound ? 404 : 500 },
          )
        }
      },
    },
  },
})
