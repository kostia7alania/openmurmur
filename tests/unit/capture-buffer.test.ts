import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CaptureBufferOverflowError, CaptureFrameBuffer } from '../../src/capture/frame-buffer.ts';
import { FakeClock } from '../../src/util/clock.ts';

function buffer(clock: FakeClock, maxBufferedFrames = 4): CaptureFrameBuffer {
  return new CaptureFrameBuffer({
    bytesPerFrame: 4,
    frameDurationMs: 32,
    maxBufferedFrames,
    clock,
  });
}

describe('capture frame buffer', () => {
  it('drains partial pipe chunks without losing frame alignment', async () => {
    const frames = buffer(new FakeClock(1_000, 2_000));
    frames.write(Buffer.from([1, 2, 3]));
    frames.write(Buffer.from([4, 5, 6, 7, 8]));

    assert.deepEqual([...((await frames.next()).value?.pcm ?? [])], [1, 2, 3, 4]);
    assert.deepEqual([...((await frames.next()).value?.pcm ?? [])], [5, 6, 7, 8]);
  });

  it('keeps capture cadence when the consumer clock jumps ahead', async () => {
    const clock = new FakeClock(2_000, 1_000);
    const frames = buffer(clock);
    frames.write(Buffer.alloc(4));
    frames.write(Buffer.alloc(4));
    clock.advance(5_000);

    const first = (await frames.next()).value;
    const second = (await frames.next()).value;
    assert.equal(first?.monotonicMs, 1_000);
    assert.equal(second?.monotonicMs, 1_032);
    assert.equal(first?.wallMs, 2_000);
    assert.equal(second?.wallMs, 2_032);
  });

  it('marks a real no-bytes gap and drops queued pre-gap audio', async () => {
    const clock = new FakeClock(2_000, 1_000);
    const frames = buffer(clock);
    frames.write(Buffer.alloc(4));
    clock.advance(1_000);
    frames.write(Buffer.alloc(4));

    assert.equal(frames.bufferedFrames, 1);
    assert.equal(frames.streamEpoch, 1);
    const resumed = (await frames.next()).value;
    assert.equal(resumed?.monotonicMs, 2_000);
    assert.equal(resumed?.streamEpoch, 1);
    assert.equal(resumed?.discontinuityBeforeMs, 968);
  });

  it('anchors the newest frame in the first pipe batch at its read time', async () => {
    const frames = buffer(new FakeClock(2_000, 1_000));
    frames.write(Buffer.alloc(8));

    const first = (await frames.next()).value;
    const second = (await frames.next()).value;
    assert.equal(first?.monotonicMs, 968);
    assert.equal(second?.monotonicMs, 1_000);
    assert.equal(first?.wallMs, 1_968);
    assert.equal(second?.wallMs, 2_000);
  });

  it('fails explicitly at its bound and preserves already queued audio', async () => {
    const frames = buffer(new FakeClock(), 2);
    assert.throws(
      () => frames.write(Buffer.alloc(12)),
      (error: unknown) => error instanceof CaptureBufferOverflowError && error.bufferedFrames === 2,
    );

    assert.equal((await frames.next()).done, false);
    assert.equal((await frames.next()).done, false);
  });

  it('wakes a waiting consumer and ends cleanly after queued frames drain', async () => {
    const frames = buffer(new FakeClock());
    const waiting = frames.next();
    frames.write(Buffer.from([1, 2, 3, 4]));
    assert.deepEqual([...((await waiting).value?.pcm ?? [])], [1, 2, 3, 4]);

    frames.write(Buffer.alloc(4));
    frames.close();
    assert.equal((await frames.next()).done, false);
    assert.equal((await frames.next()).done, true);
  });

  it('surfaces a producer failure after preserving buffered frames', async () => {
    const frames = buffer(new FakeClock());
    const failure = new Error('reader failed');
    frames.write(Buffer.alloc(8));
    frames.close(failure);

    assert.equal((await frames.next()).done, false);
    assert.equal((await frames.next()).done, false);
    await assert.rejects(frames.next(), failure);
  });

  it('invalidates an already resolved old frame when a control boundary clears the queue', async () => {
    const frames = buffer(new FakeClock());
    frames.write(Buffer.alloc(8));
    const alreadyResolved = frames.next();

    assert.equal(frames.discardBufferedFrames(), 1);
    assert.equal(frames.streamEpoch, 1);
    assert.equal((await alreadyResolved).value?.streamEpoch, 0);

    frames.write(Buffer.alloc(4));
    assert.equal((await frames.next()).value?.streamEpoch, 1);
  });

  it('aborts immediately instead of draining stale audio after a terminal failure', async () => {
    const frames = buffer(new FakeClock());
    const failure = new Error('capture failed');
    frames.write(Buffer.alloc(8));
    frames.abort(failure);

    assert.equal(frames.bufferedFrames, 0);
    await assert.rejects(frames.next(), failure);
  });

  it('wakes the consumer cleanly and rejects tail writes after intentional stop', async () => {
    const frames = buffer(new FakeClock());
    frames.write(Buffer.alloc(8));

    assert.equal(frames.stop(), 2);
    assert.equal((await frames.next()).done, true);
    assert.throws(() => frames.write(Buffer.alloc(4)), /closed/);
  });
});
