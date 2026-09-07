export type BusyMessageMode = 'queue' | 'interrupt' | 'steer'

export type ComposerPrimaryAction =
  | 'send'
  | 'stop'
  | 'queue'
  | 'interrupt'
  | 'steer'
  | 'disabled'

export function getComposerPrimaryAction(options: {
  disabled: boolean
  isBusy: boolean
  hasContent: boolean
  isCompacting?: boolean
  busyMessageMode?: BusyMessageMode
  /** True when a live run id is available for mid-turn steer */
  canSteer?: boolean
}): ComposerPrimaryAction {
  const {
    disabled,
    isBusy,
    hasContent,
    isCompacting = false,
    busyMessageMode = 'queue',
    canSteer = false,
  } = options
  if (disabled) return 'disabled'

  const busy = isBusy || isCompacting
  if (!busy) return hasContent ? 'send' : 'disabled'

  // Busy with a draft → mode-dependent primary action.
  if (hasContent) {
    if (busyMessageMode === 'steer') return canSteer ? 'steer' : 'queue'
    if (busyMessageMode === 'interrupt') return 'interrupt'
    return 'queue'
  }

  if (isBusy) return 'stop'
  if (isCompacting) return 'queue'
  return 'disabled'
}

export function composerPrimaryActionLabel(
  action: ComposerPrimaryAction,
): string {
  switch (action) {
    case 'stop':
      return 'Stop generation'
    case 'queue':
      return 'Queue message'
    case 'interrupt':
      return 'Interrupt and send'
    case 'steer':
      return 'Steer current response'
    case 'send':
      return 'Send message'
    default:
      return 'Type a message to send'
  }
}
