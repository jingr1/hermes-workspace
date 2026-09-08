/**
 * claude-code adapter — minimal path (P1 step 2).
 *
 * Spawns one managed process per run:
 *   claude -p "<task>" --mcp-config <per-run-config.json>
 *
 * - Per-run MCP config is a temp file (never the user's ~/.claude.json);
 *   credentials live only in the process env (HERMES_MCP_TOKEN).
 * - detached:true + own process group so interrupt() can SIGKILL the group
 *   and the process survives server restarts; the pid registry re-attaches.
 * - stdout/stderr are teed to (a) a per-run log file (task_runs.log_path
 *   material) and (b) an in-memory event queue consumed by streamEvents()
 *   and republished onto chat-event-bus as display-channel events.
 */
import { execFile, spawn } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { promisify } from 'node:util'
import { getClaudeRoot } from '../claude-paths'
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

/**
 * Try to locate the claude executable. The workspace server may run under a
 * different Node/npm version than the one where @anthropic-ai/claude-code was
 * installed globally, so PATH alone is not reliable.
 */
async function resolveClaudeCommand(
  requested?: string,
): Promise<string | undefined> {
  if (requested && requested !== 'claude') {
    // If agents.yaml gives an explicit absolute path, use it as-is.
    if (path.isAbsolute(requested)) return requested
    // Otherwise treat it as a command and see if PATH can resolve it.
    try {
      await execFileAsync(requested, ['--version'], { timeout: 2_000 })
      return requested
    } catch {
      // fall through to common install locations
    }
  }

  const candidates: Array<string> = []

  // 1. Current PATH resolution (works when server env matches install env).
  candidates.push('claude')

  // 2. Common npm global locations, including nvm version directories.
  const home = os.homedir()
  const nvmDir = process.env.NVM_DIR || path.join(home, '.nvm')
  try {
    if (fs.existsSync(nvmDir)) {
      const versions = fs.readdirSync(path.join(nvmDir, 'versions', 'node'))
      for (const v of versions) {
        candidates.push(
          path.join(nvmDir, 'versions', 'node', v, 'bin', 'claude'),
        )
      }
    }
  } catch {
    // ignore
  }

  // 3. Corepack / npm global prefix outside nvm.
  candidates.push(path.join(home, '.local', 'bin', 'claude'))

  // 4. macOS / Linux homebrew-style paths.
  candidates.push('/usr/local/bin/claude', '/opt/homebrew/bin/claude')

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
  // Display channel: broadcast only, never persisted.
  publishChatEvent('agent_stream', { ...event, agentId: run.agentId })
  const waiters = run.waiters.splice(0)
  for (const wake of waiters) wake()
}

export class ClaudeCodeAdapter implements AgentRuntimeAdapter {
  readonly kind = 'claude-code' as const

  constructor(private readonly decl: AgentDeclaration) {}

  private async resolveCommand(): Promise<string | undefined> {
    return resolveClaudeCommand(this.decl.command)
  }

  async probe(): Promise<AgentProbeResult> {
    const command = await this.resolveCommand()
    if (!command) {
      return {
        available: false,
        detail: `claude executable not found (checked PATH, nvm versions, ~/.local/bin, and common prefixes)`,
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
        'claude executable not found; install @anthropic-ai/claude-code globally',
      )
    }
    const runRoot = path.join(getClaudeRoot(), 'agent-runs', input.runId)
    fs.mkdirSync(runRoot, { recursive: true })

    // Per-run MCP config: endpoint + token-from-env. Never written to the
    // user's global claude config.
    const mcpConfigPath = path.join(runRoot, 'mcp-config.json')
    fs.writeFileSync(
      mcpConfigPath,
      JSON.stringify(
        {
          mcpServers: {
            'hermes-workspace': {
              url: input.mcp.endpoint,
              headers: { Authorization: 'Bearer ${HERMES_MCP_TOKEN}' },
            },
          },
        },
        null,
        2,
      ),
    )

    const logPath = path.join(runRoot, 'run.log')
    const logFd = fs.openSync(logPath, 'a')

    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      HERMES_MCP_TOKEN: input.mcp.runToken,
      // Allow users to route Claude Code through non-Anthropic providers/models
      // without the CLI rejecting the model name at startup.
      CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT: '1',
      ...input.env,
    }

    const args = [
      '--mcp-config',
      mcpConfigPath,
      ...(this.decl.args ?? ['-p']),
      '--',
      input.task,
    ]

    const child = spawn(command, args, {
      cwd: input.cwd ?? process.cwd(),
      env,
      detached: true, // own process group; survives server restart
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

    child.stdout.on('data', (data: Buffer) => {
      fs.writeSync(logFd, data)
      push(run, {
        type: 'text_delta',
        runId: input.runId,
        text: data.toString(),
      })
    })
    child.stderr.on('data', (data: Buffer) => {
      fs.writeSync(logFd, data)
      push(run, { type: 'error', runId: input.runId, message: data.toString() })
    })
    child.on('exit', (exitCode) => {
      if (run.done) return // interrupt() already emitted the terminal event
      run.done = true
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
      // After a server restart the in-memory queue is gone; the log file on
      // disk (pid registry) is the recovery path (P2a re-attach).
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
