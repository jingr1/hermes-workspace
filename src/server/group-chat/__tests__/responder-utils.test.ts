import { describe, it, expect } from 'vitest'
import {
  isGroupPassText,
  resolveGroupResponders,
  rotateGroupSpeakers,
  unaddressedGroupMentions,
} from '../responder-utils'
import type { GroupMember, MentionTarget, RoomMessage } from '../types'

function makeAgent(id: string, displayName: string): GroupMember {
  return {
    id: `${id}-id`,
    kind: 'agent',
    participantId: id,
    displayName,
    name: displayName,
    mentionName: id,
    runtime: 'hermes',
    isBot: true,
    profile: null,
  }
}

function makeHuman(id: string, displayName: string): GroupMember {
  return {
    id: `${id}-id`,
    kind: 'human',
    participantId: id,
    displayName,
    name: displayName,
    mentionName: id,
    runtime: 'human',
    isBot: false,
    profile: null,
  }
}

function makeMsg(
  senderKind: 'agent' | 'human',
  sender: string,
  content: string,
  mentions: Array<MentionTarget> = [],
): RoomMessage {
  return {
    id: `msg_${sender}_${content.slice(0, 5)}`,
    roomId: 'r1',
    senderKind,
    senderParticipantId: sender,
    senderName: sender,
    content,
    mentions,
    mentionDepth: 0,
    autoHandoff: false,
    taskRefs: [],
    answersPendingTurnId: null,
    runId: null,
    taskId: null,
    createdAt: Date.now(),
  }
}

describe('responder-utils', () => {
  const members = [
    makeAgent('a', 'Alpha'),
    makeAgent('b', 'Beta'),
    makeHuman('h', 'Human'),
  ]

  describe('isGroupPassText', () => {
    it('detects pass replies', () => {
      expect(isGroupPassText('pass')).toBe(true)
      expect(isGroupPassText('  Pass.  ')).toBe(true)
      expect(isGroupPassText('(pass)')).toBe(true)
    })

    it('allows real replies', () => {
      expect(isGroupPassText('I agree with the plan')).toBe(false)
      expect(isGroupPassText('passing the salt')).toBe(false)
    })
  })

  describe('rotateGroupSpeakers', () => {
    it('rotates round-robin', () => {
      expect(rotateGroupSpeakers(members, 0).map((m) => m.participantId)).toEqual(
        ['a', 'b', 'h'],
      )
      expect(rotateGroupSpeakers(members, 1).map((m) => m.participantId)).toEqual(
        ['b', 'h', 'a'],
      )
    })
  })

  describe('resolveGroupResponders', () => {
    it('returns addressed responders when present', () => {
      const messages = [
        makeMsg('human', 'human', '@a @b help', [
          { type: 'agent', participantId: 'a' },
          { type: 'agent', participantId: 'b' },
        ]),
      ]
      const responders = resolveGroupResponders(messages, members)
      expect(responders.map((r) => r.participantId)).toEqual(['a', 'b'])
    })

    it('falls back to all members when no mentions', () => {
      const messages = [makeMsg('human', 'human', 'any thoughts?')]
      const responders = resolveGroupResponders(messages, members)
      expect(responders.map((r) => r.participantId)).toEqual(['a', 'b', 'h'])
    })

    it('expands @all', () => {
      const messages = [makeMsg('human', 'human', '@all', [{ type: 'all' }])]
      const responders = resolveGroupResponders(messages, members)
      expect(responders.map((r) => r.participantId)).toEqual(['a', 'b', 'h'])
    })
  })

  describe('unaddressedGroupMentions', () => {
    it('returns member keys mentioned but not yet replied', () => {
      const messages: Array<RoomMessage> = [
        makeMsg('human', 'human', 'hello @a @b', [
          { type: 'agent', participantId: 'a' },
          { type: 'agent', participantId: 'b' },
        ]),
        makeMsg('agent', 'a', 'I can help', []),
      ]
      expect(unaddressedGroupMentions(messages, members)).toEqual([
        'agent:b',
      ])
    })

    it('returns empty once everyone replied', () => {
      const messages: Array<RoomMessage> = [
        makeMsg('human', 'human', '@a @b', [
          { type: 'agent', participantId: 'a' },
          { type: 'agent', participantId: 'b' },
        ]),
        makeMsg('agent', 'a', 'reply a', []),
        makeMsg('agent', 'b', 'reply b', []),
      ]
      expect(unaddressedGroupMentions(messages, members)).toEqual([])
    })
  })
})
