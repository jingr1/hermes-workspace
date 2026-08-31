import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { usePageTitle } from '@/hooks/use-page-title'
import { MissionControlScreen } from '@/screens/mission-control/mission-control-screen'

const searchSchema = z.object({
  tab: z.enum(['overview', 'board', 'pipeline']).optional(),
  taskId: z.string().optional(),
})

export const Route = createFileRoute('/mission-control')({
  ssr: false,
  validateSearch: searchSchema,
  component: MissionControlRoute,
})

function MissionControlRoute() {
  usePageTitle('Mission Control')
  return <MissionControlScreen />
}
