import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DEFAULT_CONFIG } from '../../src/config/schema.ts';
import { Sessionizer } from '../../src/sessionizer/machine.ts';
import type { SessionIntent } from '../../src/sessionizer/types.ts';
import { FakeClock } from '../../src/util/clock.ts';

/**
 * Every timing rule in the product is decided here, so these tests drive a
 * fake clock rather than sleeping. A 60-second silence timeout and a 15-minute
 * rotation are verified in microseconds.
 */

const FRAME_MS = 32;
const CONFIG = DEFAULT_CONFIG.sessionizer;

interface Harness {
  readonly machine: Sessionizer;
  readonly clock: FakeClock;
  /** Feeds `ms` of audio at the given speech probability. */
  feed(ms: number, probability: number): SessionIntent[];
}

function harness(overrides: Partial<typeof CONFIG> = {}): Harness {
  const clock = new FakeClock();
  let counter = 0;
  const machine = new Sessionizer({
    config: { ...CONFIG, ...overrides },
    generateSessionId: () => `session-${++counter}`,
  });

  return {
    machine,
    clock,
    feed(ms, probability) {
      const collected: SessionIntent[] = [];
      const frames = Math.round(ms / FRAME_MS);
      for (let i = 0; i < frames; i += 1) {
        clock.advance(FRAME_MS);
        collected.push(
          ...machine.push({
            monotonicMs: clock.monotonicMs(),
            wallMs: clock.wallMs(),
            durationMs: FRAME_MS,
            speechProbability: probability,
          }),
        );
      }
      return collected;
    },
  };
}

const SPEECH = 0.9;
const SILENCE = 0.05;

const kinds = (intents: readonly SessionIntent[]) => intents.map((i) => i.kind);

describe('sessionizer: opening a session', () => {
  it('starts in IDLE', () => {
    assert.equal(harness().machine.state, 'IDLE');
  });

  it('goes IDLE -> ACTIVE once speech is sustained', () => {
    const h = harness();
    h.feed(2000, SILENCE);
    assert.equal(h.machine.state, 'IDLE');

    const intents = h.feed(600, SPEECH);
    assert.equal(h.machine.state, 'ACTIVE');
    assert.deepEqual(kinds(intents), ['session_started', 'open_part']);
  });

  it('does not open a session for a short noise burst', () => {
    // A door slam or one loud keystroke: under the 500 ms candidate window.
    const h = harness();
    h.feed(2000, SILENCE);
    const intents = h.feed(300, SPEECH);

    assert.equal(h.machine.state, 'SPEECH_CANDIDATE');
    assert.deepEqual(kinds(intents), []);

    h.feed(100, SILENCE);
    assert.equal(h.machine.state, 'IDLE', 'a false candidate must fall back to IDLE');
  });

  it('re-arms after a false candidate, so real speech still opens a session', () => {
    const h = harness();
    h.feed(300, SPEECH);
    h.feed(500, SILENCE);
    const intents = h.feed(600, SPEECH);
    assert.deepEqual(kinds(intents), ['session_started', 'open_part']);
  });

  it('respects a configured speech-candidate threshold', () => {
    const h = harness({ speechCandidateMs: 2000 });
    h.feed(1000, SPEECH);
    assert.equal(h.machine.state, 'SPEECH_CANDIDATE');
    h.feed(1200, SPEECH);
    assert.equal(h.machine.state, 'ACTIVE');
  });
});

describe('sessionizer: pre-roll', () => {
  it('prepends buffered audio so the session starts before the first word', () => {
    const h = harness();
    h.feed(10_000, SILENCE); // more than the 5 s ring capacity
    const intents = h.feed(600, SPEECH);

    const open = intents.find((i) => i.kind === 'open_part');
    assert.ok(open?.kind === 'open_part');
    assert.ok(open.preRollMs > 0, 'pre-roll must be non-empty');
    assert.ok(
      open.preRollMs <= CONFIG.preRollSeconds * 1000,
      `pre-roll ${open.preRollMs}ms must not exceed the ${CONFIG.preRollSeconds}s ring`,
    );
  });

  it('backdates the session start by the pre-roll length', () => {
    const h = harness();
    h.feed(10_000, SILENCE);
    const intents = h.feed(600, SPEECH);

    const started = intents.find((i) => i.kind === 'session_started');
    const open = intents.find((i) => i.kind === 'open_part');
    assert.ok(started?.kind === 'session_started' && open?.kind === 'open_part');
    assert.equal(started.startedWallMs, open.startedWallMs);
    // The reported start precedes the frame that crossed the threshold.
    assert.ok(started.startedWallMs < h.clock.wallMs());
  });

  it('does not replay pre-roll into parts created by rotation', () => {
    const h = harness({ maxPartSeconds: 2, silenceTimeoutSeconds: 1 });
    h.feed(600, SPEECH);
    const intents = h.feed(3000, SPEECH);

    const opens = intents.filter((i) => i.kind === 'open_part');
    assert.ok(opens.length >= 1);
    for (const open of opens) {
      assert.ok(open.kind === 'open_part');
      assert.equal(open.preRollMs, 0, 'a rotated part continues seamlessly, no pre-roll');
    }
  });
});

