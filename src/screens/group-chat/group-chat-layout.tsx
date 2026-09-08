import { createContext, useEffect, useState } from 'react'
import { Outlet, useNavigate, useRouterState } from '@tanstack/react-router'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogRoot,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import {
  MenuContent,
  MenuItem,
  MenuRoot,
  MenuTrigger,
} from '@/components/ui/menu'
import { HugeiconsIcon } from '@hugeicons/react'
import {
  MoreVerticalCircle01Icon,
  Delete01Icon,
  Edit02Icon,
} from '@hugeicons/core-free-icons'
import {
  createRoom,
  deleteRoom,
  listRooms,
  updateRoom,
} from '@/lib/group-chat-api'
import type { Room } from '@/lib/group-chat-types'
import { clearLastRoom, resolveRoomToOpen } from './last-room'

/** Shared header height so the sidebar/main divider lines align. */
const ROOM_HEADER_CLASS =
  'h-16 shrink-0 border-b flex items-center justify-between'

export const GroupChatRoomsContext = createContext<Array<Room>>([])

export function GroupChatLayout() {
  const navigate = useNavigate()
  const routerState = useRouterState()
  const pathname = routerState.location?.pathname ?? ''
  const roomId =
    pathname.startsWith('/group-chat/') &&
    pathname.length > '/group-chat/'.length
      ? pathname.slice('/group-chat/'.length).split(/[/?#]/)[0]
      : undefined
  const [rooms, setRooms] = useState<Array<Room>>([])
  const [createTitle, setCreateTitle] = useState('')
  const [isCreateOpen, setIsCreateOpen] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<Room | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [renameTarget, setRenameTarget] = useState<Room | null>(null)
  const [renameTitle, setRenameTitle] = useState('')
  const [renaming, setRenaming] = useState(false)

  useEffect(() => {
    void loadRooms()
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
    navigate({ to: '/group-chat/$roomId', params: { roomId: res.room.id } })
  }

  async function handleConfirmDelete() {
    if (!deleteTarget || deleting) return
    const id = deleteTarget.id
    setDeleting(true)
    try {
      await deleteRoom(id)
      clearLastRoom(id)
      setDeleteTarget(null)
      const res = await listRooms()
      setRooms(res.rooms)
      if (roomId === id) {
        const next = resolveRoomToOpen(res.rooms)
        if (next) {
          navigate({
            to: '/group-chat/$roomId',
            params: { roomId: next },
            replace: true,
          })
        } else {
          navigate({ to: '/group-chat', replace: true })
        }
      }
    } finally {
      setDeleting(false)
    }
  }

  async function handleConfirmRename() {
    if (!renameTarget || renaming) return
    const title = renameTitle.trim()
    if (!title || title === renameTarget.title) {
      setRenameTarget(null)
      return
    }
    setRenaming(true)
    try {
      const res = await updateRoom(renameTarget.id, { title })
      setRooms((prev) => prev.map((r) => (r.id === res.room.id ? res.room : r)))
      setRenameTarget(null)
      setRenameTitle('')
    } finally {
      setRenaming(false)
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
        <div
          className={cn(ROOM_HEADER_CLASS, 'px-3')}
          style={{ borderColor: 'var(--theme-border)' }}
        >
          <h2 className="font-semibold">Group Chat</h2>
          <DialogRoot open={isCreateOpen} onOpenChange={setIsCreateOpen}>
            <DialogTrigger type="button" className="inline-flex">
              <Button size="sm" variant="ghost">
                + New
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogTitle>New Room</DialogTitle>
              <DialogDescription>Start a multi-agent room.</DialogDescription>
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
            <div
              key={room.id}
              className={cn(
                'group w-full text-left px-3 py-2 border-b transition-colors flex items-center justify-between gap-2',
                roomId === room.id && 'bg-accent/30',
              )}
              style={{ borderColor: 'var(--theme-border)' }}
            >
              <button
                onClick={() =>
                  navigate({
                    to: '/group-chat/$roomId',
                    params: { roomId: room.id },
                  })
                }
                className="flex-1 min-w-0 text-left"
              >
                <div className="font-medium truncate">{room.title}</div>
                <div className="flex items-center gap-2 text-xs opacity-70">
                  <span>{room.state}</span>
                </div>
              </button>
              <div className="shrink-0">
                <MenuRoot>
                  <MenuTrigger
                    type="button"
                    className="inline-flex items-center justify-center size-8 rounded-md"
                    style={{ color: 'var(--theme-muted)' }}
                    aria-label={`Room options for ${room.title}`}
                  >
                    <HugeiconsIcon
                      icon={MoreVerticalCircle01Icon}
                      size={18}
                      strokeWidth={2}
                      color="currentColor"
                    />
                  </MenuTrigger>
                  <MenuContent align="end" side="bottom">
                    <MenuItem
                      onClick={() => {
                        setRenameTarget(room)
                        setRenameTitle(room.title)
                      }}
                    >
                      <HugeiconsIcon
                        icon={Edit02Icon}
                        size={16}
                        strokeWidth={1.5}
                      />
                      Rename
                    </MenuItem>
                    <MenuItem
                      className="text-red-400 focus:text-red-400"
                      onClick={() => setDeleteTarget(room)}
                    >
                      <HugeiconsIcon
                        icon={Delete01Icon}
                        size={16}
                        strokeWidth={1.5}
                      />
                      Delete room
                    </MenuItem>
                  </MenuContent>
                </MenuRoot>
              </div>
            </div>
          ))}
        </div>
      </aside>

      <DialogRoot
        open={renameTarget !== null}
        onOpenChange={(open) => {
          if (!open && !renaming) {
            setRenameTarget(null)
            setRenameTitle('')
          }
        }}
      >
        <DialogContent>
          <DialogTitle>Rename room</DialogTitle>
          <DialogDescription>
            Change the display name for this room.
          </DialogDescription>
          <div className="flex gap-2 mt-4">
            <Input
              placeholder="Room title"
              value={renameTitle}
              onChange={(e) => setRenameTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void handleConfirmRename()
              }}
              disabled={renaming}
              autoFocus
            />
            <Button
              disabled={renaming || !renameTitle.trim()}
              onClick={() => void handleConfirmRename()}
            >
              {renaming ? 'Saving…' : 'Save'}
            </Button>
          </div>
        </DialogContent>
      </DialogRoot>

      <DialogRoot
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open && !deleting) setDeleteTarget(null)
        }}
      >
        <DialogContent>
          <DialogTitle>Delete room?</DialogTitle>
          <DialogDescription>
            This will permanently remove <strong>{deleteTarget?.title}</strong>{' '}
            and all its messages, participants, and pending turns.
          </DialogDescription>
          <div className="mt-5 flex justify-end gap-2">
            <DialogClose disabled={deleting}>Cancel</DialogClose>
            <Button
              variant="destructive"
              disabled={deleting}
              onClick={() => void handleConfirmDelete()}
            >
              {deleting ? 'Deleting…' : 'Delete'}
            </Button>
          </div>
        </DialogContent>
      </DialogRoot>

      <main className="flex-1 min-w-0 bg-[var(--theme-bg)]">
        <GroupChatRoomsContext.Provider value={rooms}>
          <Outlet />
        </GroupChatRoomsContext.Provider>
      </main>
    </div>
  )
}
