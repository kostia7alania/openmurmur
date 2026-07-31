import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { FakeAsr, SilentFakeAsr } from '../../src/asr/fake.ts';
import { resolvePaths } from '../../src/config/paths.ts';
import { DEFAULT_CONFIG } from '../../src/config/schema.ts';
import { type Database, openDatabase } from '../../src/database/db.ts';
import {
  PartRepository,
  SessionRepository,
  TranscriptRepository,
  VadSegmentRepository,
} from '../../src/database/repository.ts';
import { enqueueSessionDelivery } from '../../src/jobs/delivery.ts';
import { handleJob, reconcileSessionDelivery } from '../../src/jobs/pipeline.ts';
import { JobQueue } from '../../src/jobs/queue.ts';
import { FakeLlm } from '../../src/llm/ollama.ts';
import { EMPTY_SUMMARY } from '../../src/llm/schema.ts';
import { nullLogger } from '../../src/logging/logger.ts';
import { planRetention } from '../../src/retention/policy.ts';
import { Outbox } from '../../src/telegram/outbox.ts';

/**
 * The pipeline from a finalized session to a queued set of Telegram messages,
 * driven entirely by the fake ASR/LLM adapters — no model, no network.
 */

let dir: string;
let db: Database;

const CONFIG = DEFAULT_CONFIG;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'om-deliver-'));
  db = openDatabase({ file: join(dir, 'test.db') });
  for (const sub of ['audio', 'tmp', 'transcripts']) mkdirSync(join(dir, sub), { recursive: true });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function paths() {
  return resolvePaths(dir);
}

/**
 * A finalized session with `partCount` real files on disk, each with an
 * `.expected.txt` sidecar so FakeAsr returns a realistic transcript. Without
 * one, FakeAsr's default line is four words and the session is (correctly)
 * rejected by the five-word gate.
 */
function seedFinalizedSession(id: string, partCount = 1, bytesPerPart = 2048): string[] {
  const sessions = new SessionRepository(db.handle);
  const parts = new PartRepository(db.handle);
  const nowIso = new Date().toISOString();

  sessions.create(id, nowIso);
  sessions.finalize(id, nowIso, 60_000, 30_000, partCount);

  const created: string[] = [];
  for (let index = 0; index < partCount; index += 1) {
    const stem = join(dir, 'audio', `${id}.p${String(index).padStart(3, '0')}`);
    const path = `${stem}.flac`;
    writeFileSync(path, Buffer.alloc(bytesPerPart));
    writeFileSync(`${stem}.expected.txt`, `Обсудили сроки запуска проекта, часть ${index + 1}.`);
    const partId = parts.open(id, index, path, nowIso);
    parts.finalizePart(partId, nowIso, 60_000, bytesPerPart, `sha-${id}-${index}`);
    created.push(path);
  }
  return created;
}

function deps(asr: FakeAsr | SilentFakeAsr = new FakeAsr()) {
  return {
    db: db.handle,
    config: CONFIG,
    paths: paths(),
    asr,
    llm: new FakeLlm(),
    jobs: new JobQueue(db.handle),
    logger: nullLogger,
  };
}

