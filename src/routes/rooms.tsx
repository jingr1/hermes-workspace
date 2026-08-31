import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { usePageTitle } from '@/hooks/use-page-title'
import { RoomsScreen } from '@/screens/group-chat/rooms-screen'

const searchSchema = z.object({
  roomId: z.string().optional(),
  messageId: z.string().optional(),
})

export const Route = createFileRoute('/rooms')({
  ssr: false,
  validateSearch: searchSchema,
  component: RoomsRoute,
})

function RoomsRoute() {
  usePageTitle('Rooms')
  return <RoomsScreen />
}
