import * as fs from 'node:fs'
import * as path from 'node:path'
import { getProfilesDir } from './claude-paths'
import { loadAgentsRegistry } from './agent-runtime/agents-config'
import { readSwarmRuntimeFile, type SwarmRuntime } from './swarm-foundation'
import { publishChatEvent, subscribeToChatEvents } from './chat-event-bus'
import { dispatchNudge, type NudgeReason } from './nudge-service'
import { getRoomsByMissionId } from './group-chat/room-store'

export type AgentStatusRuntime =
  | 'hermes'
  | 'claude-code'
  | 'codex'
  | 'deepseek-harness'

export type AgentStatus = {
  agentId: string
  displayName: string
  runtime: AgentStatusRuntime
  execution: 'local' | 'ssh'
  state: string
  currentTask: string | null
  taskId: string | null
  missionId: string | null
  needsHuman: boolean
  checkpointStatus: string
  lastOutputAt: number | null
  startedAt: number | null
  capabilities: string[]
  online: boolean
  profile?: string
}

type StatusSnapshot = {
  byId: Map<string, AgentStatus>
  version: number
}

const WATCHER_KEY = '__agent_status_watcher__' as const

interface WatcherState {
  started: boolean
  stopped: boolean
  watchers: Map<string, fs.FSWatcher>
  statuses: StatusSnapshot
  unsubscribeEvents: (() => void) | null
  publishTimer: ReturnType<typeof setTimeout> | null
  pendingAgents: Set<string>
  debounceTimers: Map<string, ReturnType<typeof setTimeout>>
  nudgeTimer: ReturnType<typeof setInterval> | null
}

function getWatcherState(): WatcherState {
  const key = WATCHER_KEY as keyof typeof globalThis
  if (!(globalThis as any)[key]) {
    ;(globalThis as any)[key] = {
      started: false,
      stopped: false,
      watchers: new Map(),
      statuses: { byId: new Map(), version: 0 },
      unsubscribeEvents: null,
      publishTimer: null,
      pendingAgents: new Set(),
      debounceTimers: new Map(),
      nudgeTimer: null,
    }
  }
  return (globalThis as any)[key]
}

function nowTs(): number {
  return Date.now()
}

function isOnline(runtime: SwarmRuntime): boolean {
  const lastOut = runtime.lastOutputAt ?? runtime.startedAt
  if (!lastOut) return true
  // If no output for > 5 minutes, consider stale/offline unless currently executing.
  if (runtime.state === 'executing' || runtime.state === 'thinking') return true
  return nowTs() - lastOut < 5 * 60 * 1000
}

function runtimeToStatus(
  agentId: string,
  displayName: string,
  runtime: SwarmRuntime,
  capabilities: string[],
  execution: 'local' | 'ssh',
  profile?: string,
): AgentStatus {
  return {
    agentId,
    displayName,
    runtime: runtime.workerId
      ? (runtime.workerId as AgentStatusRuntime)
      : 'hermes',
    execution,
    state: runtime.state,
    currentTask: runtime.currentTask,
    taskId: runtime.tasks?.[0]?.id ?? null,
    missionId: runtime.missionId ?? null,
    needsHuman: runtime.needsHuman,
    checkpointStatus: runtime.checkpointStatus,
    lastOutputAt: runtime.lastOutputAt,
    startedAt: runtime.startedAt,
    capabilities,
    online: isOnline(runtime),
    profile,
  }
}

function buildFallbackStatus(
  agentId: string,
  displayName: string,
  runtime: AgentStatusRuntime,
  execution: 'local' | 'ssh',
  capabilities: string[],
  profile?: string,
): AgentStatus {
  return {
    agentId,
    displayName,
    runtime,
    execution,
    state: 'offline',
    currentTask: null,
    taskId: null,
    missionId: null,
    needsHuman: false,
    checkpointStatus: 'none',
    lastOutputAt: null,
    startedAt: null,
    capabilities,
    online: false,
    profile,
  }
}

function readAgentRuntime(profileId: string): SwarmRuntime | null {
  const profilePath = path.join(getProfilesDir(), profileId)
  if (!fs.existsSync(profilePath)) return null
  try {
    const { runtime } = readSwarmRuntimeFile(profilePath, profileId)
    return runtime
  } catch {
    return null
  }
}

function loadRegistry(): ReturnType<typeof loadAgentsRegistry> {
  try {
    return loadAgentsRegistry()
  } catch {
    return { version: 1, agents: [], byId: new Map(), orphanProfiles: [] }
  }
}

