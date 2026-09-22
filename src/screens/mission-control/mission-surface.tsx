'use client'

/**
 * MissionSurface — IssueSurface-inspired shell (board/list/table/swimlane).
 * List entity is always Mission; Tasks only in detail.
 */
import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { KanbanLane, MissionSummary } from '@/lib/mission-control-api'
import { cn } from '@/lib/utils'
import { fetchMissions } from '@/lib/mission-control-api'
import { CreateMissionButton } from './components/create-task-button'
import { toast } from '@/components/ui/toast'

export type MissionViewMode = 'board' | 'list' | 'table' | 'swimlane'

const LANES: Array<{ id: KanbanLane; label: string }> = [
  { id: 'backlog', label: 'Backlog' },
  { id: 'todo', label: 'Ready' },
  { id: 'running', label: 'Running' },
  { id: 'review', label: 'Review' },
  { id: 'blocked', label: 'Blocked' },
  { id: 'done', label: 'Done' },
]

const LANE_COLORS: Record<string, string> = {
  backlog: '#6b7280',
  todo: '#3b82f6',
  ready: '#3b82f6',
  running: '#f97316',
  review: '#a855f7',
  blocked: '#ef4444',
  done: '#22c55e',
}

const MISSIONS_QUERY_KEY = ['mission-control', 'missions'] as const
const PREFS_KEY = 'agorax-mission-surface-prefs-v1'

type SurfacePrefs = {
  viewMode: MissionViewMode
  laneFilter: KanbanLane | 'all'
  swimlaneBy: 'assignee' | 'project'
}

function loadPrefs(): Partial<SurfacePrefs> {
  try {
    const raw = localStorage.getItem(PREFS_KEY)
    if (!raw) return {}
    return JSON.parse(raw) as Partial<SurfacePrefs>
  } catch {
    return {}
  }
}

async function patchMissionLane(
  cardId: string,
  status: KanbanLane,
): Promise<void> {
  const res = await fetch('/api/swarm-kanban', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: cardId, status }),
  })
  const data = (await res.json().catch(() => ({}))) as {
    ok?: boolean
    error?: string
  }
  if (!res.ok || data.ok === false) {
    throw new Error(data.error || `Failed to move mission: ${res.status}`)
  }
}

function resolveLane(m: MissionSummary): KanbanLane {
  const lane =
    (m.derivedLane ?? m.lane) === 'ready' ? 'todo' : (m.derivedLane ?? m.lane)
  return lane
}

function assigneeLabel(m: MissionSummary): string {
  if (m.assignee?.type === 'chat_group') return `group:${m.assignee.id.slice(0, 8)}`
  if (m.assignee?.type === 'agent') return m.assignee.id
  if (m.pipelineId) return `pipeline:${m.pipelineId}`
  return m.currentAssignee ?? '—'
}

function isActiveWorker(m: MissionSummary): boolean {
  const lane = resolveLane(m)
  return lane === 'running' || lane === 'review' || lane === 'todo'
}

function selectId(m: MissionSummary): string {
  return m.missionId ?? m.cardId
}

type MissionSurfaceProps = {
  onSelectMission: (cardId: string | null) => void
}

