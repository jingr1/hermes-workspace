/**
 * Unified agent status derivation.
 *
 * Both AgentList and Operations should use the same rules so an agent never
 * looks "green" in one place and "gray" in another. Status reflects *activity*
 * first, then connectivity, then configuration health.
 *
 * Semantics:
 *   active     — currently doing work (recent runtime output, session activity,
 *                or group-chat message within the activity window)
 *   idle       — online/available but no recent activity
 *   offline    — not reachable / no runtime / no profile / gateway down
 *   blocked    — needs human intervention (needsHuman)
 *   error      — runtime/session reported an error state
 *   needsSetup — profile exists but has no model configured
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { existsSync } from 'node:fs'
import { getHermesRoot, getProfilesDir } from '../server/claude-paths'
import { getCollabDbPath } from '../server/collab-db'
import { openSqliteDatabase } from '../server/sqlite-helper'
import type { AgentStatus } from './agent-types'

export type UnifiedAgentStatus =
  | 'active'
  | 'idle'
  | 'offline'
  | 'blocked'
  | 'error'
  | 'needsSetup'

export type GroupChatActivity = {
  lastMessageAt: number
  online: boolean
}

export function loadGroupChatActivity(): Map<string, GroupChatActivity> {
  const dbPath = getCollabDbPath()
  if (!existsSync(dbPath)) return new Map()
  const db = openSqliteDatabase(dbPath, true)
  try {
    const onlineRows = db
      .prepare(
        `SELECT participant_id, MAX(online) as online
         FROM room_participants
         WHERE removed_at = 0
         GROUP BY participant_id`,
      )
      .all() as Array<{ participant_id: string; online: number }>

    const messageRows = db
      .prepare(
        `SELECT sender_participant_id as participant_id, MAX(created_at) as last_message_at
         FROM room_messages
         GROUP BY sender_participant_id`,
      )
      .all() as Array<{ participant_id: string; last_message_at: number }>

    const activity = new Map<string, GroupChatActivity>()
    for (const row of onlineRows) {
      activity.set(row.participant_id, {
        online: Boolean(row.online),
        lastMessageAt: 0,
      })
    }
    for (const row of messageRows) {
      const existing = activity.get(row.participant_id)
      if (existing) {
        existing.lastMessageAt = Number(row.last_message_at)
      } else {
        activity.set(row.participant_id, {
          online: false,
          lastMessageAt: Number(row.last_message_at),
        })
      }
    }
    return activity
  } finally {
    db.close()
  }
}

/** Milliseconds without output before an executing/running state is considered stale. */
export const ACTIVITY_STALE_MS = 10 * 60 * 1000

export type AgentActivityInput = {
  runtimeState?: string | null
  runtimeLastOutputAt?: number | null
  runtimeNeedsHuman?: boolean
  runtimeBlockedReason?: string | null
  latestSession?: { status: string; updatedAt?: number | null } | null
  crewOnline?: boolean
  groupChatLastMessageAt?: number | null
  groupChatOnline?: boolean
  /**
   * Explicit gateway/runtime reachability. When `false`, sticky signals
   * (group-chat online bit, stale runtime.json) must not paint the agent idle.
   * When omitted/`undefined`, those soft signals still apply (legacy callers).
   */
  probeAvailable?: boolean
  hasModel?: boolean
}

function normalizeState(state?: string | null): string {
  return (state ?? '').toLowerCase().trim()
}

function extractModelFromConfigYaml(text: string): string | undefined {
  // Hermes config.yaml stores model as a nested object:
  //   model:
  //     default: <model-id>
  //     provider: <provider>
  // Some profiles also use the flat string form:
  //   model: provider/model-id
  const flat = /^model:\s*(\S.*)$/m.exec(text)
  if (flat) {
    const value = flat[1].trim()
    if (value && !value.startsWith('default:')) return value
  }
  const defaultMatch = /^model:[\s\S]*?^\s+default:\s*(.*)$/m.exec(text)
  if (defaultMatch) {
    const value = defaultMatch[1].trim()
    if (value) return value
  }
  return undefined
}

