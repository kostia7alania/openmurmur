import { randomUUID } from 'node:crypto';
import type { SessionizerConfig } from '../config/schema.ts';
import type {
  RejectionReason,
  SessionIntent,
  SessionizerSnapshot,
  SessionState,
  VadFrame,
} from './types.ts';

export interface SessionizerOptions {
  readonly config: SessionizerConfig;
  /** Injectable for deterministic tests. */
  readonly generateSessionId?: () => string;
}

/**
 * Pure session state machine.
 *
 * Every duration decision uses the monotonic timestamps carried on each frame,
 * never `Date.now()`. A wall-clock jump (NTP step, sleep/wake, DST) therefore
 * cannot prematurely close a session or stretch one to hours.
 *
 * Transitions:
 *
 *   IDLE --speech--> SPEECH_CANDIDATE --sustained 500ms--> ACTIVE
 *     ^                    |                                 |
 *     |                    +--speech stops--> IDLE           | silence
 *     |                                                       v
 *     +<--finalize-- FINALIZING <--60s silence-- SILENCE_GRACE
 *                                                     |
 *                                    speech returns --+
 *
 * FINALIZING is transient inside `push()`: the machine emits the close/finalize
 * intents and returns to IDLE in the same call, so a new session can begin on
 * the very next frame while the previous one is still being transcribed. The
 * downstream PROCESSING / DELIVERING / DONE states belong to the job pipeline
 * and are tracked per-session in SQLite, not here.
 */
export class Sessionizer {
  readonly #config: SessionizerConfig;
  readonly #newId: () => string;

  #state: SessionState = 'IDLE';
  #sessionId: string | null = null;
  #partIndex = 0;

  /**
   * Durations of the frames currently held for pre-roll, oldest first.
   * Bounded by preRollSeconds, so at 32 ms/frame and a 5 s pre-roll this holds
   * ~157 numbers.
   */
  readonly #ring: number[] = [];
  #ringMs = 0;

  #candidateSpeechMs = 0;
  #speechMs = 0;
  #sessionStartedMonotonicMs: number | null = null;
  #sessionStartedWallMs: number | null = null;
  #partStartedMonotonicMs: number | null = null;
  #lastSpeechMonotonicMs: number | null = null;
  #lastFrameWallMs = 0;
  #lastFrameMonotonicMs = 0;

  constructor(options: SessionizerOptions) {
    this.#config = options.config;
    this.#newId = options.generateSessionId ?? randomUUID;
  }

  get state(): SessionState {
    return this.#state;
  }

  get sessionId(): string | null {
    return this.#sessionId;
  }

  snapshot(): SessionizerSnapshot {
    return {
      state: this.#state,
      sessionId: this.#sessionId,
      partIndex: this.#partIndex,
      speechMs: this.#speechMs,
      sessionStartedMonotonicMs: this.#sessionStartedMonotonicMs,
      sessionStartedWallMs: this.#sessionStartedWallMs,
      silenceMs:
        this.#lastSpeechMonotonicMs === null
          ? null
          : this.#lastFrameMonotonicMs - this.#lastSpeechMonotonicMs,
    };
  }

