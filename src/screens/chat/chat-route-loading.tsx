/** Lightweight chat route placeholder — must stay in a tiny module (no chat-screen import). */
export function ChatRouteLoading() {
  return (
    <div className="flex h-full min-h-[12rem] items-center justify-center bg-[var(--theme-bg)]">
      <div className="text-center">
        <div
          className="mb-3 inline-block h-8 w-8 animate-spin rounded-full border-4 border-accent-500 border-r-transparent"
          aria-hidden
        />
        <p className="text-sm text-primary-500">Loading chat…</p>
      </div>
    </div>
  )
}
