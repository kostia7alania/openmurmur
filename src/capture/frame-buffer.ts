import type { Clock } from '../util/clock.ts';
import type { CaptureFrame } from './backend.ts';

export class CaptureBufferOverflowError extends Error {
  readonly bufferedFrames: number;

  constructor(bufferedFrames: number) {
    super(`capture processing queue reached its ${bufferedFrames}-frame limit`);
    this.name = 'CaptureBufferOverflowError';
    this.bufferedFrames = bufferedFrames;
  }
}

export interface CaptureFrameBufferOptions {
  readonly bytesPerFrame: number;
  readonly frameDurationMs: number;
  readonly maxBufferedFrames: number;
  readonly clock: Clock;
}

/**
 * Frames PCM as it is read from FFmpeg and decouples that reader from the
 * slower recorder consumer. Timestamps advance with the samples, not with the
 * time at which VAD eventually consumes a buffered frame.
 */
export class CaptureFrameBuffer {
  readonly #options: CaptureFrameBufferOptions;
  readonly #frames: CaptureFrame[] = [];
  #carry: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  #waiter:
    | {
        resolve: (result: IteratorResult<CaptureFrame>) => void;
        reject: (error: unknown) => void;
      }
    | undefined;
  #closed = false;
  #terminalError: unknown;
  #nextMonotonicMs: number | null = null;
  #nextWallMs: number | null = null;
  #epoch = 0;
  #pendingDiscontinuityMs: number | null = null;
  #latestFrameMonotonicMs: number | null = null;

  constructor(options: CaptureFrameBufferOptions) {
    if (options.bytesPerFrame <= 0) throw new Error('bytesPerFrame must be positive');
    if (options.frameDurationMs <= 0) throw new Error('frameDurationMs must be positive');
    if (!Number.isInteger(options.maxBufferedFrames) || options.maxBufferedFrames <= 0) {
      throw new Error('maxBufferedFrames must be a positive integer');
    }
    this.#options = options;
  }

  get bufferedFrames(): number {
    return this.#frames.length;
  }

  get streamEpoch(): number {
    return this.#epoch;
  }

  get latestFrameMonotonicMs(): number | null {
    return this.#latestFrameMonotonicMs;
  }

