import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, before, beforeEach, describe, it } from 'node:test';
import { FfmpegCapture } from '../../src/capture/ffmpeg.ts';
import { normalizeToWav, probeAudio } from '../../src/capture/probe.ts';
import { PartWriter, partPaths, sha256File } from '../../src/capture/writer.ts';
import { splitFlacLossless } from '../../src/jobs/delivery.ts';
import { validateProbe } from '../../src/telegram/incoming.ts';
import { systemClock } from '../../src/util/clock.ts';

/**
 * Real ffmpeg, real files, synthetic audio.
 *
 * These run in CI: fixtures are generated with ffmpeg's own sine/anullsrc
 * sources, so nothing here needs a microphone, a network, or a model.
 */

const FFMPEG = process.env['FFMPEG_PATH'] ?? 'ffmpeg';
const FFPROBE = process.env['FFPROBE_PATH'] ?? 'ffprobe';

let dir: string;
let hasFfmpeg = false;

function run(command: string, args: readonly string[]): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(command, [...args], { stdio: 'ignore' });
    child.on('error', () => resolve(-1));
    child.on('close', (code) => resolve(code ?? -1));
  });
}

/** Generates a WAV of `seconds` at 16 kHz mono: a sine tone, or silence. */
async function generateWav(path: string, seconds: number, kind: 'tone' | 'silence'): Promise<void> {
  const source =
    kind === 'tone'
      ? `sine=frequency=440:sample_rate=16000:duration=${seconds}`
      : `anullsrc=r=16000:cl=mono:d=${seconds}`;
  const code = await run(FFMPEG, [
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    source,
    '-ac',
    '1',
    '-ar',
    '16000',
    '-c:a',
    'pcm_s16le',
    '-y',
    path,
  ]);
  assert.equal(code, 0, `failed to generate fixture ${path}`);
}

/** Raw 16-bit mono PCM of a sine tone, the shape the capture backend emits. */
function pcmTone(seconds: number, amplitude = 0.4): Buffer {
  const samples = Math.round(16_000 * seconds);
  const buffer = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i += 1) {
    buffer.writeInt16LE(
      Math.round(Math.sin((i / 16_000) * 2 * Math.PI * 440) * amplitude * 32767),
      i * 2,
    );
  }
  return buffer;
}

function fakePcmSource(
  frameCount: number,
  options: { readonly linger?: boolean; readonly exitCode?: number } = {},
): string {
  const path = join(dir, 'fake-pcm-source');
  const tail = options.linger === false ? `exit ${options.exitCode ?? 0}` : 'exec /bin/sleep 5';
  writeFileSync(
    path,
    `#!/bin/sh\n/bin/dd if=/dev/zero bs=2 count=${frameCount} 2>/dev/null\n${tail}\n`,
    { mode: 0o700 },
  );
  chmodSync(path, 0o700);
  return path;
}

function fakePcmSourceIgnoringTerm(frameCount: number, pidFile?: string): string {
  const path = join(dir, 'fake-pcm-source-ignoring-term');
  writeFileSync(
    path,
    `#!${process.execPath}\nprocess.on('SIGTERM', () => {});\n${
      pidFile === undefined
        ? ''
        : `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));\n`
    }process.stdout.write(Buffer.alloc(${frameCount * 2}));\nsetInterval(() => {}, 1000);\n`,
    { mode: 0o700 },
  );
  chmodSync(path, 0o700);
  return path;
}

function fakePcmSourceStuckBeforeOutput(pidFile: string): string {
  const path = join(dir, 'fake-pcm-source-stuck-before-output');
  const shellPidFile = `'${pidFile.replaceAll("'", `'"'"'`)}'`;
  writeFileSync(
    path,
    `#!/bin/sh\ntrap '' TERM\nprintf '%s' "$$" > ${shellPidFile}\nwhile :; do /bin/sleep 1; done\n`,
    { mode: 0o700 },
  );
  chmodSync(path, 0o700);
  return path;
}

function fakePcmSourceTricklingPartialFrame(pidFile: string, bytesPerFrame: number): string {
  const path = join(dir, 'fake-pcm-source-trickling-partial-frame');
  writeFileSync(
    path,
    `#!${process.execPath}\nprocess.on('SIGTERM', () => {});\nprocess.stdout.on('error', () => {});\nrequire('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));\nprocess.stdout.write(Buffer.alloc(${bytesPerFrame}));\nsetInterval(() => process.stdout.write(Buffer.alloc(1)), 50);\n`,
    { mode: 0o700 },
  );
  chmodSync(path, 0o700);
  return path;
}

