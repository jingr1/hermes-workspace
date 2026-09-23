/**
 * Format enabled platform skills for managed-agent turn/session injection.
 */
import { listEnabledSkillsWithContent } from './store'
import type { PlatformSkill } from './types'

export function formatSkillBundleForPrompt(
  skills: Array<PlatformSkill>,
  opts?: { selectedNames?: Array<string> },
): string {
  const selected = opts?.selectedNames?.map((n) => n.toLowerCase())
  const filtered = selected?.length
    ? skills.filter((s) => selected.includes(s.name.toLowerCase()))
    : skills
  if (filtered.length === 0) return ''
  const parts = filtered.map((skill) => {
    const files =
      skill.files
        ?.map((f) => `\n\n### File: ${f.path}\n\`\`\`\n${f.content}\n\`\`\``)
        .join('') ?? ''
    return `## Skill: ${skill.name}\n${skill.description ? `${skill.description}\n\n` : ''}${skill.content}${files}`
  })
  return [
    '<!-- agorax-platform-skills -->',
    'The following workspace skills are bound and enabled for this agent. Follow them when relevant.',
    ...parts,
    '<!-- /agorax-platform-skills -->',
  ].join('\n\n')
}

/** Extract leading `/skill-name` tokens from a composer message. */
export function extractLeadingSkillTriggers(text: string): {
  skillNames: Array<string>
  remainder: string
} {
  const tokens = text.trimStart().split(/\s+/)
  const skillNames: Array<string> = []
  let i = 0
  while (i < tokens.length) {
    const token = tokens[i] ?? ''
    if (!token.startsWith('/') || token.length < 2) break
    const name = token.slice(1).toLowerCase()
    // Skip known UI slash commands
    if (
      name === 'new' ||
      name === 'clear' ||
      name === 'model' ||
      name === 'help' ||
      name === 'skills' ||
      name === 'skill'
    ) {
      break
    }
    skillNames.push(name)
    i += 1
  }
  const remainder = tokens.slice(i).join(' ').trim()
  return { skillNames, remainder }
}

export function buildManagedSkillPromptPrefix(agentId: string): string {
  const skills = listEnabledSkillsWithContent(agentId)
  return formatSkillBundleForPrompt(skills)
}

export function buildTurnSkillInjection(
  agentId: string,
  userText: string,
): { text: string; injected: Array<string> } {
  const { skillNames, remainder } = extractLeadingSkillTriggers(userText)
  if (skillNames.length === 0) {
    return { text: userText, injected: [] }
  }
  const skills = listEnabledSkillsWithContent(agentId)
  const bundle = formatSkillBundleForPrompt(skills, {
    selectedNames: skillNames,
  })
  if (!bundle) {
    return { text: userText, injected: [] }
  }
  const text = remainder
    ? `${bundle}\n\n${remainder}`
    : `${bundle}\n\n(Use the skill(s) above.)`
  return { text, injected: skillNames }
}
