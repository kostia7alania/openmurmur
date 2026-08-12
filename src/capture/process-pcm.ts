import { type ChildProcessByStdio, spawn } from 'node:child_process';
import type { Readable } from 'node:stream';
import { redact } from '../logging/redact.ts';
import type { Clock } from '../util/clock.ts';
import {
  type CaptureBackend,
  type CaptureBackendOptions,
  CaptureError,
  type CaptureFrame,
} from './backend.ts';
import { CaptureBufferOverflowError, CaptureFrameBuffer } from './frame-buffer.ts';

const MAX_PROCESSING_LAG_MS = 30_000;
export const FIRST_SOURCE_FRAME_TIMEOUT_MS = 10_000;
export const SOURCE_FRAME_STALL_TIMEOUT_MS = 15_000;

export interface ProcessPcmCaptureOptions extends CaptureBackendOptions {
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly clock: Clock;
  readonly firstSourceFrameTimeoutMs?: number;
  readonly sourceFrameStallTimeoutMs?: number;
  readonly classifyExit: (stderr: string, code: number | null) => CaptureError;
}

/** Shared lifecycle for child processes that emit raw PCM on stdout. */
export class ProcessPcmCapture implements CaptureBackend {
  readonly name: string;

  readonly #options: ProcessPcmCaptureOptions;
  readonly #bytesPerFrame: number;
  readonly #frameDurationMs: number;
  readonly #firstSourceFrameTimeoutMs: number;
  readonly #sourceFrameStallTimeoutMs: number;

  #child: ChildProcessByStdio<null, Readable, Readable> | null = null;
  #exitPromise: Promise<CaptureError | null> | null = null;
  #activeFrames: CaptureFrameBuffer | null = null;
  #cancelActiveWatchdog: (() => void) | null = null;
  #terminateActiveChild: (() => Promise<void>) | null = null;
  #lastIngressAtMonotonicMs: number | null = null;
  #lastDeliveredFrameMonotonicMs: number | null = null;
  #latestIngressFrameMonotonicMs: number | null = null;
  #stopping = false;