function setStatus(state: WatcherState, status: AgentStatus): void {
  const existing = state.statuses.byId.get(status.agentId)
  state.statuses.byId.set(status.agentId, status)
  state.statuses.version += 1

  // Publish only when something meaningful changed.
  if (!existing || statusChanged(existing, status)) {
    state.pendingAgents.add(status.agentId)
    schedulePublish(state)
  }
}

function statusChanged(a: AgentStatus, b: AgentStatus): boolean {
  return (
    a.state !== b.state ||
    a.online !== b.online ||
    a.needsHuman !== b.needsHuman ||
    a.currentTask !== b.currentTask ||
    a.taskId !== b.taskId ||
    a.missionId !== b.missionId ||
    a.checkpointStatus !== b.checkpointStatus
  )
}

function schedulePublish(state: WatcherState): void {
  if (state.publishTimer) return
  state.publishTimer = setTimeout(() => {
    state.publishTimer = null
    const pending = Array.from(state.pendingAgents)
    state.pendingAgents.clear()
    if (pending.length === 0) return
    publishChatEvent('agent_status', {
      scope: 'global',
      agents: pending.map((id) => statusToJson(state.statuses.byId.get(id))),
    })
  }, 300)
}

function statusToJson(status: AgentStatus | undefined): Record<string, unknown> {
  if (!status) return {}
  return { ...status }
}

function refreshAgent(state: WatcherState, agentId: string): void {
  const registry = loadRegistry()
  const agent = registry.byId.get(agentId)
  if (!agent) {
    state.statuses.byId.delete(agentId)
    return
  }

  if (agent.runtime === 'hermes' && agent.profile) {
    const runtime = readAgentRuntime(agent.profile)
    if (runtime) {
      setStatus(
        state,
        runtimeToStatus(
          agent.id,
          agent.displayName || agent.id,
          runtime,
          agent.capabilities,
          agent.execution,
          agent.profile,
        ),
      )
    } else {
      setStatus(
        state,
        buildFallbackStatus(
          agent.id,
          agent.displayName || agent.id,
          agent.runtime,
          agent.execution,
          agent.capabilities,
          agent.profile,
        ),
      )
    }
  } else {
    // CLI adapters: rely on events; fallback to offline.
    const existing = state.statuses.byId.get(agent.id)
    if (!existing) {
      setStatus(
        state,
        buildFallbackStatus(
          agent.id,
          agent.displayName || agent.id,
          agent.runtime,
          agent.execution,
          agent.capabilities,
        ),
      )
    }
  }
}

function watchAgentProfile(
  state: WatcherState,
  agentId: string,
  profileId: string,
): void {
  if (state.watchers.has(agentId)) return
  const profilePath = path.join(getProfilesDir(), profileId)
  const runtimePath = path.join(profilePath, 'runtime.json')

  try {
    const watcher = fs.watch(
      profilePath,
      { recursive: false },
      (_eventType, filename) => {
        if (filename !== 'runtime.json') return
        const timer = state.debounceTimers.get(agentId)
        if (timer) clearTimeout(timer)
        state.debounceTimers.set(
          agentId,
          setTimeout(() => {
            state.debounceTimers.delete(agentId)
            refreshAgent(state, agentId)
          }, 300),
        )
      },
    )
    state.watchers.set(agentId, watcher)
  } catch {
    // Profile directory may not exist yet; best-effort.
    if (fs.existsSync(runtimePath)) {
      refreshAgent(state, agentId)
    }
  }
}

function refreshAllAgents(state: WatcherState): void {
  const registry = loadRegistry()
  for (const agent of registry.agents) {
    if (agent.runtime === 'hermes' && agent.profile) {
      watchAgentProfile(state, agent.id, agent.profile)
    }
    refreshAgent(state, agent.id)
  }
}