  /**
   * Feed one VAD frame. Returns the intents the host must carry out, in order.
   */
  push(frame: VadFrame): readonly SessionIntent[] {
    const intents: SessionIntent[] = [];
    const isSpeech = frame.speechProbability >= this.#config.vadThreshold;
    this.#lastFrameWallMs = frame.wallMs;
    this.#lastFrameMonotonicMs = frame.monotonicMs;

    switch (this.#state) {
      case 'IDLE':
        this.#bufferPreRoll(frame);
        if (isSpeech) {
          this.#state = 'SPEECH_CANDIDATE';
          this.#candidateSpeechMs = frame.durationMs;
        }
        break;

      case 'SPEECH_CANDIDATE':
        this.#bufferPreRoll(frame);
        if (!isSpeech) {
          // A door slam, a cough, one loud keystroke: not a session.
          this.#state = 'IDLE';
          this.#candidateSpeechMs = 0;
          break;
        }
        this.#candidateSpeechMs += frame.durationMs;
        if (this.#candidateSpeechMs >= this.#config.speechCandidateMs) {
          intents.push(...this.#openSession(frame));
        }
        break;

      case 'ACTIVE':
        if (isSpeech) {
          this.#speechMs += frame.durationMs;
          this.#lastSpeechMonotonicMs = frame.monotonicMs;
          this.#maybeRotate(frame, intents);
        } else {
          this.#state = 'SILENCE_GRACE';
        }
        break;

      case 'SILENCE_GRACE':
        if (isSpeech) {
          // Speech returned inside the grace window: same logical session.
          this.#state = 'ACTIVE';
          this.#speechMs += frame.durationMs;
          this.#lastSpeechMonotonicMs = frame.monotonicMs;
          this.#maybeRotate(frame, intents);
          break;
        }
        if (this.#silenceElapsedMs(frame) >= this.#config.silenceTimeoutSeconds * 1000) {
          intents.push(...this.#finalize(frame));
        }
        break;

      // The machine never rests in these; they are pipeline states recorded in
      // SQLite. Reaching one here would mean a caller mutated state directly.
      case 'FINALIZING':
      case 'PROCESSING':
      case 'DELIVERING':
      case 'DONE':
        throw new Error(`Sessionizer.push called in non-input state ${this.#state}`);
    }

    return intents;
  }

  /**
   * Close the current session immediately (daemon shutdown, capture failure).
   * Returns the intents needed to leave the recording durable on disk.
   */
  forceFinalize(): readonly SessionIntent[] {
    if (this.#state !== 'ACTIVE' && this.#state !== 'SILENCE_GRACE') {
      this.#resetToIdle();
      return [];
    }
    return this.#finalize({
      monotonicMs: this.#lastFrameMonotonicMs,
      wallMs: this.#lastFrameWallMs,
      durationMs: 0,
      speechProbability: 0,
    });
  }

  /**
   * Record the outcome of ASR for a session that passed the speech-duration
   * gate but may still be noise. Returns a rejection intent when the transcript
   * is too thin to be worth a Telegram message.
   */
  classifyTranscript(sessionId: string, wordCount: number, speechMs: number): SessionIntent | null {
    if (wordCount >= this.#config.minTranscriptWords) return null;
    return {
      kind: 'session_rejected',
      sessionId,
      reason: wordCount === 0 ? 'asr_empty' : 'insufficient_words',
      speechMs,
      partCount: 0,
    };
  }

  #silenceElapsedMs(frame: VadFrame): number {
    if (this.#lastSpeechMonotonicMs === null) return 0;
    return frame.monotonicMs - this.#lastSpeechMonotonicMs;
  }

  #bufferPreRoll(frame: VadFrame): void {
    const capacityMs = this.#config.preRollSeconds * 1000;
    this.#ring.push(frame.durationMs);
    this.#ringMs += frame.durationMs;
    while (this.#ring.length > 1 && this.#ringMs > capacityMs) {
      const oldest = this.#ring.shift();
      if (oldest === undefined) break;
      this.#ringMs -= oldest;
    }
  }

  #drainPreRoll(): { frames: number; ms: number } {
    const drained = { frames: this.#ring.length, ms: this.#ringMs };
    this.#ring.length = 0;
    this.#ringMs = 0;
    return drained;
  }

  #openSession(frame: VadFrame): readonly SessionIntent[] {
    const sessionId = this.#newId();
    // The session's clock starts at the beginning of the pre-roll, not at the
    // frame that tripped the threshold, so the reported start time matches the
    // audio the user will actually hear.
    const startedMonotonicMs = frame.monotonicMs - this.#ringMs;
    const startedWallMs = frame.wallMs - this.#ringMs;

