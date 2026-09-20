import { createFileRoute, useNavigate, useSearch } from '@tanstack/react-router'
import { z } from 'zod'
import { usePageTitle } from '@/hooks/use-page-title'
import { MissionsLayout } from '@/screens/mission-control/mission-control-layout'

const searchSchema = z.object({
  taskId: z.string().optional(),
})

export const Route = createFileRoute('/missions')({
  ssr: false,
  validateSearch: searchSchema,
  component: MissionsRoute,
})

function MissionsRoute() {
  usePageTitle('Missions')
  const search = useSearch({ from: '/missions' })
  const navigate = useNavigate({ from: '/missions' })
  const taskId = search.taskId

  function selectTask(nextTaskId: string | null) {
    void navigate({
      search: (prev) => {
        if (!nextTaskId) {
          const { taskId: _removed, ...rest } = prev
          return rest
        }
        return { ...prev, taskId: nextTaskId }
      },
      replace: true,
    })
  }

  return (
    <MissionsLayout
      selectedTaskId={taskId ?? null}
      onSelectTask={selectTask}
    />
  )
}
