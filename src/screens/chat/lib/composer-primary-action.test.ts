import { describe, expect, it } from 'vitest'
import {
  composerPrimaryActionLabel,
  getComposerPrimaryAction,
} from './composer-primary-action'

describe('getComposerPrimaryAction', () => {
  it('returns disabled when composer is locked', () => {
    expect(
      getComposerPrimaryAction({
        disabled: true,
        isBusy: false,
        hasContent: true,
      }),
    ).toBe('disabled')
  })

  it('returns send when idle with draft content', () => {
    expect(
      getComposerPrimaryAction({
        disabled: false,
        isBusy: false,
        hasContent: true,
      }),
    ).toBe('send')
  })

  it('returns stop when busy without draft content', () => {
    expect(
      getComposerPrimaryAction({
        disabled: false,
        isBusy: true,
        hasContent: false,
      }),
    ).toBe('stop')
  })

  it('returns send when busy with draft content', () => {
    expect(
      getComposerPrimaryAction({
        disabled: false,
        isBusy: true,
        hasContent: true,
      }),
    ).toBe('send')
  })

  it('returns queue when compacting without draft content', () => {
    expect(
      getComposerPrimaryAction({
        disabled: false,
        isBusy: false,
        hasContent: false,
        isCompacting: true,
      }),
    ).toBe('queue')
  })
})

describe('composerPrimaryActionLabel', () => {
  it('labels stop and send actions', () => {
    expect(composerPrimaryActionLabel('stop')).toBe('Stop generation')
    expect(composerPrimaryActionLabel('send')).toBe('Send message')
  })
})
