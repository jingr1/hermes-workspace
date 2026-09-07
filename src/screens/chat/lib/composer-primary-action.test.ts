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

  it('returns queue when busy with draft content (default mode)', () => {
    expect(
      getComposerPrimaryAction({
        disabled: false,
        isBusy: true,
        hasContent: true,
      }),
    ).toBe('queue')
  })

  it('returns interrupt when busy mode is interrupt', () => {
    expect(
      getComposerPrimaryAction({
        disabled: false,
        isBusy: true,
        hasContent: true,
        busyMessageMode: 'interrupt',
      }),
    ).toBe('interrupt')
  })

  it('returns steer when busy mode is steer and canSteer', () => {
    expect(
      getComposerPrimaryAction({
        disabled: false,
        isBusy: true,
        hasContent: true,
        busyMessageMode: 'steer',
        canSteer: true,
      }),
    ).toBe('steer')
  })

  it('falls back to queue when steer mode but no live run', () => {
    expect(
      getComposerPrimaryAction({
        disabled: false,
        isBusy: true,
        hasContent: true,
        busyMessageMode: 'steer',
        canSteer: false,
      }),
    ).toBe('queue')
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
  it('labels busy-mode actions', () => {
    expect(composerPrimaryActionLabel('stop')).toBe('Stop generation')
    expect(composerPrimaryActionLabel('queue')).toBe('Queue message')
    expect(composerPrimaryActionLabel('interrupt')).toBe('Interrupt and send')
    expect(composerPrimaryActionLabel('steer')).toBe('Steer current response')
    expect(composerPrimaryActionLabel('send')).toBe('Send message')
  })
})
