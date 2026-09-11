/**
 * Lifecycle action for managed CLI runtimes declared in agents.yaml.
 *
 * Mirrors the install/update surface from cc-switch's
 * `run_tool_lifecycle_action`, but scoped to the agents hermes-workspace
 * supports today: Claude Code (`cc-impl`) and Codex (`codex-impl`).
 *
 * The implementation:
 *   - Uses npm global install / update by default.
 *   - Runs anchored to the npm binary that is currently providing the CLI,
 *     when it can be discovered (e.g. nvm/fnm/mise/global npm), so `npm i -g`
 *     writes into the same prefix the user already sees on PATH.
 *   - Optionally elevates with sudo if the caller requests it and the current
 *     uid is non-zero.
 *   - Captures stdout/stderr and returns them for UI feedback.
 *
 * No secrets are accepted from the client; everything is resolved server-side.
 */
import { spawn, spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

export type AgentEnvAction = 'install' | 'update'

export type AgentEnvActionResult = {
  ok: boolean
  agentId: string
  action: AgentEnvAction
  /** Human-readable summary. */
  message: string
  /** Full command that was executed. */
  command: string
  /** Terminal output (truncated to last lines). */
  output: string
  /** Exit code, when the process launched. */
  exitCode: number | null
}

export type AgentEnvActionOptions = {
  agentId: string
  action: AgentEnvAction
  /** When true and running on Linux/macOS as non-root, prefix with sudo -S
   *  and pass the provided password on stdin. */
  useSudo?: boolean
  sudoPassword?: string
}

const MANAGED_AGENTS: Record<
  string,
  { name: string; command: string; npmPackage: string }
> = {
  'cc-impl': {
    name: 'Claude Code',
    command: 'claude',
    npmPackage: '@anthropic-ai/claude-code',
  },
  'codex-impl': {
    name: 'Codex',
    command: 'codex',
    npmPackage: '@openai/codex',
  },
}

/**
 * Locate the currently-active npm binary.
 * Prefer the one sitting next to the resolved CLI command, then `which npm`.
 */
function resolveNpmForCommand(command: string): string | null {
  const resolved = resolveCommand(command)
  if (resolved) {
    const siblingNpm = path.join(path.dirname(resolved), 'npm')
    if (fs.existsSync(siblingNpm)) return siblingNpm
  }
  try {
    const which = spawnSync('/bin/sh', ['-c', 'command -v npm'], {
      encoding: 'utf8',
      timeout: 5_000,
    })
    if (which.status === 0 && which.stdout?.trim()) {
      return which.stdout.trim()
    }
    return null
  } catch {
    return null
  }
}

function resolveCommand(command: string): string | null {
  try {
    const pathEnv = process.env.PATH || ''
    const pathExt =
      process.platform === 'win32'
        ? process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD'
        : ''

    for (const segment of pathEnv.split(path.delimiter)) {
      if (!segment) continue
      const base = path.join(segment, command)
      const candidates = pathExt
        ? pathExt
            .split(path.delimiter)
            .map((ext) =>
              base.toLowerCase().endsWith(ext.toLowerCase())
                ? base
                : base + ext,
            )
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
  } catch {
    // fall through
  }

  const home = os.homedir()
  const fallbackDirs = [
    path.join(home, '.local', 'bin'),
    '/usr/local/bin',
    '/opt/homebrew/bin',
  ]
  for (const dir of fallbackDirs) {
    const candidate = path.join(dir, command)
    if (fs.existsSync(candidate)) {
      try {
        fs.accessSync(candidate, fs.constants.X_OK)
        return candidate
      } catch {
        // ignore
      }
    }
  }

  return null
}

function lastLines(text: string, n: number): string {
  const lines = text.split('\n')
  const start = Math.max(0, lines.length - n)
  return lines.slice(start).join('\n')
}

function buildCommandLine(
  npm: string,
  pkg: string,
  action: AgentEnvAction,
): string {
  const isWindows = process.platform === 'win32'
  if (action === 'install' || action === 'update') {
    // `npm install` and `npm update` for a single global package are equivalent
    // for our purposes; use install@latest so a fresh install gets the same
    // version an update would.
    const base = `"${npm}" i -g ${pkg}@latest`
    if (isWindows) {
      // On Windows npm's shebang resolves node via PATH; a GUI-launched server
      // may have a narrow PATH. Prefix with npm's own directory so node.exe is
      // found. Quoted because paths can contain spaces.
      return `set "PATH=${path.dirname(npm)};%PATH%" && ${base}`
    }
    return `PATH="${path.dirname(npm)}":"$PATH" ${base}`
  }
  throw new Error(`Unsupported action: ${action}`)
}

/**
 * Run a shell command with an optional timeout and capture output.
 * If sudo is requested, prefix the command and feed the password on stdin.
 */
function runShellCommand(
  commandLine: string,
  options: {
    useSudo?: boolean
    sudoPassword?: string
    timeoutMs?: number
  } = {},
): Promise<{ exitCode: number | null; output: string }> {
  return new Promise((resolve) => {
    const isWindows = process.platform === 'win32'
    let shell = isWindows ? 'cmd' : 'bash'
    let shellFlag = isWindows ? '/C' : '-c'
    let finalCommand = commandLine

    if (
      options.useSudo &&
      !isWindows &&
      process.getuid &&
      process.getuid() !== 0
    ) {
      shell = 'sudo'
      shellFlag = '-S'
      finalCommand = commandLine
    }

    const child = spawn(shell, [shellFlag, finalCommand], {
      stdio: options.useSudo ? ['pipe', 'pipe', 'pipe'] : 'pipe',
      env: process.env as Record<string, string>,
    })

    const chunks: Buffer[] = []
    child.stdout?.on('data', (chunk: Buffer) => chunks.push(chunk))
    child.stderr?.on('data', (chunk: Buffer) => chunks.push(chunk))

    if (options.useSudo && options.sudoPassword && child.stdin) {
      child.stdin.write(`${options.sudoPassword}\n`)
      child.stdin.end()
    }

    const timeout = setTimeout(() => {
      child.kill('SIGTERM')
    }, options.timeoutMs ?? 120_000)

    child.on('close', (exitCode) => {
      clearTimeout(timeout)
      const output = Buffer.concat(chunks).toString('utf-8')
      resolve({ exitCode, output })
    })

    child.on('error', (err) => {
      clearTimeout(timeout)
      resolve({ exitCode: 127, output: String(err) })
    })
  })
}

export async function runAgentEnvAction(
  options: AgentEnvActionOptions,
): Promise<AgentEnvActionResult> {
  const managed = MANAGED_AGENTS[options.agentId]
  if (!managed) {
    return {
      ok: false,
      agentId: options.agentId,
      action: options.action,
      message: 'Unsupported agent for lifecycle action',
      command: '',
      output: '',
      exitCode: null,
    }
  }

  const npm = resolveNpmForCommand(managed.command)
  if (!npm) {
    return {
      ok: false,
      agentId: options.agentId,
      action: options.action,
      message: 'Could not locate npm; install/update unavailable',
      command: '',
      output: '',
      exitCode: null,
    }
  }

  const commandLine = buildCommandLine(npm, managed.npmPackage, options.action)
  const { exitCode, output } = await runShellCommand(commandLine, {
    useSudo: options.useSudo,
    sudoPassword: options.sudoPassword,
    timeoutMs: 180_000,
  })

  const ok = exitCode === 0
  const trimmedOutput = lastLines(output, 40)

  return {
    ok,
    agentId: options.agentId,
    action: options.action,
    message: ok
      ? `${managed.name} ${options.action} completed`
      : `${managed.name} ${options.action} failed`,
    command: commandLine,
    output: trimmedOutput,
    exitCode,
  }
}

export function listManagedEnvAgents(): Array<{
  agentId: string
  name: string
  command: string
}> {
  return Object.entries(MANAGED_AGENTS).map(([agentId, meta]) => ({
    agentId,
    name: meta.name,
    command: meta.command,
  }))
}
