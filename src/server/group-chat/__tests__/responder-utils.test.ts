import { describe, it, expect, beforeEach } from 'vitest'
import {
  isGroupPassText,
  isGroupTranscriptBusy,
  pickGroupTurnReply,
  resolveGroupResponders,
  rotateGroupSpeakers,
  unaddressedGroupMentions,
} from '../responder-utils'
import {
  clearAllRunnerState,
  clearStranded,
  getStranded,
  hasStranded,
  listStrandedMembers,
  setStranded,
} from '../runner-state'
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

  describe('pickGroupTurnReply', () => {
    it('prefers the newest substantive reply over an earlier ack', () => {
      const messages = [
        { role: 'user', content: 'go' },
        { role: 'assistant', content: '我先去查一下' },
        { role: 'assistant', content: '', tool_calls: [{ id: '1' }] },
        { role: 'tool', content: '{}' },
        { role: 'assistant', content: '结论：两层截断都存在' },
      ]
      expect(pickGroupTurnReply(messages, 1)).toBe('结论：两层截断都存在')
    })

    it('skips trailing pass in favor of earlier real answer', () => {
      const messages = [
        { role: 'user', content: 'go' },
        { role: 'assistant', content: 'real answer' },
        { role: 'assistant', content: '(pass)' },
      ]
      expect(pickGroupTurnReply(messages, 1)).toBe('real answer')
    })

    it('returns newest pass when only passes exist', () => {
      const messages = [
        { role: 'assistant', content: 'pass' },
        { role: 'assistant', content: '(pass)' },
      ]
      expect(pickGroupTurnReply(messages, 0)).toBe('(pass)')
    })
  })

  describe('isGroupTranscriptBusy', () => {
    it('is busy when last message is a tool result', () => {
      expect(
        isGroupTranscriptBusy(
          [
            { role: 'user' },
            { role: 'assistant', tool_calls: [{ id: '1' }] },
            { role: 'tool' },
          ],
          1,
        ),
      ).toBe(true)
    })

    it('is busy when last assistant still has tool_calls', () => {
      expect(
        isGroupTranscriptBusy(
          [{ role: 'assistant', tool_calls: [{ id: '1' }] }],
          0,
        ),
      ).toBe(true)
    })

    it('is idle when last assistant is final text', () => {
      expect(
        isGroupTranscriptBusy(
          [
            { role: 'assistant', tool_calls: [{ id: '1' }] },
            { role: 'tool' },
            { role: 'assistant' },
          ],
          0,
        ),
      ).toBe(false)
    })

    it('is busy when nothing new after baseline', () => {
      expect(isGroupTranscriptBusy([{ role: 'user' }], 1)).toBe(true)
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

describe('stranded runner-state', () => {
  const member = makeAgent('developer', 'developer')

  beforeEach(() => {
    clearAllRunnerState()
  })

  it('records and clears stranded markers', () => {
    expect(hasStranded('room1', member)).toBe(false)
    setStranded('room1', member, { before: 4, sessionId: 'sess_1' })
    expect(hasStranded('room1', member)).toBe(true)
    expect(getStranded('room1', member)?.before).toBe(4)
    expect(listStrandedMembers('room1')).toEqual(['agent:developer'])
    clearStranded('room1', member)
    expect(hasStranded('room1', member)).toBe(false)
  })
})
