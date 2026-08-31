/**
 * Lightweight toast notification system.
 * Usage: import { toast } from '@/components/ui/toast'
 *        toast('Context compacted', { type: 'info' })
 */
import { useCallback, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { cn } from '@/lib/utils'

type ToastType = 'info' | 'success' | 'warning' | 'error'
type ToastPosition = 'top-right' | 'bottom-right'

interface ToastItem {
  id: number
  message: string
  type: ToastType
  duration: number
  icon?: string
  position?: ToastPosition
  onClick?: () => void
}

let toastId = 0
const listeners: Set<(t: ToastItem) => void> = new Set()

export function toast(
  message: string,
  opts?: {
    type?: ToastType
    duration?: number
    icon?: string
    position?: ToastPosition
    onClick?: () => void
  },
) {
  const item: ToastItem = {
    id: ++toastId,
    message,
    type: opts?.type ?? 'info',
    duration: opts?.duration ?? 5000,
    icon: opts?.icon,
    position: opts?.position ?? 'top-right',
    onClick: opts?.onClick,
  }
  listeners.forEach((fn) => fn(item))
}

const typeStyles: Record<ToastType, string> = {
  info: 'bg-accent-600 text-white',
  success: 'bg-green-600 text-white',
  warning: 'bg-amber-500 text-white',
  error: 'bg-red-600 text-white',
}

const defaultIcons: Record<ToastType, string> = {
  info: 'ℹ️',
  success: '✅',
  warning: '⚠️',
  error: '❌',
}

export function Toaster() {
  const [toasts, setToasts] = useState<Array<ToastItem>>([])

  const addToast = useCallback((item: ToastItem) => {
    setToasts((prev) => {
      // Dedupe: skip if same message + type already visible
      if (
        prev.some((t) => t.message === item.message && t.type === item.type)
      ) {
        return prev
      }
      return [...prev.slice(-4), item] // max 5
    })
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== item.id))
    }, item.duration)
  }, [])

  useEffect(() => {
    listeners.add(addToast)
    return () => {
      listeners.delete(addToast)
    }
  }, [addToast])

  if (!toasts.length) return null

  const topToasts = toasts.filter((t) => t.position !== 'bottom-right')
  const bottomToasts = toasts.filter((t) => t.position === 'bottom-right')

  const renderToast = (t: ToastItem) => (
    <div
      key={t.id}
      role={t.onClick ? 'button' : undefined}
      tabIndex={t.onClick ? 0 : undefined}
      onClick={t.onClick}
      onKeyDown={(e) => {
        if (t.onClick && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault()
          t.onClick()
        }
      }}
      className={cn(
        'pointer-events-auto flex w-full max-w-[calc(100vw-1rem)] items-start gap-2.5 rounded-xl px-4 py-3 text-sm font-medium shadow-lg backdrop-blur-sm animate-in slide-in-from-right-5 fade-in duration-200 sm:w-auto',
        t.onClick && 'cursor-pointer',
        typeStyles[t.type],
      )}
    >
      <span className="text-base">{t.icon ?? defaultIcons[t.type]}</span>
      <span className="min-w-0 break-words">{t.message}</span>
      <button
        type="button"
        onClick={() => setToasts((prev) => prev.filter((x) => x.id !== t.id))}
        className="ml-2 shrink-0 rounded-full p-0.5 opacity-70 transition-opacity hover:opacity-100"
      >
        ✕
      </button>
    </div>
  )

  return createPortal(
    <>
      <div className="pointer-events-none fixed left-2 right-2 z-[9999] flex flex-col gap-2 top-[calc(var(--titlebar-h,0px)+1rem)] sm:left-auto sm:right-4 sm:w-auto">
        {topToasts.map(renderToast)}
      </div>
      <div className="pointer-events-none fixed left-2 right-2 z-[9999] flex flex-col gap-2 bottom-4 sm:left-auto sm:right-4 sm:w-auto">
        {bottomToasts.map(renderToast)}
      </div>
    </>,
    document.body,
  )
}
