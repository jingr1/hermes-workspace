/**
 * pipeline-templates — load + validate pipelines.yaml (plan 模块 1).
 *
 * Templates define structure only: stage keys, owning agent, dependsOn
 * edges, review placement. Content is filled per task by stage-brief.ts.
 *
 * Load-time validation (all fail-fast, plan «校验放在 pipeline-templates»):
 *  - stage graph is acyclic (a cycle makes readyQueuedAssignments return []
 *    forever — the pipeline silently dies)
 *  - every dependsOn references an existing stage key
 *  - reworkTarget of a review stage references an existing stage
 *  - agent is declared in agents.yaml or is human:*
 *  - P2a: workspaceMode must be 'canonical'. 'worktree' is rejected until
 *    P2b (per-mission worktrees + git model) lands. Loading a worktree
 *    template in P2a is a hard error, not a silent fallback.
 *  - workspaceMode: worktree additionally forbids local hermes tmux workers
 *    (they can't switch cwd per mission) — enforced when P2b enables it.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as YAML from 'yaml'
import { loadAgentsRegistry } from '../agent-runtime/agents-config'

export type WorkspaceMode = 'canonical' | 'worktree'

export type PipelineStage = {
  key: string
  agent: string // agents.yaml id, or human:<userId>
  kind: 'work' | 'review'
  dependsOn: Array<string>
  reworkTarget: string | null
  requires: Array<string> // capability routing (P2b)
}

export type PipelineTemplate = {
  id: string
  name: string
  workspaceMode: WorkspaceMode
  stages: Array<PipelineStage>
}

export type PipelinesFile = {
  version: number
  pipelines: Array<PipelineTemplate>
}

export function getPipelinesYamlPath(repoRoot?: string): string {
  return path.join(repoRoot ?? process.cwd(), 'pipelines.yaml')
}

/** Topological cycle check over stage keys (Kahn). */
function assertAcyclicStages(template: PipelineTemplate): void {
  const keys = new Set(template.stages.map((s) => s.key))
  const indegree = new Map<string, number>()
  const edges = new Map<string, Array<string>>()
  for (const s of template.stages) indegree.set(s.key, 0)
  for (const s of template.stages) {
    for (const dep of s.dependsOn) {
      if (!keys.has(dep)) continue
      indegree.set(s.key, (indegree.get(s.key) ?? 0) + 1)
      const list = edges.get(dep) ?? []
      list.push(s.key)
      edges.set(dep, list)
    }
  }
  const queue = template.stages.filter((s) => (indegree.get(s.key) ?? 0) === 0).map((s) => s.key)
  let visited = 0
  while (queue.length > 0) {
    const cur = queue.pop()!
    visited++
    for (const next of edges.get(cur) ?? []) {
      const remaining = (indegree.get(next) ?? 0) - 1
      indegree.set(next, remaining)
      if (remaining === 0) queue.push(next)
    }
  }
  if (visited < keys.size) {
    const cyclic = template.stages.filter((s) => (indegree.get(s.key) ?? 0) > 0).map((s) => s.key)
    throw new Error(`pipeline ${template.id}: stage dependsOn cycle among: ${cyclic.join(', ')}`)
  }
}

export function validatePipelineTemplate(
  template: PipelineTemplate,
  knownAgentIds: Set<string>,
): Array<string> {
  const errors: Array<string> = []
  const keys = new Set(template.stages.map((s) => s.key))

  if (keys.size !== template.stages.length) {
    errors.push(`pipeline ${template.id}: duplicate stage keys`)
  }
  if (template.workspaceMode !== 'canonical') {
    // workspaceMode is typed canonical|worktree; runtime YAML may widen it.
    if ((template.workspaceMode as string) !== 'worktree') {
      errors.push(`pipeline ${template.id}: unknown workspaceMode "${String(template.workspaceMode)}"`)
    }
  }
  // P2a gate: worktree is P2b. Reject loudly at load.
  if (template.workspaceMode === 'worktree') {
    errors.push(`pipeline ${template.id}: workspaceMode=worktree is not enabled until P2b`)
  }
  for (const stage of template.stages) {
    if (!stage.agent.startsWith('human:') && !knownAgentIds.has(stage.agent)) {
      errors.push(`pipeline ${template.id} stage ${stage.key}: agent "${stage.agent}" not declared in agents.yaml`)
    }
    for (const dep of stage.dependsOn) {
      if (!keys.has(dep)) errors.push(`pipeline ${template.id} stage ${stage.key}: unknown dependsOn "${dep}"`)
    }
    if (stage.kind === 'review' && stage.reworkTarget && !keys.has(stage.reworkTarget)) {
      errors.push(`pipeline ${template.id} stage ${stage.key}: unknown reworkTarget "${stage.reworkTarget}"`)
    }
  }
  try {
    assertAcyclicStages(template)
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error))
  }
  return errors
}

export function loadPipelineTemplates(input?: {
  repoRoot?: string
  rawYaml?: string
  agentIds?: Set<string>
}): PipelinesFile {
  const filePath = getPipelinesYamlPath(input?.repoRoot)
  const raw = input?.rawYaml ?? (fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : null)
  if (raw === null) return { version: 1, pipelines: [] }

  const doc = YAML.parse(raw) as {
    version?: number
    pipelines?: Array<Record<string, unknown>>
  } | null

  const knownAgentIds = input?.agentIds ?? new Set(loadAgentsRegistry({ repoRoot: input?.repoRoot }).agents.map((a) => a.id))

  const pipelines: Array<PipelineTemplate> = (doc?.pipelines ?? []).map((p) => ({
    id: String(p.id ?? ''),
    name: String(p.name ?? p.id ?? ''),
    workspaceMode: (p.workspaceMode === 'worktree' ? 'worktree' : 'canonical') as WorkspaceMode,
    stages: ((p.stages as Array<Record<string, unknown>> | undefined) ?? []).map((s) => ({
      key: String(s.key ?? ''),
      agent: String(s.agent ?? ''),
      kind: (s.kind === 'review' ? 'review' : 'work'),
      dependsOn: Array.isArray(s.dependsOn) ? s.dependsOn.map(String) : [],
      reworkTarget: s.reworkTarget ? String(s.reworkTarget) : null,
      requires: Array.isArray(s.requires) ? s.requires.map(String) : [],
    })),
  }))

  const allErrors: Array<string> = []
  for (const template of pipelines) {
    allErrors.push(...validatePipelineTemplate(template, knownAgentIds))
  }
  if (allErrors.length > 0) {
    throw new Error(`pipelines.yaml validation failed:\n  - ${allErrors.join('\n  - ')}`)
  }
  return { version: doc?.version ?? 1, pipelines }
}

export function getPipelineTemplate(id: string, input?: { repoRoot?: string }): PipelineTemplate | null {
  return loadPipelineTemplates(input).pipelines.find((p) => p.id === id) ?? null
}
