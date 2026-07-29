/**
 * Clock abstraction.
 *
 * The sessionizer must be testable without real time passing, and it must not
 * be fooled by wall-clock jumps (NTP steps, sleep/wake, timezone changes).
 * Therefore every duration decision uses `monotonicMs`, and only user-facing
 * timestamps use `wallMs`.
 */
export interface Clock {
  /** Milliseconds since an arbitrary fixed origin. Never goes backwards. */
  monotonicMs(): number;
  /** Milliseconds since the Unix epoch, UTC. May jump. Display/records only. */
  wallMs(): number;
}

export const systemClock: Clock = {
  monotonicMs: () => Number(process.hrtime.bigint() / 1_000_000n),
  wallMs: () => Date.now(),
};

/** Manually advanced clock for deterministic tests. */
export class FakeClock implements Clock {
  #monotonic: number;
  #wall: number;

  constructor(startWallMs = 1_700_000_000_000, startMonotonicMs = 0) {
    this.#wall = startWallMs;
    this.#monotonic = startMonotonicMs;
  }

  monotonicMs(): number {
    return this.#monotonic;
  }

  wallMs(): number {
    return this.#wall;
  }

  /** Advance both clocks together, as real time would. */
  advance(ms: number): void {
    if (ms < 0) throw new Error('FakeClock cannot go backwards');
    this.#monotonic += ms;
    this.#wall += ms;
  }

  /** Simulate an NTP step or DST change: wall clock jumps, monotonic does not. */
  jumpWallClock(ms: number): void {
    this.#wall += ms;
  }
}

export function toIsoUtc(wallMs: number): string {
  return new Date(wallMs).toISOString();
}
