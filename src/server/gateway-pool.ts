/**
 * Multi-gateway pool: one Hermes API server per profile, lazy start,
 * no restart on profile switch.
 */
import fs from 'node:fs'
import path from 'node:path'
import {
  getActiveProfileName,
  resolveProfileHermesHome,
} from './profiles-browser'
import {
  isClaudeAgentHealthy,
  readAliveGatewayPid,
  spawnProfileGateway,
  type StartClaudeAgentResult,
} from './claude-agent'
import {
  GATEWAY_BASE_PORT,
  bindProfileToPort,
  gatewayUrlForPort,
  getProfileGatewayUrl,
  isGatewayPoolEnabled,
  listManagedProfileNames,
  profileNameFromHermesHome,
  resolveProfileGatewayPort,
} from './gateway-ports'

export {
  GATEWAY_BASE_PORT,
  bindProfileToPort,
  gatewayUrlForPort,
  getProfileGatewayUrl,
  isGatewayPoolEnabled,
  listManagedProfileNames,
  profileNameFromHermesHome,
  readExplicitProfilePort,
  resolveProfileGatewayPort,
  ensureProfileApiServerEnv,
} from './gateway-ports'

export type GatewayPoolState = 'stopped' | 'spawning' | 'healthy' | 'dead'

export type PooledGateway = {
  profile: string
  port: number
  url: string
  hermesHome: string
  state: GatewayPoolState
}

export type EnsureGatewayResult = StartClaudeAgentResult & {
  port?: number
  url?: string
  started?: boolean
}

const ensurePromises = new Map<string, Promise<EnsureGatewayResult>>()

function homesMatch(left: string, right: string): boolean {
  return path.resolve(left) === path.resolve(right)
}

const LISTEN_CACHE_MS = 250
let listenCache: { at: number; inodesByPort: Map<number, Set<string>> } | null =
  null

function listenInodesByPort(): Map<number, Set<string>> {
  const now = Date.now()
  if (listenCache && now - listenCache.at < LISTEN_CACHE_MS) {
    return listenCache.inodesByPort
  }
  const inodesByPort = new Map<number, Set<string>>()
  for (const file of ['/proc/net/tcp', '/proc/net/tcp6']) {
    let raw = ''
    try {
      raw = fs.readFileSync(file, 'utf8')
    } catch {
      continue
    }
    for (const line of raw.split('\n').slice(1)) {
      const parts = line.trim().split(/\s+/)
      if (parts.length < 10 || parts[3] !== '0A') continue
      const hex = parts[1]?.split(':')[1]
      if (!hex) continue
      const port = Number.parseInt(hex, 16)
      if (!Number.isInteger(port) || port <= 0) continue
      if (!parts[9] || parts[9] === '0') continue
      let inodes = inodesByPort.get(port)
      if (!inodes) {
        inodes = new Set<string>()
        inodesByPort.set(port, inodes)
      }
      inodes.add(parts[9])
    }
  }
  listenCache = { at: now, inodesByPort }
  return inodesByPort
}

function listenInodesForPort(port: number): Set<string> {
  return listenInodesByPort().get(port) ?? new Set()
}

function pidOwnsSocketInodes(pid: number, inodes: Set<string>): boolean {
  if (!inodes.size) return false
  let fds: Array<string> = []
  try {
    fds = fs.readdirSync(`/proc/${pid}/fd`)
  } catch {
    return false
  }
  for (const fd of fds) {
    try {
      const target = fs.readlinkSync(`/proc/${pid}/fd/${fd}`)
      const match = target.match(/^socket:\[(\d+)\]$/)
      if (match && inodes.has(match[1])) return true
    } catch {
      // fd vanished
    }
  }
  return false
}

function pidListeningOnPort(port: number): number | null {
  const inodes = listenInodesForPort(port)
  if (!inodes.size) return null
  for (const name of listManagedProfileNames()) {
    const pid = readAliveGatewayPid(resolveProfileHermesHome(name))
    if (pid && pidOwnsSocketInodes(pid, inodes)) return pid
  }
  return null
}

function profileOwnsPort(profileName: string, port: number): boolean {
  const inodes = listenInodesForPort(port)
  if (!inodes.size) return false
  const pid = readAliveGatewayPid(resolveProfileHermesHome(profileName))
  return Boolean(pid && pidOwnsSocketInodes(pid, inodes))
}

function readProcessHermesHome(pid: number): string | null {
  try {
    const raw = fs.readFileSync(`/proc/${pid}/environ`)
    const env = raw.toString('utf8').split('\0')
    const line = env.find((entry) => entry.startsWith('HERMES_HOME='))
    if (!line) return null
    const value = line.slice('HERMES_HOME='.length).trim()
    return value || null
  } catch {
    return null
  }
}

export function identifyPortOccupant(port: number): {
  pid: number
  hermesHome: string
  profile: string | null
} | null {
  const pid = pidListeningOnPort(port)
  if (!pid) return null
  const hermesHome = readProcessHermesHome(pid)
  if (!hermesHome) return null
  return {
    pid,
    hermesHome,
    profile: profileNameFromHermesHome(hermesHome),
  }
}

