import type { Clock } from '../util/clock.ts';
import { type CaptureBackendOptions, CaptureError, classifyFfmpegFailure } from './backend.ts';
import { ProcessPcmCapture } from './process-pcm.ts';

export { FIRST_SOURCE_FRAME_TIMEOUT_MS } from './process-pcm.ts';

export interface FfmpegCaptureOptions extends CaptureBackendOptions {
  readonly ffmpegPath: string;
  readonly clock: Clock;
  readonly firstSourceFrameTimeoutMs?: number;
  readonly sourceFrameStallTimeoutMs?: number;
}

function buildFfmpegArgs(options: CaptureBackendOptions): string[] {
  return [
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'avfoundation',
    // AVFoundation wants "video:audio"; ":default" means no video, default mic.
    '-i',
    `:${options.device === 'default' ? '0' : options.device}`,
    '-ac',
    String(options.channels),
    '-ar',
    String(options.sampleRate),
    '-f',
    's16le',
    '-acodec',
    'pcm_s16le',
    'pipe:1',
  ];
}

function classifyExit(stderr: string, code: number | null): CaptureError {
  if (code === 0) {
    return new CaptureError(
      'exit',
      'ffmpeg capture ended unexpectedly with code 0; continuous recording stopped',
    );
  }
  return classifyFfmpegFailure(stderr || `ffmpeg exited with code ${code}`);
}

/** Continuous microphone capture through FFmpeg + AVFoundation. */
export class FfmpegCapture extends ProcessPcmCapture {
  readonly #args: readonly string[];

  constructor(options: FfmpegCaptureOptions) {
    const args = buildFfmpegArgs(options);
    super({
      name: 'ffmpeg-avfoundation',
      command: options.ffmpegPath,
      args,
      sampleRate: options.sampleRate,
      channels: options.channels,
      device: options.device,
      frameSamples: options.frameSamples,
      clock: options.clock,
      classifyExit,
      ...(options.firstSourceFrameTimeoutMs === undefined
        ? {}
        : { firstSourceFrameTimeoutMs: options.firstSourceFrameTimeoutMs }),
      ...(options.sourceFrameStallTimeoutMs === undefined
        ? {}
        : { sourceFrameStallTimeoutMs: options.sourceFrameStallTimeoutMs }),
    });
    this.#args = args;
  }

  buildArgs(): string[] {
    return [...this.#args];
  }
}