describe('ASR job', () => {
  it('stores a transcript and queues the summarize step', async () => {
    seedFinalizedSession('s1');
    const jobs = new JobQueue(db.handle);

    await handleJob(deps(), {
      jobId: 'j1',
      kind: 'asr',
      payload: { sessionId: 's1' },
      attempts: 1,
      maxAttempts: 5,
    });

    const transcript = new TranscriptRepository(db.handle).current('s1');
    assert.ok(transcript, 'a transcript revision must exist');
    assert.ok(transcript.text.length > 0);
    assert.equal(jobs.pendingCount('summarize'), 1);
  });

  it('concatenates every part of a multi-part session', async () => {
    seedFinalizedSession('s1', 3);
    await handleJob(deps(), {
      jobId: 'j1',
      kind: 'asr',
      payload: { sessionId: 's1' },
      attempts: 1,
      maxAttempts: 5,
    });

    const transcript = new TranscriptRepository(db.handle).current('s1');
    assert.ok(transcript);
    assert.equal(
      transcript.text.split('\n\n').length,
      3,
      'each part contributes its own block of text',
    );
  });

  it('rejects a session whose transcript is empty', async () => {
    seedFinalizedSession('s1');
    await handleJob(deps(new SilentFakeAsr()), {
      jobId: 'j1',
      kind: 'asr',
      payload: { sessionId: 's1' },
      attempts: 1,
      maxAttempts: 5,
    });

    const session = new SessionRepository(db.handle).get('s1');
    assert.equal(session?.state, 'REJECTED');
    assert.equal(session?.rejection_reason, 'asr_empty');
    assert.equal(new JobQueue(db.handle).pendingCount('summarize'), 0, 'nothing is delivered');
  });

  it('fails loudly when a session has no finalized audio', async () => {
    new SessionRepository(db.handle).create('s1', new Date().toISOString());
    await assert.rejects(
      handleJob(deps(), {
        jobId: 'j1',
        kind: 'asr',
        payload: { sessionId: 's1' },
        attempts: 1,
        maxAttempts: 5,
      }),
      /no finalized audio parts/,
    );
  });
});

describe('delivery enqueue', () => {
  async function transcribeAndSummarize(id: string): Promise<void> {
    const d = deps();
    await handleJob(d, {
      jobId: 'a',
      kind: 'asr',
      payload: { sessionId: id },
      attempts: 1,
      maxAttempts: 5,
    });
    await handleJob(d, {
      jobId: 'b',
      kind: 'summarize',
      payload: { sessionId: id },
      attempts: 1,
      maxAttempts: 5,
    });
  }

  it('queues audio first, then transcript, then report', async () => {
    seedFinalizedSession('s1', 2);
    await transcribeAndSummarize('s1');

    const plan = await enqueueSessionDelivery(db.handle, {
      sessionId: 's1',
      summary: EMPTY_SUMMARY,
      config: CONFIG,
      paths: paths(),
    });

    assert.equal(plan.audioRows, 2, 'one row per audio part');
    assert.ok(plan.transcriptRows >= 1);
    assert.equal(plan.reportRows, 1);

    const outbox = new Outbox(db.handle);
    assert.equal(outbox.claimNext()?.kind, 'audio');
    assert.equal(outbox.claimNext()?.kind, 'audio');
    assert.equal(outbox.claimNext()?.kind, 'transcript');
    assert.equal(outbox.claimNext()?.kind, 'report');
  });

  it('sends the original FLAC, never a re-encode', async () => {
    const files = seedFinalizedSession('s1', 1);
    await transcribeAndSummarize('s1');
    await enqueueSessionDelivery(db.handle, {
      sessionId: 's1',
      summary: EMPTY_SUMMARY,
      config: CONFIG,
      paths: paths(),
    });

    const row = db.handle
      .prepare("SELECT payload FROM telegram_outbox WHERE kind = 'audio'")
      .get() as { payload: string };
    const payload = JSON.parse(row.payload) as { type: string; path: string; filename: string };

    assert.equal(payload.type, 'document');
    assert.equal(payload.path, files[0], 'the source file itself is uploaded');
    assert.ok(payload.filename.endsWith('.flac'));
  });

  it('is idempotent: re-running enqueues nothing new', async () => {
    seedFinalizedSession('s1', 2);
    await transcribeAndSummarize('s1');
    const input = { sessionId: 's1', summary: EMPTY_SUMMARY, config: CONFIG, paths: paths() };

    await enqueueSessionDelivery(db.handle, input);
    const before = new Outbox(db.handle).pendingCount();

    const second = await enqueueSessionDelivery(db.handle, input);
    assert.equal(second.audioRows, 0);
    assert.equal(second.reportRows, 0);
    assert.equal(
      new Outbox(db.handle).pendingCount(),
      before,
      'a retried job must not double-send',
    );
  });

  it('attaches a .md file when the transcript needs splitting', async () => {
    seedFinalizedSession('s1');
    const sidecar = join(dir, 'audio', 's1.p000.expected.txt');
    writeFileSync(sidecar, 'слово '.repeat(2000));

    await transcribeAndSummarize('s1');
    await enqueueSessionDelivery(db.handle, {
      sessionId: 's1',
      summary: EMPTY_SUMMARY,
      config: CONFIG,
      paths: paths(),
    });

    const rows = db.handle
      .prepare("SELECT delivery_part_id, payload FROM telegram_outbox WHERE kind = 'transcript'")
      .all() as { delivery_part_id: string; payload: string }[];

    assert.ok(rows.length > 2, 'a long transcript is split across messages');
    const md = rows.find((r) => r.delivery_part_id.startsWith('transcript-md:'));
    assert.ok(md, 'a long transcript also travels as one .md file');
    assert.ok(existsSync(join(dir, 'transcripts', 's1.md')));
  });

  it('still delivers the transcript when the audio is already gone', async () => {
    const files = seedFinalizedSession('s1');
    await transcribeAndSummarize('s1');
    rmSync(files[0] ?? '', { force: true });

    const plan = await enqueueSessionDelivery(db.handle, {
      sessionId: 's1',
      summary: EMPTY_SUMMARY,
      config: CONFIG,
      paths: paths(),
    });
    assert.equal(plan.audioRows, 0);
    assert.ok(plan.transcriptRows >= 1, 'losing the audio must not lose the transcript');
  });

  it('moves the session to DELIVERING', async () => {
    seedFinalizedSession('s1');
    await transcribeAndSummarize('s1');
    await enqueueSessionDelivery(db.handle, {
      sessionId: 's1',
      summary: EMPTY_SUMMARY,
      config: CONFIG,
      paths: paths(),
    });
    assert.equal(new SessionRepository(db.handle).get('s1')?.state, 'DELIVERING');
  });
});

