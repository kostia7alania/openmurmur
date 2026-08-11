import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, before, beforeEach, describe, it } from 'node:test';
import { FakeAsr } from '../../src/asr/fake.ts';
import type { CaptureBackend, CaptureFrame } from '../../src/capture/backend.ts';
import { probeAudio } from '../../src/capture/probe.ts';
import { recoverAfterCrash } from '../../src/capture/recovery.ts';
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
import { EnergyVad, type Vad } from '../../src/sessionizer/vad.ts';
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

class BoundaryCapture implements CaptureBackend {
  readonly name = 'boundary-scripted';
  #epoch = 0;
  #stopped = false;
  #finish: (() => void) | undefined;
  discardCalls = 0;

  async *start(): AsyncIterableIterator<CaptureFrame> {
    for (let index = 0; index < 2; index += 1) {
      yield {
        pcm: quietFrame(),
        monotonicMs: index * FRAME_MS,
        wallMs: Date.UTC(2026, 6, 31) + index * FRAME_MS,
        durationMs: FRAME_MS,
        streamEpoch: 0,
      };
    }
    if (!this.#stopped) {
      await new Promise<void>((resolve) => {
        this.#finish = resolve;
      });
    }
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    this.#finish?.();
  }

  msSinceLastFrame(): number | null {
    return 0;
  }

  discardBufferedFrames(): number {
    this.discardCalls += 1;
    this.#epoch += 1;
    return 1;
  }

  currentStreamEpoch(): number {
    return this.#epoch;
  }
}

class BlockingVad implements Vad {
  readonly name = 'blocking';
  calls = 0;
  resetWhilePending = false;
  readonly started: Promise<void>;
  #markStarted: (() => void) | undefined;
  #release: (() => void) | undefined;
  #pending = false;

  constructor() {
    this.started = new Promise<void>((resolve) => {
      this.#markStarted = resolve;
    });
  }

  async probability(): Promise<number> {
    this.calls += 1;
    this.#pending = true;
    this.#markStarted?.();
    await new Promise<void>((resolve) => {
      this.#release = resolve;
    });
    this.#pending = false;
    return 0;
  }

  release(): void {
    this.#release?.();
  }