describe('sessionizer: closing on silence', () => {
  it('enters SILENCE_GRACE the moment speech stops', () => {
    const h = harness();
    h.feed(600, SPEECH);
    h.feed(100, SILENCE);
    assert.equal(h.machine.state, 'SILENCE_GRACE');
  });

  it('keeps the same session when speech returns at 59 seconds', () => {
    const h = harness();
    const opening = h.feed(600, SPEECH);
    const sessionId = h.machine.sessionId;

    const during = h.feed(59_000, SILENCE);
    assert.deepEqual(kinds(during), [], 'nothing may close before the timeout');
    assert.equal(h.machine.state, 'SILENCE_GRACE');

    h.feed(600, SPEECH);
    assert.equal(h.machine.state, 'ACTIVE');
    assert.equal(h.machine.sessionId, sessionId, 'it is still the same logical session');
    assert.equal(kinds(opening).filter((k) => k === 'session_started').length, 1);
  });

  it('finalizes at 60 seconds of silence', () => {
    const h = harness();
    h.feed(4000, SPEECH); // clears the 3 s minimum-speech floor

    const before = h.feed(59_500, SILENCE);
    assert.deepEqual(kinds(before), []);

    const after = h.feed(1000, SILENCE);
    assert.deepEqual(kinds(after), ['close_part', 'session_finalized']);
    assert.equal(h.machine.state, 'IDLE');
  });

  it('honours a configured silence timeout', () => {
    const h = harness({ silenceTimeoutSeconds: 5, maxPartSeconds: 600 });
    h.feed(4000, SPEECH);
    assert.deepEqual(kinds(h.feed(4500, SILENCE)), []);
    assert.deepEqual(kinds(h.feed(1000, SILENCE)), ['close_part', 'session_finalized']);
  });

  it('resets the silence timer on every return of speech', () => {
    const h = harness();
    h.feed(600, SPEECH);
    for (let i = 0; i < 5; i += 1) {
      h.feed(50_000, SILENCE);
      const intents = h.feed(200, SPEECH);
      assert.deepEqual(kinds(intents), [], `cycle ${i}: must not close`);
    }
    assert.equal(h.machine.state, 'ACTIVE');
  });
});

describe('sessionizer: monotonic time', () => {
  it('ignores a wall-clock jump when deciding to close', () => {
    const h = harness();
    h.feed(600, SPEECH);
    h.feed(10_000, SILENCE);

    // NTP steps the wall clock forward an hour. Monotonic time does not move.
    h.clock.jumpWallClock(3_600_000);

    const intents = h.feed(1000, SILENCE);
    assert.deepEqual(kinds(intents), [], 'a clock step must not close a live session');
    assert.equal(h.machine.state, 'SILENCE_GRACE');
  });

  it('closes on real elapsed time even after a backwards wall-clock step', () => {
    const h = harness();
    h.feed(4000, SPEECH);
    h.clock.jumpWallClock(-7_200_000);
    const intents = h.feed(61_000, SILENCE);
    assert.deepEqual(kinds(intents), ['close_part', 'session_finalized']);
    const close = intents.find((intent) => intent.kind === 'close_part');
    const finalized = intents.find((intent) => intent.kind === 'session_finalized');
    assert.ok(close?.kind === 'close_part' && close.finalSession !== undefined);
    assert.ok(finalized?.kind === 'session_finalized');
    assert.equal(close.finalSession.durationMs, finalized.durationMs);
    assert.equal(close.finalSession.speechMs, finalized.speechMs);
    assert.equal(close.finalSession.endedWallMs, finalized.endedWallMs);
    assert.ok(close.finalSession.durationMs > 0, 'wall-clock reversal cannot corrupt duration');
  });
});

