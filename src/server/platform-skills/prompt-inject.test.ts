import { describe, expect, it } from 'vitest'
import {
  extractLeadingSkillTriggers,
  formatSkillBundleForPrompt,
} from './prompt-inject'

describe('platform-skills prompt-inject', () => {
  it('extracts leading skill triggers', () => {
    const result = extractLeadingSkillTriggers(
      '/reviewer /deploy please check this',
    )
    expect(result.skillNames).toEqual(['reviewer', 'deploy'])
    expect(result.remainder).toBe('please check this')
  })

  it('ignores UI slash commands', () => {
    const result = extractLeadingSkillTriggers('/new session')
    expect(result.skillNames).toEqual([])
    expect(result.remainder).toBe('/new session')
  })

  it('formats skill bundles', () => {
    const text = formatSkillBundleForPrompt([
      {
        id: '1',
        name: 'reviewer',
        description: 'Review code',
        content: 'Be careful.',
        origin: { kind: 'manual' },
        createdAt: 0,
        updatedAt: 0,
      },
    ])
    expect(text).toContain('## Skill: reviewer')
    expect(text).toContain('Be careful.')
  })
})