async function vacateForeignOccupant(
  port: number,
  forProfile: string,
): Promise<void> {
  const occupant = identifyPortOccupant(port)
  if (!occupant?.profile || occupant.profile === forProfile) return
  const theirs = resolveProfileGatewayPort(occupant.profile)
  if (theirs === port) return
  await spawnProfileGateway({
    profileName: occupant.profile,
    port: theirs,
    forceReplace: true,
    waitForHealthy: false,
  })
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (!profileOwnsPort(occupant.profile, port)) return
    await new Promise((resolveAttempt) => setTimeout(resolveAttempt, 100))
  }
}

export async function probeProfileGateway(profileName: string): Promise<boolean> {
  const port = resolveProfileGatewayPort(profileName)
  const name = (profileName || 'default').trim() || 'default'
  if (!profileOwnsPort(name, port)) return false
  return isClaudeAgentHealthy(port, 250)
}

export function getGatewayPoolSnapshot(): Array<PooledGateway> {
  return listManagedProfileNames().map((profile) => {
    const port = resolveProfileGatewayPort(profile)
    return {
      profile,
      port,
      url: gatewayUrlForPort(port),
      hermesHome: resolveProfileHermesHome(profile),
      state: 'stopped' as GatewayPoolState,
    }
  })
}

export async function getGatewayPoolStatus(): Promise<Array<PooledGateway>> {
  const snapshot = getGatewayPoolSnapshot()
  for (const entry of snapshot) {
    entry.state = profileOwnsPort(entry.profile, entry.port) ? 'healthy' : 'stopped'
  }
  return snapshot
}

async function applyRoute(url: string): Promise<void> {
  const { applyProfileGatewayRoute } = await import('./gateway-capabilities')
  applyProfileGatewayRoute(url)
}

async function ensureProfileGatewayLocked(
  profileName: string,
  options: { forceReplace?: boolean } = {},
): Promise<EnsureGatewayResult> {
  const name = (profileName || 'default').trim() || 'default'
  const hermesHome = resolveProfileHermesHome(name)
  const port = resolveProfileGatewayPort(name)
  const url = gatewayUrlForPort(port)
  await applyRoute(url)

  if (
    !options.forceReplace &&
    profileOwnsPort(name, port) &&
    (await isClaudeAgentHealthy(port, 250))
  ) {
    return {
      ok: true,
      message: 'already running',
      profile: name,
      hermesHome,
      port,
      url,
      started: false,
    }
  }

  if (!profileOwnsPort(name, port) && (await isClaudeAgentHealthy(port, 200))) {
    await vacateForeignOccupant(port, name)
  }

  const owned = profileOwnsPort(name, port)
  const healthy = await isClaudeAgentHealthy(port, 250)
  const forceReplace =
    options.forceReplace === true || (healthy && !owned)

  const spawned = await spawnProfileGateway({
    profileName: name,
    port,
    forceReplace,
  })

  if (spawned.ok && (await isClaudeAgentHealthy(port, 250))) {
    const occupant = identifyPortOccupant(port)
    if (occupant && !homesMatch(occupant.hermesHome, hermesHome)) {
      return {
        ok: false,
        error: `port ${port} is occupied by ${occupant.profile ?? occupant.hermesHome}, not ${name}`,
        port,
        url,
        started: false,
      }
    }
    bindProfileToPort(name, port)
    await applyRoute(url)
    return {
      ...spawned,
      port,
      url,
      started: spawned.message === 'started' || spawned.message === 'restarted',
    }
  }

  return {
    ok: false,
    error:
      ('error' in spawned && spawned.error) ||
      `gateway for ${name} did not bind ${url} with HERMES_HOME=${hermesHome}`,
    port,
    url,
    started: false,
  }
}

/** Start (or adopt) the gateway for one profile. Never kills other profiles. */
export async function ensureProfileGateway(
  profileName: string,
  options: { forceReplace?: boolean } = {},
): Promise<EnsureGatewayResult> {
  const name = (profileName || 'default').trim() || 'default'
  if (!isGatewayPoolEnabled()) {
    const port = resolveProfileGatewayPort(name)
    return {
      ok: true,
      message: 'pool disabled',
      profile: name,
      hermesHome: resolveProfileHermesHome(name),
      port,
      url: gatewayUrlForPort(port),
      started: false,
    }
  }
  const key = `${name}:${options.forceReplace ? 'replace' : 'ensure'}`
  const existing = ensurePromises.get(key)
  if (existing) return existing

  const pending = ensureProfileGatewayLocked(name, options).finally(() => {
    ensurePromises.delete(key)
  })
  ensurePromises.set(key, pending)
  return pending
}

export async function ensureActiveProfileGateway(options?: {
  forceReplace?: boolean
}): Promise<EnsureGatewayResult> {
  if (!isGatewayPoolEnabled()) {
    const { startClaudeAgent } = await import('./claude-agent')
    const started = await startClaudeAgent({
      profileName: getActiveProfileName(),
      forceReplace: options?.forceReplace,
    })
    return started
  }
  return ensureProfileGateway(getActiveProfileName() || 'default', options)
}

export async function syncActiveProfileGatewayRoute(): Promise<string | null> {
  if (!isGatewayPoolEnabled()) return null
  const url = getProfileGatewayUrl(getActiveProfileName() || 'default')
  await applyRoute(url)
  return url
}