  write(chunk: Buffer<ArrayBufferLike>): void {
    if (this.#closed) throw new Error('capture frame buffer is closed');

    const observedMonotonicMs = this.#options.clock.monotonicMs();
    const observedWallMs = this.#options.clock.wallMs();
    this.#carry = this.#carry.length === 0 ? chunk : Buffer.concat([this.#carry, chunk]);
    let completeFrames = Math.floor(this.#carry.length / this.#options.bytesPerFrame);
    if (completeFrames === 0) return;

    if (this.#nextMonotonicMs !== null && this.#nextWallMs !== null) {
      const expectedLastMonotonicMs =
        this.#nextMonotonicMs + (completeFrames - 1) * this.#options.frameDurationMs;
      const driftMs = observedMonotonicMs - expectedLastMonotonicMs;
      const discontinuityThresholdMs = Math.max(250, this.#options.frameDurationMs * 4);
      if (driftMs > discontinuityThresholdMs) {
        // A true no-bytes source gap is a control boundary, unlike a slow
        // consumer. Never let queued pre-gap PCM open a post-gap session.
        this.#frames.length = 0;
        this.#carry = chunk;
        completeFrames = Math.floor(this.#carry.length / this.#options.bytesPerFrame);
        this.#epoch += 1;
        this.#pendingDiscontinuityMs = driftMs;
        this.#nextMonotonicMs = null;
        this.#nextWallMs = null;
      }
    }

    if (
      this.#nextMonotonicMs === null &&
      this.#nextWallMs === null &&
      this.#carry.length >= this.#options.bytesPerFrame
    ) {
      const bufferedDurationMs = (completeFrames - 1) * this.#options.frameDurationMs;
      this.#nextMonotonicMs = observedMonotonicMs - bufferedDurationMs;
      this.#nextWallMs = observedWallMs - bufferedDurationMs;
    }
    while (this.#carry.length >= this.#options.bytesPerFrame) {
      const pcm = this.#carry.subarray(0, this.#options.bytesPerFrame);
      this.#carry = this.#carry.subarray(this.#options.bytesPerFrame);
      const monotonicMs = this.#nextMonotonicMs;
      const wallMs = this.#nextWallMs;
      if (monotonicMs === null || wallMs === null) {
        throw new Error('capture frame timestamps were not initialized');
      }

      const frame: CaptureFrame = {
        pcm,
        monotonicMs,
        wallMs,
        durationMs: this.#options.frameDurationMs,
        streamEpoch: this.#epoch,
        ...(this.#pendingDiscontinuityMs === null
          ? {}
          : { discontinuityBeforeMs: this.#pendingDiscontinuityMs }),
      };
      this.#pendingDiscontinuityMs = null;
      this.#nextMonotonicMs = monotonicMs + this.#options.frameDurationMs;
      this.#nextWallMs = wallMs + this.#options.frameDurationMs;
      this.#latestFrameMonotonicMs = monotonicMs;
      this.#push(frame);
    }
  }

  /**
   * Drops frames that have not reached the consumer and invalidates any frame
   * already resolved to it but not processed yet through the epoch change.
   */
  discardBufferedFrames(): number {
    if (this.#closed) return 0;
    const discarded = this.#frames.length;
    this.#frames.length = 0;
    this.#carry = Buffer.alloc(0);
    this.#nextMonotonicMs = null;
    this.#nextWallMs = null;
    this.#pendingDiscontinuityMs = null;
    this.#latestFrameMonotonicMs = null;
    this.#epoch += 1;
    return discarded;
  }

  abort(error: unknown): void {
    if (this.#closed) return;
    this.#frames.length = 0;
    this.#carry = Buffer.alloc(0);
    this.#closed = true;
    this.#terminalError = error;
    if (this.#waiter !== undefined) {
      const waiter = this.#waiter;
      this.#waiter = undefined;
      waiter.reject(error);
    }
  }

  /** Intentional capture shutdown: discard queued PCM and wake the consumer cleanly. */
  stop(): number {
    if (this.#closed) return 0;
    const discarded = this.#frames.length;
    this.#frames.length = 0;
    this.#carry = Buffer.alloc(0);
    this.#epoch += 1;
    this.#closed = true;
    if (this.#waiter !== undefined) {
      const waiter = this.#waiter;
      this.#waiter = undefined;
      waiter.resolve({ done: true, value: undefined });
    }
    return discarded;
  }

  close(error?: unknown): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#terminalError = error;

    if (this.#waiter !== undefined) {
      const waiter = this.#waiter;
      this.#waiter = undefined;
      if (error === undefined) waiter.resolve({ done: true, value: undefined });
      else waiter.reject(error);
    }
  }

  next(): Promise<IteratorResult<CaptureFrame>> {
    const frame = this.#frames.shift();
    if (frame !== undefined) return Promise.resolve({ done: false, value: frame });

    if (this.#closed) {
      if (this.#terminalError !== undefined) return Promise.reject(this.#terminalError);
      return Promise.resolve({ done: true, value: undefined });
    }

    if (this.#waiter !== undefined) {
      return Promise.reject(new Error('capture frame buffer supports one consumer'));
    }
    return new Promise<IteratorResult<CaptureFrame>>((resolve, reject) => {
      this.#waiter = { resolve, reject };
    });
  }

  #push(frame: CaptureFrame): void {
    if (this.#waiter !== undefined) {
      const waiter = this.#waiter;
      this.#waiter = undefined;
      waiter.resolve({ done: false, value: frame });
      return;
    }

    if (this.#frames.length >= this.#options.maxBufferedFrames) {
      throw new CaptureBufferOverflowError(this.#options.maxBufferedFrames);
    }
    this.#frames.push(frame);
  }
}