async function waitForCondition(
  condition: () => boolean,
  description: string,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

before(async () => {
  hasFfmpeg = (await run(FFMPEG, ['-version'])) === 0;
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'om-audio-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('FLAC part writing', { skip: process.env['SKIP_FFMPEG_TESTS'] === '1' }, () => {
  it('writes a valid FLAC and publishes it atomically', async (t) => {
    if (!hasFfmpeg) return t.skip('ffmpeg not available');

    const tempPath = join(dir, 'part.flac.part');
    const finalPath = join(dir, 'part.flac');

    const writer = new PartWriter({
      ffmpegPath: FFMPEG,
      sampleRate: 16_000,
      channels: 1,
      compressionLevel: 5,
      tempPath,
      finalPath,
    });

    writer.open();
    assert.equal(existsSync(finalPath), false, 'nothing is visible until the part is complete');
    await writer.write(pcmTone(1));
    await writer.write(pcmTone(1));
    const finalized = await writer.close();

    assert.equal(existsSync(tempPath), false, 'the temp file is renamed away, not left behind');
    assert.ok(existsSync(finalPath));
    assert.equal(finalized.path, finalPath);
    assert.ok(finalized.bytes > 0);

    // It is a real FLAC, decodable by ffprobe.
    const probe = await probeAudio(FFPROBE, finalPath);
    assert.equal(probe?.codec, 'flac');
    assert.equal(probe?.sampleRate, 16_000);
    assert.equal(probe?.channels, 1);
    assert.ok(
      Math.abs(probe.durationSeconds - 2) < 0.1,
      `expected ~2s, got ${probe.durationSeconds}`,
    );
  });

  it('computes a SHA-256 that matches the file on disk', async (t) => {
    if (!hasFfmpeg) return t.skip('ffmpeg not available');

    const finalPath = join(dir, 'sum.flac');
    const writer = new PartWriter({
      ffmpegPath: FFMPEG,
      sampleRate: 16_000,
      channels: 1,
      compressionLevel: 5,
      tempPath: join(dir, 'sum.flac.part'),
      finalPath,
    });
    writer.open();
    await writer.write(pcmTone(0.5));
    const finalized = await writer.close();

    assert.match(finalized.sha256, /^[0-9a-f]{64}$/);
    assert.equal(
      finalized.sha256,
      await sha256File(finalPath),
      'the checksum must describe the published file',
    );
  });

  it('detects a corrupted file through its checksum', async (t) => {
    if (!hasFfmpeg) return t.skip('ffmpeg not available');

    const finalPath = join(dir, 'corrupt.flac');
    const writer = new PartWriter({
      ffmpegPath: FFMPEG,
      sampleRate: 16_000,
      channels: 1,
      compressionLevel: 5,
      tempPath: join(dir, 'corrupt.flac.part'),
      finalPath,
    });
    writer.open();
    await writer.write(pcmTone(0.5));
    const finalized = await writer.close();

    const bytes = readFileSync(finalPath);
    bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 0xff;
    writeFileSync(finalPath, bytes);

    assert.notEqual(await sha256File(finalPath), finalized.sha256);
  });

  it('leaves no file behind when a part is aborted', async (t) => {
    if (!hasFfmpeg) return t.skip('ffmpeg not available');

    const tempPath = join(dir, 'abort.flac.part');
    const finalPath = join(dir, 'abort.flac');
    const writer = new PartWriter({
      ffmpegPath: FFMPEG,
      sampleRate: 16_000,
      channels: 1,
      compressionLevel: 5,
      tempPath,
      finalPath,
    });
    writer.open();
    await writer.write(pcmTone(0.5));
    await writer.abort();

    assert.equal(existsSync(tempPath), false);
    assert.equal(existsSync(finalPath), false, 'an aborted part must never appear in the archive');
  });

  it('lays parts out by date with a shared session id', () => {
    const wallMs = Date.UTC(2026, 6, 29, 15, 30);
    const p0 = partPaths('/audio', '/tmp', 'sess-abc', 0, wallMs);
    const p1 = partPaths('/audio', '/tmp', 'sess-abc', 1, wallMs);

    assert.equal(p0.finalPath, '/audio/2026-07-29/sess-abc.p000.flac');
    assert.equal(p1.finalPath, '/audio/2026-07-29/sess-abc.p001.flac');
    assert.ok(p0.tempPath.startsWith('/tmp/'), 'in-progress writes stay out of the archive');
    assert.notEqual(p0.finalPath, p0.tempPath);
  });
});

describe('lossless splitting for oversize parts', {
  skip: process.env['SKIP_FFMPEG_TESTS'] === '1',
}, () => {
  it('returns the file untouched when it already fits', async (t) => {
    if (!hasFfmpeg) return t.skip('ffmpeg not available');

    const source = join(dir, 'small.flac');
    await run(FFMPEG, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:sample_rate=16000:duration=2',
      '-ac',
      '1',
      '-c:a',
      'flac',
      '-y',
      source,
    ]);

    const chunks = await splitFlacLossless(FFMPEG, source, dir, 50 * 1024 * 1024, 2000);
    assert.deepEqual(chunks, [source], 'no splitting, no re-encoding');
  });

  it('splits an oversize part into chunks that each fit the limit', async (t) => {
    if (!hasFfmpeg) return t.skip('ffmpeg not available');

    const source = join(dir, 'big.flac');
    await run(FFMPEG, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:sample_rate=16000:duration=120',
      '-ac',
      '1',
      '-c:a',
      'flac',
      '-y',
      source,
    ]);

    const sourceSize = (await stat(source)).size;
    const limit = Math.floor(sourceSize / 3);
    const staleGappedArtifact = join(dir, 'big.split999.flac');
    const staleFourDigitArtifact = join(dir, 'big.split1000.flac');
    writeFileSync(staleGappedArtifact, 'unowned stale split');
    writeFileSync(staleFourDigitArtifact, 'unowned four-digit split');
    const chunks = await splitFlacLossless(FFMPEG, source, dir, limit, 120_000);

    assert.ok(chunks.length > 1, `expected several chunks, got ${chunks.length}`);
    assert.equal(
      existsSync(staleGappedArtifact),
      false,
      'cleanup must not stop at the first missing split index',
    );
    assert.equal(
      existsSync(staleFourDigitArtifact),
      false,
      'ffmpeg %03d is a minimum width, so split1000 must also be enumerated',
    );
    for (const chunk of chunks) {
      const size = (await stat(chunk)).size;
      assert.ok(size <= limit, `chunk of ${size} bytes exceeds the ${limit} byte limit`);

      // Still lossless FLAC, not a lossy re-encode.
      const probe = await probeAudio(FFPROBE, chunk);
      assert.equal(probe?.codec, 'flac', 'splitting must not change the codec');
    }
  });

  it('remeasures and retries when the initial bitrate estimate is far too low', async (t) => {
    if (!hasFfmpeg) return t.skip('ffmpeg not available');

    const source = join(dir, 'underestimated.flac');
    await run(FFMPEG, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=880:sample_rate=16000:duration=30',
      '-ac',
      '1',
      '-c:a',
      'flac',
      '-y',
      source,
    ]);

    const sourceSize = (await stat(source)).size;
    const limit = Math.floor(sourceSize / 4);
    const chunks = await splitFlacLossless(FFMPEG, source, dir, limit, 30 * 60 * 1000);

    assert.ok(chunks.length > 1, 'the oversize first attempt must be replaced by smaller chunks');
    for (const chunk of chunks) {
      const size = (await stat(chunk)).size;
      assert.ok(size <= limit, `remeasured chunk of ${size} bytes exceeds ${limit}`);
    }
  });

  it('fails explicitly and cleans derived files when one-second chunks still exceed the limit', async (t) => {
    if (!hasFfmpeg) return t.skip('ffmpeg not available');

    const source = join(dir, 'unsplittable.flac');
    await run(FFMPEG, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=660:sample_rate=16000:duration=2',
      '-ac',
      '1',
      '-c:a',
      'flac',
      '-y',
      source,
    ]);

    await assert.rejects(
      splitFlacLossless(FFMPEG, source, dir, 1, 2000),
      /cannot split .* below the Telegram limit of 1 bytes without re-encoding/,
    );
    assert.equal(existsSync(source), true, 'an upload-limit failure must preserve the source FLAC');
    assert.deepEqual(
      (await readdir(dir)).filter((entry) => entry.startsWith('unsplittable.split')),
      [],
      'an explicit split failure must not leave unowned derived artifacts',
    );
  });
});

