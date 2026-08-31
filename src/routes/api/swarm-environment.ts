import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../server/auth-middleware'
import { getSwarmEnvironment } from '../../server/swarm-environment'
import { getSwarmMission } from '../../server/swarm-missions'
import { getProject } from '../../server/task-pipeline/projects'

export const Route = createFileRoute('/api/swarm-environment')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return json({ ok: false, error: 'Unauthorized' }, { status: 401 })
        }

        const url = new URL(request.url)
        const missionId = url.searchParams.get('missionId') ?? undefined
        let workspaceMode: 'canonical' | 'worktree' = 'canonical'
        let worktreeCwd: string | null = null

        if (missionId) {
          const mission = getSwarmMission(missionId)
          if (mission?.workspaceMode === 'worktree' && mission.projectId) {
            const project = getProject(mission.projectId)
            if (project) {
              workspaceMode = 'worktree'
              worktreeCwd = `${project.worktreeRoot}/${mission.id}`
            }
          }
        }

        return json({
          ok: true,
          generatedAt: Date.now(),
          workspaceMode,
          ...getSwarmEnvironment({
            missionId,
            workspaceMode,
            worktreeCwd,
          }),
        })
      },
    },
  },
})
