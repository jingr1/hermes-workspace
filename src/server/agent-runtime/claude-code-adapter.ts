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
import * as path from 'node:path'
import { promisify } from 'node:util'
import { getClaudeRoot } from '../claude-paths'
import { publishChatEvent } from '../chat-event-bus'
import { killProcessGroup, lookupPid, registerPid, unregisterPid } from './pid-registry'
import type {
  AgentProbeResult,
  AgentRunInput,
  AgentRuntimeAdapter,
  AgentStreamEvent,
  McpHandshake,
} from './types'
import type { AgentDeclaration } from './agents-config'

const execFileAsync = promisify(execFile)

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

  async probe(): Promise<AgentProbeResult> {
    const command = this.decl.command ?? 'claude'
    try {
      const { stdout } = await execFileAsync(command, ['--version'], { timeout: 5_000 })
      return { available: true, version: stdout.trim() }
    } catch (error) {
      return {
        available: false,
        detail: `${command} --version failed: ${error instanceof Error ? error.message : String(error)}`,
      }
    }
  }

  async startRun(input: AgentRunInput & { mcp: McpHandshake }): Promise<{ runId: string }> {
    const command = this.decl.command ?? 'claude'
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
      ...input.env,
    }

    const args = [...(this.decl.args ?? ['-p']), '--mcp-config', mcpConfigPath, input.task]

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
      push(run, { type: 'text_delta', runId: input.runId, text: data.toString() })
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