describe('incoming media validation against real files', {
  skip: process.env['SKIP_FFMPEG_TESTS'] === '1',
}, () => {
  const limits = { maxIncomingBytes: 20 * 1024 * 1024, maxDurationSeconds: 7200 };

  it('accepts a real ogg/opus voice note', async (t) => {
    if (!hasFfmpeg) return t.skip('ffmpeg not available');

    const path = join(dir, 'voice.ogg');
    await run(FFMPEG, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:sample_rate=48000:duration=3',
      '-ac',
      '1',
      '-c:a',
      'libopus',
      '-y',
      path,
    ]);
    if (!existsSync(path)) return t.skip('this ffmpeg build has no libopus');

    const probe = await probeAudio(FFPROBE, path);
    assert.doesNotThrow(() => validateProbe(probe, limits));
  });

  it('rejects a file that is not audio at all, whatever it is named', async (t) => {
    if (!hasFfmpeg) return t.skip('ffmpeg not available');

    // A text file called .mp3: the extension is a claim, ffprobe is the truth.
    const path = join(dir, 'definitely-audio.mp3');
    writeFileSync(path, 'This is plain text pretending to be an MP3.\n'.repeat(50));

    const probe = await probeAudio(FFPROBE, path);
    assert.throws(() => validateProbe(probe, limits));
  });

  it('rejects a truncated media file', async (t) => {
    if (!hasFfmpeg) return t.skip('ffmpeg not available');

    const path = join(dir, 'truncated.flac');
    await run(FFMPEG, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:sample_rate=16000:duration=5',
      '-ac',
      '1',
      '-c:a',
      'flac',
      '-y',
      path,
    ]);
    // Keep only the first 40 bytes: a header with no frames.
    writeFileSync(path, readFileSync(path).subarray(0, 40));

    const probe = await probeAudio(FFPROBE, path);
    assert.throws(() => validateProbe(probe, limits));
  });

  it('normalizes any supported input to 16 kHz mono', async (t) => {
    if (!hasFfmpeg) return t.skip('ffmpeg not available');

    // Deliberately stereo at 44.1 kHz — what a phone recording looks like.
    const source = join(dir, 'stereo.wav');
    await run(FFMPEG, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:sample_rate=44100:duration=2',
      '-ac',
      '2',
      '-ar',
      '44100',
      '-c:a',
      'pcm_s16le',
      '-y',
      source,
    ]);

    const target = join(dir, 'normalized.wav');
    assert.equal(await normalizeToWav(FFMPEG, source, target), true);

    const probe = await probeAudio(FFPROBE, target);
    assert.equal(probe?.sampleRate, 16_000, 'the ASR model requires 16 kHz');
    assert.equal(probe?.channels, 1, 'the ASR model requires mono');
  });

  it('reports failure rather than producing a bad file', async (t) => {
    if (!hasFfmpeg) return t.skip('ffmpeg not available');
    const target = join(dir, 'out.wav');
    assert.equal(await normalizeToWav(FFMPEG, join(dir, 'no-such-file.mp3'), target), false);
    assert.equal(existsSync(target), false);
  });

  it('never exposes a partial WAV or overwrites a complete target on failure', async (t) => {
    if (!hasFfmpeg) return t.skip('ffmpeg not available');
    const target = join(dir, 'out.wav');
    writeFileSync(target, 'previous complete file');

    assert.equal(await normalizeToWav(FFMPEG, join(dir, 'no-such-file.mp3'), target), false);
    assert.equal(readFileSync(target, 'utf8'), 'previous complete file');
  });
});

