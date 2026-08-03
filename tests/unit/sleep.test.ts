import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { formatSleepDuration, renderSleepMessage, SleepDetector } from '../../src/health/sleep.ts';
import { FakeClock } from '../../src/util/clock.ts';

/**
 * Sleep leaves a fingerprint: wall-clock time advances while monotonic time
 * does not, because macOS freezes the process. `FakeClock` can reproduce that
 * exactly, so none of this needs a real suspend.
 */

describe('sleep detection', () => {
  it('says nothing while time passes normally', () => {
    const clock = new FakeClock();
    const detector = new SleepDetector({ clock });

    for (let i = 0; i < 20; i += 1) {
      clock.advance(2000);
      assert.equal(detector.poll(), null);
    }
  });

  it('detects a suspend as a wall-clock gap the monotonic clock did not see', () => {
    const clock = new FakeClock();
    const detector = new SleepDetector({ clock });

    clock.advance(2000);
    assert.equal(detector.poll(), null);

    // Two hours of sleep: the wall clock moved, the process did not run.
    clock.jumpWallClock(2 * 60 * 60 * 1000);
    const event = detector.poll();

    assert.ok(event, 'a two-hour gap must be detected');
    assert.ok(Math.abs(event.sleptMs - 2 * 60 * 60 * 1000) < 1000);
  });

  it('reports the gap once, then resumes normal tracking', () => {
    const clock = new FakeClock();
    const detector = new SleepDetector({ clock });

    clock.jumpWallClock(60 * 60 * 1000);
    assert.ok(detector.poll());

    clock.advance(2000);
    assert.equal(detector.poll(), null, 'the same sleep must not be reported twice');
  });

  it('ignores an NTP correction that moves the clock backwards', () => {
    // The sessionizer already ignores backwards jumps by using monotonic time;
    // treating one as sleep would close a live session for no reason.
    const clock = new FakeClock();
    const detector = new SleepDetector({ clock });

    clock.advance(1000);
    clock.jumpWallClock(-60 * 60 * 1000);
    assert.equal(detector.poll(), null);
  });

  it('ignores ordinary scheduling jitter', () => {
    const clock = new FakeClock();
    const detector = new SleepDetector({ clock, thresholdMs: 10_000 });

    clock.advance(2000);
    clock.jumpWallClock(500); // a small NTP nudge
    assert.equal(detector.poll(), null, 'half a second is not a sleep');
  });

  it('respects a configured threshold', () => {
    const clock = new FakeClock();
    const detector = new SleepDetector({ clock, thresholdMs: 60_000 });

    clock.jumpWallClock(30_000);
    assert.equal(detector.poll(), null, 'below the threshold');

    clock.jumpWallClock(90_000);
    assert.ok(detector.poll(), 'above it');
  });

  it('detects a very long sleep, such as overnight', () => {
    const clock = new FakeClock();
    const detector = new SleepDetector({ clock });

    clock.jumpWallClock(9 * 60 * 60 * 1000);
    const event = detector.poll();

    assert.ok(event);
    assert.ok(event.sleptMs > 8 * 60 * 60 * 1000);
  });
});

describe('sleep reporting', () => {
  it('formats durations the way a person would say them', () => {
    assert.equal(formatSleepDuration(90_000), '2 мин');
    assert.equal(formatSleepDuration(45 * 60_000), '45 мин');
    assert.equal(formatSleepDuration(2.5 * 60 * 60_000), '2 ч 30 мин');
  });

  it('explains what happened to the recording, not just that time passed', () => {
    const message = renderSleepMessage({ sleptMs: 3 * 60 * 60_000, detectedAtWallMs: 0 });
    assert.match(message, /🟡/);
    assert.match(message, /3 ч 0 мин/);
    assert.match(message, /сессия закрыта/i);
  });
});
