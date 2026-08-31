import type { Participant } from './participants'

export type MentionTarget =
  | { type: 'human'; participantId: string }
  | { type: 'agent'; participantId: string }
  | { type: 'all' }

export type ParsedMentions = {
  text: string
  mentions: MentionTarget[]
  answeredPendingTurnId?: string
}

const ALL_NAMES = ['all']
const HUMAN_NAMES = ['human', 'me', 'owner']

export function parseMentions(
  text: string,
  participants: Participant[],
  opts?: {
    ownerParticipantId?: string | null
    pendingTurnId?: string
  },
): ParsedMentions {
  const mentionTargets: MentionTarget[] = []
  let cleanedText = text

  const mentionRe = /@([a-zA-Z0-9_\-.\u4e00-\u9fff]+)/g
  const seen = new Set<string>()

  cleanedText = text.replace(mentionRe, (match, rawName) => {
    const name = rawName.toLowerCase().replace(/\s+/g, '-')

    if (name.startsWith('task-') || /^\d+$/.test(name)) {
      // Reserved for #task-id references, not a participant mention.
      return match
    }

    if (ALL_NAMES.includes(name)) {
      if (!seen.has('all')) {
        mentionTargets.push({ type: 'all' })
        seen.add('all')
      }
      return match
    }

    if (HUMAN_NAMES.includes(name) && opts?.ownerParticipantId) {
      if (!seen.has(`human:${opts.ownerParticipantId}`)) {
        mentionTargets.push({ type: 'human', participantId: opts.ownerParticipantId })
        seen.add(`human:${opts.ownerParticipantId}`)
      }
      return match
    }

    const participant = participants.find(
      (p) => p.mention_name.toLowerCase() === name && p.removed_at === 0,
    )
    if (participant) {
      const key = `${participant.kind}:${participant.participant_id}`
      if (!seen.has(key)) {
        mentionTargets.push({
          type: participant.kind,
          participantId: participant.participant_id,
        })
        seen.add(key)
      }
      return match
    }

    // Unknown mention: leave the text but don't route.
    return match
  })

  return {
    text: cleanedText,
    mentions: mentionTargets,
    answeredPendingTurnId: opts?.pendingTurnId,
  }
}

export function resolveMentionTargets(
  mentions: MentionTarget[],
  participants: Participant[],
): { humans: Participant[]; agents: Participant[] } {
  const humans: Participant[] = []
  const agents: Participant[] = []

  for (const m of mentions) {
    if (m.type === 'all') {
      for (const p of participants) {
        if (p.removed_at !== 0) continue
        if (p.kind === 'human') humans.push(p)
        else agents.push(p)
      }
      continue
    }

    const p = participants.find(
      (x) => x.participant_id === m.participantId && x.removed_at === 0,
    )
    if (!p) continue
    if (p.kind === 'human') humans.push(p)
    else agents.push(p)
  }

  return { humans, agents }
}

export function formatMentionDisplay(mentionName: string): string {
  return `@${mentionName}`
}
