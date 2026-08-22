import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  detectAudioRecordingSupport,
  detectMicrophoneBrowserSupport,
  detectGetUserMediaSupport,
  detectSpeechRecognitionSupport,
  formatMicrophoneAccessError,
  INSECURE_MICROPHONE_MESSAGE,
  isMicrophoneContextSecure,
  requestAudioStream,
  resolveSpeechRecognitionLang,
} from './voice-capture-support'

function stubSecureWindow(extra: Record<string, unknown> = {}) {
  vi.stubGlobal('window', {
    isSecureContext: true,
    ...extra,
  })
}

describe('voice capture support', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('reports no speech recognition without window APIs', () => {
    vi.stubGlobal('window', undefined)
    expect(detectSpeechRecognitionSupport()).toBe(false)
  })

  it('detects prefixed Safari/Chrome speech recognition', () => {
    stubSecureWindow({
      webkitSpeechRecognition: function WebkitSpeechRecognition() {},
    })
    expect(detectSpeechRecognitionSupport()).toBe(true)
  })

  it('treats MediaRecorder as enough to show the mic on Safari', () => {
    stubSecureWindow()
    vi.stubGlobal('MediaRecorder', function MediaRecorder() {})
    vi.stubGlobal('navigator', {})
    expect(detectMicrophoneBrowserSupport()).toBe(true)
    expect(detectAudioRecordingSupport()).toBe(true)
  })

  it('detects getUserMedia on mediaDevices', () => {
    stubSecureWindow()
    vi.stubGlobal('navigator', {
      mediaDevices: { getUserMedia: vi.fn() },
    })
    expect(detectGetUserMediaSupport()).toBe(true)
  })

  it('detects prefixed getUserMedia when mediaDevices is missing', () => {
    stubSecureWindow()
    vi.stubGlobal('navigator', {
      webkitGetUserMedia: vi.fn(),
    })
    expect(detectGetUserMediaSupport()).toBe(true)
  })

  it('does not throw when mediaDevices access fails', () => {
    stubSecureWindow()
    vi.stubGlobal('navigator', {
      get mediaDevices(): MediaDevices {
        throw new Error('blocked')
      },
    })
    expect(detectGetUserMediaSupport()).toBe(false)
  })

  it('disables microphone capture on insecure HTTP remote origins', () => {
    vi.stubGlobal('window', { isSecureContext: false })
    vi.stubGlobal('MediaRecorder', function MediaRecorder() {})
    vi.stubGlobal('navigator', {
      mediaDevices: { getUserMedia: vi.fn() },
    })
    expect(isMicrophoneContextSecure()).toBe(false)
    expect(detectMicrophoneBrowserSupport()).toBe(true)
    expect(detectAudioRecordingSupport()).toBe(false)
    expect(detectGetUserMediaSupport()).toBe(false)
  })

  it('returns a clear error for insecure microphone contexts', async () => {
    vi.stubGlobal('window', { isSecureContext: false })
    await expect(requestAudioStream()).rejects.toMatchObject({
      name: 'SecurityError',
      message: INSECURE_MICROPHONE_MESSAGE,
    })
    expect(formatMicrophoneAccessError(new Error('ignored'))).toBe(
      INSECURE_MICROPHONE_MESSAGE,
    )
  })

  it('uses browser locale for speech recognition language', () => {
    vi.stubGlobal('navigator', { language: 'zh-CN' })
    expect(resolveSpeechRecognitionLang()).toBe('zh-CN')
  })

  it('falls back to en-US when browser locale is missing', () => {
    vi.stubGlobal('navigator', {})
    expect(resolveSpeechRecognitionLang()).toBe('en-US')
  })
})
