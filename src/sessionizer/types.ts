/**
 * Sessionizer state machine vocabulary.
 *
 * The sessionizer is deliberately pure: it consumes VAD verdicts plus a clock
 * and emits *intents*. It never touches the filesystem, the database or
 * Telegram. That is what makes the 60-second-silence and 15-minute-rotation
 * rules testable in milliseconds with a fake clock.
 */

export type SessionState =
  | 'IDLE'
  | 'SPEECH_CANDIDATE'
  | 'ACTIVE'
  | 'SILENCE_GRACE'
  | 'FINALIZING'
  | 'PROCESSING'
  | 'DELIVERING'
  | 'DONE';

/** One VAD verdict for one fixed-size audio frame. */
export interface VadFrame {
  /** Monotonic milliseconds at the *end* of this frame. */
  readonly monotonicMs: number;
  /** Wall-clock milliseconds at the end of this frame, UTC. */
  readonly wallMs: number;
  readonly durationMs: number;
  /** Silero speech probability, 0..1. */
  readonly speechProbability: number;
}

export type RejectionReason =
  | 'insufficient_speech'
  | 'insufficient_words'
  | 'asr_empty'
  | 'asr_failed';

/**
 * Side effects the sessionizer asks its host to perform. The host (the daemon)
 * owns all I/O and may fail an intent without corrupting sessionizer state.
 */
export type SessionIntent =
  | {
      readonly kind: 'open_part';
      readonly sessionId: string;
      readonly partIndex: number;
      /** Frames replayed from the pre-roll ring buffer, oldest first. */
      readonly preRollFrames: number;
      /** Audio duration those frames represent. Zero for parts 1..n after rotation. */
      readonly preRollMs: number;
      readonly startedWallMs: number;
      readonly startedMonotonicMs: number;
    }
  | {
      readonly kind: 'close_part';
      readonly sessionId: string;
      readonly partIndex: number;
      readonly endedWallMs: number;
      readonly endedMonotonicMs: number;
      readonly reason: 'rotation' | 'session_end';
      /** Present only for the last part, before its archive publication. */
      readonly finalSession?: {
        readonly endedWallMs: number;
        readonly durationMs: number;
        readonly speechMs: number;
      };
    }
  | {
      readonly kind: 'session_started';
      readonly sessionId: string;
      readonly startedWallMs: number;
    }
  | {
      readonly kind: 'session_finalized';
      readonly sessionId: string;
      readonly startedWallMs: number;
      readonly endedWallMs: number;
      readonly partCount: number;
      readonly speechMs: number;
      readonly durationMs: number;
    }
  | {
      readonly kind: 'session_rejected';
      readonly sessionId: string;
      readonly reason: RejectionReason;
      readonly speechMs: number;
      readonly partCount: number;
      readonly endedWallMs?: number;
      readonly durationMs?: number;
    };

export interface SessionizerSnapshot {
  readonly state: SessionState;
  readonly sessionId: string | null;
  readonly partIndex: number;
  readonly speechMs: number;
  readonly sessionStartedMonotonicMs: number | null;
  readonly sessionStartedWallMs: number | null;
  /** Milliseconds since the last speech frame, or null if speech is current. */
  readonly silenceMs: number | null;
}
