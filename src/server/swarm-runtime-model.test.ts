import { describe, expect, it } from 'vitest'

import {
  buildHermesChatQueryArgs,
  buildSwarmModelEnvAssignments,
} from './swarm-runtime-model'

describe('swarm-runtime-model', () => {
  it('builds launch-scoped model env without touching config files', () => {
    expect(
      buildSwarmModelEnvAssignments({
        provider: 'moonshot-coding-plan',
        default: 'kimi-for-coding',
      }),
    ).toEqual([
      "HERMES_MODEL='kimi-for-coding'",
      "HERMES_INFERENCE_MODEL='kimi-for-coding'",
      "HERMES_TUI_PROVIDER='moonshot-coding-plan'",
      "HERMES_INFERENCE_PROVIDER='moonshot-coding-plan'",
    ])
  })

  it('passes per-dispatch --model/--provider after the -q prompt', () => {
    const prompt = 'STATE: DONE\nRESULT: ok'
    const args = buildHermesChatQueryArgs(prompt, {
      provider: 'moonshot-coding-plan',
      default: 'kimi-for-coding',
    })

    expect(args.slice(0, 7)).toEqual([
      'chat',
      '-q',
      prompt,
      '--model',
      'kimi-for-coding',
      '--provider',
      'moonshot-coding-plan',
    ])
    expect(args).toContain('-Q')
    expect(args).toContain('--source')
  })

  it('leaves chat args unchanged when no runtime model is provided', () => {
    const prompt = 'ping'
    const args = buildHermesChatQueryArgs(prompt)
    expect(args.slice(0, 3)).toEqual(['chat', '-q', prompt])
    expect(args).not.toContain('--model')
  })
})
