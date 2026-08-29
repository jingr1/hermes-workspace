import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let tempRoot: string
let dbPath: string

async function loadModules() {
  vi.resetModules()
  tempRoot = mkdtempSync(join(tmpdir(), 'task-pipeline-test-'))
  dbPath = join(tempRoot, 'collab.db')
  vi.doMock('../collab-db', async () => {
    const actual = await vi.importActual('../collab-db')
    return { ...actual, getCollabDbPath: () => dbPath }
  })
  vi.doMock('../../server/collab-db', async () => {
    const actual = await vi.importActual('../../server/collab-db')
    return { ...actual, getCollabDbPath: () => dbPath }
  })
  vi.doMock('../../server/swarm-environment', () => ({
    SWARM_CANONICAL_REPO: tempRoot,
    SWARM_MEMORY_HANDOFFS: join(tempRoot, 'memory'),
    SWARM_LEGACY_OUTPUT_ROOT: join(tempRoot, 'output'),
  }))
  vi.doMock('../../server/agent-runtime/agents-config', () => ({
    loadAgentsRegistry: () => ({
      version: 1,
      agents: [
        {
          id: 'orchestrator',
          runtime: 'hermes',
          execution: 'local',
          profile: 'orchestrator',
          capabilities: [],
        },
        {
          id: 'gpuserver',
          runtime: 'hermes',
          execution: 'ssh',
          profile: 'gpuserver',
          capabilities: ['gpu'],
        },
        {
          id: 'cc-impl',
          runtime: 'claude-code',
          execution: 'local',
          command: 'claude',
          capabilities: [],
        },
      ],
      byId: new Map([
        [
          'orchestrator',
          {
            id: 'orchestrator',
            runtime: 'hermes',
            execution: 'local',
            profile: 'orchestrator',
            capabilities: [],
          },
        ],
        [
          'gpuserver',
          {
            id: 'gpuserver',
            runtime: 'hermes',
            execution: 'ssh',
            profile: 'gpuserver',
            capabilities: ['gpu'],
          },
        ],
        [
          'cc-impl',
          {
            id: 'cc-impl',
            runtime: 'claude-code',
            execution: 'local',
            command: 'claude',
            capabilities: [],
          },
        ],
      ]),
      orphanProfiles: [],
    }),
    detectExecutionFromProfile: () => 'local',
    getProfileSshHost: () => null,
  }))
  const templates =
    await import('../../server/task-pipeline/pipeline-templates')
  const taskService = await import('../../server/task-pipeline/task-service')
  const review = await import('../../server/task-pipeline/review')
  const laneSync = await import('../../server/task-pipeline/lane-sync')
  const stageBrief = await import('../../server/task-pipeline/stage-brief')
  const missions = await import('../../server/swarm-missions')
  return { templates, taskService, review, laneSync, stageBrief, missions }
}

