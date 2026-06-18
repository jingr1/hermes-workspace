import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../server/auth-middleware'

type ResumeBody = {
  missionId?: unknown
  action?: unknown
}

function resolvePythonBin(): string {
  const override = process.env.HERMES_LANGGRAPH_PYTHON
  if (override) return override
  return join(process.cwd(), 'hermes_langgraph_orchestrator', '.venv', 'bin', 'python')
}

function cleanString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

export const Route = createFileRoute('/api/orchestrator-resume')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return json({ ok: false, error: 'Unauthorized' }, { status: 401 })
        }
        let body: ResumeBody
        try {
          body = (await request.json()) as ResumeBody
        } catch {
          return json({ ok: false, error: 'Invalid JSON body' }, { status: 400 })
        }
        const missionId = cleanString(body.missionId)
        const action = cleanString(body.action)
        if (!missionId) {
          return json({ ok: false, error: 'missionId required' }, { status: 400 })
        }
        if (action !== 'approved' && action !== 'abort') {
          return json({ ok: false, error: 'action must be approved or abort' }, { status: 400 })
        }

        const url = new URL(request.url)
        const useMock = url.searchParams.get('mock') === '1'

        const python = resolvePythonBin()
        const args = [
          '-m',
          'hermes_langgraph_orchestrator',
          '--execute',
          ...(useMock ? ['--mock-services'] : []),
          '--resume',
          action,
          '--mission-id',
          missionId,
        ]

        const child = spawn(python, args, {
          detached: true,
          stdio: 'ignore',
          env: process.env,
        })
        child.unref()

        return json({
          ok: true,
          accepted: true,
          action,
          missionId,
          mock: useMock,
          pid: child.pid ?? null,
        })
      },
    },
  },
})
