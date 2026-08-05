import { randomUUID } from 'node:crypto';
import type { WorkerProcess } from '../asr/worker-process.ts';
import type { Logger } from '../logging/logger.ts';
import { type Clock, systemClock } from '../util/clock.ts';
import { EnergyVad, type Vad } from './vad.ts';

/**
 * Live Silero VAD.
 *
 * This is what makes the sessionizer mean what it says. An energy gate answers
 * "is it loud?"; Silero answers "is someone speaking?" — and those differ in
 * exactly the cases an ambient journal lives in: a fan, traffic, music, a
 * television, a door. Measured on this machine, Silero scores real speech at
 * p≈0.99, white noise at 0.009 and a 440 Hz tone at 0.000. No energy threshold
 * separates the tone from the speech.
 *
 * Each 32 ms frame costs about 0.2 ms of round trip, so scoring frames one at a
 * time as they leave the capture pipe uses well under 1% of the budget.
 *
 * If the worker becomes unavailable the recorder keeps running on the energy
 * gate rather than stopping — a degraded journal beats no journal — but this is
 * announced, never silent: `onDegraded` exists so the daemon can tell the user
 * that sessions are being cut by loudness until it recovers.
 */

export const FRAME_SAMPLES = 512;
export const FRAME_BYTES = FRAME_SAMPLES * 2;

/** The transport for one batch of frames. Injectable so tests need no process. */
export interface FrameScorer {
  score(pcm: Uint8Array, reset: boolean): Promise<readonly number[]>;
}

export class WorkerFrameScorer implements FrameScorer {
  readonly #worker: WorkerProcess;
  readonly #timeoutMs: number;

  constructor(worker: WorkerProcess, timeoutMs = 5000) {
    this.#worker = worker;
    this.#timeoutMs = timeoutMs;
  }

  async score(pcm: Uint8Array, reset: boolean): Promise<readonly number[]> {
    await this.#worker.ensureStarted();
    const response = await this.#worker.send(
      {
        id: randomUUID(),
        op: 'vad_stream',
        pcm: Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).toString('base64'),
        ...(reset ? { reset: true } : {}),
      },
      this.#timeoutMs,
    );
    if (!response.ok) throw new Error(response.error);
    if (response.op !== 'vad_stream') throw new Error('worker replied to the wrong operation');
    return response.probabilities;
  }
}

export interface SileroStreamVadOptions {
  readonly scorer: FrameScorer;
  readonly logger: Logger;
  /** Used while the worker is unavailable. */
  readonly fallback?: Vad;
  /** Consecutive failures tolerated before announcing a degraded detector. */
  readonly failureThreshold?: number;
  /** How long to stay on the fallback before trying Silero again. */
  readonly retryIntervalMs?: number;
  readonly clock?: Clock;
  readonly onDegraded?: (reason: string) => void;
  readonly onRecovered?: () => void;
}

export class SileroStreamVad implements Vad {
  readonly name = 'silero';

  readonly #options: SileroStreamVadOptions;
  readonly #fallback: Vad;
  readonly #failureThreshold: number;
  readonly #retryIntervalMs: number;
  readonly #clock: Clock;

  #pendingReset = true;
  #failures = 0;
  #degraded = false;
  #nextRetryMs = 0;

  constructor(options: SileroStreamVadOptions) {
    this.#options = options;
    this.#fallback = options.fallback ?? new EnergyVad();
    this.#failureThreshold = options.failureThreshold ?? 3;
    this.#retryIntervalMs = options.retryIntervalMs ?? 60_000;
    this.#clock = options.clock ?? systemClock;
  }

  /** True while frames are being scored by the fallback rather than Silero. */
  get degraded(): boolean {
    return this.#degraded;
  }

  /**
   * Loads the model before the first frame arrives.
   *
   * Creating the ONNX session takes about a second. Paying that on the first
   * frame would back up a second of audio behind it at start-up, which is
   * exactly when someone is most likely to be talking to check it works.
   */
  async warmUp(): Promise<void> {
    await this.#options.scorer.score(new Uint8Array(FRAME_BYTES), true);
    this.#pendingReset = true;
  }

  async probability(frame: Uint8Array): Promise<number> {
    if (frame.byteLength !== FRAME_BYTES) {
      throw new Error(
        `Silero VAD needs exactly ${FRAME_SAMPLES} samples (${FRAME_BYTES} bytes) per frame, ` +
          `got ${frame.byteLength}. The capture backend must be configured with frameSamples=512.`,
      );
    }

    if (this.#degraded && this.#clock.monotonicMs() < this.#nextRetryMs) {
      return this.#fallback.probability(frame);
    }

    try {
      const probabilities = await this.#options.scorer.score(frame, this.#pendingReset);
      const probability = probabilities[0];
      if (probability === undefined) throw new Error('worker returned no probability');

      this.#pendingReset = false;
      this.#failures = 0;
      if (this.#degraded) {
        this.#degraded = false;
        this.#options.logger.info('speech detection recovered: back on Silero VAD');
        this.#options.onRecovered?.();
      }
      return probability;
    } catch (error) {
      this.#onFailure((error as Error).message);
      return this.#fallback.probability(frame);
    }
  }

  reset(): void {
    this.#pendingReset = true;
    this.#fallback.reset();
  }

  #onFailure(reason: string): void {
    // The stream is broken either way; whatever state the worker held no longer
    // corresponds to the audio we are about to send it.
    this.#pendingReset = true;
    this.#nextRetryMs = this.#clock.monotonicMs() + this.#retryIntervalMs;
    this.#failures += 1;

    if (this.#degraded) return;
    if (this.#failures < this.#failureThreshold) {
      this.#options.logger.warn('streaming VAD frame failed', { reason, failures: this.#failures });
      return;
    }

    this.#degraded = true;
    this.#options.logger.error('speech detection degraded to an energy gate', { reason });
    this.#options.onDegraded?.(reason);
  }
}
