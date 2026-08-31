import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { execFileSync } from 'node:child_process'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  commitStage,
  diffRange,
  ensureMissionWorktree,
  filesChangedBetween,
  gitExec,
  localGitContext,
  mergeMissionBranch,
  mergeSiblings,
  releaseMissionWorktree,
  resolveHead,
} from './git-ops'
import type { ProjectDeclaration } from './task-pipeline/projects'

function makeBareRepo(dir: string): void {
  fs.mkdirSync(dir, { recursive: true })
  execFileSync('git', ['init', '--bare', dir])
}

function makeRepo(dir: string): void {
  fs.mkdirSync(dir, { recursive: true })
  execFileSync('git', ['init'], { cwd: dir })
  execFileSync('git', ['config', 'user.email', 'test@example.com'], {
    cwd: dir,
  })
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir })
  execFileSync('git', ['checkout', '-b', 'main'], { cwd: dir })
  fs.writeFileSync(path.join(dir, 'README.md'), '# init')
  execFileSync('git', ['add', 'README.md'], { cwd: dir })
  execFileSync('git', ['commit', '-m', 'init'], { cwd: dir })
}

describe('git-ops (P2b)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'git-ops-test-'))
  let project: ProjectDeclaration

  beforeAll(() => {
    const repo = path.join(tmp, 'repo')
    const worktreeRoot = path.join(tmp, 'worktrees')
    makeRepo(repo)
    project = {
      id: 'test-project',
      repo,
      defaultBranch: 'main',
      worktreeRoot,
      setup: [],
      maxConcurrentWorktrees: 2,
      gitRemote: '',
      selfHosted: false,
      remotes: [],
    }
  })

  afterAll(() => {
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('creates a mission worktree and reports base ref', async () => {
    const { ctx, baseRef } = await ensureMissionWorktree(project, 'mission-1')
    expect(fs.existsSync(path.join(project.worktreeRoot, 'mission-1'))).toBe(
      true,
    )
    expect(baseRef.length).toBe(40)
    const head = await resolveHead(ctx)
    expect(head).toBe(baseRef)
  })

  it('commits a change and can diff base..head', async () => {
    const { ctx, baseRef } = await ensureMissionWorktree(project, 'mission-2')
    fs.writeFileSync(path.join(ctx.cwd, 'feature.md'), '# feature')
    const head = await commitStage(ctx, 'add feature')
    expect(head).not.toBe(baseRef)

    const diff = await diffRange(ctx, baseRef, head)
    expect(diff).toContain('+# feature')

    const files = await filesChangedBetween(ctx, baseRef, head)
    expect(files).toEqual(['feature.md'])
  })

  it('merges sibling branches cleanly', async () => {
    const { ctx, baseRef } = await ensureMissionWorktree(project, '3')
    const branchA = 'swarm/mission-3-a'
    const branchB = 'swarm/mission-3-b'
    execFileSync('git', ['checkout', '-b', branchA], { cwd: ctx.cwd })
    fs.writeFileSync(path.join(ctx.cwd, 'a.md'), 'A')
    await commitStage(ctx, 'a')
    execFileSync('git', ['checkout', baseRef], { cwd: ctx.cwd })
    execFileSync('git', ['checkout', '-b', branchB], { cwd: ctx.cwd })
    fs.writeFileSync(path.join(ctx.cwd, 'b.md'), 'B')
    await commitStage(ctx, 'b')
    execFileSync('git', ['checkout', 'swarm/mission-3'], { cwd: ctx.cwd })

    const result = await mergeSiblings(project, '3', [branchA, branchB])
    expect(result.ok).toBe(true)
    expect(result.conflicts).toEqual([])
  })

  it('reports conflicts when merging divergent siblings', async () => {
    const { ctx, baseRef } = await ensureMissionWorktree(project, '4')
    const branchA = 'swarm/mission-4-a'
    const branchB = 'swarm/mission-4-b'
    execFileSync('git', ['checkout', '-b', branchA], { cwd: ctx.cwd })
    fs.writeFileSync(path.join(ctx.cwd, 'shared.md'), 'A')
    await commitStage(ctx, 'a')
    execFileSync('git', ['checkout', baseRef], { cwd: ctx.cwd })
    execFileSync('git', ['checkout', '-b', branchB], { cwd: ctx.cwd })
    fs.writeFileSync(path.join(ctx.cwd, 'shared.md'), 'B')
    await commitStage(ctx, 'b')
    execFileSync('git', ['checkout', 'swarm/mission-4'], { cwd: ctx.cwd })

    const result = await mergeSiblings(project, '4', [branchA, branchB])
    expect(result.ok).toBe(false)
    expect(result.conflicts).toContain('shared.md')
  })

  it('releases a mission worktree', async () => {
    await ensureMissionWorktree(project, '5')
    await releaseMissionWorktree(project, '5')
    expect(fs.existsSync(path.join(project.worktreeRoot, '5'))).toBe(false)
  })

  it('merges mission branch into default branch', async () => {
    const { ctx, baseRef } = await ensureMissionWorktree(project, 'merge-ok')
    fs.writeFileSync(path.join(ctx.cwd, 'feature.md'), '# feature')
    await commitStage(ctx, 'add feature')

    const result = await mergeMissionBranch(project, 'merge-ok')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.mergedHead).not.toBe(baseRef)

    // default branch in the main repo should now contain the feature file.
    const mainFile = path.join(project.repo, 'feature.md')
    expect(fs.existsSync(mainFile)).toBe(true)
  })

  it('reports conflicts when merging divergent mission branch', async () => {
    const { ctx, baseRef } = await ensureMissionWorktree(project, 'merge-conflict')
    fs.writeFileSync(path.join(ctx.cwd, 'shared.md'), 'mission line')
    await commitStage(ctx, 'mission change')

    // Make default branch advance with a conflicting change.
    const mainCtx: import('./git-ops').GitContext = {
      locality: 'local',
      cwd: project.repo,
    }
    fs.writeFileSync(path.join(project.repo, 'shared.md'), 'main line')
    await gitExec(mainCtx, ['add', '-A'])
    await gitExec(mainCtx, ['commit', '-m', 'main change'])

    const result = await mergeMissionBranch(project, 'merge-conflict')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.conflicts).toContain('shared.md')

    // default branch should be back to a clean state.
    const status = await gitExec(mainCtx, ['status', '--porcelain'])
    expect(status.stdout).toBe('')
  })
})
