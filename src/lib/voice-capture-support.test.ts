import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  detectAudioRecordingSupport,
  detectGetUserMediaSupport,
  detectSpeechRecognitionSupport,
} from './voice-capture-support'

describe('voice capture support', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('reports no speech recognition without window APIs', () => {
    vi.stubGlobal('window', undefined)
    expect(detectSpeechRecognitionSupport()).toBe(false)
  })

  it('detects prefixed Safari/Chrome speech recognition', () => {
    vi.stubGlobal('window', {
      webkitSpeechRecognition: function WebkitSpeechRecognition() {},
    })
    expect(detectSpeechRecognitionSupport()).toBe(true)
  })

  it('treats MediaRecorder as enough to show the mic on Safari', () => {
    vi.stubGlobal('window', {})
    vi.stubGlobal('MediaRecorder', function MediaRecorder() {})
    vi.stubGlobal('navigator', {})
    expect(detectAudioRecordingSupport()).toBe(true)
  })

  it('detects getUserMedia on mediaDevices', () => {
    vi.stubGlobal('navigator', {
      mediaDevices: { getUserMedia: vi.fn() },
    })
    expect(detectGetUserMediaSupport()).toBe(true)
  })

  it('detects prefixed getUserMedia when mediaDevices is missing', () => {
    vi.stubGlobal('navigator', {
      webkitGetUserMedia: vi.fn(),
    })
    expect(detectGetUserMediaSupport()).toBe(true)
  })

  it('does not throw when mediaDevices access fails', () => {
    vi.stubGlobal('navigator', {
      get mediaDevices(): MediaDevices {
        throw new Error('blocked')
      },
    })
    expect(detectGetUserMediaSupport()).toBe(false)
  })
})
