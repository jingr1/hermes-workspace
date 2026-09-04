import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/group-chat/')({
  component: GroupChatIndex,
})

function GroupChatIndex() {
  return (
    <div className="h-full flex items-center justify-center text-muted-foreground">
      Select a room from the sidebar.
    </div>
  )
}
