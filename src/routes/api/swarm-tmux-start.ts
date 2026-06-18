import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { json } from '@tanstack/react-start'
import { createFileRoute } from '@tanstack/react-router'
import { isAuthenticated } from '../../server/auth-middleware'
import { rosterByWorkerId } from '../../server/swarm-roster'
import { parseSwarmModelLabel } from '../../server/swarm-model-resolver'
import { syncSwarmProfileModel } from '../../server/swarm-profile-config'
import { handoffPath, readHandoff } from '../../server/handoff'

// Inlined to avoid SSR module-resolution races against freshly-written
// helpers; mirrors `src/server/claude-paths.ts` getProfilesDir().
function getProfilesDir(): string {
  const envHome = process.env.HERMES_HOME || process.env.CLAUDE_HOME
  if (envHome) {
    const parts = envHome.split('/').filter(Boolean)
    if (parts.length >= 2 && parts.at(-2) === 'profiles') {
      return envHome.split('/').slice(0, -1).join('/')
    }
    return join(envHome, 'profiles')
  }
  return join(homedir(), '.hermes', 'profiles')
}

/**
 * POST /api/swarm-tmux-start
 * Body: { workerId: "swarm1" }
 *
 * Idempotently ensures a long-lived tmux session exists for a worker.
 * The session runs the worker's `hermes` TUI inside its profile + cwd, so
 * dispatch traffic + the swarm2 Runtime pane both see the same live agent.
 *
 * Returns: { workerId, sessionName, alreadyRunning, started }
 */

type StartRequest = {
  workerId?: unknown
}

const TMUX_BIN_CANDIDATES = [
  process.env.TMUX_BIN,
  '/opt/homebrew/bin/tmux',
  '/usr/local/bin/tmux',
  join(homedir(), '.local', 'bin', 'tmux'),
  'tmux',
].filter((value): value is string => Boolean(value))

function resolveTmuxBin(): string | null {
  for (const candidate of TMUX_BIN_CANDIDATES) {
    if (candidate.includes('/')) {
      // Trust an explicit TMUX_BIN override even if existsSync misses it
      // (some sandbox / launchd setups report false negatives).
      if (candidate === process.env.TMUX_BIN) {
        return candidate
      }
      // For absolute candidate paths, only use them if they actually exist.
      // Otherwise a hardcoded macOS Homebrew path will break Linux hosts.
      if (existsSync(candidate)) {
        return candidate
      }
      continue
    }
    // Bare command: let execFile resolve it via PATH.
    return candidate
  }
  return null
}

function tmuxHasSession(tmuxBin: string, name: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(tmuxBin, ['has-session', '-t', name], (error) => {
      resolve(!error)
    })
  })
}

function validateWorkerId(value: string): boolean {
  return /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(value)
}

const HERMES_BIN_CANDIDATES = [
  process.env.HERMES_CLI_BIN,
  join(homedir(), '.hermes', 'hermes-agent', 'venv', 'bin', 'hermes'),
  join(homedir(), '.local', 'bin', 'hermes'),
  'hermes',
].filter((value): value is string => Boolean(value))

