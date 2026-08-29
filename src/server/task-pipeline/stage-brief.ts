/**
 * stage-brief — per-task instruction text for each pipeline stage.
 *
 * Plan «模板只定流程，内容由 decompose 填»: the template gives the stage
 * skeleton (key + agent + dependsOn); this module produces the concrete,
 * self-contained instruction text the agent receives at dispatch time.
 *
 * Staleness rule (plan): the spec can be edited after briefs are generated.
 * Each assignment records briefSpecVersion; the mission carries specVersion
 * (bumped on every spec edit). Before dispatch, a stage whose
 * briefSpecVersion !== mission.specVersion is STALE and must be regenerated
 * or human-confirmed — never silently dispatched with old text. Already
 * dispatched/completed stages are unaffected (history reflects its time).
 *
 * P2a minimal generation: structured template text per stage kind. The full
 * LLM-backed decompose (model writes content per stage) is a follow-up; the
 * fallback here IS the plan's «模板措辞 + spec 全文» heuristic floor.
 */
import type { PipelineStage } from './pipeline-templates'

export type StageBrief = {
  stageKey: string
  agent: string
  instruction: string
  specVersion: number
}

const ROLE_GUIDANCE: Record<string, string> = {
  research:
    'Establish facts only: competitive analysis, data validation, source tracing. ' +
    'No strategy, no recommendations. Cite evidence for every claim.',
  spec:
    'Produce the technical/content spec: wedge, bets, kill criteria, interface ' +
    'definitions, file-level plan. Choose exactly one build executor lane.',
  build:
    'Implement per the spec. Code + tests + build verification. No architecture ' +
    'changes; escalate spec gaps back to the architect.',
  review:
    'Review the build output against the spec. Output REVIEW_OUTCOME: approved ' +
    'or REVIEW_OUTCOME: changes_requested with concrete file/line feedback.',
  retro:
    'Document lessons learned; ingest durable knowledge. Mission wrap-up only.',
}

function guidanceFor(stage: PipelineStage): string {
  if (stage.kind === 'review') return ROLE_GUIDANCE.review
  return (
    ROLE_GUIDANCE[stage.key] ??
    `Execute stage "${stage.key}" per the task spec.`
  )
}

/**
 * Generate the brief for one stage. Self-contained: spec text + stage role
 * guidance + dependency context line. Deterministic (no model call) in P2a.
 */
export function generateStageBrief(input: {
  stage: PipelineStage
  taskTitle: string
  spec: string
  acceptanceCriteria: Array<string>
  specVersion: number
  upstreamSummary?: string | null
}): StageBrief {
  const { stage } = input
  const lines: Array<string> = [
    `# Stage: ${stage.key} (agent: ${stage.agent})`,
    ``,
    `## Task`,
    input.taskTitle,
    ``,
    `## Spec (authoritative, specVersion=${input.specVersion})`,
    input.spec.trim() || '(no spec text)',
    ``,
    `## Acceptance criteria`,
    ...(input.acceptanceCriteria.length > 0
      ? input.acceptanceCriteria.map((c) => `- ${c}`)
      : ['- (none declared)']),
    ``,
    `## Your role at this stage`,
    guidanceFor(stage),
  ]
  if (stage.dependsOn.length > 0) {
    lines.push(
      ``,
      `## Depends on (must be complete)`,
      ...stage.dependsOn.map((d) => `- ${d}`),
    )
  }
  if (input.upstreamSummary) {
    lines.push(``, `## Upstream handoff`, input.upstreamSummary)
  }
  if (stage.kind === 'review') {
    lines.push(
      ``,
      `## Review protocol`,
      `End with exactly one of:`,
      `  REVIEW_OUTCOME: approved`,
      `  REVIEW_OUTCOME: changes_requested  (with concrete file/line feedback)`,
    )
  }
  return {
    stageKey: stage.key,
    agent: stage.agent,
    instruction: lines.join('\n'),
    specVersion: input.specVersion,
  }
}

/**
 * Is this stage's brief stale relative to the mission's current specVersion?
 * Stale briefs must NOT be dispatched silently.
 */
export function isBriefStale(
  briefSpecVersion: number,
  missionSpecVersion: number,
): boolean {
  return briefSpecVersion !== missionSpecVersion
}
