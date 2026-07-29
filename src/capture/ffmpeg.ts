import { type ChildProcessByStdio, spawn } from 'node:child_process';
import type { Readable } from 'node:stream';
import type { Clock } from '../util/clock.ts';
import {
  type CaptureBackend,
  type CaptureBackendOptions,
  CaptureError,
  type CaptureFrame,
  classifyFfmpegFailure,
} from './backend.ts';

export interface FfmpegCaptureOptions extends CaptureBackendOptions {
  readonly ffmpegPath: string;
  readonly clock: Clock;
}

/**
 * Continuous microphone capture via FFmpeg + AVFoundation, emitting raw PCM
 * frames on stdout.
 *
 * FFmpeg is used rather than a native helper because it needs no Apple
 * Developer certificate, which keeps the MVP installable by anyone with
 * Homebrew. See docs/adr/0003-capture-backend.md.
 */
export class FfmpegCapture implements CaptureBackend {
  readonly name = 'ffmpeg-avfoundation';

  readonly #options: FfmpegCaptureOptions;
  readonly #bytesPerFrame: number;
  readonly #frameDurationMs: number;

  #child: ChildProcessByStdio<null, Readable, Readable> | null = null;
  #lastFrameMonotonicMs: number | null = null;
  #stopping = false;

  constructor(options: FfmpegCaptureOptions) {
    this.#options = options;
    this.#bytesPerFrame = options.frameSamples * 2 * options.channels;
    this.#frameDurationMs = (options.frameSamples / options.sampleRate) * 1000;
  }

  buildArgs(): string[] {
    return [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'avfoundation',
      // AVFoundation wants "video:audio"; ":default" means no video, default mic.
      '-i',
      `:${this.#options.device === 'default' ? '0' : this.#options.device}`,
      '-ac',
      String(this.#options.channels),
      '-ar',
      String(this.#options.sampleRate),
      '-f',
      's16le',
      '-acodec',
      'pcm_s16le',
      'pipe:1',
    ];
  }

  async *start(): AsyncIterableIterator<CaptureFrame> {
    if (this.#child !== null) throw new CaptureError('spawn', 'capture already running');
    this.#stopping = false;

    const child = spawn(this.#options.ffmpegPath, this.buildArgs(), {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.#child = child;

    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      // Bounded: a device that spews errors must not grow memory without limit.
      stderr = (stderr + chunk).slice(-8192);
    });

    const exited = new Promise<CaptureError | null>((resolve) => {
      child.on('error', (error) => resolve(new CaptureError('spawn', error.message)));
      child.on('close', (code) => {
        if (this.#stopping || code === 0) resolve(null);
        else resolve(classifyFfmpegFailure(stderr || `ffmpeg exited with code ${code}`));
      });
    });

    // Chunks arriving from the pipe are not frame-aligned, so a partial frame
    // is carried across reads rather than dropped.
    let carry: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    try {
      for await (const chunk of child.stdout) {
        const bytes = chunk as Buffer<ArrayBufferLike>;
        carry = carry.length === 0 ? bytes : Buffer.concat([carry, bytes]);
        while (carry.length >= this.#bytesPerFrame) {
          const pcm: Uint8Array = carry.subarray(0, this.#bytesPerFrame);
          carry = carry.subarray(this.#bytesPerFrame);
          const monotonicMs = this.#options.clock.monotonicMs();
          this.#lastFrameMonotonicMs = monotonicMs;
          yield {
            pcm,
            monotonicMs,
            wallMs: this.#options.clock.wallMs(),
            durationMs: this.#frameDurationMs,
          };
        }
      }
    } finally {
      this.#child = null;
    }

    const failure = await exited;
    if (failure !== null) throw failure;
  }

  async stop(): Promise<void> {
    const child = this.#child;
    if (child === null) return;
    this.#stopping = true;
    child.kill('SIGTERM');
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve();
      }, 3000);
      child.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    this.#child = null;
  }

  msSinceLastFrame(): number | null {
    if (this.#lastFrameMonotonicMs === null) return null;
    return this.#options.clock.monotonicMs() - this.#lastFrameMonotonicMs;
  }
}