function resolveHermesBin(): string {
  for (const candidate of HERMES_BIN_CANDIDATES) {
    if (candidate.includes('/')) {
      if (existsSync(candidate)) return candidate
      continue
    }
    return candidate
  }
  return 'hermes'
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function startSession(
  tmuxBin: string,
  sessionName: string,
  profilePath: string,
  cwd: string,
  workerId: string,
): Promise<{ ok: boolean; error?: string }> {
  const handoff = readHandoff(workerId)
  const handoffEnv = handoff
    ? `HERMES_HANDOFF_PATH='${handoffPath(workerId).replace(/'/g, `'\\''`)}' `
    : ''
  return new Promise((resolve) => {
    const child = execFile(
      tmuxBin,
      [
        'new-session',
        '-d',
        '-s',
        sessionName,
        '-c',
        cwd,
        `${handoffEnv}HERMES_HOME='${profilePath.replace(/'/g, `'\\''`)}' HERMES_CLI_BIN='${resolveHermesBin().replace(/'/g, `'\\''`)}' exec '${resolveHermesBin().replace(/'/g, `'\\''`)}' chat --tui`,
      ],
      { timeout: 8_000 },
      async (error, _stdout, stderr) => {
        if (error) {
          resolve({
            ok: false,
            error: stderr.toString().trim() || error.message,
          })
          return
        }
        // Give the agent a moment to render its prompt. If the Hermes process
        // exits immediately, the session dies before dispatch can use it.
        await sleep(1_500)
        if (await tmuxHasSession(tmuxBin, sessionName)) {
          // If a previous handoff exists for this worker, paste it into the
          // session so the agent can ground itself on restart.
          if (handoff) {
            await injectHandoffPrompt(tmuxBin, sessionName, workerId)
          }
          resolve({ ok: true })
          return
        }
        resolve({
          ok: false,
          error: `Hermes worker session ${sessionName} exited during startup. Check the profile and Hermes logs.`,
        })
      },
    )
    child.on('error', (error) => {
      resolve({ ok: false, error: error.message })
    })
  })
}

async function injectHandoffPrompt(
  tmuxBin: string,
  sessionName: string,
  workerId: string,
): Promise<void> {
  const handoff = readHandoff(workerId)
  if (!handoff) return
  const prompt =
    `CONTEXT_HANDOFF. Your latest structured handoff is at ${handoffPath(workerId)}. ` +
    `Read it (and the matching .md file) to re-ground, then wait for the next assignment.`
  try {
    await new Promise<void>((resolve, reject) => {
      const child = execFile(tmuxBin, ['load-buffer', '-b', `swarm-start-${workerId}`, '-'], {
        encoding: 'utf8',
      })
      child.stdin?.write(prompt)
      child.stdin?.end()
      child.on('close', (code) => {
        if (code !== 0) return reject(new Error(`load-buffer exited ${code}`))
        resolve()
      })
      child.on('error', reject)
    })
    await new Promise<void>((resolve, reject) => {
      execFile(tmuxBin, ['send-keys', '-t', sessionName, 'C-c'], () => {
        setTimeout(() => {
          execFile(tmuxBin, ['send-keys', '-t', sessionName, 'C-u'], () => {
            execFile(
              tmuxBin,
              ['paste-buffer', '-d', '-b', `swarm-start-${workerId}`, '-t', sessionName],
              (err) => {
                if (err) return reject(err)
                setTimeout(() => {
                  execFile(tmuxBin, ['send-keys', '-t', sessionName, 'Enter'], (enterErr) => {
                    if (enterErr) return reject(enterErr)
                    resolve()
                  })
                }, 150)
              },
            )
          })
        }, 200)
      })
    })
  } catch (err) {
    console.error(`[swarm-tmux-start] failed to inject handoff for ${workerId}:`, err)
  }
}

function resolveWorkerCwd(workerId: string): string {
  const worker = rosterByWorkerId([workerId]).get(workerId)
  const wrapperName = worker?.wrapper?.trim() || workerId
  const wrapperPath = join(homedir(), '.local', 'bin', wrapperName)
  if (existsSync(wrapperPath)) {
    try {
      const text = readFileSync(wrapperPath, 'utf8')
      const m = text.match(/cd\s+'([^']+)'/)
      if (m && m[1] && existsSync(m[1])) return m[1]
    } catch {
      /* noop */
    }
  }
  return homedir()
}

export const Route = createFileRoute('/api/swarm-tmux-start')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return json({ error: 'Unauthorized' }, { status: 401 })
        }

        let body: StartRequest
        try {
          body = (await request.json()) as StartRequest
        } catch {
          return json({ error: 'Invalid JSON body' }, { status: 400 })
        }

        const workerId =
          typeof body.workerId === 'string' ? body.workerId.trim() : ''
        if (!workerId || !validateWorkerId(workerId)) {
          return json(
            { error: 'workerId required (alnum, _, -; ≤64 chars)' },
            { status: 400 },
          )
        }

        const profilesDir = getProfilesDir()
        const profilePath = join(profilesDir, workerId)
        // Skip the existsSync gate; tmux new-session will fail loudly if the
        // path is bogus, and the sandbox quirks on this host make existsSync
        // unreliable for parent dirs even when leaf paths work.
        // We still verify the wrapper exists as a sanity check.
        const worker = rosterByWorkerId([workerId]).get(workerId)
        const wrapperName = worker?.wrapper?.trim() || workerId
        const wrapper = join(homedir(), '.local', 'bin', wrapperName)
        if (!existsSync(wrapper)) {
          return json(
            { error: `No wrapper for ${workerId} at ${wrapper}` },
            { status: 404 },
          )
        }

        const tmuxBin = resolveTmuxBin()
        if (!tmuxBin) {
          return json(
            { error: 'tmux not installed on this host' },
            { status: 503 },
          )
        }

        // Sync the worker's profile config.yaml model section to the
        // roster's `model:` label before we (re)attach tmux. Hermes Agent
        // reads config.yaml on every invocation, and the wrapper does not
        // pass `--model`, so this is the only way the roster value is
        // honored. Best-effort: unrecognised labels (typos, custom
        // models) are left as-is so a worker never gets wedged. See #236.
        const modelSync: {
          attempted: boolean
          changed: boolean
          target?: string
          previous?: string
          error?: string
        } = { attempted: false, changed: false }
        try {
          const roster = rosterByWorkerId([workerId]).get(workerId)
          const resolved = parseSwarmModelLabel(roster?.model ?? null)
          if (resolved) {
            modelSync.attempted = true
            const result = syncSwarmProfileModel(profilePath, resolved)
            if (result.ok) {
              modelSync.changed = result.changed
              modelSync.target = `${resolved.provider}/${resolved.default}`
              if (result.previous) {
                modelSync.previous = `${result.previous.provider}/${result.previous.default}`
              }
            } else {
              modelSync.error = result.error
            }
          }
        } catch (err) {
          modelSync.error = err instanceof Error ? err.message : String(err)
        }

        const sessionName = `swarm-${workerId}`
        const alreadyRunning = await tmuxHasSession(tmuxBin, sessionName)
        if (alreadyRunning) {
          return json({
            workerId,
            sessionName,
            alreadyRunning: true,
            started: false,
            tmuxBin,
            modelSync,
          })
        }

        const cwd = resolveWorkerCwd(workerId)
        const result = await startSession(
          tmuxBin,
          sessionName,
          profilePath,
          cwd,
          workerId,
        )
        if (!result.ok) {
          return json(
            { error: result.error ?? 'tmux new-session failed' },
            { status: 500 },
          )
        }

        return json({
          workerId,
          sessionName,
          alreadyRunning: false,
          started: true,
          tmuxBin,
          cwd,
          modelSync,
        })
      },
    },
  },
})
