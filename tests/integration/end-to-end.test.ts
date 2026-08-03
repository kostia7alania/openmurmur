import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, before, beforeEach, describe, it } from 'node:test';
import { FakeAsr } from '../../src/asr/fake.ts';
import type { CaptureBackend, CaptureFrame } from '../../src/capture/backend.ts';
import { probeAudio } from '../../src/capture/probe.ts';
import { resolvePaths } from '../../src/config/paths.ts';
import { DEFAULT_CONFIG } from '../../src/config/schema.ts';
import { type Database, openDatabase } from '../../src/database/db.ts';
import {
  PartRepository,
  SessionRepository,
  TranscriptRepository,
  VadSegmentRepository,
} from '../../src/database/repository.ts';
import { handleJob } from '../../src/jobs/pipeline.ts';
import { JobQueue } from '../../src/jobs/queue.ts';
import { FakeLlm } from '../../src/llm/ollama.ts';
import { nullLogger } from '../../src/logging/logger.ts';
import { Recorder } from '../../src/sessionizer/recorder.ts';
import { EnergyVad } from '../../src/sessionizer/vad.ts';
import { Outbox } from '../../src/telegram/outbox.ts';

/**
 * The whole pipeline, end to end, with **no microphone**.
 *
 * A fake `CaptureBackend` replays real PCM — loud tone standing in for speech,
 * near-silence for the gaps — through the genuine Recorder, sessionizer, FLAC
 * writer, database, ASR job and outbox. Everything below the capture device is
 * the production code path.
 *
 * Recording the developer's actual room to test this would be both unnecessary
 * and, per RECORDING_POLICY.md, exactly what this project asks people not to
 * do casually.
 */

const FFMPEG = process.env['FFMPEG_PATH'] ?? 'ffmpeg';
const FFPROBE = process.env['FFPROBE_PATH'] ?? 'ffprobe';
const FRAME_SAMPLES = 512;
const FRAME_MS = (FRAME_SAMPLES / 16_000) * 1000;

let dir: string;
let db: Database;
let hasFfmpeg = false;

before(async () => {
  hasFfmpeg = await new Promise<boolean>((resolve) => {
    const child = spawn(FFMPEG, ['-version'], { stdio: 'ignore' });
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
  });
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'om-e2e-'));
  db = openDatabase({ file: join(dir, 'test.db') });
  for (const sub of ['audio', 'tmp', 'transcripts']) mkdirSync(join(dir, sub), { recursive: true });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** One frame of a loud tone — what the energy gate will read as speech. */
function loudFrame(index: number): Uint8Array {
  const buffer = Buffer.alloc(FRAME_SAMPLES * 2);
  for (let i = 0; i < FRAME_SAMPLES; i += 1) {
    const t = (index * FRAME_SAMPLES + i) / 16_000;
    buffer.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 440 * t) * 0.5 * 32767), i * 2);
  }
  return buffer;
}

/** Near-silence: dithered so it is realistic, but far below the gate. */
function quietFrame(): Uint8Array {
  const buffer = Buffer.alloc(FRAME_SAMPLES * 2);
  for (let i = 0; i < FRAME_SAMPLES; i += 1) {
    buffer.writeInt16LE(Math.round((Math.random() - 0.5) * 6), i * 2);
  }
  return buffer;
}

export interface ScriptedSegment {
  readonly kind: 'speech' | 'silence';
  readonly seconds: number;
}

/**
 * Capture backend that replays a script instead of opening a device.
 *
 * Frame timestamps advance by exactly one frame each, so a 60-second silence
 * costs microseconds of wall time rather than a minute of waiting.
 */
class ScriptedCapture implements CaptureBackend {
  readonly name = 'scripted';
  readonly #script: readonly ScriptedSegment[];
  #lastMonotonicMs: number | null = null;
  #stopped = false;

  constructor(script: readonly ScriptedSegment[]) {
    this.#script = script;
  }

