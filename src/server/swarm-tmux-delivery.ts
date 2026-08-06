/**
 * Shared tmux transport helpers for Swarm worker sessions.
 *
 * Lifecycle (all modes):
 *   POST /api/swarm-tmux-start  → tmux new-session -d -s swarm-<role> "<shell|hermes>"
 *   POST /api/swarm-dispatch    → tmux send-keys (TUI paste or CLI command)
 *   POST /api/swarm-tmux-scroll → capture-pane / copy-mode scroll
 *   POST /api/swarm-tmux-stop   → tmux kill-session
 */

export type TmuxTransportMode = 'tui' | 'cli'

export function shellEscapeSingle(value: string): string {
  return value.replace(/'/g, `'\\''`)
}

/** tmux-tui: long-lived Hermes TUI (paste SwarmBrief into prompt). */
export function buildHermesTmuxTuiCommand(input: {
  profilePath: string
  hermesBin: string
  ghToken?: string | null
  useExec?: boolean
}): string {
  const launchPrefix = [
    `HERMES_HOME='${shellEscapeSingle(input.profilePath)}'`,
    `HERMES_CLI_BIN='${shellEscapeSingle(input.hermesBin)}'`,
    input.ghToken ? `GH_TOKEN='${shellEscapeSingle(input.ghToken)}'` : '',
    input.ghToken ? `GITHUB_TOKEN='${shellEscapeSingle(input.ghToken)}'` : '',
  ].filter(Boolean).join(' ')
  const hermesBin = shellEscapeSingle(input.hermesBin)
  return `${launchPrefix} exec ${hermesBin} chat --tui`
}

/** tmux-cli: long-lived bash with Hermes env; dispatch runs `hermes chat -q` per task. */
export function buildHermesTmuxShellCommand(input: {
  profilePath: string
  hermesBin: string
  ghToken?: string | null
}): string {
  const launchPrefix = [
    `HERMES_HOME='${shellEscapeSingle(input.profilePath)}'`,
    `HERMES_CLI_BIN='${shellEscapeSingle(input.hermesBin)}'`,
    input.ghToken ? `GH_TOKEN='${shellEscapeSingle(input.ghToken)}'` : '',
    input.ghToken ? `GITHUB_TOKEN='${shellEscapeSingle(input.ghToken)}'` : '',
  ].filter(Boolean).join(' ')
  return `${launchPrefix} exec bash -l`
}

export function resolveTmuxTransportMode(
  request?: TmuxTransportMode | null,
): TmuxTransportMode {
  if (request === 'cli' || request === 'tui') return request
  const env = (process.env.HERMES_SWARM_TMUX_MODE || '').trim().toLowerCase()
  if (env === 'cli') return 'cli'
  return 'tui'
}

const HERMES_TUI_MARKERS = [
  /ready\s*│/i,
  /❯/,
  /Hermes Agent/i,
  /Available Tools/i,
  /Nous Research/i,
]

/** True when tmux capture-pane content looks like an active Hermes TUI prompt. */
export function tmuxPaneLooksLikeHermesTui(paneText: string): boolean {
  const text = paneText.trim()
  if (!text) return false
  const hasTui = HERMES_TUI_MARKERS.some((pattern) => pattern.test(text))
  if (!hasTui) return false
  const tail = text.split('\n').slice(-8).join('\n')
  if (/\)\s+[\w.-]+@[\w.-]+:.*\$\s*$/m.test(tail) && !/❯/.test(tail)) {
    return false
  }
  if (/Execute: command not found/i.test(tail)) {
    return false
  }
  return true
}

const SHELL_COMMANDS = /^(bash|sh|zsh|fish|dash|login)$/i

/** True when the pane is an idle shell ready to accept a CLI dispatch command. */
export function tmuxPaneLooksLikeShellReady(
  paneText: string,
  paneCommand?: string | null,
): boolean {
  if (paneCommand && !SHELL_COMMANDS.test(paneCommand.trim())) {
    return false
  }
  const tail = paneText.trim().split('\n').slice(-12).join('\n')
  if (/Execute: command not found/i.test(tail)) return false
  if (tmuxPaneLooksLikeHermesTui(paneText)) return false
  // Match common shell prompts: $, #, or ~$ at end of line (with optional spaces)
  // Supports: user@host:~$, user@host:path$, user@host:dir$, etc.
  return /[$#~]\s*$/m.test(tail.trim())
}