afterEach(() => {
  vi.resetModules()
  vi.doUnmock('../collab-db')
  vi.doUnmock('../../server/collab-db')
  vi.doUnmock('../../server/swarm-environment')
  vi.doUnmock('../../server/agent-runtime/agents-config')
  try {
    rmSync(tempRoot, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})

const AGENTS = [
  'researcher',
  'architect',
  'developer',
  'learning',
  'writer',
  'orchestrator',
]

const VALID_PIPELINE = `
version: 1
pipelines:
  - id: default-build
    name: build
    workspaceMode: canonical
    stages:
      - key: research
        agent: researcher
        dependsOn: []
      - key: spec
        agent: architect
        dependsOn: [research]
      - key: build
        agent: developer
        dependsOn: [spec]
      - key: review
        agent: architect
        kind: review
        reworkTarget: build
        dependsOn: [build]
      - key: retro
        agent: learning
        dependsOn: [review]
`

describe('pipeline-templates', () => {
  it('loads a valid canonical pipeline', async () => {
    const { templates } = await loadModules()
    const file = templates.loadPipelineTemplates({
      rawYaml: VALID_PIPELINE,
      agentIds: new Set(AGENTS),
    })
    expect(file.pipelines).toHaveLength(1)
    expect(file.pipelines[0].stages.map((s) => s.key)).toEqual([
      'research',
      'spec',
      'build',
      'review',
      'retro',
    ])
    expect(file.pipelines[0].workspaceMode).toBe('canonical')
  })

  it('rejects local hermes worker in worktree mode', async () => {
    const { templates } = await loadModules()
    const rawYaml = `
version: 1
pipelines:
  - id: worktree-local
    name: worktree-local
    workspaceMode: worktree
    stages:
      - key: only
        agent: orchestrator
        dependsOn: []
`
    expect(() =>
      templates.loadPipelineTemplates({
        repoRoot: '/tmp',
        rawYaml,
        agentIds: new Set(['orchestrator']),
      }),
    ).toThrow(/workspaceMode=worktree forbids local hermes tmux worker/)
  })

  it('allows managed CLI adapter in worktree mode', async () => {
    const { templates } = await loadModules()
    const rawYaml = VALID_PIPELINE.replace(
      'workspaceMode: canonical',
      'workspaceMode: worktree',
    )
    expect(() =>
      templates.loadPipelineTemplates({
        repoRoot: '/tmp',
        rawYaml,
        agentIds: new Set(['researcher', 'architect', 'developer', 'learning']),
      }),
    ).not.toThrow()
  })

  it('rejects cyclic stage graph', async () => {
    const { templates } = await loadModules()
    expect(() =>
      templates.loadPipelineTemplates({
        rawYaml: `
version: 1
pipelines:
  - id: cyc
    workspaceMode: canonical
    stages:
      - key: a
        agent: researcher
        dependsOn: [b]
      - key: b
        agent: architect
        dependsOn: [a]
`,
        agentIds: new Set(AGENTS),
      }),
    ).toThrow(/cycle/)
  })

  it('rejects unknown dependsOn / reworkTarget / agent', async () => {
    const { templates } = await loadModules()
    expect(() =>
      templates.loadPipelineTemplates({
        rawYaml: VALID_PIPELINE.replace(
          'dependsOn: [research]',
          'dependsOn: [ghost]',
        ).replace('reworkTarget: build', 'reworkTarget: ghost'),
        agentIds: new Set(AGENTS),
      }),
    ).toThrow(/unknown dependsOn|unknown reworkTarget/)
    expect(() =>
      templates.loadPipelineTemplates({
        rawYaml: VALID_PIPELINE.replace('agent: researcher', 'agent: nobody'),
        agentIds: new Set(AGENTS),
      }),
    ).toThrow(/not declared in agents.yaml/)
  })
})

describe('stage-brief staleness', () => {
  it('isBriefStale compares versions', async () => {
    const { stageBrief } = await loadModules()
    expect(stageBrief.isBriefStale(1, 1)).toBe(false)
    expect(stageBrief.isBriefStale(1, 2)).toBe(true)
  })
})

describe('review.ts', () => {
  it('parseReviewOutcome extracts verdict + feedback', async () => {
    const { review } = await loadModules()
    expect(review.parseReviewOutcome('REVIEW_OUTCOME: approved')).toEqual({
      outcome: 'approved',
      feedback: null,
    })
    const cr = review.parseReviewOutcome(
      'REVIEW_OUTCOME: changes_requested\nfile x.ts line 3 is wrong',
    )
    expect(cr?.outcome).toBe('changes_requested')
    expect(cr?.feedback).toContain('x.ts')
    expect(review.parseReviewOutcome('no verdict here')).toBeNull()
  })
})

describe('task-service instantiatePipeline (two-pass)', () => {
  it('builds a mission with dependsOn wired stage→assignment and a single ready first stage', async () => {
    const { templates, taskService, missions } = await loadModules()
    const template = templates.loadPipelineTemplates({
      rawYaml: VALID_PIPELINE,
      agentIds: new Set(AGENTS),
    }).pipelines[0]

    const mission = taskService.instantiatePipeline({
      template,
      title: 'Build the thing',
      spec: 'spec text here',
      acceptanceCriteria: ['works'],
      cardId: 'card-1',
    })

    // 5 stages → 5 assignments, architect owns spec+review (two assignments).
    expect(mission.assignments).toHaveLength(5)
    expect(mission.pipelineId).toBe('default-build')
    expect(mission.taskId).toBe('card-1')
    expect(mission.specVersion).toBe(1)

    const byStage = new Map(mission.assignments.map((a) => [a.stageKey, a]))
    // research has no deps; spec depends on research's assignment id, etc.
    expect(byStage.get('research')!.dependsOn).toEqual([])
    expect(byStage.get('spec')!.dependsOn).toEqual([
      byStage.get('research')!.id,
    ])
    expect(byStage.get('build')!.dependsOn).toEqual([byStage.get('spec')!.id])
    expect(byStage.get('review')!.dependsOn).toEqual([byStage.get('build')!.id])
    expect(byStage.get('retro')!.dependsOn).toEqual([byStage.get('review')!.id])

    // Only research is dispatchable initially.
    const ready = missions.readyQueuedAssignments(mission.id)
    expect(ready.map((a) => a.stageKey)).toEqual(['research'])

    // Brief text carries the spec and stage role.
    expect(byStage.get('build')!.task).toContain('spec text here')
    expect(byStage.get('review')!.task).toContain('REVIEW_OUTCOME')
  })
})

describe('lane-sync', () => {
  it('maps mission state to lane', async () => {
    const { laneSync } = await loadModules()
    const base = {
      id: 'm',
      title: 't',
      state: 'executing' as const,
      createdAt: 0,
      updatedAt: 0,
      events: [],
    }
    const mk = (state: string) => ({
      id: state,
      workerId: 'w',
      task: '',
      rationale: null,
      dependsOn: [],
      reviewRequired: false,
      state,
      dispatchedAt: null,
      completedAt: null,
      reviewedAt: null,
      reviewedBy: null,
      checkpoint: null,
    })
    expect(
      laneSync.laneFromMission({
        ...base,
        state: 'complete',
        assignments: [],
      } as never),
    ).toBe('done')
    expect(
      laneSync.laneFromMission({
        ...base,
        assignments: [mk('blocked')],
      } as never),
    ).toBe('blocked')
    expect(
      laneSync.laneFromMission({
        ...base,
        assignments: [mk('dispatched')],
      } as never),
    ).toBe('running')
    expect(
      laneSync.laneFromMission({
        ...base,
        assignments: [mk('reviewing')],
      } as never),
    ).toBe('review')
    expect(
      laneSync.laneFromMission({
        ...base,
        assignments: [mk('queued')],
      } as never),
    ).toBe('ready')
  })
})
