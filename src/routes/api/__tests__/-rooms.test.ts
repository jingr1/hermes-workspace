import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: (_path: string) => (opts: any) => opts,
}))

vi.mock('../../server/auth-middleware', () => ({
  isAuthenticated: () => true,
}))

let tmpHome = ''

function writeSwarmMissions(missions: Array<Record<string, unknown>>) {
  const runtimePath = path.join(tmpHome, '.runtime')
  fs.mkdirSync(runtimePath, { recursive: true })
  fs.writeFileSync(
    path.join(runtimePath, 'swarm-missions.json'),
    JSON.stringify({ version: 1, missions }, null, 2) + '\n',
    'utf-8',
  )
}

async function makePostHandlers() {
  const mod = await import('../rooms')
  return (mod as any).Route.server.handlers
}

async function makeRoomIdHandlers() {
  const mod = await import('../rooms/$roomId')
  return (mod as any).Route.server.handlers
}

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'rooms-route-test-'))
  vi.stubEnv('HERMES_HOME', tmpHome)
  vi.stubEnv('CLAUDE_HOME', '')
  vi.resetModules()
})

afterEach(() => {
  vi.unstubAllEnvs()
  fs.rmSync(tmpHome, { recursive: true, force: true })
})

describe('POST /api/rooms taskId -> missionId backfill', () => {
  it('writes taskId into missionId when taskId is an existing mission id', async () => {
    writeSwarmMissions([
      {
        id: 'mission-123',
        title: 'Existing mission',
        state: 'executing',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        assignments: [],
        events: [],
      },
    ])

    const handlers = await makePostHandlers()
    const res = await handlers.POST({
      request: new Request('http://localhost/api/rooms', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'Room for mission', taskId: 'mission-123' }),
      }),
    })
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.ok).toBe(true)
    expect(body.room.taskId).toBe('mission-123')
    expect(body.room.missionId).toBe('mission-123')
  })

  it('does NOT overwrite missionId when taskId is not a known mission id', async () => {
    writeSwarmMissions([])

    const handlers = await makePostHandlers()
    const res = await handlers.POST({
      request: new Request('http://localhost/api/rooms', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          title: 'Room with kanban task',
          taskId: 'kanban-task-456',
          missionId: 'explicit-mission-789',
        }),
      }),
    })
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.ok).toBe(true)
    expect(body.room.taskId).toBe('kanban-task-456')
    expect(body.room.missionId).toBe('explicit-mission-789')
  })

  it('falls back to null missionId when no taskId or missionId is supplied', async () => {
    writeSwarmMissions([])

    const handlers = await makePostHandlers()
    const res = await handlers.POST({
      request: new Request('http://localhost/api/rooms', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'Standalone room' }),
      }),
    })
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.ok).toBe(true)
    expect(body.room.taskId).toBeNull()
    expect(body.room.missionId).toBeNull()
  })
})

describe('PATCH /api/rooms/$roomId taskId -> missionId backfill', () => {
  it('backfills missionId when taskId is updated to an existing mission id', async () => {
    writeSwarmMissions([
      {
        id: 'mission-abc',
        title: 'Another mission',
        state: 'dispatching',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        assignments: [],
        events: [],
      },
    ])

    const postHandlers = await makePostHandlers()
    const createRes = await postHandlers.POST({
      request: new Request('http://localhost/api/rooms', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'Room to patch' }),
      }),
    })
    const { room } = await createRes.json()

    const patchHandlers = await makeRoomIdHandlers()
    const patchRes = await patchHandlers.PATCH({
      request: new Request(`http://localhost/api/rooms/${room.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ taskId: 'mission-abc' }),
      }),
      params: { roomId: room.id },
    })
    const patched = await patchRes.json()

    expect(patchRes.status).toBe(200)
    expect(patched.ok).toBe(true)
    expect(patched.room.taskId).toBe('mission-abc')
    expect(patched.room.missionId).toBe('mission-abc')
  })

  it('leaves missionId alone when taskId is not a known mission id', async () => {
    writeSwarmMissions([])

    const postHandlers = await makePostHandlers()
    const createRes = await postHandlers.POST({
      request: new Request('http://localhost/api/rooms', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          title: 'Room to patch',
          missionId: 'mission-xyz',
        }),
      }),
    })
    const { room } = await createRes.json()

    const patchHandlers = await makeRoomIdHandlers()
    const patchRes = await patchHandlers.PATCH({
      request: new Request(`http://localhost/api/rooms/${room.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ taskId: 'kanban-task-999' }),
      }),
      params: { roomId: room.id },
    })
    const patched = await patchRes.json()

    expect(patchRes.status).toBe(200)
    expect(patched.ok).toBe(true)
    expect(patched.room.taskId).toBe('kanban-task-999')
    expect(patched.room.missionId).toBe('mission-xyz')
  })

  it('clears missionId when taskId is set to null', async () => {
    writeSwarmMissions([])

    const postHandlers = await makePostHandlers()
    const createRes = await postHandlers.POST({
      request: new Request('http://localhost/api/rooms', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          title: 'Room to clear',
          taskId: 'kanban-task-111',
          missionId: 'mission-xyz',
        }),
      }),
    })
    const { room } = await createRes.json()

    const patchHandlers = await makeRoomIdHandlers()
    const patchRes = await patchHandlers.PATCH({
      request: new Request(`http://localhost/api/rooms/${room.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ taskId: null }),
      }),
      params: { roomId: room.id },
    })
    const patched = await patchRes.json()

    expect(patchRes.status).toBe(200)
    expect(patched.ok).toBe(true)
    expect(patched.room.taskId).toBeNull()
    expect(patched.room.missionId).toBeNull()
  })
})