describe('session completion and retention handoff', () => {
  it('marks a session DONE only when every message is sent', async () => {
    seedFinalizedSession('s1');
    const d = deps();
    await handleJob(d, {
      jobId: 'a',
      kind: 'asr',
      payload: { sessionId: 's1' },
      attempts: 1,
      maxAttempts: 5,
    });
    await handleJob(d, {
      jobId: 'b',
      kind: 'summarize',
      payload: { sessionId: 's1' },
      attempts: 1,
      maxAttempts: 5,
    });
    await handleJob(d, {
      jobId: 'c',
      kind: 'deliver',
      payload: { sessionId: 's1' },
      attempts: 1,
      maxAttempts: 5,
    });

    reconcileSessionDelivery(db.handle, 's1', nullLogger);
    assert.equal(
      new SessionRepository(db.handle).get('s1')?.state,
      'DELIVERING',
      'nothing is sent yet, so the session is not done',
    );

    db.handle.prepare("UPDATE telegram_outbox SET state = 'sent'").run();
    reconcileSessionDelivery(db.handle, 's1', nullLogger);
    assert.equal(new SessionRepository(db.handle).get('s1')?.state, 'DONE');
  });

  it('audio becomes retention-eligible only after the whole chain completes', async () => {
    seedFinalizedSession('s1');
    const d = deps();
    await handleJob(d, {
      jobId: 'a',
      kind: 'asr',
      payload: { sessionId: 's1' },
      attempts: 1,
      maxAttempts: 5,
    });
    await handleJob(d, {
      jobId: 'b',
      kind: 'summarize',
      payload: { sessionId: 's1' },
      attempts: 1,
      maxAttempts: 5,
    });
    await handleJob(d, {
      jobId: 'c',
      kind: 'deliver',
      payload: { sessionId: 's1' },
      attempts: 1,
      maxAttempts: 5,
    });

    // Mid-flight: nothing may be deleted. Each handler queues the next stage,
    // and those pending jobs are themselves a reason to hold the audio.
    assert.equal(planRetention(db.handle, CONFIG.retention).candidates.length, 0);

    // The worker loop finishes the chain it queued.
    db.handle.prepare("UPDATE jobs SET state = 'done'").run();
    db.handle.prepare("UPDATE telegram_outbox SET state = 'sent'").run();
    db.handle.prepare('UPDATE audio_parts SET delivered = 1').run();
    reconcileSessionDelivery(db.handle, 's1', nullLogger);

    // Still inside the 48-hour window.
    assert.equal(planRetention(db.handle, CONFIG.retention).candidates.length, 0);

    // Now age it past the window.
    db.handle.prepare("UPDATE audio_sessions SET ended_at = '2020-01-01T00:00:00.000Z'").run();
    const plan = planRetention(db.handle, CONFIG.retention);
    assert.equal(plan.candidates.length, 1, 'only now is the audio safe to delete');
  });
});

