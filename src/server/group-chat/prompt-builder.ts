/**
 * Build the turn prompt for a group-chat member.
 *
 * This is a direct translation of upstream buildGroupChatTurnPrompt, adapted
 * for workspace storage shapes (RoomMessage instead of plugin log entries).
 */
import type { GroupMember, RoomMessage } from './types'
import { groupMemberKey } from './mention-routing'

export type BuildPromptInput = {
  groupName: string
  members: Array<GroupMember>
  viewer: GroupMember
  deltaLines: Array<string>
}

export function buildGroupChatTurnPrompt(
  input: BuildPromptInput,
): string {
  const viewerKey = groupMemberKey(input.viewer)
  const peers = input.members.filter(
    (m) => groupMemberKey(m) !== viewerKey,
  )
  const peerNames = peers
    .map((m) => {
      const handle = `@${m.mentionName || m.displayName}`
      return m.displayName ? `${m.displayName} (${handle})` : handle
    })
    .join(', ')

  return [
    `[Group chat: "${input.groupName}"] You are @${input.viewer.mentionName || input.viewer.displayName}, one participant in a group chat with ${peerNames || 'no one else yet'} and the user.`,
    '',
    'New messages in the room since your last turn (oldest first):',
    ...input.deltaLines.map((line) => `  ${line}`),
    '',
    'Rules for this room:',
    '- Reply with ONE conversational message ONLY if you have something new worth adding: build on what was just said, claim or hand off work, answer a question aimed at you, or report a real result. Keep chatter short (1-3 sentences) — but when you are delivering a result, an answer the user asked for, or substantive work, give it at full quality and length; never thin out real content to fit the room.',
    '- If you have nothing new to add, reply with exactly "(pass)". Passing is good — it lets the conversation settle.',
    '- Mention a teammate as @name to pull them in; mention @user only for a judgment call or a result the user needs. Do not repeat points already made.',
    '- Never reveal content from your private 1:1 chats. Your reply text goes to the room verbatim — no preamble, no meta-commentary.',
  ].join('\n')
}

export function formatGroupChatLine(
  message: RoomMessage,
  viewerName: string,
): string {
  const suffix = message.senderName === viewerName ? ' (you)' : ''
  const prefix =
    message.senderKind === 'human'
      ? `${message.senderName} (user)`
      : `${message.senderName}${suffix}`
  return `${prefix}: ${message.content}`
}

/**
 * Compose the [Summary] + [Recent messages] context for a participant turn.
 */
export function buildTurnContext(
  groupName: string,
  members: Array<GroupMember>,
  viewer: GroupMember,
  messages: Array<RoomMessage>,
  summary?: string | null,
): string {
  const deltaLines = messages.map((m) => formatGroupChatLine(m, viewer.name))
  const prompt = buildGroupChatTurnPrompt({
    groupName,
    members,
    viewer,
    deltaLines,
  })
  if (summary) {
    return `[Earlier conversation summary]\n${summary}\n\n${prompt}`
  }
  return prompt
}
