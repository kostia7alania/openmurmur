/**
 * Capture backend interface.
 *
 * The MVP ships one implementation (FFmpeg + AVFoundation). A native
 * AVAudioEngine helper is P1 — see native/OpenMurmurCapture/README.md — and
 * exists behind this interface so that shipping it does not touch the
 * sessionizer, the database or Telegram.
 */

export interface CaptureFrame {
  /** 16-bit little-endian mono PCM at the configured sample rate. */
  readonly pcm: Uint8Array;
  readonly monotonicMs: number;
  readonly wallMs: number;
  readonly durationMs: number;
  /** Changes when queued PCM is discarded across a capture/control boundary. */
  readonly streamEpoch?: number;
  /** Missing source time before this frame, never ordinary processing lag. */
  readonly discontinuityBeforeMs?: number;
}

export interface CaptureBackendOptions {
  readonly sampleRate: number;
  readonly channels: number;
  readonly device: string;
  /** Samples per emitted frame. Silero requires exactly 512 at 16 kHz. */
  readonly frameSamples: number;
}

export interface CaptureBackend {
  readonly name: string;
  /**
   * Starts capture. The returned iterator yields frames until `stop()` is
   * called or the device fails. The *first* yielded frame is what proves the
   * microphone is really open — the daemon does not announce
   * "🟢 Запись включена" until it arrives.
   */
  start(): AsyncIterableIterator<CaptureFrame>;
  stop(): Promise<void>;
  /** Milliseconds since the last frame, or null if none has ever arrived. */
  msSinceLastFrame(): number | null;
  /** Drops PCM not yet handed to the recorder and starts a new stream epoch. */
  discardBufferedFrames?(): number;
  currentStreamEpoch?(): number;
}

export class CaptureError extends Error {
  readonly kind: 'permission' | 'device' | 'spawn' | 'exit';
  constructor(kind: CaptureError['kind'], message: string) {
    super(message);
    this.name = 'CaptureError';
    this.kind = kind;
  }
}

/**
 * macOS reports a microphone TCC denial as a device-open failure rather than a
 * distinct error code, so we match the message. Getting this wrong only costs
 * a less helpful error string, never correctness.
 */
export function classifyFfmpegFailure(stderr: string): CaptureError {
  const lower = stderr.toLowerCase();
  if (
    lower.includes('operation not permitted') ||
    lower.includes('permission denied') ||
    lower.includes('failed to create input device')
  ) {
    return new CaptureError(
      'permission',
      'macOS denied microphone access.\n' +
        'Grant it in System Settings -> Privacy & Security -> Microphone, for the app that ' +
        'launches OpenMurmur (Terminal, iTerm, or the launchd agent).\n' +
        'The first run must be started interactively so macOS can show the prompt.',
    );
  }
  if (
    lower.includes('no such device') ||
    lower.includes('cannot find') ||
    lower.includes('input/output error')
  ) {
    return new CaptureError('device', `Audio device unavailable: ${stderr.trim().slice(0, 400)}`);
  }
  return new CaptureError('exit', stderr.trim().slice(0, 800));
}