    this.#state = 'ACTIVE';
    this.#sessionId = sessionId;
    this.#partIndex = 0;
    this.#speechMs = this.#candidateSpeechMs;
    this.#candidateSpeechMs = 0;
    this.#sessionStartedMonotonicMs = startedMonotonicMs;
    this.#sessionStartedWallMs = startedWallMs;
    this.#partStartedMonotonicMs = startedMonotonicMs;
    this.#lastSpeechMonotonicMs = frame.monotonicMs;

    const preRoll = this.#drainPreRoll();

    return [
      { kind: 'session_started', sessionId, startedWallMs },
      {
        kind: 'open_part',
        sessionId,
        partIndex: 0,
        preRollFrames: preRoll.frames,
        preRollMs: preRoll.ms,
        startedWallMs,
        startedMonotonicMs,
      },
    ];
  }

  /**
   * Rotation is evaluated only while ACTIVE. Rotating during SILENCE_GRACE
   * would risk emitting a part containing nothing but trailing silence; instead
   * a part may overrun by at most `silenceTimeoutSeconds`, which the delivery
   * size check still covers.
   */
  #maybeRotate(frame: VadFrame, intents: SessionIntent[]): void {
    const partStart = this.#partStartedMonotonicMs;
    const sessionId = this.#sessionId;
    if (partStart === null || sessionId === null) return;
    if (frame.monotonicMs - partStart < this.#config.maxPartSeconds * 1000) return;

    intents.push({
      kind: 'close_part',
      sessionId,
      partIndex: this.#partIndex,
      endedWallMs: frame.wallMs,
      endedMonotonicMs: frame.monotonicMs,
      reason: 'rotation',
    });
    this.#partIndex += 1;
    this.#partStartedMonotonicMs = frame.monotonicMs;
    intents.push({
      kind: 'open_part',
      sessionId,
      partIndex: this.#partIndex,
      preRollFrames: 0,
      preRollMs: 0,
      startedWallMs: frame.wallMs,
      startedMonotonicMs: frame.monotonicMs,
    });
  }

  #finalize(frame: VadFrame): readonly SessionIntent[] {
    const sessionId = this.#sessionId;
    const startedWallMs = this.#sessionStartedWallMs;
    const startedMonotonicMs = this.#sessionStartedMonotonicMs;
    if (sessionId === null || startedWallMs === null || startedMonotonicMs === null) {
      this.#resetToIdle();
      return [];
    }

    const partCount = this.#partIndex + 1;
    const speechMs = this.#speechMs;
    const durationMs = frame.monotonicMs - startedMonotonicMs;
    const intents: SessionIntent[] = [
      {
        kind: 'close_part',
        sessionId,
        partIndex: this.#partIndex,
        endedWallMs: frame.wallMs,
        endedMonotonicMs: frame.monotonicMs,
        reason: 'session_end',
        finalSession: {
          endedWallMs: frame.wallMs,
          durationMs,
          speechMs,
        },
      },
    ];

    if (speechMs < this.#config.minSpeechSeconds * 1000) {
      const reason: RejectionReason = 'insufficient_speech';
      intents.push({
        kind: 'session_rejected',
        sessionId,
        reason,
        speechMs,
        partCount,
        endedWallMs: frame.wallMs,
        durationMs,
      });
    } else {
      intents.push({
        kind: 'session_finalized',
        sessionId,
        startedWallMs,
        endedWallMs: frame.wallMs,
        partCount,
        speechMs,
        durationMs,
      });
    }

    this.#resetToIdle();
    return intents;
  }

  #resetToIdle(): void {
    this.#state = 'IDLE';
    this.#sessionId = null;
    this.#partIndex = 0;
    this.#speechMs = 0;
    this.#candidateSpeechMs = 0;
    this.#sessionStartedMonotonicMs = null;
    this.#sessionStartedWallMs = null;
    this.#partStartedMonotonicMs = null;
    this.#lastSpeechMonotonicMs = null;
    this.#drainPreRoll();
  }
}