  constructor(options: ProcessPcmCaptureOptions) {
    this.name = options.name;
    this.#options = options;
    this.#bytesPerFrame = options.frameSamples * 2 * options.channels;
    this.#frameDurationMs = (options.frameSamples / options.sampleRate) * 1000;
    this.#firstSourceFrameTimeoutMs =
      options.firstSourceFrameTimeoutMs ?? FIRST_SOURCE_FRAME_TIMEOUT_MS;
    this.#sourceFrameStallTimeoutMs =
      options.sourceFrameStallTimeoutMs ?? SOURCE_FRAME_STALL_TIMEOUT_MS;
    if (!Number.isFinite(this.#firstSourceFrameTimeoutMs) || this.#firstSourceFrameTimeoutMs <= 0) {
      throw new Error('first source frame timeout must be positive');
    }
    if (!Number.isFinite(this.#sourceFrameStallTimeoutMs) || this.#sourceFrameStallTimeoutMs <= 0) {
      throw new Error('source frame stall timeout must be positive');
    }
  }

  async *start(): AsyncIterableIterator<CaptureFrame> {
    if (this.#child !== null) throw new CaptureError('spawn', 'capture already running');
    this.#stopping = false;

    const child = spawn(this.#options.command, [...this.#options.args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.#child = child;

    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      // Redact before retaining the bounded tail so split token chunks cannot
      // become a secret-bearing error later.
      stderr = redact(stderr + chunk).slice(-8192);
    });

    const exited = new Promise<CaptureError | null>((resolve) => {
      child.on('error', (error) => resolve(new CaptureError('spawn', redact(error.message))));
      child.on('close', (code) => {
        resolve(this.#stopping ? null : this.#options.classifyExit(stderr, code));
      });
    });
    this.#exitPromise = exited;
    let terminationPromise: Promise<void> | null = null;
    const terminate = () => {
      terminationPromise ??= this.#terminateAndJoin(child, exited);
      return terminationPromise;
    };
    this.#terminateActiveChild = terminate;

    const maxBufferedFrames = Math.ceil(MAX_PROCESSING_LAG_MS / this.#frameDurationMs);
    const frames = new CaptureFrameBuffer({
      bytesPerFrame: this.#bytesPerFrame,
      frameDurationMs: this.#frameDurationMs,
      maxBufferedFrames,
      clock: this.#options.clock,
    });
    this.#activeFrames = frames;
    let sourceFrameSeen = false;
    let watchdogTimer: NodeJS.Timeout | undefined;
    const releaseGeneration = () => {
      if (this.#activeFrames === frames) this.#activeFrames = null;
      if (this.#exitPromise === exited) this.#exitPromise = null;
      if (this.#child === child) this.#child = null;
      if (this.#cancelActiveWatchdog === cancelWatchdog) this.#cancelActiveWatchdog = null;
      if (this.#terminateActiveChild === terminate) this.#terminateActiveChild = null;
    };
    const armWatchdog = () => {
      if (watchdogTimer !== undefined) clearTimeout(watchdogTimer);
      const waitingForFirstFrame = !sourceFrameSeen;
      const timeoutMs = waitingForFirstFrame
        ? this.#firstSourceFrameTimeoutMs
        : this.#sourceFrameStallTimeoutMs;
      watchdogTimer = setTimeout(() => {
        watchdogTimer = undefined;
        const duration = this.#renderTimeoutDuration(timeoutMs);
        frames.abort(
          new CaptureError(
            'exit',
            waitingForFirstFrame
              ? `No source audio frame arrived within ${duration}; microphone access may be blocked or the input device may be unavailable.`
              : `No source audio frame arrived for ${duration}; the input device or capture process may have stalled.`,
          ),
        );
        // The recorder can still be processing the previously yielded frame.
        // Reap this exact generation without waiting for another iterator pull.
        void terminate().then(releaseGeneration);
      }, timeoutMs);
    };
    const cancelWatchdog = () => {
      if (watchdogTimer !== undefined) {
        clearTimeout(watchdogTimer);
        watchdogTimer = undefined;
      }
    };
    this.#cancelActiveWatchdog = cancelWatchdog;
    const pump = this.#pumpFrames(child, frames, maxBufferedFrames, exited, () => {
      sourceFrameSeen = true;
      armWatchdog();
    });
    armWatchdog();
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
      cancelWatchdog();
      await terminate();
      releaseGeneration();
    }
  }

  async #pumpFrames(
    child: ChildProcessByStdio<null, Readable, Readable>,
    frames: CaptureFrameBuffer,
    maxBufferedFrames: number,
    exited: Promise<CaptureError | null>,
    onIngress: () => void,
  ): Promise<void> {
    try {
      for await (const chunk of child.stdout) {
        const previousFrameMonotonicMs = frames.latestFrameMonotonicMs;
        try {
          frames.write(chunk as Buffer<ArrayBufferLike>);
        } finally {
          this.#latestIngressFrameMonotonicMs = frames.latestFrameMonotonicMs;
        }
        if (frames.latestFrameMonotonicMs !== previousFrameMonotonicMs) {
          this.#lastIngressAtMonotonicMs = this.#options.clock.monotonicMs();
          onIngress();
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
      frames.abort(failure);
      if (!this.#stopping && child.exitCode === null) child.kill('SIGTERM');
    }
  }

  async stop(): Promise<void> {
    const child = this.#child;
    const exited = this.#exitPromise;
    const terminate = this.#terminateActiveChild;
    if (child === null || exited === null || terminate === null) return;
    this.#stopping = true;
    this.#cancelActiveWatchdog?.();
    this.#activeFrames?.stop();
    await terminate();
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

  #renderTimeoutDuration(timeoutMs: number): string {
    return timeoutMs % 1000 === 0 ? `${timeoutMs / 1000} seconds` : `${timeoutMs} ms`;
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
