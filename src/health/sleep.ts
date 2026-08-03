import type { Clock } from '../util/clock.ts';

/**
 * Sleep detection.
 *
 * macOS suspends the whole process when the Mac sleeps. There is no signal to
 * subscribe to from a plain Node process, but sleep leaves an unmistakable
 * fingerprint: **wall-clock time advances while monotonic time does not.**
 *
 * On macOS `process.hrtime.bigint()` does not tick while the system is
 * suspended, so after a two-hour sleep the wall clock is two hours further on
 * and the monotonic clock has barely moved. Comparing the two deltas separates
 * a real sleep from an NTP step (which moves the wall clock but is not
 * accompanied by the process being frozen) closely enough to act on.
 *
 * Why this matters: an open session must not silently span the gap. A user who
 * spoke before closing the lid and again the next morning should get two
 * sessions, not one nine-hour recording with a hole in it.
 */

export interface SleepEvent {
  /** How long the machine appeared to be suspended. */
  readonly sleptMs: number;
  readonly detectedAtWallMs: number;
}

export interface SleepDetectorOptions {
  readonly clock: Clock;
  /**
   * Divergence above this is treated as sleep. It must exceed ordinary
   * scheduling jitter and small NTP corrections; a few seconds is far more
   * than either, and far less than any real sleep.
   */
  readonly thresholdMs?: number;
}

export class SleepDetector {
  readonly #clock: Clock;
  readonly #thresholdMs: number;
  #lastWallMs: number;
  #lastMonotonicMs: number;

  constructor(options: SleepDetectorOptions) {
    this.#clock = options.clock;
    this.#thresholdMs = options.thresholdMs ?? 10_000;
    this.#lastWallMs = options.clock.wallMs();
    this.#lastMonotonicMs = options.clock.monotonicMs();
  }

  /**
   * Call periodically. Returns an event the first time it observes a gap, then
   * resumes normal tracking.
   */
  poll(): SleepEvent | null {
    const wallMs = this.#clock.wallMs();
    const monotonicMs = this.#clock.monotonicMs();

    const wallDelta = wallMs - this.#lastWallMs;
    const monotonicDelta = monotonicMs - this.#lastMonotonicMs;
    const divergence = wallDelta - monotonicDelta;

    this.#lastWallMs = wallMs;
    this.#lastMonotonicMs = monotonicMs;

    // Only a *forward* divergence indicates suspension. A backwards jump is an
    // NTP correction, which the sessionizer already ignores by using monotonic
    // time for every duration decision.
    if (divergence < this.#thresholdMs) return null;

    return { sleptMs: divergence, detectedAtWallMs: wallMs };
  }
}

export function formatSleepDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes} мин`;
  const hours = Math.floor(minutes / 60);
  return `${hours} ч ${minutes % 60} мин`;
}

export function renderSleepMessage(event: SleepEvent): string {
  return (
    '🟡 Запись прерывалась: компьютер спал\n\n' +
    `Длительность паузы: ${formatSleepDuration(event.sleptMs)}\n` +
    'Открытая сессия закрыта и отправлена отдельно, чтобы запись не выглядела ' +
    'непрерывной там, где звука не было.'
  );
}