  reset(): void {
    if (this.#pending) this.resetWhilePending = true;
  }
}

function recorderFor(script: readonly ScriptedSegment[], overrides = {}, ffmpegPath = FFMPEG) {
  const config = {
    ...DEFAULT_CONFIG,
    sessionizer: { ...DEFAULT_CONFIG.sessionizer, ...overrides },
    audio: { ...DEFAULT_CONFIG.audio, ffmpegPath },
  };
  const capture = new ScriptedCapture(script);
  let firstFrameSeen = false;
  const startedSessions: string[] = [];
  const finalizedSessions: string[] = [];
  const rejectedSessions: string[] = [];

  const recorder = new Recorder({
    config,
    paths: resolvePaths(dir),
    db: db.handle,
    capture,
    vad: new EnergyVad(),
    logger: nullLogger,
    captureHost: 'test-capture-mac',
    captureTimezone: 'Asia/Bangkok',
    onFirstFrame: () => {
      firstFrameSeen = true;
    },
    onSessionStarted: (sessionId) => startedSessions.push(sessionId),
    onSessionFinalized: (sessionId) => finalizedSessions.push(sessionId),
    onSessionRejected: (sessionId) => rejectedSessions.push(sessionId),
  });
  return {
    recorder,
    config,
    sawFirstFrame: () => firstFrameSeen,
    startedSessions,
    finalizedSessions,
    rejectedSessions,
  };
}

describe('end to end: capture through delivery, without a microphone', () => {
  it('serializes a sleep boundary and rejects already-resolved frames from the old epoch', async () => {
    const capture = new BoundaryCapture();
    const vad = new BlockingVad();
    const recorder = new Recorder({
      config: DEFAULT_CONFIG,
      paths: resolvePaths(dir),
      db: db.handle,
      capture,
      vad,
      logger: nullLogger,
    });

    const run = recorder.run();
    await vad.started;
    let boundaryResolved = false;
    const boundary = recorder.closeOpenSession('machine slept').then((result) => {
      boundaryResolved = true;
      return result;
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(boundaryResolved, false, 'control must wait for the in-flight frame mutation');

    vad.release();
    assert.equal(await boundary, null);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(vad.resetWhilePending, false);
    assert.equal(vad.calls, 1, 'the already-resolved old-epoch frame must be discarded');
    assert.equal(capture.discardCalls, 1);

    await recorder.stop();
    await run;
  });

  it('stops capture immediately even while VAD holds the recorder mutation lane', async () => {
    const capture = new BoundaryCapture();
    const vad = new BlockingVad();
    const recorder = new Recorder({
      config: DEFAULT_CONFIG,
      paths: resolvePaths(dir),
      db: db.handle,
      capture,
      vad,
      logger: nullLogger,
    });

    const run = recorder.run();
    await vad.started;
    const stopped = recorder.stop();
    const outcome = await Promise.race([
      stopped.then(() => 'stopped' as const),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 100)),
    ]);
    assert.equal(outcome, 'stopped', 'capture stop must not wait behind blocked VAD');

    vad.release();
    await run;
  });

  it('records a session, writes a valid FLAC, transcribes and queues delivery', async (t) => {
    if (!hasFfmpeg) return t.skip('ffmpeg not available');

    const { recorder, config, sawFirstFrame, startedSessions, finalizedSessions } = recorderFor([
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
    const provenance = sessions.get(sessionId);
    assert.equal(provenance?.capture_host, 'test-capture-mac');
    assert.equal(provenance?.capture_timezone, 'Asia/Bangkok');
    assert.equal(provenance?.timing_exact, 1);
    assert.equal(
      (
        db.handle.prepare('SELECT count(*) AS count FROM audio_finalization_journal').get() as {
          count: number;
        }
      ).count,
      0,
      'normal part and session finalization consume the durable journal',
    );
    assert.deepEqual(startedSessions, [sessionId], 'one durable start event per session');
    assert.deepEqual(finalizedSessions, [sessionId], 'one durable finish event per session');
    const lifecycle = db.handle
      .prepare(
        "SELECT delivery_part_id FROM telegram_outbox WHERE kind = 'status' ORDER BY created_at, rowid",
      )
      .all() as { delivery_part_id: string }[];
    assert.deepEqual(
      lifecycle.map((row) => row.delivery_part_id),
      [`session-status:started:${sessionId}`, `session-status:finalized:${sessionId}`],
      'lifecycle notices are committed durably with the session transitions',
    );

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
    assert.ok(
      Math.abs((probe?.durationSeconds ?? 0) * 1000 - ((part.duration_ms ?? 0) - FRAME_MS)) < 2,
      'the threshold-crossing frame must occur once, not in both pre-roll and live output',
    );

    // Pre-roll means the file is longer than the speech that opened it.
    assert.ok(
      (probe?.durationSeconds ?? 0) > 6,
      `expected pre-roll + speech + trailing silence, got ${probe?.durationSeconds}s`,
    );

    // --- the queued work --------------------------------------------------
    const jobs = new JobQueue(db.handle);
    assert.equal(jobs.pendingCount('deliver_audio'), 1, 'audio delivery is ready immediately');
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
    const audioJob = jobs.claim(['deliver_audio']);
    assert.ok(audioJob, 'audio delivery must not wait for ASR');
    await handleJob(pipelineDeps, audioJob);
    jobs.complete(audioJob);

    const asrJob = jobs.claim(['asr']);
    assert.ok(asrJob);
    await handleJob(pipelineDeps, asrJob);
    jobs.complete(asrJob);

    const transcriptJob = jobs.claim(['deliver_transcript']);
    assert.ok(transcriptJob, 'ASR must make the transcript independently deliverable');
    await handleJob(pipelineDeps, transcriptJob);
    jobs.complete(transcriptJob);

    const summarizeJob = jobs.claim(['summarize']);
    assert.ok(summarizeJob, 'ASR must queue the summarize step');
    await handleJob(pipelineDeps, summarizeJob);
    jobs.complete(summarizeJob);

    const reportJob = jobs.claim(['deliver_report']);
    assert.ok(reportJob);
    await handleJob(pipelineDeps, reportJob);
    jobs.complete(reportJob);

    // --- what the user would receive --------------------------------------
    const outbox = new Outbox(db.handle);
    const queued = db.handle
      .prepare('SELECT kind, ordinal FROM telegram_outbox ORDER BY ordinal')
      .all() as { kind: string; ordinal: number }[];

    assert.ok(
      queued.some((q) => q.kind === 'audio'),
      'the source FLAC is queued',
    );
    assert.ok(
      queued.some((q) => q.kind === 'transcript'),
      'the transcript is queued',
    );
    assert.ok(
      queued.some((q) => q.kind === 'report'),
      'the report is queued',
    );
    assert.equal(outbox.claimNext()?.kind, 'status', 'the start notice is first');
    assert.equal(outbox.claimNext()?.kind, 'status', 'the finish/upload notice follows');
    assert.equal(outbox.claimNext()?.kind, 'audio', 'audio goes before transcript and report');

    assert.ok(
      new TranscriptRepository(db.handle).current(sessionId),
      'a transcript revision exists',
    );
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
      .prepare('SELECT state, rejection_reason, duration_ms, timing_exact FROM audio_sessions')
      .get() as
      | { state: string; rejection_reason: string; duration_ms: number; timing_exact: number }
      | undefined;

    assert.equal(row?.state, 'REJECTED');
    assert.equal(row?.rejection_reason, 'insufficient_speech');
    assert.equal(row?.timing_exact, 1);
    assert.ok((row?.duration_ms ?? 0) > 0);
    assert.equal(
      new JobQueue(db.handle).pendingCount('asr'),
      0,
      'a rejected session must not be queued for transcription',
    );
  });

  it('reports a truthful failure and queues no work when no audio part finalizes', async () => {
    const failingEncoder = join(dir, 'ffmpeg-always-fails');
    writeFileSync(failingEncoder, '#!/bin/sh\ncat >/dev/null\nexit 1\n', { mode: 0o700 });
    const { recorder } = recorderFor(
      [
        { kind: 'speech', seconds: 6 },
        { kind: 'silence', seconds: 61 },
      ],
      {},
      failingEncoder,
    );

    await recorder.run();

    const session = db.handle
      .prepare('SELECT session_id, state, rejection_reason FROM audio_sessions')
      .get() as {
      session_id: string;
      state: string;
      rejection_reason: string;
    };
    assert.equal(session.state, 'FAILED');
    assert.equal(session.rejection_reason, 'audio_finalize_failed');
    const jobs = new JobQueue(db.handle);
    assert.equal(jobs.pendingCount('deliver_audio'), 0);
    assert.equal(jobs.pendingCount('asr'), 0);
    assert.equal(
      new Outbox(db.handle).stateOf(`session-status:finalized:${session.session_id}`),
      null,
      'a failed archive must never claim that upload started',
    );
    const failure = db.handle
      .prepare('SELECT payload FROM telegram_outbox WHERE delivery_part_id = ?')
      .get(`session-status:failed:${session.session_id}`) as { payload: string };
    assert.match(JSON.parse(failure.payload).text as string, /не удалось сохранить/);
  });

  it('queues no partial plan until every published journal-owned part is recovered', async (t) => {
    if (!hasFfmpeg) return t.skip('ffmpeg not available');

    const scenarios = [
      {
        name: 'final-part',
        script: [
          { kind: 'speech' as const, seconds: 6 },
          { kind: 'silence' as const, seconds: 61 },
        ],
        overrides: {},
      },
      {
        name: 'rotated-part',
        script: [
          { kind: 'speech' as const, seconds: 14 },
          { kind: 'silence' as const, seconds: 6 },
        ],
        overrides: { maxPartSeconds: 5, silenceTimeoutSeconds: 5 },
      },
    ];

    for (const scenario of scenarios) {
      db.handle.exec(`
        CREATE TRIGGER fail_${scenario.name.replace('-', '_')}_finalize
        BEFORE UPDATE OF finalized ON audio_parts
        WHEN NEW.part_index = 0 AND NEW.finalized = 1
        BEGIN
          SELECT RAISE(ABORT, 'injected part finalization failure');
        END
      `);
      const { recorder } = recorderFor(scenario.script, scenario.overrides);
      await recorder.run();
      const session = db.handle
        .prepare(
          `SELECT session_id, state, rejection_reason, timing_exact, part_count
             FROM audio_sessions ORDER BY rowid DESC LIMIT 1`,
        )
        .get() as {
        session_id: string;
        state: string;
        rejection_reason: string;
        timing_exact: number;
        part_count: number;
      };
      assert.deepEqual(
        {
          state: session.state,
          rejectionReason: session.rejection_reason,
          timingExact: session.timing_exact,
        },
        { state: 'FAILED', rejectionReason: 'audio_finalize_failed', timingExact: 1 },
      );
      const jobsBeforeRecovery = db.handle
        .prepare(
          `SELECT count(*) AS count FROM jobs
            WHERE idempotency_key IN (?, ?)`,
        )
        .get(`deliver-audio:${session.session_id}`, `asr:${session.session_id}`) as {
        count: number;
      };
      assert.equal(jobsBeforeRecovery.count, 0, `${scenario.name} cannot enqueue a partial plan`);
      const pendingParts = db.handle
        .prepare(
          `SELECT count(*) AS count
             FROM audio_finalization_journal j
             JOIN audio_parts p ON p.part_id = j.part_id
            WHERE j.session_id = ? AND p.finalized = 0`,
        )
        .get(session.session_id) as { count: number };
      assert.ok(pendingParts.count > 0, `${scenario.name} keeps its exact recovery proof`);

      db.handle.exec(`DROP TRIGGER fail_${scenario.name.replace('-', '_')}_finalize`);
      await recoverAfterCrash(db.handle, resolvePaths(dir), nullLogger);

      const recovered = new SessionRepository(db.handle).get(session.session_id);
      const parts = new PartRepository(db.handle).listForSession(session.session_id);
      assert.equal(recovered?.state, 'PROCESSING');
      assert.equal(recovered?.part_count, parts.length);
      assert.ok(parts.length > 0);
      assert.ok(parts.every((part) => part.finalized === 1));
      const recoveredJobs = db.handle
        .prepare(
          `SELECT kind FROM jobs
            WHERE idempotency_key IN (?, ?)
            ORDER BY kind`,
        )
        .all(`deliver-audio:${session.session_id}`, `asr:${session.session_id}`) as {
        kind: string;
      }[];
      assert.deepEqual(
        recoveredJobs.map((job) => job.kind),
        ['asr', 'deliver_audio'],
      );
      const journal = db.handle
        .prepare('SELECT count(*) AS count FROM audio_finalization_journal WHERE session_id = ?')
        .get(session.session_id) as { count: number };
      assert.equal(journal.count, 0);
    }
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

  it('delivers surviving rotated parts with an honest partial status', async (t) => {
    if (!hasFfmpeg) return t.skip('ffmpeg not available');

    const wrapper = join(dir, 'ffmpeg-fails-after-first');
    const marker = join(dir, 'first-encoder-started');
    const shellLiteral = (value: string) => `'${value.replaceAll("'", "'\\\"'\\\"'")}'`;
    writeFileSync(
      wrapper,
      [
        '#!/bin/sh',
        `if [ ! -e ${shellLiteral(marker)} ]; then`,
        `  : > ${shellLiteral(marker)}`,
        `  exec ${shellLiteral(FFMPEG)} "$@"`,
        'fi',
        'cat >/dev/null',
        'exit 1',
        '',
      ].join('\n'),
      { mode: 0o700 },
    );
    const { recorder } = recorderFor(
      [
        { kind: 'speech', seconds: 8 },
        { kind: 'silence', seconds: 6 },
      ],
      { maxPartSeconds: 5, silenceTimeoutSeconds: 5 },
      wrapper,
    );

    await recorder.run();

    const session = db.handle
      .prepare('SELECT session_id, state, part_count FROM audio_sessions')
      .get() as {
      session_id: string;
      state: string;
      part_count: number;
    };
    assert.equal(session.state, 'PROCESSING');
    assert.equal(session.part_count, 1, 'only the surviving source is advertised');
    const parts = new PartRepository(db.handle).listForSession(session.session_id);
    assert.deepEqual(
      parts.map((part) => part.finalized),
      [1, 0],
    );
    const jobs = new JobQueue(db.handle);
    assert.equal(jobs.pendingCount('deliver_audio'), 1);
    assert.equal(jobs.pendingCount('asr'), 1);
    const status = db.handle
      .prepare('SELECT payload FROM telegram_outbox WHERE delivery_part_id = ?')
      .get(`session-status:finalized:${session.session_id}`) as { payload: string };
    assert.match(JSON.parse(status.payload).text as string, /сохранившиеся части/);
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

    const parts = db.handle.prepare('SELECT path, finalized, sha256 FROM audio_parts').all() as {
      path: string;
      finalized: number;
      sha256: string | null;
    }[];

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
