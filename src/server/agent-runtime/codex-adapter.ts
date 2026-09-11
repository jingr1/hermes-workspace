/**
 * Codex CLI adapter for hermes-workspace.
 *
 * Codex 0.146+ uses the OpenAI Responses API by default (`wire_api = "responses"`).
 * It loads configuration from `~/.codex/config.toml` and project `.codex/config.toml`
 * overlays. Provider / model / auth are declared in config, not CLI argv, so this
 * adapter spawns `codex -p` and injects:
 *   - HERMES_MCP_TOKEN + a per-run MCP config for Hermes tool access
 *   - cwd and task prompt
 *   - per-run model override via `--model` if requested by the picker
 *
 * Output is parsed from Codex's default text/JSON print mode. Codex CLI emits
 * streamed Markdown chunks and final JSON; we normalize both into
 * AgentStreamEvent text_delta / error / run_exited.
 */
import { execFile, spawn } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { promisify } from 'node:util'

import { getHermesRoot } from '../claude-paths'
import { readCodexConfig, type CodexConfig } from '../codex-settings'
import { getCatalogProviderCredential } from '../provider-catalog'
import { parseEnvFile } from '../hermes-config-store'
import { publishChatEvent } from '../chat-event-bus'
import {
  killProcessGroup,
  lookupPid,
  registerPid,
  unregisterPid,
} from './pid-registry'
import type {
  AgentProbeResult,
  AgentRunInput,
  AgentRuntimeAdapter,
  AgentStreamEvent,
  McpHandshake,
} from './types'
import type { AgentDeclaration } from './agents-config'

const execFileAsync = promisify(execFile)

/** Resolve codex executable; prefer explicit path, then PATH. */
async function resolveCodexCommand(requested?: string): Promise<string | undefined> {
  if (requested && requested !== 'codex') {
    if (path.isAbsolute(requested)) {
      if (!fs.existsSync(requested)) return undefined
      return requested
    }
    try {
      await execFileAsync(requested, ['--version'], { timeout: 2_000 })
      return requested
    } catch {
      // fall through
    }
  }

  const candidates: Array<string> = []
  candidates.push('codex')

  const home = os.homedir()
  const nvmDir = process.env.NVM_DIR || path.join(home, '.nvm')
  try {
    if (fs.existsSync(nvmDir)) {
      const versions = fs.readdirSync(path.join(nvmDir, 'versions', 'node'))
      for (const v of versions) {
        candidates.push(path.join(nvmDir, 'versions', 'node', v, 'bin', 'codex'))
      }
    }
  } catch {
    // ignore
  }

  candidates.push(
    path.join(home, '.local', 'bin', 'codex'),
    '/usr/local/bin/codex',
    '/opt/homebrew/bin/codex',
  )

  for (const cmd of candidates) {
    try {
      await execFileAsync(cmd, ['--version'], { timeout: 2_000 })
      return cmd
    } catch {
      // try next
    }
  }

  return undefined
}

/** Build spawn env; inherit parent, overlay HERMES_MCP_TOKEN and provider key. */
function buildCodexSpawnEnv(input: {
  runToken: string
  codexConfig: CodexConfig
  extra?: Record<string, string>
}): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value
  }

  const provider = input.codexConfig.provider
  const block = provider ? input.codexConfig.providers[provider] : undefined
  const envKey = block?.env_key
  if (envKey) {
    // Always inject the latest key from the Hermes catalog so Codex uses it,
    // even if the server process's environment does not have it set.
    const credential = getCatalogProviderCredential(provider)
    if (credential?.apiKey) {
      env[envKey] = credential.apiKey
    } else {
      // Fallback: read the key directly from the top-level ~/.hermes/.env
      // when it has not been synced into the default profile's .env.
      try {
        const hermesRoot = process.env.HERMES_HOME || path.join(os.homedir(), '.hermes')
        const envText = fs.readFileSync(path.join(hermesRoot, '.env'), 'utf8')
        const parsed = parseEnvFile(envText)
        if (parsed[envKey]) {
          env[envKey] = parsed[envKey]
        }
      } catch {
        // ignore missing env file
      }
    }
  }

  return {
    ...env,
    HERMES_MCP_TOKEN: input.runToken,
    ...input.extra,
  }
}

function resolveCodexArgs(declArgs: Array<string> | undefined): Array<string> {
  const base = declArgs?.length ? [...declArgs] : ['exec']
  if (!base.includes('exec') && !base.includes('e')) {
    base.unshift('exec')
  }
  return base
}

type ManagedRun = {
  runId: string
  agentId: string
  pid: number
  queue: Array<AgentStreamEvent>
  waiters: Array<() => void>
  done: boolean
}

const runs = new Map<string, ManagedRun>()

function push(run: ManagedRun, event: AgentStreamEvent): void {
  run.queue.push(event)
  publishChatEvent('agent_stream', { ...event, agentId: run.agentId })
  const waiters = run.waiters.splice(0)
  for (const wake of waiters) wake()
}

export class CodexAdapter implements AgentRuntimeAdapter {
  readonly kind = 'codex' as const

  constructor(private readonly decl: AgentDeclaration) {}

  private async resolveCommand(): Promise<string | undefined> {
    return resolveCodexCommand(this.decl.command)
  }

