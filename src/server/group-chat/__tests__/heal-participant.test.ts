/** @vitest-environment node */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resetCollabDbForTests } from '../room-store'

vi.mock('../../agent-runtime/agents-config', () => ({
  loadAgentsRegistry: () => ({
    agents: [
      {
        id: 'cc-impl',
        runtime: 'claude-code',
        profile: undefined,
        displayName: 'Claude Code',
        mentionName: 'claude',
      },
      {
        id: 'developer',
        runtime: 'hermes',
        profile: 'developer',
        displayName: 'developer',
        mentionName: 'developer',
      },
    ],
  }),
}))

describe('healParticipantFromRegistry', () => {
  let dbPath: string

  beforeEach(() => {
    dbPath = resetCollabDbForTests()
  })

  it('fixes stale hermes runtime on claude-code agent id', async () => {
    const {
      addParticipant,
      createRoom,
      healParticipantFromRegistry,
      listParticipants,
    } = await import('../room-store')
    const room = createRoom({ title: 't', dbPath })
    addParticipant({
      roomId: room.id,
      kind: 'agent',
      participantId: 'cc-impl',
      displayName: 'cc-impl',
      runtime: 'hermes',
      profile: 'cc-impl',
      dbPath,
    })
    const stale = listParticipants(room.id, { dbPath })[0]!
    expect(stale.runtime).toBe('hermes')
    const healed = healParticipantFromRegistry(stale, { dbPath })
    expect(healed.runtime).toBe('claude-code')
    expect(healed.profile).toBeNull()
    const again = listParticipants(room.id, { dbPath })[0]!
    expect(again.runtime).toBe('claude-code')
    expect(again.profile).toBeNull()
  })

  it('toHealedGroupMember heals before returning', async () => {
    const {
      addParticipant,
      createRoom,
      listParticipants,
      toHealedGroupMember,
    } = await import('../room-store')
    const room = createRoom({ title: 't', dbPath })
    addParticipant({
      roomId: room.id,
      kind: 'agent',
      participantId: 'cc-impl',
      runtime: 'hermes',
      profile: 'cc-impl',
      dbPath,
    })
    const member = toHealedGroupMember(
      listParticipants(room.id, { dbPath })[0]!,
      { dbPath },
    )
    expect(member.runtime).toBe('claude-code')
    expect(member.profile).toBeNull()
  })
})
