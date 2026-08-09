/**
 * VAD interface and a deterministic in-process implementation.
 *
 * The production detector is Silero VAD (ONNX) inside the Python worker, which
 * is the only thing that reliably separates *speech* from room tone, traffic,
 * a fan or a television. `EnergyVad` below is explicitly **not** a substitute:
 * it is an energy gate used for tests and for `capture test`, where the point
 * is to prove the audio path works, not to classify sound.
 */

export interface Vad {
  readonly name: string;
  /** Speech probability 0..1 for one frame of 16-bit mono PCM. */
  probability(frame: Uint8Array): number | Promise<number>;
  reset(): void;
  close?(): Promise<void>;
}

/**
 * Root-mean-square energy gate.
 *
 * Room tone in a quiet flat sits around -55 dBFS; speech at conversational
 * distance around -30 dBFS. The default threshold sits between them. This is
 * good enough to demonstrate the capture path and to drive tests with
 * synthesized tones, and nothing more — see the class comment.
 */
export class EnergyVad implements Vad {
  readonly name = 'energy-gate';
  readonly #thresholdDbfs: number;

  constructor(thresholdDbfs = -42) {
    this.#thresholdDbfs = thresholdDbfs;
  }

  probability(frame: Uint8Array): number {
    const dbfs = rmsDbfs(frame);
    if (!Number.isFinite(dbfs)) return 0;
    // Map [threshold-10, threshold+10] dBFS onto [0, 1] so callers can still
    // apply their own probability threshold meaningfully.
    const normalized = (dbfs - (this.#thresholdDbfs - 10)) / 20;
    return Math.min(1, Math.max(0, normalized));
  }

  reset(): void {}
}

export function rmsDbfs(frame: Uint8Array): number {
  const samples = new Int16Array(frame.buffer, frame.byteOffset, Math.floor(frame.byteLength / 2));
  if (samples.length === 0) return Number.NEGATIVE_INFINITY;

  let sumSquares = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const value = (samples[i] ?? 0) / 32768;
    sumSquares += value * value;
  }
  const rms = Math.sqrt(sumSquares / samples.length);
  if (rms === 0) return Number.NEGATIVE_INFINITY;
  return 20 * Math.log10(rms);
}

/** Replays a fixed probability sequence. Used by sessionizer tests. */
export class ScriptedVad implements Vad {
  readonly name = 'scripted';
  #index = 0;
  readonly #values: readonly number[];

  constructor(values: readonly number[]) {
    this.#values = values;
  }

  probability(): number {
    const value = this.#values[this.#index] ?? 0;
    this.#index = Math.min(this.#index + 1, this.#values.length);
    return value;
  }

  reset(): void {
    this.#index = 0;
  }
}
