import { useEffect, useState } from 'react'
import {
  Outlet,
  useNavigate,
  useRouterState,
} from '@tanstack/react-router'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  DialogContent,
  DialogDescription,
  DialogRoot,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { createRoom, deleteRoom, listRooms } from '@/lib/group-chat-api'
import type { Room } from '@/lib/group-chat-types'

export function GroupChatLayout() {
  const navigate = useNavigate()
  const routerState = useRouterState()
  const pathname = routerState.location?.pathname ?? ''
  const roomId =
    pathname.startsWith('/group-chat/') && pathname.length > '/group-chat/'.length
      ? pathname.slice('/group-chat/'.length)
      : undefined
  const [rooms, setRooms] = useState<Array<Room>>([])
  const [createTitle, setCreateTitle] = useState('')
  const [isCreateOpen, setIsCreateOpen] = useState(false)

  useEffect(() => {
    loadRooms()
  }, [])

  async function loadRooms() {
    const res = await listRooms()
    setRooms(res.rooms)
  }

  async function handleCreateRoom() {
    const title = createTitle.trim()
    if (!title) return
    const res = await createRoom({ title })
    setCreateTitle('')
    setIsCreateOpen(false)
    await loadRooms()
    navigate({ to: `/group-chat/${res.room.id}` })
  }

  async function handleDeleteRoom(id: string) {
    await deleteRoom(id)
    await loadRooms()
    if (roomId === id) {
      navigate({ to: '/group-chat' })
    }
  }

  return (
    <div className="flex h-full" style={{ color: 'var(--theme-text)' }}>
      <aside
        className="w-64 flex flex-col border-r"
        style={{
          borderColor: 'var(--theme-border)',
          background: 'var(--theme-card)',
        }}
      >
        <div className="p-3 border-b flex items-center justify-between">
          <h2 className="font-semibold">Group Chat</h2>
          <DialogRoot open={isCreateOpen} onOpenChange={setIsCreateOpen}>
            <DialogTrigger type="button" className="inline-flex">
              <Button size="sm" variant="ghost">
                + New
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogTitle>New Room</DialogTitle>
              <DialogDescription>
                Start a multi-agent room.
              </DialogDescription>
              <div className="flex gap-2 mt-4">
                <Input
                  placeholder="Room title"
                  value={createTitle}
                  onChange={(e) => setCreateTitle(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleCreateRoom()}
                />
                <Button onClick={handleCreateRoom}>Create</Button>
              </div>
            </DialogContent>
          </DialogRoot>
        </div>
        <div className="flex-1 overflow-auto">
          {rooms.map((room) => (
            <button
              key={room.id}
              onClick={() => navigate({ to: `/group-chat/${room.id}` })}
              className={cn(
                'w-full text-left px-3 py-2 border-b transition-colors',
                roomId === room.id && 'bg-accent/30',
              )}
              style={{ borderColor: 'var(--theme-border)' }}
            >
              <div className="font-medium truncate">{room.title}</div>
              <div className="flex items-center gap-2 text-xs opacity-70">
                <span>{room.state}</span>
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    void handleDeleteRoom(room.id)
                  }}
                  className="ml-auto text-red-400 hover:text-red-300 opacity-0 group-hover:opacity-100"
                >
                  ×
                </button>
              </div>
            </button>
          ))}
        </div>
      </aside>

      <main className="flex-1 min-w-0 bg-[var(--theme-bg)]">
        <Outlet />
      </main>
    </div>
  )
}
