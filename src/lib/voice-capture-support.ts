/**
 * Browser voice-capture capability detection.
 *
 * Desktop Safari has no Web Speech API, so the mic button must be gated on
 * MediaRecorder / getUserMedia instead. Safari also leaves `mediaDevices`
 * undefined during SSR and sometimes on the first client tick, so callers
 * should read these helpers after mount (useLayoutEffect).
 */

type NavigatorWithLegacyMedia = Navigator & {
  webkitGetUserMedia?: (
    constraints: MediaStreamConstraints,
    success: (stream: MediaStream) => void,
    error: (error: Error) => void,
  ) => void
  getUserMedia?: (
    constraints: MediaStreamConstraints,
    success: (stream: MediaStream) => void,
    error: (error: Error) => void,
  ) => void
}

const AUDIO_MIME_CANDIDATES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4;codecs=mp4a.40.2',
  'audio/mp4',
  'audio/aac',
] as const

function getNavigator(): NavigatorWithLegacyMedia | null {
  if (typeof navigator === 'undefined') return null
  return navigator as NavigatorWithLegacyMedia
}

export function detectSpeechRecognitionSupport(): boolean {
  if (typeof window === 'undefined') return false
  const win = window as Window & {
    SpeechRecognition?: unknown
    webkitSpeechRecognition?: unknown
  }
  return Boolean(win.SpeechRecognition || win.webkitSpeechRecognition)
}

export function detectGetUserMediaSupport(): boolean {
  const nav = getNavigator()
  if (!nav) return false
  try {
    if (typeof nav.mediaDevices?.getUserMedia === 'function') return true
    if (typeof nav.webkitGetUserMedia === 'function') return true
    if (typeof nav.getUserMedia === 'function') return true
    return false
  } catch {
    return false
  }
}

export function detectAudioRecordingSupport(): boolean {
  if (typeof window === 'undefined') return false
  if (typeof MediaRecorder === 'undefined') {
    return detectGetUserMediaSupport()
  }
  // Safari can expose MediaRecorder while lazily initializing mediaDevices.
  // Treat either API as enough to show the mic; click-time errors stay explicit.
  return true
}

export async function requestAudioStream(): Promise<MediaStream> {
  const nav = getNavigator()
  if (!nav) {
    throw new DOMException('Microphone APIs are unavailable', 'NotSupportedError')
  }

  if (typeof nav.mediaDevices?.getUserMedia === 'function') {
    return nav.mediaDevices.getUserMedia({ audio: true })
  }

  const legacy = nav.webkitGetUserMedia ?? nav.getUserMedia
  if (typeof legacy === 'function') {
    return new Promise<MediaStream>((resolve, reject) => {
      legacy.call(nav, { audio: true }, resolve, reject)
    })
  }

  throw new DOMException(
    'Microphone APIs are unavailable in this browser',
    'NotSupportedError',
  )
}

export function createAudioRecorder(stream: MediaStream): {
  recorder: MediaRecorder
  mimeType: string
} {
  for (const mimeType of AUDIO_MIME_CANDIDATES) {
    try {
      if (
        typeof MediaRecorder.isTypeSupported === 'function' &&
        !MediaRecorder.isTypeSupported(mimeType)
      ) {
        continue
      }
      return { recorder: new MediaRecorder(stream, { mimeType }), mimeType }
    } catch {
      // Safari may report a type as supported then reject the constructor.
    }
  }

  const recorder = new MediaRecorder(stream)
  return { recorder, mimeType: recorder.mimeType || 'audio/mp4' }
}

export function startAudioRecorder(
  recorder: MediaRecorder,
  timesliceMs = 100,
): void {
  try {
    recorder.start(timesliceMs)
  } catch {
    // Safari ignores or rejects timeslice on some versions.
    recorder.start()
  }
}
