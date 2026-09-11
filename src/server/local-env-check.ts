/**
 * Local environment check for managed CLI runtimes.
 *
 * Inspired by cc-switch's `get_tool_versions` logic, but trimmed to the subset
 * hermes-workspace actually declares in agents.yaml: Claude Code and Codex.
 *
 * Responsibilities:
 *   - Detect the installed version of a CLI command via `--version`.
 *   - Query the upstream registry (npm for Claude Code/Codex) for the latest
 *     stable version.
 *   - Surface whether the tool is runnable, not installed, or broken.
 *
 * No install/update lifecycle is implemented here; callers may trigger updates
 * through the regular adapter or by shelling out themselves.
 */
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

export type LocalEnvCheckResult = {
  /** Declared agent id, e.g. cc-impl or codex-impl. */
  agentId: string
  /** Display name for the card. */
  name: string
  /** Underlying CLI command (claude / codex). */
  command: string
  /** semver-like version reported by the local CLI, or null. */
  currentVersion: string | null
  /** Latest version from the upstream registry, or null. */
  latestVersion: string | null
  /** true = installed and `--version` returned cleanly. */
  installed: boolean
  /** true = binary found but `--version` failed (e.g. broken node / missing optional deps). */
  installedButBroken: boolean
  /** Human-readable detail / error. */
  detail: string | null
  /** "windows" | "macos" | "linux" | "wsl" | "unknown". */
  envType: string
}

const NPM_REGISTRY_TIMEOUT_MS = 15_000

const MANAGED_AGENTS: Array<{
  agentId: string
  name: string
  command: string
  npmPackage: string
}> = [
  {
    agentId: 'cc-impl',
    name: 'Claude Code',
    command: 'claude',
    npmPackage: '@anthropic-ai/claude-code',
  },
  {
    agentId: 'codex-impl',
    name: 'Codex',
    command: 'codex',
    npmPackage: '@openai/codex',
  },
]

function detectEnvType(): LocalEnvCheckResult['envType'] {
  switch (process.platform) {
    case 'win32':
      return 'windows'
    case 'darwin':
      return 'macos'
    case 'linux':
      return 'linux'
    default:
      return 'unknown'
  }
}

/**
 * Resolve the command to an absolute executable path.
 * Returns null if not found on PATH or in the usual fallback directories.
 */
function resolveCommand(command: string): string | null {
  const fromPath = findInPath(command)
  if (fromPath) return fromPath

  const home = os.homedir()
  const fallbackDirs = [
    path.join(home, '.local', 'bin'),
    '/usr/local/bin',
    '/opt/homebrew/bin',
  ]

  // On non-Windows we can probe the candidate directly. On Windows the .cmd/.exe
  // extension handling is implicit through PATHEXT, so `findInPath` already won.
  for (const dir of fallbackDirs) {
    const candidate = path.join(dir, command)
    if (fs.existsSync(candidate)) {
      try {
        fs.accessSync(candidate, fs.constants.X_OK)
        return candidate
      } catch {
        // not executable, keep scanning
      }
    }
  }

  // nvm-style fallback for Node-based CLIs.
  const nvmDir = process.env.NVM_DIR || path.join(home, '.nvm')
  if (fs.existsSync(nvmDir)) {
    try {
      const nodeVersions = fs.readdirSync(path.join(nvmDir, 'versions', 'node'))
      for (const v of nodeVersions) {
        const candidate = path.join(
          nvmDir,
          'versions',
          'node',
          v,
          'bin',
          command,
        )
        if (fs.existsSync(candidate)) {
          try {
            fs.accessSync(candidate, fs.constants.X_OK)
            return candidate
          } catch {
            // ignore
          }
        }
      }
    } catch {
      // ignore
    }
  }

  return null
}

function findInPath(command: string): string | null {
  const pathEnv = process.env.PATH || ''
  const pathExt =
    process.platform === 'win32' ? process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD' : ''

  for (const segment of pathEnv.split(path.delimiter)) {
    if (!segment) continue
    const base = path.join(segment, command)
    const candidates = pathExt
      ? pathExt
          .split(path.delimiter)
          .map((ext) => (base.toLowerCase().endsWith(ext.toLowerCase()) ? base : base + ext))
          .filter((c, i, arr) => arr.indexOf(c) === i)
      : [base]

    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        try {
          fs.accessSync(candidate, fs.constants.X_OK)
          return candidate
        } catch {
          // not executable
        }
      }
    }
  }
  return null
}

const VERSION_RE = /\d+\.\d+\.\d+(-[\w.]+)?/