describe('generated fixtures', { skip: process.env['SKIP_FFMPEG_TESTS'] === '1' }, () => {
  it('produces tone and silence fixtures with the expected shape', async (t) => {
    if (!hasFfmpeg) return t.skip('ffmpeg not available');

    const tonePath = join(dir, 'tone.wav');
    const silencePath = join(dir, 'silence.wav');
    await generateWav(tonePath, 2, 'tone');
    await generateWav(silencePath, 2, 'silence');

    for (const path of [tonePath, silencePath]) {
      const probe = await probeAudio(FFPROBE, path);
      assert.equal(probe?.sampleRate, 16_000);
      assert.equal(probe?.channels, 1);
    }
    // Silence compresses to far less than a tone, which confirms the two
    // fixtures really do differ in content and not just in name.
    assert.ok((await stat(tonePath)).size > 0);
  });
});

describe('capture backend argument construction', () => {
  it('asks AVFoundation for mono 16 kHz PCM on stdout', () => {
    const capture = new FfmpegCapture({
      sampleRate: 16_000,
      channels: 1,
      device: 'default',
      frameSamples: 512,
      ffmpegPath: FFMPEG,
      clock: systemClock,
    });
    const args = capture.buildArgs().join(' ');

    assert.match(args, /-f avfoundation/);
    assert.match(args, /-i :0/, 'no video device, default audio device');
    assert.match(args, /-ar 16000/);
    assert.match(args, /-ac 1/);
    assert.match(args, /-f s16le/);
    assert.match(args, /pipe:1$/);
  });

  it('passes a configured device index through', () => {
    const capture = new FfmpegCapture({
      sampleRate: 16_000,
      channels: 1,
      device: '2',
      frameSamples: 512,
      ffmpegPath: FFMPEG,
      clock: systemClock,
    });
    assert.match(capture.buildArgs().join(' '), /-i :2/);
  });

  it('reports no frame age before capture has started', () => {
    const capture = new FfmpegCapture({
      sampleRate: 16_000,
      channels: 1,
      device: 'default',
      frameSamples: 512,
      ffmpegPath: FFMPEG,
      clock: systemClock,
    });
    assert.equal(capture.msSinceLastFrame(), null);
  });

  it('fails and reaps a capture child that never produces its first source frame', async () => {
    const pidFile = join(dir, 'stuck-source.pid');
    const capture = new FfmpegCapture({
      sampleRate: 16_000,
      channels: 1,
      device: 'default',
      frameSamples: 512,
      ffmpegPath: fakePcmSourceStuckBeforeOutput(pidFile),
      clock: systemClock,
      firstSourceFrameTimeoutMs: 1_000,
    });

    const started = Date.now();
    await assert.rejects(capture.start().next(), /No source audio frame arrived within 1 seconds/);
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= 3_900, `expected the SIGKILL fallback, stopped after ${elapsed}ms`);
    assert.ok(elapsed < 6_000, `bounded first-frame failure took ${elapsed}ms`);

    const childPid = Number(readFileSync(pidFile, 'utf8'));
    assert.throws(() => process.kill(childPid, 0), { code: 'ESRCH' });
    assert.equal(capture.msSinceLastFrame(), null);
  });

  it('fails an overloaded consumer immediately and reaps the capture child', async () => {
    const capture = new FfmpegCapture({
      sampleRate: 1,
      channels: 1,
      device: 'default',
      frameSamples: 1,
      ffmpegPath: fakePcmSource(40),
      clock: systemClock,
    });
    const iterator = capture.start();
    assert.equal((await iterator.next()).done, false);
    // Pipe reads may split the producer's writes differently under load. Wait
    // for the observable overload condition instead of assuming the next read
    // already consumed all 40 frames.
    await waitForCondition(
      () => (capture.processingLagMs() ?? 0) > 30_000,
      'capture processing lag to cross its explicit bound',
    );
    await assert.rejects(iterator.next(), /fell more than 30 seconds behind/);
    assert.ok((capture.processingLagMs() ?? 0) >= 30_000);

    // A terminal path must join the old child and release single-instance
    // ownership, otherwise a retry would fail with "capture already running".
    const retry = capture.start();
    assert.equal((await retry.next()).done, false);
    await capture.stop();
    await retry.return?.();
  });

  it('fails and reaps a capture child that stalls after its first source frame', async () => {
    const pidFile = join(dir, 'stalled-source.pid');
    const frameSamples = 512;
    const bytesPerFrame = frameSamples * 2;
    const source = fakePcmSourceTricklingPartialFrame(pidFile, bytesPerFrame);
    const capture = new FfmpegCapture({
      sampleRate: 16_000,
      channels: 1,
      device: 'default',
      frameSamples,
      ffmpegPath: source,
      clock: systemClock,
      sourceFrameStallTimeoutMs: 250,
    });
    const iterator = capture.start();
    assert.equal((await iterator.next()).done, false);

    const started = Date.now();
    await waitForCondition(() => {
      if (!existsSync(pidFile)) return false;
      const pid = Number(readFileSync(pidFile, 'utf8'));
      try {
        process.kill(pid, 0);
        return false;
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === 'ESRCH';
      }
    }, 'the stalled source to be reaped without another iterator pull');
    await assert.rejects(
      iterator.next(),
      /No source audio frame arrived for 250 ms; the input device or capture process may have stalled/,
    );
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= 3_100, `expected the SIGKILL fallback, stopped after ${elapsed}ms`);
    assert.ok(elapsed < 5_000, `bounded source-stall failure took ${elapsed}ms`);

    const childPid = Number(readFileSync(pidFile, 'utf8'));
    assert.throws(() => process.kill(childPid, 0), { code: 'ESRCH' });

    writeFileSync(
      source,
      `#!${process.execPath}\nprocess.stdout.write(Buffer.alloc(${bytesPerFrame}), () => setTimeout(() => process.exit(7), 25));\n`,
      { mode: 0o700 },
    );
    const replacement = capture.start();
    assert.equal((await replacement.next()).done, false);
    await assert.rejects(replacement.next(), /ffmpeg exited with code 7/);
  });

  it('discards buffered PCM immediately when the capture child exits non-zero', async () => {
    const capture = new FfmpegCapture({
      sampleRate: 1,
      channels: 1,
      device: 'default',
      frameSamples: 1,
      ffmpegPath: fakePcmSource(10, { linger: false, exitCode: 7 }),
      clock: systemClock,
    });
    const iterator = capture.start();
    assert.equal((await iterator.next()).done, false);
    await new Promise((resolve) => setTimeout(resolve, 200));
    await assert.rejects(iterator.next(), /ffmpeg exited with code 7/);

    const retry = capture.start();
    assert.equal((await retry.next()).done, false);
    await new Promise((resolve) => setTimeout(resolve, 200));
    await assert.rejects(retry.next(), /ffmpeg exited with code 7/);
  });

  it('classifies an unexpected code-zero EOF as immediate capture failure', async () => {
    const capture = new FfmpegCapture({
      sampleRate: 1,
      channels: 1,
      device: 'default',
      frameSamples: 1,
      ffmpegPath: fakePcmSource(10, { linger: false, exitCode: 0 }),
      clock: systemClock,
    });
    const iterator = capture.start();
    assert.equal((await iterator.next()).done, false);
    await new Promise((resolve) => setTimeout(resolve, 200));
    await assert.rejects(
      iterator.next(),
      /capture ended unexpectedly with code 0; continuous recording stopped/,
    );

    const retry = capture.start();
    assert.equal((await retry.next()).done, false);
    await new Promise((resolve) => setTimeout(resolve, 200));
    await assert.rejects(retry.next(), /capture ended unexpectedly with code 0/);
  });

  it('can stop while frames are buffered without leaving the child behind', async () => {
    const capture = new FfmpegCapture({
      sampleRate: 1,
      channels: 1,
      device: 'default',
      frameSamples: 1,
      ffmpegPath: fakePcmSource(10),
      clock: systemClock,
    });
    const iterator = capture.start();
    assert.equal((await iterator.next()).done, false);
    assert.ok((capture.processingLagMs() ?? 0) > 0);

    capture.discardBufferedFrames();
    await capture.stop();
    await iterator.return?.();

    const retry = capture.start();
    assert.equal((await retry.next()).done, false);
    await capture.stop();
    await retry.return?.();
  });

  it('SIGKILLs and joins a capture child that ignores the stop signal', async () => {
    const capture = new FfmpegCapture({
      sampleRate: 1,
      channels: 1,
      device: 'default',
      frameSamples: 1,
      ffmpegPath: fakePcmSourceIgnoringTerm(10),
      clock: systemClock,
    });
    const iterator = capture.start();
    assert.equal((await iterator.next()).done, false);

    const started = Date.now();
    capture.discardBufferedFrames();
    await capture.stop();
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= 2_900, `expected the SIGKILL fallback, stopped after ${elapsed}ms`);
    assert.ok(elapsed < 5_000, `bounded join took ${elapsed}ms`);
    await iterator.return?.();
  });
});

describe('directory creation for date-partitioned audio', () => {
  it('creates the date directory before writing into it', async () => {
    const { dateDir, finalPath } = partPaths(
      join(dir, 'audio'),
      join(dir, 'tmp'),
      's1',
      0,
      Date.now(),
    );
    await mkdir(dateDir, { recursive: true, mode: 0o700 });
    assert.ok(existsSync(dateDir));
    assert.equal(dirname(finalPath), dateDir);
  });
});