  async probe(): Promise<AgentProbeResult> {
    const command = await this.resolveCommand()
    if (!command) {
      return {
        available: false,
        detail: `codex executable not found (checked PATH, nvm versions, ~/.local/bin, and common prefixes)`,
      }
    }
    try {
      const { stdout } = await execFileAsync(command, ['--version'], {
        timeout: 5_000,
      })
      return { available: true, version: stdout.trim() }
    } catch (error) {
      return {
        available: false,
        detail: `${command} --version failed: ${error instanceof Error ? error.message : String(error)}`,
      }
    }
  }

  async startRun(
    input: AgentRunInput & { mcp: McpHandshake },
  ): Promise<{ runId: string }> {
    const command = await this.resolveCommand()
    if (!command) {
      throw new Error(
        'codex executable not found; install @openai/codex globally',
      )
    }

    const runRoot = path.join(getHermesRoot(), 'codex', 'agent-runs', input.runId)
    fs.mkdirSync(runRoot, { recursive: true })

    // NOTE: Codex 0.146+ does not accept a per-run MCP config file via CLI.
    // MCP servers must be configured in ~/.codex/config.toml (or via `codex mcp add`).
    // We keep the HERMES_MCP_TOKEN env var so a pre-registered Hermes MCP server
    // can authenticate, but we no longer pass --mcp-config here.
    void input.mcp

    const logPath = path.join(runRoot, 'run.log')
    const logFd = fs.openSync(logPath, 'a')

    const args = [
      ...resolveCodexArgs(this.decl.args),
      '--skip-git-repo-check',
      ...(input.model ? ['--model', input.model] : []),
      '--',
      input.task,
    ]

    try {
      fs.writeFileSync(
        path.join(runRoot, 'argv.txt'),
        JSON.stringify(
          {
            command,
            args,
            inputModel: input.model ?? null,
            cwd: input.cwd ?? process.cwd(),
          },
          null,
          2,
        ),
        'utf-8',
      )
    } catch {
      // non-fatal
    }

    const child = spawn(command, args, {
      cwd: input.cwd ?? process.cwd(),
      env: buildCodexSpawnEnv({
        runToken: input.mcp.runToken,
        codexConfig: readCodexConfig(),
        extra: input.env,
      }),
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    if (!child.pid) {
      fs.closeSync(logFd)
      throw new Error(`Failed to spawn ${command}: no pid`)
    }

    const run: ManagedRun = {
      runId: input.runId,
      agentId: input.agentId,
      pid: child.pid,
      queue: [],
      waiters: [],
      done: false,
    }
    runs.set(input.runId, run)

    registerPid({
      runId: input.runId,
      agentId: input.agentId,
      pid: child.pid,
      runtime: this.kind,
      startedAt: Date.now(),
      logPath,
    })

    let stdoutBuffer = ''
    const emitText = (text: string) => {
      const trimmed = text.trim()
      if (!trimmed) return
      push(run, { type: 'text_delta', runId: input.runId, text: trimmed })
    }

    child.stdout.on('data', (data: Buffer) => {
      const text = data.toString()
      fs.writeSync(logFd, data)
      stdoutBuffer += text
      // Codex print mode streams text chunks; emit incremental.
      if (stdoutBuffer.includes('\n')) {
        const lines = stdoutBuffer.split('\n')
        stdoutBuffer = lines.pop() ?? ''
        for (const line of lines) emitText(line)
      }
    })

    child.stderr.on('data', (data: Buffer) => {
      fs.writeSync(logFd, data)
      const text = data.toString().trim()
      if (!text) return
      push(run, { type: 'error', runId: input.runId, message: text })
    })

    child.on('exit', (exitCode) => {
      if (run.done) return
      run.done = true
      if (stdoutBuffer.trim()) emitText(stdoutBuffer)
      fs.closeSync(logFd)
      unregisterPid(input.runId)
      push(run, { type: 'run_exited', runId: input.runId, exitCode })
    })

    child.on('error', (error) => {
      run.done = true
      push(run, { type: 'error', runId: input.runId, message: error.message })
    })

    child.unref()

    push(run, {
      type: 'run_started',
      runId: input.runId,
      agentId: input.agentId,
      taskId: input.taskId ?? undefined,
      roomId: input.roomId ?? undefined,
    })

    return { runId: input.runId }
  }

  async *streamEvents(runId: string): AsyncIterable<AgentStreamEvent> {
    const run = runs.get(runId)
    if (!run) {
      const entry = lookupPid(runId)
      if (entry) {
        yield {
          type: 'error',
          runId,
          message: `run predates this server process (pid ${entry.pid}); log at ${entry.logPath}`,
        }
      }
      return
    }
    let cursor = 0
    for (;;) {
      while (cursor < run.queue.length) {
        yield run.queue[cursor++]
      }
      if (run.done && cursor >= run.queue.length) return
      await new Promise<void>((wake) => run.waiters.push(wake))
    }
  }

  async interrupt(runId: string, reason: string): Promise<void> {
    const entry = lookupPid(runId)
    const run = runs.get(runId)
    const pid = run?.pid ?? entry?.pid
    if (pid) {
      killProcessGroup(pid, 'SIGKILL')
    }
    unregisterPid(runId)
    if (run) {
      run.done = true
      push(run, { type: 'error', runId, message: `interrupted: ${reason}` })
      push(run, { type: 'run_exited', runId, exitCode: null })
    }
  }
}

if (import.meta.hot) {
  import.meta.hot.accept()
  import.meta.hot.dispose(() => {
    void import('./router').then((mod) => {
      mod.resetAgentRuntimeRouter()
    })
  })
}