function extractVersion(raw: string): string {
  const match = VERSION_RE.exec(raw)
  return match ? match[0] : raw.trim()
}

function lastLines(text: string, n: number): string {
  const lines = text.split('\n')
  const start = Math.max(0, lines.length - n)
  return lines.slice(start).join('\n')
}

function runVersionProbe(command: string): {
  version: string | null
  installed: boolean
  installedButBroken: boolean
  detail: string | null
} {
  const resolved = resolveCommand(command)
  if (!resolved) {
    return {
      version: null,
      installed: false,
      installedButBroken: false,
      detail: 'not installed or not executable',
    }
  }

  const result = spawnSync(resolved, ['--version'], {
    timeout: 5_000,
    encoding: 'utf-8',
    shell: false,
  })

  const stdout = result.stdout?.trim() || ''
  const stderr = result.stderr?.trim() || ''

  if (result.status === 0) {
    const raw = stdout || stderr
    if (!raw) {
      return {
        version: null,
        installed: false,
        installedButBroken: false,
        detail: 'not installed or not executable',
      }
    }
    return {
      version: extractVersion(raw),
      installed: true,
      installedButBroken: false,
      detail: null,
    }
  }

  const err = stderr || stdout
  const notFound =
    result.status === 127 ||
    /command not found|not found|No such file/i.test(err)

  if (notFound) {
    return {
      version: null,
      installed: false,
      installedButBroken: false,
      detail: 'not installed or not executable',
    }
  }

  return {
    version: null,
    installed: true,
    installedButBroken: true,
    detail: lastLines(err, 4) || 'installed but not runnable',
  }
}

/**
 * Parse a semver-like string into numeric parts for comparison.
 * Returns null when the string cannot be parsed.
 */
function parseSemver(version: string): Array<number> | null {
  const core = version.split('+')[0].split('-')[0]
  const parts = core.split('.').map((p) => parseInt(p, 10))
  if (parts.length < 3 || parts.some((p) => Number.isNaN(p))) return null
  return parts.slice(0, 3)
}

function compareSemver(a: string, b: string): number | null {
  const av = parseSemver(a)
  const bv = parseSemver(b)
  if (!av || !bv) return null
  for (let i = 0; i < 3; i += 1) {
    if (av[i] !== bv[i]) return av[i] - bv[i]
  }
  return 0
}

/**
 * Fetch the latest version from npm. Mirrors the strategy used by cc-switch:
 * read dist-tags.latest; if the local install is strictly ahead of latest,
 * also consider prerelease tags for that tool (only Claude Code uses `next`).
 */
async function fetchNpmLatest(
  packageName: string,
  command: string,
  localVersion: string | null,
): Promise<string | null> {
  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), NPM_REGISTRY_TIMEOUT_MS)
    const resp = await fetch(`https://registry.npmjs.org/${packageName}`, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    })
    clearTimeout(timeout)

    if (!resp.ok) return null
    const data = (await resp.json()) as {
      'dist-tags'?: Record<string, string>
    }
    const tags = data['dist-tags'] ?? {}
    const latest = tags.latest
    if (!latest) return null

    const prereleaseTags = command === 'claude' ? ['next'] : []
    if (prereleaseTags.length === 0 || !localVersion) return latest

    const ahead = compareSemver(localVersion, latest)
    if (ahead === null || ahead <= 0) return latest

    let best = latest
    for (const tag of prereleaseTags) {
      const candidate = tags[tag]
      if (!candidate) continue
      const cmp = compareSemver(candidate, best)
      if (cmp !== null && cmp > 0) best = candidate
    }
    return best
  } catch {
    return null
  }
}

export async function checkLocalEnvForAgent(
  agentId: string,
): Promise<LocalEnvCheckResult | null> {
  const managed = MANAGED_AGENTS.find((a) => a.agentId === agentId)
  if (!managed) return null

  const probe = runVersionProbe(managed.command)
  const latestVersion = await fetchNpmLatest(
    managed.npmPackage,
    managed.command,
    probe.version,
  )

  return {
    agentId: managed.agentId,
    name: managed.name,
    command: managed.command,
    currentVersion: probe.version,
    latestVersion,
    installed: probe.installed,
    installedButBroken: probe.installedButBroken,
    detail: probe.detail,
    envType: detectEnvType(),
  }
}

export function listManagedEnvAgents(): Array<{
  agentId: string
  name: string
  command: string
}> {
  return MANAGED_AGENTS.map(({ agentId, name, command }) => ({
    agentId,
    name,
    command,
  }))
}