export function MissionSurface({ onSelectMission }: MissionSurfaceProps) {
  const prefs = useMemo(() => loadPrefs(), [])
  const [viewMode, setViewMode] = useState<MissionViewMode>(
    prefs.viewMode ?? 'board',
  )
  const [filter, setFilter] = useState('')
  const [laneFilter, setLaneFilter] = useState<KanbanLane | 'all'>(
    prefs.laneFilter ?? 'all',
  )
  const [agentsWorkingOnly, setAgentsWorkingOnly] = useState(false)
  const [swimlaneBy, setSwimlaneBy] = useState<'assignee' | 'project'>(
    prefs.swimlaneBy ?? 'assignee',
  )
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [dragCardId, setDragCardId] = useState<string | null>(null)
  const queryClient = useQueryClient()

  useEffect(() => {
    const next: SurfacePrefs = { viewMode, laneFilter, swimlaneBy }
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(next))
    } catch {
      /* ignore quota */
    }
  }, [viewMode, laneFilter, swimlaneBy])

  const missionsQuery = useQuery({
    queryKey: MISSIONS_QUERY_KEY,
    queryFn: fetchMissions,
    refetchInterval: 30_000,
  })

  const missions = missionsQuery.data?.missions ?? []

  const moveMutation = useMutation({
    mutationFn: async (input: { cardId: string; status: KanbanLane }) =>
      patchMissionLane(input.cardId, input.status),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: MISSIONS_QUERY_KEY })
    },
    onError: (error: Error) => {
      toast(error.message || 'Failed to move mission', { type: 'error' })
    },
  })

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase()
    return missions.filter((m) => {
      if (laneFilter !== 'all' && resolveLane(m) !== laneFilter) return false
      if (agentsWorkingOnly && !isActiveWorker(m)) return false
      if (!q) return true
      return (
        m.title.toLowerCase().includes(q) ||
        (m.pipelineId ?? '').includes(q) ||
        assigneeLabel(m).toLowerCase().includes(q)
      )
    })
  }, [missions, filter, laneFilter, agentsWorkingOnly])

  const workingCount = missions.filter(isActiveWorker).length

  const byLane = useMemo(() => {
    const map = new Map<KanbanLane, MissionSummary[]>()
    for (const lane of LANES) map.set(lane.id, [])
    for (const m of filtered) {
      const lane = resolveLane(m)
      const list = map.get(lane) ?? []
      list.push(m)
      map.set(lane, list)
    }
    return map
  }, [filtered])

  const swimLanes = useMemo(() => {
    const map = new Map<string, MissionSummary[]>()
    for (const m of filtered) {
      const key =
        swimlaneBy === 'project'
          ? m.projectId ?? 'No project'
          : assigneeLabel(m)
      const list = map.get(key) ?? []
      list.push(m)
      map.set(key, list)
    }
    return [...map.entries()]
  }, [filtered, swimlaneBy])

  function toggleSelect(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  async function batchMove(status: KanbanLane) {
    const targets = missions.filter((m) => selectedIds.has(m.cardId))
    for (const m of targets) {
      await moveMutation.mutateAsync({ cardId: m.cardId, status })
    }
    setSelectedIds(new Set())
    toast(`Moved ${targets.length} mission(s)`, { type: 'success' })
  }

  function onDropLane(laneId: KanbanLane) {
    if (!dragCardId) return
    void moveMutation.mutateAsync({ cardId: dragCardId, status: laneId })
    setDragCardId(null)
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[var(--theme-border)] bg-[var(--theme-card)] px-4 py-2">
        <div className="flex gap-0.5 rounded-lg border border-[var(--theme-border)] p-0.5">
          {(['board', 'list', 'table', 'swimlane'] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              onClick={() => setViewMode(mode)}
              className={cn(
                'rounded-md px-2.5 py-1 text-[11px] font-medium capitalize',
                viewMode === mode
                  ? 'bg-[var(--theme-accent)] text-white'
                  : 'text-[var(--theme-muted)] hover:bg-[var(--theme-hover)]',
              )}
            >
              {mode}
            </button>
          ))}
        </div>
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter missions…"
          className="min-w-[10rem] flex-1 rounded-md border border-[var(--theme-border)] bg-[var(--theme-bg)] px-2 py-1 text-xs"
        />
        <select
          value={laneFilter}
          onChange={(e) =>
            setLaneFilter(e.target.value as KanbanLane | 'all')
          }
          className="rounded-md border border-[var(--theme-border)] bg-[var(--theme-bg)] px-2 py-1 text-xs"
        >
          <option value="all">All lanes</option>
          {LANES.map((l) => (
            <option key={l.id} value={l.id}>
              {l.label}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={() => setAgentsWorkingOnly((v) => !v)}
          className={cn(
            'rounded-md border px-2 py-1 text-[11px]',
            agentsWorkingOnly
              ? 'border-[var(--theme-accent)] bg-[var(--theme-accent)]/10 text-[var(--theme-accent)]'
              : 'border-[var(--theme-border)] text-[var(--theme-muted)]',
          )}
        >
          Agents working ({workingCount})
        </button>
        {viewMode === 'swimlane' ? (
          <select
            value={swimlaneBy}
            onChange={(e) =>
              setSwimlaneBy(e.target.value as 'assignee' | 'project')
            }
            className="rounded-md border border-[var(--theme-border)] bg-[var(--theme-bg)] px-2 py-1 text-xs"
          >
            <option value="assignee">Swim by assignee</option>
            <option value="project">Swim by project</option>
          </select>
        ) : null}
        {selectedIds.size > 0 ? (
          <div className="flex items-center gap-2">
            <span className="text-[11px] text-[var(--theme-muted)]">
              {selectedIds.size} selected
            </span>
            <select
              defaultValue=""
              onChange={(e) => {
                const value = e.target.value as KanbanLane | ''
                if (!value) return
                void batchMove(value)
                e.target.value = ''
              }}
              className="rounded-md border border-[var(--theme-border)] bg-[var(--theme-bg)] px-2 py-1 text-xs"
            >
              <option value="" disabled>
                Batch move…
              </option>
              {LANES.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.label}
                </option>
              ))}
            </select>
          </div>
        ) : null}
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-4">
        {missionsQuery.isLoading ? (
          <p className="text-xs text-[var(--theme-muted)]">Loading missions…</p>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center gap-3 py-16 text-center">
            <p className="text-sm text-[var(--theme-muted)]">No missions yet.</p>
            <CreateMissionButton variant="inline" />
          </div>
        ) : viewMode === 'board' ? (
          <div className="flex gap-3 overflow-x-auto pb-2">
            {LANES.map((lane) => (
              <div
                key={lane.id}
                className="flex w-64 shrink-0 flex-col rounded-lg border border-[var(--theme-border)] bg-[var(--theme-card)]"
                onDragOver={(e) => e.preventDefault()}
                onDrop={() => onDropLane(lane.id)}
              >
                <div className="flex items-center gap-2 border-b border-[var(--theme-border)] px-3 py-2">
                  <span
                    className="h-2 w-2 rounded-full"
                    style={{ background: LANE_COLORS[lane.id] }}
                  />
                  <span className="text-xs font-semibold">{lane.label}</span>
                  <span className="ml-auto text-[10px] text-[var(--theme-muted)]">
                    {byLane.get(lane.id)?.length ?? 0}
                  </span>
                </div>
                <div className="flex flex-col gap-2 p-2">
                  {(byLane.get(lane.id) ?? []).map((m) => (
                    <MissionCard
                      key={m.cardId}
                      mission={m}
                      draggable
                      onDragStart={() => setDragCardId(m.cardId)}
                      onOpen={() => onSelectMission(selectId(m))}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        ) : viewMode === 'list' ? (
          <div className="space-y-4">
            {LANES.map((lane) => {
              const rows = byLane.get(lane.id) ?? []
              if (rows.length === 0) return null
              return (
                <section key={lane.id}>
                  <h3 className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-[var(--theme-muted)]">
                    <span
                      className="h-2 w-2 rounded-full"
                      style={{ background: LANE_COLORS[lane.id] }}
                    />
                    {lane.label}
                  </h3>
                  <div className="divide-y divide-[var(--theme-border)] rounded-lg border border-[var(--theme-border)]">
                    {rows.map((m) => (
                      <div
                        key={m.cardId}
                        className="flex items-center gap-2 px-3 py-2 hover:bg-[var(--theme-hover)]"
                      >
                        <input
                          type="checkbox"
                          checked={selectedIds.has(m.cardId)}
                          onChange={() => toggleSelect(m.cardId)}
                        />
                        <button
                          type="button"
                          className="min-w-0 flex-1 text-left text-sm"
                          onClick={() => onSelectMission(selectId(m))}
                        >
                          {m.title}
                        </button>
                        <span className="text-[10px] text-[var(--theme-muted)]">
                          {assigneeLabel(m)}
                        </span>
                        <ProgressTiny value={m.progress} />
                      </div>
                    ))}
                  </div>
                </section>
              )
            })}
          </div>
        ) : viewMode === 'table' ? (
          <div className="overflow-x-auto rounded-lg border border-[var(--theme-border)]">
            <table className="w-full min-w-[640px] text-left text-xs">
              <thead className="border-b border-[var(--theme-border)] bg-[var(--theme-card)] text-[var(--theme-muted)]">
                <tr>
                  <th className="px-3 py-2 font-medium">
                    <span className="sr-only">Select</span>
                  </th>
                  <th className="px-3 py-2 font-medium">Title</th>
                  <th className="px-3 py-2 font-medium">Lane</th>
                  <th className="px-3 py-2 font-medium">Assignee</th>
                  <th className="px-3 py-2 font-medium">Pipeline</th>
                  <th className="px-3 py-2 font-medium">Tasks</th>
                  <th className="px-3 py-2 font-medium">Progress</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((m) => (
                  <tr
                    key={m.cardId}
                    className="border-b border-[var(--theme-border)] hover:bg-[var(--theme-hover)]"
                  >
                    <td className="px-3 py-2">
                      <input
                        type="checkbox"
                        checked={selectedIds.has(m.cardId)}
                        onChange={() => toggleSelect(m.cardId)}
                      />
                    </td>
                    <td
                      className="cursor-pointer px-3 py-2 font-medium"
                      onClick={() => onSelectMission(selectId(m))}
                    >
                      {m.title}
                    </td>
                    <td className="px-3 py-2">{resolveLane(m)}</td>
                    <td className="px-3 py-2">{assigneeLabel(m)}</td>
                    <td className="px-3 py-2">{m.pipelineId ?? '—'}</td>
                    <td className="px-3 py-2">{m.taskCount}</td>
                    <td className="px-3 py-2">{m.progress}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="space-y-4">
            {swimLanes.map(([laneName, rows]) => (
              <section key={laneName}>
                <h3 className="mb-2 text-xs font-semibold text-[var(--theme-muted)]">
                  {laneName}
                </h3>
                <div className="flex gap-2 overflow-x-auto">
                  {LANES.map((lane) => (
                    <div
                      key={lane.id}
                      className="w-48 shrink-0 rounded-lg border border-[var(--theme-border)] bg-[var(--theme-card)] p-2"
                      onDragOver={(e) => e.preventDefault()}
                      onDrop={() => onDropLane(lane.id)}
                    >
                      <div className="mb-1 text-[10px] font-medium uppercase text-[var(--theme-muted)]">
                        {lane.label}
                      </div>
                      {rows
                        .filter((m) => resolveLane(m) === lane.id)
                        .map((m) => (
                          <MissionCard
                            key={m.cardId}
                            mission={m}
                            compact
                            draggable
                            onDragStart={() => setDragCardId(m.cardId)}
                            onOpen={() => onSelectMission(selectId(m))}
                          />
                        ))}
                    </div>
                  ))}
                </div>
              </section>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function ProgressTiny({ value }: { value: number }) {
  return (
    <span className="tabular-nums text-[10px] text-[var(--theme-muted)]">
      {value}%
    </span>
  )
}

function MissionCard({
  mission,
  onOpen,
  compact,
  draggable,
  onDragStart,
}: {
  mission: MissionSummary
  onOpen: () => void
  compact?: boolean
  draggable?: boolean
  onDragStart?: () => void
}) {
  return (
    <button
      type="button"
      draggable={draggable}
      onDragStart={onDragStart}
      onClick={onOpen}
      className={cn(
        'w-full rounded-md border border-[var(--theme-border)] bg-[var(--theme-bg)] p-2 text-left transition-colors hover:border-[var(--theme-accent)]',
        compact && 'mb-1',
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <span className="text-xs font-medium leading-snug">{mission.title}</span>
        {isActiveWorker(mission) ? (
          <span className="shrink-0 rounded bg-amber-500/15 px-1 text-[9px] font-medium text-amber-700">
            Working
          </span>
        ) : null}
      </div>
      <div className="mt-1 flex items-center justify-between gap-2 text-[10px] text-[var(--theme-muted)]">
        <span className="truncate">
          {mission.currentAssignee
            ? `${mission.currentAssignee}${mission.currentStage ? ` · ${mission.currentStage}` : ''}`
            : mission.currentStage
              ? mission.currentStage
              : assigneeLabel(mission)}
        </span>
        <span>
          {mission.taskCount} tasks · {mission.progress}%
        </span>
      </div>
    </button>
  )
}
