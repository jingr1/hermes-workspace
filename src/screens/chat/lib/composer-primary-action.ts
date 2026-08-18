export type ComposerPrimaryAction =
  | 'send'
  | 'stop'
  | 'queue'
  | 'disabled'

export function getComposerPrimaryAction(options: {
  disabled: boolean
  isBusy: boolean
  hasContent: boolean
  isCompacting?: boolean
}): ComposerPrimaryAction {
  const { disabled, isBusy, hasContent, isCompacting = false } = options
  if (disabled) return 'disabled'

  const busy = isBusy || isCompacting
  if (!busy) return hasContent ? 'send' : 'disabled'

  if (!hasContent) {
    if (isBusy) return 'stop'
    if (isCompacting) return 'queue'
    return 'disabled'
  }

  return 'send'
}

export function composerPrimaryActionLabel(action: ComposerPrimaryAction): string {
  switch (action) {
    case 'stop':
      return 'Stop generation'
    case 'queue':
      return 'Queue message'
    case 'send':
      return 'Send message'
    default:
      return 'Type a message to send'
  }
}