function handleAdapterEvent(
  state: WatcherState,
  event: string,
  data: Record<string, unknown>,
): void {
  const agentId =
    typeof data.agentId === 'string'
      ? data.agentId
      : typeof data.runId === 'string'
        ? data.runId.split(':')[0]
        : undefined
  if (!agentId) return

  const registry = loadRegistry()
  const agent = registry.byId.get(agentId)
  if (!agent) return

  // CLI adapters publish memory-state updates without runtime.json.
  const stateValue =
    typeof data.state === 'string' ? data.state : (state.statuses.byId.get(agentId)?.state ?? 'idle')
  const currentTask =
    typeof data.currentTask === 'string'
      ? data.currentTask
      : (state.statuses.byId.get(agentId)?.currentTask ?? null)
  const taskId =
    typeof data.taskId === 'string'
      ? data.taskId
      : (state.statuses.byId.get(agentId)?.taskId ?? null)
  const missionId =
    typeof data.missionId === 'string'
      ? data.missionId
      : (state.statuses.byId.get(agentId)?.missionId ?? null)
  const needsHuman =
    typeof data.needsHuman === 'boolean'
      ? data.needsHuman
      : (state.statuses.byId.get(agentId)?.needsHuman ?? false)
  const checkpointStatus =
    typeof data.checkpointStatus === 'string'
      ? data.checkpointStatus
      : (state.statuses.byId.get(agentId)?.checkpointStatus ?? 'none')
  const lastOutputAt =
    typeof data.lastOutputAt === 'number'
      ? data.lastOutputAt
      : nowTs()

  const next: AgentStatus = {
    agentId,
    displayName: agent.displayName || agent.id,
    runtime: agent.runtime,
    execution: agent.execution,
    state: stateValue,
    currentTask,
    taskId,
    missionId,
    needsHuman,
    checkpointStatus,
    lastOutputAt,
    startedAt: state.statuses.byId.get(agentId)?.startedAt ?? null,
    capabilities: agent.capabilities,
    online: stateValue !== 'offline',
  }
  setStatus(state, next)
}

function checkNudges(state: WatcherState): void {
  const now = Date.now()
  const PROGRESS_STALL_MS = 5 * 60 * 1000

  for (const status of state.statuses.byId.values()) {
    if (!status.online) continue
    if (status.state !== 'executing' && status.state !== 'thinking') continue
    if (!status.lastOutputAt) continue

    const stalled = now - status.lastOutputAt > PROGRESS_STALL_MS
    if (!stalled) continue

    // Find a room associated with the agent's current mission/task.
    let roomId: string | undefined
    if (status.missionId) {
      const rooms = getRoomsByMissionId(status.missionId)
      roomId = rooms[0]?.id
    }

    const reason: NudgeReason = 'progress_stalled'
    dispatchNudge({
      agentId: status.agentId,
      assignmentId: status.taskId ?? undefined,
      roomId,
      taskId: status.missionId ?? undefined,
      reason,
      context: {
        lastStdoutAt: status.lastOutputAt,
      },
      message: `Agent ${status.agentId} appears stalled (no output for ${Math.round((now - status.lastOutputAt) / 1000 / 60)}m)`,
    })
  }
}

/**
 * Start watching profile runtime.json files and listening to adapter events.
 * Safe to call multiple times; subsequent calls are no-ops.
 */
export function startAgentStatusWatcher(): void {
  const state = getWatcherState()
  if (state.started) return
  state.started = true
  state.stopped = false

  refreshAllAgents(state)

  state.nudgeTimer = setInterval(() => {
    try {
      checkNudges(state)
    } catch (error) {
      console.error('[agent-status-watcher] nudge check failed', error)
    }
  }, 60_000)

  state.unsubscribeEvents = subscribeToChatEvents((evt) => {
    if (evt.event === 'agent_status' && evt.data.scope === 'global') {
      // Already from us; ignore to avoid loops.
      if (Array.isArray(evt.data.agents)) return
    }
    if (
      evt.event === 'agent_status' ||
      evt.event === 'agent_dispatched' ||
      evt.event === 'agent_stream'
    ) {
      handleAdapterEvent(state, evt.event, evt.data)
    }
  })
}

/**
 * Stop all watchers and event subscriptions.
 */
export function stopAgentStatusWatcher(): void {
  const state = getWatcherState()
  state.stopped = true
  state.started = false

  Array.from(state.watchers.entries()).forEach(([id, watcher]) => {
    watcher.close()
    state.watchers.delete(id)
  })
  Array.from(state.debounceTimers.entries()).forEach(([id, timer]) => {
    clearTimeout(timer)
    state.debounceTimers.delete(id)
  })
  if (state.publishTimer) {
    clearTimeout(state.publishTimer)
    state.publishTimer = null
  }
  if (state.nudgeTimer) {
    clearInterval(state.nudgeTimer)
    state.nudgeTimer = null
  }
  if (state.unsubscribeEvents) {
    state.unsubscribeEvents()
    state.unsubscribeEvents = null
  }
}

/**
 * Force a refresh of all agent statuses from disk/events.
 * Useful for tests and for explicit "refresh" API calls.
 */
export function refreshAgentStatuses(): void {
  const state = getWatcherState()
  refreshAllAgents(state)
}

/**
 * Return the current snapshot of all known agent statuses.
 */
export function getAgentStatuses(): {
  agents: AgentStatus[]
  version: number
} {
  const state = getWatcherState()
  if (!state.started) {
    startAgentStatusWatcher()
  }
  return {
    agents: Array.from(state.statuses.byId.values()),
    version: state.statuses.version,
  }
}