describe('recording is never blocked by processing', () => {
  it('a second session can be recorded while the first is still queued', async () => {
    seedFinalizedSession('s1');
    const jobs = new JobQueue(db.handle);
    jobs.enqueue({ kind: 'asr', idempotencyKey: 'asr:s1', payload: { sessionId: 's1' } });

    // The first session's ASR is claimed and in flight...
    const inFlight = jobs.claim(['asr']);
    assert.ok(inFlight);

    // ...and a brand-new session is recorded and finalized regardless.
    seedFinalizedSession('s2');
    assert.ok(
      jobs.enqueue({ kind: 'asr', idempotencyKey: 'asr:s2', payload: { sessionId: 's2' } }),
    );

    assert.equal(new SessionRepository(db.handle).get('s2')?.state, 'PROCESSING');
    assert.equal(jobs.pendingCount('asr'), 2, 'both sessions are tracked independently');
  });
});

describe('final VAD pass', () => {
  it('stores authoritative speech segments for the session', async () => {
    seedFinalizedSession('s1', 2);
    await handleJob(deps(), {
      jobId: 'j1',
      kind: 'asr',
      payload: { sessionId: 's1' },
      attempts: 1,
      maxAttempts: 5,
    });

    const vad = new VadSegmentRepository(db.handle);
    const segments = vad.listForSession('s1');

    assert.equal(segments.length, 2, 'one segment per part from the fake backend');
    assert.ok(vad.totalSpeechMs('s1') > 0);
  });

  it('offsets segment times so they refer to the whole session', async () => {
    // Each seeded part is 60 s long, so the second part's segments must be
    // shifted by 60 000 ms rather than restarting at zero.
    seedFinalizedSession('s1', 2);
    await handleJob(deps(), {
      jobId: 'j1',
      kind: 'asr',
      payload: { sessionId: 's1' },
      attempts: 1,
      maxAttempts: 5,
    });

    const segments = new VadSegmentRepository(db.handle).listForSession('s1');
    assert.equal(segments[0]?.startMs, 0);
    assert.equal(segments[1]?.startMs, 60_000, 'second part is offset by the first part duration');
  });

  it('is idempotent, so a retried ASR job cannot duplicate segments', async () => {
    seedFinalizedSession('s1');
    const job = {
      jobId: 'j1',
      kind: 'asr' as const,
      payload: { sessionId: 's1' },
      attempts: 1,
      maxAttempts: 5,
    };
    await handleJob(deps(), job);
    await handleJob(deps(), job);

    assert.equal(new VadSegmentRepository(db.handle).listForSession('s1').length, 1);
  });

  it('does not cost the user their transcript when VAD fails', async () => {
    seedFinalizedSession('s1');
    const failing = new FakeAsr();
    failing.vadSegments = async () => {
      throw new Error('worker died');
    };

    await handleJob(
      { ...deps(), asr: failing },
      {
        jobId: 'j1',
        kind: 'asr',
        payload: { sessionId: 's1' },
        attempts: 1,
        maxAttempts: 5,
      },
    );

    assert.equal(new VadSegmentRepository(db.handle).listForSession('s1').length, 0);
    assert.ok(
      new TranscriptRepository(db.handle).current('s1'),
      'the transcript must still be stored',
    );
  });
});