describe('sessionizer: 15-minute rotation', () => {
  it('rotates the physical file without ending the logical session', () => {
    const h = harness({ maxPartSeconds: 60, silenceTimeoutSeconds: 10 });
    h.feed(600, SPEECH);
    const sessionId = h.machine.sessionId;

    const intents = h.feed(61_000, SPEECH);
    const rotations = intents.filter((i) => i.kind === 'close_part');

    assert.equal(rotations.length, 1);
    assert.ok(rotations[0]?.kind === 'close_part');
    assert.equal(rotations[0].reason, 'rotation');
    assert.equal(h.machine.state, 'ACTIVE', 'the session stays open across rotation');
    assert.equal(h.machine.sessionId, sessionId);
  });

  it('gives every part of one session the same session id', () => {
    const h = harness({ maxPartSeconds: 30, silenceTimeoutSeconds: 10 });
    h.feed(600, SPEECH);
    const intents = h.feed(95_000, SPEECH);

    const parts = intents.filter((i) => i.kind === 'open_part' || i.kind === 'close_part');
    assert.ok(parts.length >= 4, 'expected several rotations');

    const ids = new Set(parts.map((p) => p.sessionId));
    assert.equal(ids.size, 1, 'all parts share one session id');
  });

  it('numbers parts consecutively from zero', () => {
    const h = harness({ maxPartSeconds: 30, silenceTimeoutSeconds: 10 });
    const opening = h.feed(600, SPEECH);
    const rest = h.feed(95_000, SPEECH);

    const opens = [...opening, ...rest].filter((i) => i.kind === 'open_part');
    const indices = opens.map((o) => (o.kind === 'open_part' ? o.partIndex : -1));
    assert.deepEqual(
      indices,
      indices.map((_, i) => i),
    );
  });

  it('reports the true part count when the session finally closes', () => {
    const h = harness({ maxPartSeconds: 30, silenceTimeoutSeconds: 5 });
    h.feed(600, SPEECH);
    h.feed(65_000, SPEECH);
    const closing = h.feed(6000, SILENCE);

    const finalized = closing.find((i) => i.kind === 'session_finalized');
    assert.ok(finalized?.kind === 'session_finalized');
    assert.equal(finalized.partCount, 3);
  });

  it('does not rotate while only silence is playing out', () => {
    // Rotating during the grace window would emit a part of pure silence.
    const h = harness({ maxPartSeconds: 2, silenceTimeoutSeconds: 10 });
    h.feed(600, SPEECH);
    const intents = h.feed(9000, SILENCE);
    assert.deepEqual(kinds(intents), []);
  });
});

describe('sessionizer: rejecting noise', () => {
  it('rejects a session with less than the minimum speech', () => {
    const h = harness({ minSpeechSeconds: 3, speechCandidateMs: 500 });
    h.feed(1000, SPEECH); // 1 s of speech, under the 3 s floor
    const intents = h.feed(61_000, SILENCE);

    const rejected = intents.find((i) => i.kind === 'session_rejected');
    assert.ok(rejected?.kind === 'session_rejected');
    assert.equal(rejected.reason, 'insufficient_speech');
    assert.equal(
      intents.find((i) => i.kind === 'session_finalized'),
      undefined,
    );
  });

  it('still closes the audio part for a rejected session', () => {
    // The file must be valid on disk even when we throw the session away.
    const h = harness({ minSpeechSeconds: 3 });
    h.feed(1000, SPEECH);
    const intents = h.feed(61_000, SILENCE);
    assert.equal(kinds(intents)[0], 'close_part');
  });

  it('accepts a session that clears the speech floor', () => {
    const h = harness({ minSpeechSeconds: 3 });
    h.feed(4000, SPEECH);
    const intents = h.feed(61_000, SILENCE);
    assert.ok(intents.some((i) => i.kind === 'session_finalized'));
  });

  it('flags a transcript with too few words', () => {
    const h = harness({ minTranscriptWords: 5 });
    const rejection = h.machine.classifyTranscript('s1', 2, 9000);
    assert.ok(rejection?.kind === 'session_rejected');
    assert.equal(rejection.reason, 'insufficient_words');

    assert.equal(h.machine.classifyTranscript('s1', 9, 9000), null);
  });

  it('distinguishes an empty transcript from a thin one', () => {
    const h = harness();
    const empty = h.machine.classifyTranscript('s1', 0, 9000);
    assert.ok(empty?.kind === 'session_rejected');
    assert.equal(empty.reason, 'asr_empty');
  });
});

describe('sessionizer: concurrency and shutdown', () => {
  it('is ready for a new session immediately after one finalizes', () => {
    // Processing happens on the job queue; the recorder must not be blocked.
    const h = harness();
    h.feed(4000, SPEECH);
    const closing = h.feed(61_000, SILENCE);
    const first = closing.find((i) => i.kind === 'session_finalized');
    assert.ok(first?.kind === 'session_finalized');

    const second = h.feed(4000, SPEECH);
    const started = second.find((i) => i.kind === 'session_started');
    assert.ok(started?.kind === 'session_started');
    assert.notEqual(started.sessionId, first.sessionId, 'a distinct new session');
    assert.equal(h.machine.state, 'ACTIVE');
  });

  it('force-finalizes an active session on shutdown', () => {
    const h = harness();
    h.feed(4000, SPEECH);
    const intents = h.machine.forceFinalize();
    assert.deepEqual(kinds(intents), ['close_part', 'session_finalized']);
    assert.equal(h.machine.state, 'IDLE');
  });

  it('force-finalize on an idle machine is a no-op', () => {
    const h = harness();
    assert.deepEqual(h.machine.forceFinalize(), []);
  });

  it('reports speech time, not elapsed time, in the snapshot', () => {
    const h = harness();
    h.feed(4000, SPEECH);
    h.feed(10_000, SILENCE);
    const snapshot = h.machine.snapshot();

    assert.ok(snapshot.speechMs >= 3900 && snapshot.speechMs <= 4100, `got ${snapshot.speechMs}`);
    assert.ok((snapshot.silenceMs ?? 0) >= 9900);
  });
});