export function deriveUnifiedStatus(
  input: AgentActivityInput,
  nowMs: number = Date.now(),
): UnifiedAgentStatus {
  const state = normalizeState(input.runtimeState)

  // Configuration health wins everything: an unconfigured agent is unusable.
  if (input.hasModel === false) return 'needsSetup'

  // Explicit human gate / blocked.
  if (input.runtimeNeedsHuman) return 'blocked'
  if (
    state === 'blocked' ||
    state === 'needs_human' ||
    state === 'needs_human_approval'
  ) {
    return 'blocked'
  }

  // Error states from runtime or session.
  if (
    state === 'error' ||
    state === 'failed' ||
    state === 'cancelled' ||
    state === 'canceled' ||
    state === 'killed'
  ) {
    return 'error'
  }

  const runtimeLastOutput = input.runtimeLastOutputAt ?? 0
  const sessionUpdated = input.latestSession?.updatedAt ?? 0
  const chatUpdated = input.groupChatLastMessageAt ?? 0
  const lastActivity = Math.max(runtimeLastOutput, sessionUpdated, chatUpdated)
  const recentlyActive =
    lastActivity > 0 && nowMs - lastActivity < ACTIVITY_STALE_MS

  const busyStates = new Set([
    'executing',
    'thinking',
    'writing',
    'reviewing',
    'syncing',
    'running',
    'busy',
  ])

  if (busyStates.has(state) || recentlyActive) {
    // A busy state only counts as active when we have seen output recently.
    // Stale runtime.json entries (e.g. a zombie 'executing' from days ago)
    // should not show green forever; they fall through to idle/offline below.
    if (recentlyActive) return 'active'
  }

  // Online signals: recent runtime activity, crew heartbeat, group-chat
  // membership, or a successful probe. Stale runtimeState alone is NOT enough
  // — otherwise a months-old runtime.json paints the agent idle forever.
  const onlineNow =
    recentlyActive ||
    Boolean(input.crewOnline) ||
    Boolean(input.groupChatOnline) ||
    input.probeAvailable === true

  if (onlineNow) return 'idle'
  return 'offline'
}

export function deriveUnifiedStatusForAgent(
  agentId: string,
  snapshot:
    | { state?: string | null; updatedAt?: number | null; needsHuman?: boolean }
    | null
    | undefined,
  probeAvailable: boolean,
  groupChatMap: Map<string, GroupChatActivity>,
  profileName?: string,
): UnifiedAgentStatus {
  const hasModel = profileHasModel(profileName ?? agentId)
  const groupChat = groupChatMap.get(agentId)
  return deriveUnifiedStatus(
    {
      runtimeState: snapshot?.state,
      runtimeLastOutputAt: snapshot?.updatedAt,
      runtimeNeedsHuman: snapshot?.needsHuman,
      probeAvailable,
      groupChatOnline: groupChat?.online,
      groupChatLastMessageAt: groupChat?.lastMessageAt,
      hasModel,
    },
    Date.now(),
  )
}

export function readProfileModel(profileName: string): string | undefined {
  const profileConfigPath = path.join(
    getProfilesDir(),
    profileName,
    'config.yaml',
  )

  // 1. Prefer profile-specific config when the profile directory exists.
  if (fs.existsSync(profileConfigPath)) {
    try {
      const text = fs.readFileSync(profileConfigPath, 'utf8')
      const model = extractModelFromConfigYaml(text)
      if (model) return model
    } catch {
      // fall through to global fallback
    }
  }

  // 2. The implicit 'default' profile (and any profile without its own directory)
  //    inherits from the global ~/.hermes/config.yaml model.default.
  const globalConfigPath = path.join(getHermesRoot(), 'config.yaml')
  if (fs.existsSync(globalConfigPath)) {
    try {
      const text = fs.readFileSync(globalConfigPath, 'utf8')
      return extractModelFromConfigYaml(text)
    } catch {
      return undefined
    }
  }

  return undefined
}

export function profileHasModel(profileName?: string): boolean {
  if (!profileName) return false
  const model = readProfileModel(profileName)
  return Boolean(model && model.length > 0)
}

/** Map the unified status to a concrete AgentStatus for code that still uses the older union. */
export function toAgentStatus(status: UnifiedAgentStatus): AgentStatus {
  switch (status) {
    case 'active':
      return 'busy'
    case 'idle':
      return 'idle'
    case 'offline':
      return 'offline'
    case 'blocked':
      return 'blocked'
    case 'error':
      return 'blocked'
    case 'needsSetup':
      return 'offline'
  }
}

/** Return a human-readable label for the unified status. */
export function statusLabel(status: UnifiedAgentStatus): string {
  switch (status) {
    case 'active':
      return 'Active'
    case 'idle':
      return 'Idle'
    case 'offline':
      return 'Offline'
    case 'blocked':
      return 'Blocked'
    case 'error':
      return 'Error'
    case 'needsSetup':
      return 'Needs setup'
  }
}
