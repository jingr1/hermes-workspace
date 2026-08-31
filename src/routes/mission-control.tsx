import { createFileRoute, useNavigate, useSearch } from '@tanstack/react-router'
import { z } from 'zod'
import type { MissionControlTab } from '@/screens/mission-control/mission-control-layout'
import { usePageTitle } from '@/hooks/use-page-title'
import { MissionControlLayout } from '@/screens/mission-control/mission-control-layout'

const searchSchema = z.object({
  tab: z
    .union([z.literal('overview'), z.literal('board'), z.literal('pipeline')])
    .optional()
    .default('overview'),
  taskId: z.string().optional(),
})

export const Route = createFileRoute('/mission-control')({
  ssr: false,
  validateSearch: searchSchema,
  component: MissionControlRoute,
})

function MissionControlRoute() {
  usePageTitle('Mission Control')
  const search = useSearch({ from: '/mission-control' })
  const navigate = useNavigate({ from: '/mission-control' })
  const tab = search.tab
  const taskId = search.taskId

  function setTab(next: MissionControlTab) {
    void navigate({
      search: (prev) => ({ ...prev, tab: next }),
      replace: true,
    })
  }

  return (
    <MissionControlLayout
      activeTab={tab}
      onTabChange={setTab}
      initialTaskId={taskId}
    />
  )
}