  async *start(): AsyncIterableIterator<CaptureFrame> {
    let monotonicMs = 0;
    let index = 0;
    const wallStart = Date.UTC(2026, 6, 31, 2, 0, 0);

    for (const segment of this.#script) {
      const frames = Math.round((segment.seconds * 1000) / FRAME_MS);
      for (let i = 0; i < frames; i += 1) {
        if (this.#stopped) return;
        monotonicMs += FRAME_MS;
        this.#lastMonotonicMs = monotonicMs;
        yield {
          pcm: segment.kind === 'speech' ? loudFrame(index) : quietFrame(),
          monotonicMs,
          wallMs: wallStart + monotonicMs,
          durationMs: FRAME_MS,
        };
        index += 1;
        // Yield to the event loop periodically so writer backpressure resolves.
        if (index % 64 === 0) await new Promise((r) => setImmediate(r));
      }
    }
  }

  async stop(): Promise<void> {
    this.#stopped = true;
  }

  msSinceLastFrame(): number | null {
    return this.#lastMonotonicMs === null ? null : 0;
  }
}

function recorderFor(script: readonly ScriptedSegment[], overrides = {}) {
  const config = {
    ...DEFAULT_CONFIG,
    sessionizer: { ...DEFAULT_CONFIG.sessionizer, ...overrides },
    audio: { ...DEFAULT_CONFIG.audio, ffmpegPath: FFMPEG },
  };
  const capture = new ScriptedCapture(script);
  let firstFrameSeen = false;

  const recorder = new Recorder({
    config,
    paths: resolvePaths(dir),
    db: db.handle,
    capture,
    vad: new EnergyVad(),
    logger: nullLogger,
    onFirstFrame: () => {
      firstFrameSeen = true;
    },
  });
  return { recorder, config, sawFirstFrame: () => firstFrameSeen };
}

describe('end to end: capture through delivery, without a microphone', () => {
  it('records a session, writes a valid FLAC, transcribes and queues delivery', async (t) => {
    if (!hasFfmpeg) return t.skip('ffmpeg not available');

    const { recorder, config, sawFirstFrame } = recorderFor([
      { kind: 'silence', seconds: 3 },
      { kind: 'speech', seconds: 6 },
      { kind: 'silence', seconds: 61 },
    ]);

    await recorder.run();

    // --- the recorder's own guarantees ------------------------------------
    assert.ok(sawFirstFrame(), 'onFirstFrame must fire; it is what gates the 🟢 status message');

    const sessions = new SessionRepository(db.handle);
    const rows = db.handle.prepare('SELECT session_id, state FROM audio_sessions').all() as {
      session_id: string;
      state: string;
    }[];
    assert.equal(rows.length, 1, 'exactly one session');
    const sessionId = rows[0]?.session_id ?? '';
    assert.equal(rows[0]?.state, 'PROCESSING');

    // --- the file on disk is real -----------------------------------------
    const parts = new PartRepository(db.handle).listForSession(sessionId);
    assert.equal(parts.length, 1);
    const part = parts[0];
    assert.ok(part);
    assert.equal(part.finalized, 1);
    assert.match(part.sha256 ?? '', /^[0-9a-f]{64}$/);
    assert.ok(existsSync(part.path), 'the FLAC must exist at the recorded path');

    const probe = await probeAudio(FFPROBE, part.path);
    assert.equal(probe?.codec, 'flac');
    assert.equal(probe?.sampleRate, 16_000);
    assert.equal(probe?.channels, 1);

    // Pre-roll means the file is longer than the speech that opened it.
    assert.ok(
      (probe?.durationSeconds ?? 0) > 6,
      `expected pre-roll + speech + trailing silence, got ${probe?.durationSeconds}s`,
    );

    // --- the queued work --------------------------------------------------
    const jobs = new JobQueue(db.handle);
    assert.equal(jobs.pendingCount('asr'), 1, 'finalizing enqueues exactly one ASR job');

    // Give FakeAsr a realistic transcript for the file the recorder actually
    // produced. Its default line is four words, which the five-word gate would
    // (correctly) reject — see the rejection test below for that path.
    writeFileSync(
      part.path.replace(/\.flac$/, '.expected.txt'),
      'Обсудили сроки запуска проекта и настройку телеграм-бота.',
    );

    // --- run the rest of the pipeline -------------------------------------
    const pipelineDeps = {
      db: db.handle,
      config,
      paths: resolvePaths(dir),
      asr: new FakeAsr(),
      llm: new FakeLlm(),
      jobs,
      logger: nullLogger,
    };
    const asrJob = jobs.claim(['asr']);
    assert.ok(asrJob);
    await handleJob(pipelineDeps, asrJob);
    jobs.complete(asrJob.jobId);

    const summarizeJob = jobs.claim(['summarize']);
    assert.ok(summarizeJob, 'ASR must queue the summarize step');
    await handleJob(pipelineDeps, summarizeJob);
    jobs.complete(summarizeJob.jobId);

    const deliverJob = jobs.claim(['deliver']);
    assert.ok(deliverJob);
    await handleJob(pipelineDeps, deliverJob);
    jobs.complete(deliverJob.jobId);

    // --- what the user would receive --------------------------------------
    const outbox = new Outbox(db.handle);
    const queued = db.handle
      .prepare('SELECT kind, ordinal FROM telegram_outbox ORDER BY ordinal')
      .all() as { kind: string; ordinal: number }[];

    assert.ok(queued.some((q) => q.kind === 'audio'), 'the source FLAC is queued');
    assert.ok(queued.some((q) => q.kind === 'transcript'), 'the transcript is queued');
    assert.ok(queued.some((q) => q.kind === 'report'), 'the report is queued');
    assert.equal(outbox.claimNext()?.kind, 'audio', 'audio goes first');

    assert.ok(new TranscriptRepository(db.handle).current(sessionId), 'a transcript revision exists');
    assert.equal(sessions.get(sessionId)?.state, 'DELIVERING');
  });

  it('opens no session at all for a quiet room', async (t) => {
    if (!hasFfmpeg) return t.skip('ffmpeg not available');

    const { recorder } = recorderFor([{ kind: 'silence', seconds: 90 }]);
    await recorder.run();

    const count = db.handle.prepare('SELECT count(*) AS c FROM audio_sessions').get() as {
      c: number;
    };
    assert.equal(count.c, 0, 'ninety seconds of silence must not create a session');
  });

  it('rejects a session that is only a short noise burst', async (t) => {
    if (!hasFfmpeg) return t.skip('ffmpeg not available');

    // 1 s of sound clears the 500 ms candidate window but not the 3 s floor.
    const { recorder } = recorderFor([
      { kind: 'silence', seconds: 2 },
      { kind: 'speech', seconds: 1 },
      { kind: 'silence', seconds: 61 },
    ]);
    await recorder.run();

    const row = db.handle
      .prepare('SELECT state, rejection_reason FROM audio_sessions')
      .get() as { state: string; rejection_reason: string } | undefined;

    assert.equal(row?.state, 'REJECTED');
    assert.equal(row?.rejection_reason, 'insufficient_speech');
    assert.equal(
      new JobQueue(db.handle).pendingCount('asr'),
      0,
      'a rejected session must not be queued for transcription',
    );
  });

  it('keeps one session across a pause shorter than the timeout', async (t) => {
    if (!hasFfmpeg) return t.skip('ffmpeg not available');

    const { recorder } = recorderFor([
      { kind: 'speech', seconds: 4 },
      { kind: 'silence', seconds: 50 },
      { kind: 'speech', seconds: 4 },
      { kind: 'silence', seconds: 61 },
    ]);
    await recorder.run();

    const rows = db.handle.prepare('SELECT session_id FROM audio_sessions').all();
    assert.equal(rows.length, 1, 'a 50-second pause is one session, not two');
  });

  it('starts a second session after the timeout elapses', async (t) => {
    if (!hasFfmpeg) return t.skip('ffmpeg not available');

    const { recorder } = recorderFor([
      { kind: 'speech', seconds: 4 },
      { kind: 'silence', seconds: 62 },
      { kind: 'speech', seconds: 4 },
      { kind: 'silence', seconds: 62 },
    ]);
    await recorder.run();

    const rows = db.handle.prepare('SELECT session_id FROM audio_sessions').all();
    assert.equal(rows.length, 2, 'a 62-second gap separates two sessions');
  });

  it('rotates into multiple parts that share one session id', async (t) => {
    if (!hasFfmpeg) return t.skip('ffmpeg not available');

    const { recorder } = recorderFor(
      [
        { kind: 'speech', seconds: 25 },
        { kind: 'silence', seconds: 11 },
      ],
      { maxPartSeconds: 10, silenceTimeoutSeconds: 10 },
    );
    await recorder.run();

    const sessionRows = db.handle.prepare('SELECT session_id FROM audio_sessions').all() as {
      session_id: string;
    }[];
    assert.equal(sessionRows.length, 1);

    const parts = new PartRepository(db.handle).listForSession(sessionRows[0]?.session_id ?? '');
    assert.ok(parts.length >= 3, `expected several parts, got ${parts.length}`);

    for (const part of parts) {
      assert.equal(part.finalized, 1, 'every rotated part is closed properly');
      assert.ok(existsSync(part.path));
      assert.match(part.sha256 ?? '', /^[0-9a-f]{64}$/);
    }
    assert.deepEqual(
      parts.map((p) => p.part_index),
      parts.map((_, i) => i),
      'part indices are consecutive from zero',
    );
  });

  it('leaves a valid file behind when the daemon stops mid-session', async (t) => {
    if (!hasFfmpeg) return t.skip('ffmpeg not available');

    const { recorder } = recorderFor([
      { kind: 'speech', seconds: 5 },
      { kind: 'speech', seconds: 300 }, // interrupted long before this ends
    ]);

    const run = recorder.run();
    // Let some audio be written, then stop the way SIGTERM would.
    await new Promise((r) => setTimeout(r, 400));
    await recorder.stop();
    await run;

    const parts = db.handle
      .prepare('SELECT path, finalized, sha256 FROM audio_parts')
      .all() as { path: string; finalized: number; sha256: string | null }[];

    assert.ok(parts.length >= 1, 'the interrupted session still produced a part');
    for (const part of parts) {
      assert.equal(part.finalized, 1, 'shutdown must finalize, not abandon');
      assert.ok(existsSync(part.path));
      const probe = await probeAudio(FFPROBE, part.path);
      assert.equal(probe?.codec, 'flac', 'the file left behind is a playable FLAC');
    }

    // The archive must never contain a half-written file: everything in
    // progress lives in tmp/ until it is fsynced and atomically renamed.
    assert.deepEqual(
      readdirSync(join(dir, 'tmp')).filter((f) => f.endsWith('.part')),
      [],
      'no partial .part file may survive a clean shutdown',
    );
  });

  it('stores VAD segments for the finished session', async (t) => {
    if (!hasFfmpeg) return t.skip('ffmpeg not available');

    const { recorder, config } = recorderFor([
      { kind: 'speech', seconds: 6 },
      { kind: 'silence', seconds: 61 },
    ]);
    await recorder.run();

    const sessionId = (
      db.handle.prepare('SELECT session_id FROM audio_sessions').get() as { session_id: string }
    ).session_id;

    const jobs = new JobQueue(db.handle);
    const job = jobs.claim(['asr']);
    assert.ok(job);
    await handleJob(
      {
        db: db.handle,
        config,
        paths: resolvePaths(dir),
        asr: new FakeAsr(),
        llm: new FakeLlm(),
        jobs,
        logger: nullLogger,
      },
      job,
    );

    assert.ok(
      new VadSegmentRepository(db.handle).listForSession(sessionId).length > 0,
      'the final VAD pass must have stored segments',
    );
  });
});
