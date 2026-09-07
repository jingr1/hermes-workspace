/**
 * Round-robin speaker selection and pass/reply extraction.
 *
 * Translated from upstream Bot Mode:
 *   - resolveGroupResponders
 *   - rotateGroupSpeakers
 *   - isGroupPassText
 *   - pickGroupTurnReply
 *   - unaddressedGroupMentions
 */
import { groupMemberKey, parseMentions } from './mention-routing'
import type { GroupMember, RoomMessage } from './types'

/**
 * Decide which members should respond after the last user message.
 * If nobody is explicitly mentioned, all members get a turn.
 */
export function resolveGroupResponders(
  messages: Array<RoomMessage>,
  members: Array<GroupMember>,
): Array<GroupMember> {
  let sinceLastUser: Array<RoomMessage> = []
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.senderKind === 'human') {
      sinceLastUser = messages.slice(i)
      break
    }
  }

  const mentioned = new Set<string>()
  let everyone = false

  for (const entry of sinceLastUser) {
    const parsed = parseMentions(entry.content, members)
    if (parsed.everyone) {
      everyone = true
    }
    for (const name of parsed.mentioned) {
      mentioned.add(name)
    }
  }

  if (everyone || mentioned.size === 0) {
    return members
  }

  return members.filter((member) => mentioned.has(groupMemberKey(member)))
}

/**
 * Rotate the speaker order each round so the same member doesn't always go
 * first.
 */
export function rotateGroupSpeakers(
  members: Array<GroupMember>,
  round: number,
): Array<GroupMember> {
  if (members.length < 2) return members
  const shift = round % members.length
  return [...members.slice(shift), ...members.slice(0, shift)]
}

/** True if the bot chose to pass. */
export function isGroupPassText(text: string | null | undefined): boolean {
  const trimmed = String(text || '').trim()
  if (!trimmed) return true
  return /^\(?\s*pass\s*\)?\.?$/i.test(trimmed)
}

/**
 * Pick the substantive reply from a sequence of assistant messages.
 * Scans newest-first and prefers the last non-pass answer. This handles the
 * case where a model emits an answer followed by a synthetic "(pass)".
 */
export function pickGroupTurnReply(
  messages: Array<{ role: string; content?: string | null; tool_calls?: unknown }>,
  before: number,
): string | null {
  let passText: string | null = null

  for (let i = messages.length - 1; i >= before; i--) {
    const msg = messages[i]
    if (!msg || msg.role !== 'assistant') continue

    const text = String(msg.content ?? '').trim()

    if (isGroupPassText(text)) {
      if (passText === null) passText = text
      continue
    }

    return text
  }

  return passText
}

/**
 * Heuristic for "session still grinding" when the gateway does not expose
 * session.running/inflight to REST. A tool-loop leaves the last message as
 * either a tool result or an assistant message that still has tool_calls.
 */
export function isGroupTranscriptBusy(
  messages: Array<{ role: string; tool_calls?: unknown }>,
  before: number,
): boolean {
  if (messages.length <= before) return true
  const last = messages[messages.length - 1]
  if (!last) return false
  if (last.role === 'tool') return true
  if (last.role === 'assistant' && hasToolCalls(last.tool_calls)) return true
  return false
}

function hasToolCalls(toolCalls: unknown): boolean {
  if (!toolCalls) return false
  if (Array.isArray(toolCalls)) return toolCalls.length > 0
  if (typeof toolCalls === 'string') {
    const trimmed = toolCalls.trim()
    return trimmed.length > 0 && trimmed !== '[]' && trimmed !== 'null'
  }
  return false
}

/**
 * Find members who were @mentioned recently but have not yet replied.
 * Used to trigger bounded continuation rounds.
 */
export function unaddressedGroupMentions(
  messages: Array<RoomMessage>,
  members: Array<GroupMember>,
): Array<string> {
  // key -> index of the entry that most recently cited this member.
  const lastCited = new Map<string, number>()

  for (let i = 0; i < messages.length; i++) {
    const entry = messages[i]!
    if (entry.senderKind === 'system') continue
    const parsed = parseMentions(entry.content, members)
    if (parsed.everyone) {
      for (const member of members) {
        lastCited.set(groupMemberKey(member), i)
      }
    } else {
      for (const key of parsed.mentioned) {
        lastCited.set(key, i)
      }
    }
  }

  const memberKeyByParticipantId = new Map(
    members.map((m) => [m.participantId, groupMemberKey(m)]),
  )

  const result: Array<string> = []
  for (const [key, citedIndex] of lastCited.entries()) {
    // The member has addressed the mention if they posted after the citation.
    let answered = false
    for (let i = citedIndex + 1; i < messages.length; i++) {
      const entry = messages[i]!
      if (
        entry.senderKind === 'agent' &&
        entry.senderParticipantId &&
        memberKeyByParticipantId.get(entry.senderParticipantId) === key
      ) {
        answered = true
        break
      }
    }
    if (!answered) result.push(key)
  }

  return result
}
