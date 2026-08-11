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
import { CaptureBufferOverflowError, CaptureFrameBuffer } from './frame-buffer.ts';

const MAX_PROCESSING_LAG_MS = 30_000;

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
  #exitPromise: Promise<CaptureError | null> | null = null;
  #activeFrames: CaptureFrameBuffer | null = null;
  #lastIngressAtMonotonicMs: number | null = null;
  #lastDeliveredFrameMonotonicMs: number | null = null;
  #latestIngressFrameMonotonicMs: number | null = null;
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
    this.#exitPromise = exited;

    // FFmpeg's stdout is drained by its own pump. VAD, encoder backpressure and
    // part fsync/hash can delay the consumer without pushing that delay back to
    // the microphone until the explicit bounded-overload limit is reached.
    const maxBufferedFrames = Math.ceil(MAX_PROCESSING_LAG_MS / this.#frameDurationMs);
    const frames = new CaptureFrameBuffer({
      bytesPerFrame: this.#bytesPerFrame,
      frameDurationMs: this.#frameDurationMs,
      maxBufferedFrames,
      clock: this.#options.clock,
    });
    this.#activeFrames = frames;
    const pump = this.#pumpFrames(child, frames, maxBufferedFrames, exited);
    try {
      while (true) {
        const next = await frames.next();
        if (next.done) break;
        this.#lastDeliveredFrameMonotonicMs = next.value.monotonicMs;
        yield next.value;
      }
      await pump;
      const failure = await exited;
      if (failure !== null) throw failure;
    } finally {
      await this.#terminateAndJoin(child, exited);
      if (this.#activeFrames === frames) this.#activeFrames = null;
      if (this.#exitPromise === exited) this.#exitPromise = null;
      if (this.#child === child) this.#child = null;
    }
  }

  async #pumpFrames(
    child: ChildProcessByStdio<null, Readable, Readable>,
    frames: CaptureFrameBuffer,
    maxBufferedFrames: number,
    exited: Promise<CaptureError | null>,
  ): Promise<void> {
    try {
      for await (const chunk of child.stdout) {
        this.#lastIngressAtMonotonicMs = this.#options.clock.monotonicMs();
        try {
          frames.write(chunk as Buffer<ArrayBufferLike>);
        } finally {
          this.#latestIngressFrameMonotonicMs = frames.latestFrameMonotonicMs;
        }
      }
      const failure = await exited;
      if (failure === null) frames.close();
      else frames.abort(failure);
    } catch (error) {
      const failure =
        error instanceof CaptureBufferOverflowError
          ? new CaptureError(
              'exit',
              `Capture processing fell more than ${Math.round(
                (maxBufferedFrames * this.#frameDurationMs) / 1000,
              )} seconds behind. Recording stopped before audio could be dropped silently.`,
            )
          : error;
      // A terminal source/overload failure is reported as soon as the current
      // consumer operation returns. Keeping a stale queue here would leave the
      // user told recording is active for up to another 30 seconds.
      frames.abort(failure);
      if (!this.#stopping && child.exitCode === null) child.kill('SIGTERM');
    }
  }

  async stop(): Promise<void> {
    const child = this.#child;
    const exited = this.#exitPromise;
    if (child === null || exited === null) return;
    this.#stopping = true;
    this.#activeFrames?.stop();
    await this.#terminateAndJoin(child, exited);
  }

  msSinceLastFrame(): number | null {
    if (this.#lastIngressAtMonotonicMs === null) return null;
    return Math.max(0, this.#options.clock.monotonicMs() - this.#lastIngressAtMonotonicMs);
  }

  processingLagMs(): number | null {
    if (
      this.#latestIngressFrameMonotonicMs === null ||
      this.#lastDeliveredFrameMonotonicMs === null
    ) {
      return null;
    }
    return Math.max(0, this.#latestIngressFrameMonotonicMs - this.#lastDeliveredFrameMonotonicMs);
  }

  discardBufferedFrames(): number {
    return this.#activeFrames?.discardBufferedFrames() ?? 0;
  }

  currentStreamEpoch(): number {
    return this.#activeFrames?.streamEpoch ?? 0;
  }

  async #terminateAndJoin(
    child: ChildProcessByStdio<null, Readable, Readable>,
    exited: Promise<CaptureError | null>,
  ): Promise<void> {
    if (child.exitCode !== null) {
      await exited;
      return;
    }

    child.kill('SIGTERM');
    let timer: NodeJS.Timeout | undefined;
    const timedOut = await Promise.race([
      exited.then(() => false),
      new Promise<true>((resolve) => {
        timer = setTimeout(() => resolve(true), 3000);
      }),
    ]);
    if (timer !== undefined) clearTimeout(timer);
    if (timedOut && child.exitCode === null) {
      child.kill('SIGKILL');
      await exited;
    }
  }
}
