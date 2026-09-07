import assert from 'node:assert/strict';
import { it } from 'node:test';
import type { CaptureBackend } from '../../src/capture/backend.ts';
import { captureTest } from '../../src/cli/main.ts';
import { FakeClock } from '../../src/util/clock.ts';

it('rejects digital silence without rejecting quiet nonzero input or extending capture on wall jumps', async (t) => {
  let output = '';
  t.mock.method(process.stdout, 'write', (chunk: string | Uint8Array) => {
    output += String(chunk);
    return true;
  });
  t.mock.method(process.stderr, 'write', (chunk: string | Uint8Array) => {
    output += String(chunk);
    return true;
  });
  for (const sample of [0, 1, 16_384]) {
    output = '';
    const clock = new FakeClock();
    let stopped = false;
    let frames = 0;
    const pcm = Buffer.alloc(1024);
    pcm.writeInt16LE(sample);
    const capture: CaptureBackend = {
      name: 'diagnostic-fixture',
      async *start() {
        for (let index = 0; index < 200; index += 1) {
          frames += 1;
          yield { pcm, monotonicMs: clock.monotonicMs(), wallMs: clock.wallMs(), durationMs: 32 };
          clock.advance(32);
          clock.jumpWallClock(-86_400_000);
        }
      },
      async stop() {
        stopped = true;
      },
      msSinceLastFrame: () => null,
    };
    assert.equal(await captureTest(capture), sample === 0 ? 1 : 0);
    assert.equal(stopped, true, 'the diagnostic must release the microphone');
    assert.equal(frames, 158, 'wall-clock corrections cannot lengthen the five-second probe');
    if (sample === 0) {
      assert.match(output, /Digital silence/);
      assert.doesNotMatch(
        output,
        /✅/u,
        'zero PCM must never be reported as a successful input check',
      );
    } else {
      assert.match(output, /✅/u);
      assert.doesNotMatch(output, /Digital silence/);
    }
  }
});
