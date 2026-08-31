import { join, resolve } from 'node:path'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { getHermesRoot, getProfilesDir, getLocalBinDir } from './claude-paths'

export const SWARM_CANONICAL_REPO = resolve(process.cwd())
export const SWARM_MEMORY_ROOT =
  process.env.HERMES_SWARM_MEMORY_ROOT || join(homedir(), 'hermes-workspace')
export const SWARM_MEMORY_HANDOFFS = join(SWARM_MEMORY_ROOT, 'memory')
/** Legacy flat deliverable tree — retained on disk only; platform code must not use it. */
export const SWARM_LEGACY_OUTPUT_ROOT = join(SWARM_CANONICAL_REPO, 'output')
export const SWARM_FORBIDDEN_PATHS: string[] = [SWARM_LEGACY_OUTPUT_ROOT]

export type SwarmEnvironment = {
  canonicalRepo: string
  canonicalRepoExists: boolean
  memoryRoot: string
  memoryRootExists: boolean
  handoffsRoot: string
  handoffsRootExists: boolean
  hermesRoot: string
  profilesRoot: string
  localBinDir: string
  wrapperPattern: string
  tmuxSessionPattern: string
  defaultBuildCommand: string
  defaultTestCommand: string
  defaultDevCommand: string
  runtimeApis: string[]
  writableRoots: string[]
  readOnlyRoots: string[]
  forbiddenRoots: string[]
  notes: string[]
}

export function getSwarmEnvironment(input?: {
  missionId?: string
  workspaceMode?: 'canonical' | 'worktree'
  worktreeCwd?: string | null
}): SwarmEnvironment {
  const hermesRoot = getHermesRoot()
  const profilesRoot = getProfilesDir()
  const localBinDir = getLocalBinDir()

  const workspaceMode = input?.workspaceMode ?? 'canonical'
  const worktreeCwd = input?.worktreeCwd ?? null

  // P2b: in worktree mode, the agent's working directory is the mission worktree,
  // not the control-plane repo. Notes must reflect this or agents will be directed
  // to modify the server's own source tree.
  const workDir = worktreeCwd ?? SWARM_CANONICAL_REPO

  const canonicalNotes = [
    'Swarm code, git, build, and tests run only in the canonical repo.',
    'Do not use the legacy hermes-workspace alias for Swarm work.',
    'Worker profiles live under ~/.hermes/profiles/<workerId> and wrappers under ~/.local/bin/swarmN.',
    'Prefer live tmux-backed Hermes sessions over one-shot subprocesses.',
    'Use the swarm APIs as the machine-readable source of worker/runtime truth.',
    'Swarm deliverables belong under memory/swarm/missions/<missionId>/<worker>/; do not write new files under output/.',
  ]

  const worktreeNotes = [
    `Mission worktree mode: code, git, build, and tests run in the per-mission worktree at ${workDir}.`,
    'Do not write files in the control-plane hermes-workspace repo.',
    'Swarm deliverables belong under memory/swarm/missions/<missionId>/<worker>/; do not write new files under output/.',
    `Run git operations inside ${workDir}.`,
    ...(input?.missionId
      ? [`Current mission: ${input.missionId}. Current worktree: ${workDir}.`]
      : []),
  ]

  return {
    canonicalRepo: SWARM_CANONICAL_REPO,
    canonicalRepoExists: existsSync(SWARM_CANONICAL_REPO),
    memoryRoot: SWARM_MEMORY_ROOT,
    memoryRootExists: existsSync(SWARM_MEMORY_ROOT),
    handoffsRoot: SWARM_MEMORY_HANDOFFS,
    handoffsRootExists: existsSync(SWARM_MEMORY_HANDOFFS),
    hermesRoot,
    profilesRoot,
    localBinDir,
    wrapperPattern: join(localBinDir, 'swarmN'),
    tmuxSessionPattern: 'swarm-<workerId>',
    defaultBuildCommand: `cd ${workDir} && npm run build`,
    defaultTestCommand: `cd ${workDir} && npm test -- src/screens/swarm2`,
    defaultDevCommand: `cd ${workDir} && PORT=3002 npm run dev`,
    runtimeApis: [
      '/api/swarm-environment',
      '/api/swarm-runtime',
      '/api/swarm-roster',
      '/api/swarm-health',
      '/api/swarm-project',
      '/api/swarm-chat',
      '/api/swarm-decompose',
      '/api/swarm-dispatch',
      '/api/swarm-tmux-start',
      '/api/swarm-tmux-stop',
      '/api/swarm-tmux-scroll',
    ],
    writableRoots:
      workspaceMode === 'worktree' && worktreeCwd
        ? [worktreeCwd, SWARM_MEMORY_HANDOFFS]
        : [SWARM_CANONICAL_REPO, SWARM_MEMORY_HANDOFFS],
    readOnlyRoots: [
      SWARM_MEMORY_ROOT,
      profilesRoot,
      localBinDir,
      join(homedir(), '.ssh'),
    ],
    forbiddenRoots: SWARM_FORBIDDEN_PATHS,
    notes: workspaceMode === 'worktree' ? worktreeNotes : canonicalNotes,
  }
}

export function isForbiddenSwarmPath(
  pathValue: string | null | undefined,
): boolean {
  if (!pathValue) return false
  return SWARM_FORBIDDEN_PATHS.some(
    (root) => pathValue === root || pathValue.startsWith(`${root}/`),
  )
}
