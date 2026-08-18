import { createFileRoute, redirect } from '@tanstack/react-router'
import { ChatRouteLoading } from '../../screens/chat/chat-route-loading'
import { readLastSession } from '../../screens/chat/last-session'

export const Route = createFileRoute('/chat/')({
  ssr: false,
  pendingComponent: ChatRouteLoading,
  beforeLoad: () => {
    // Restore a last session id; ChatScreen still verifies it belongs to the
    // active profile before painting history.
    const lastSession = readLastSession() ?? 'new'
    throw redirect({
      to: '/chat/$sessionKey',
      params: { sessionKey: lastSession },
      replace: true,
    })
  },
  component: function ChatIndexRoute() {
    return <ChatRouteLoading />
  },
})
