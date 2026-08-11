import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { FakeAsr, SilentFakeAsr } from '../../src/asr/fake.ts';
import { reconcileIncomingDelivery } from '../../src/cli/daemon.ts';
import { resolvePaths } from '../../src/config/paths.ts';
import { DEFAULT_CONFIG } from '../../src/config/schema.ts';
import { type Database, openDatabase } from '../../src/database/db.ts';
import {
  PartRepository,
  SessionRepository,
  TranscriptRepository,
  VadSegmentRepository,
} from '../../src/database/repository.ts';
import {
  enqueueSessionAudio,
  enqueueSessionDelivery,
  enqueueSessionReport,
  enqueueSessionTranscript,
} from '../../src/jobs/delivery.ts';
import {
  handleJob,
  markAudioDelivered,
  reconcileSessionDelivery,
} from '../../src/jobs/pipeline.ts';
import { JobQueue } from '../../src/jobs/queue.ts';
import { FakeLlm } from '../../src/llm/ollama.ts';
import { EMPTY_SUMMARY } from '../../src/llm/schema.ts';
import { nullLogger } from '../../src/logging/logger.ts';
import { planRetention } from '../../src/retention/policy.ts';
import { formatClock } from '../../src/telegram/format.ts';
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

  sessions.create(id, nowIso, { hostName: 'test-mac', timezone: 'Europe/Moscow' });
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
    assert.equal(jobs.pendingCount('deliver_transcript'), 1);
    assert.equal(jobs.pendingCount('summarize'), 1);
  });

  it('fences transcript and downstream commits from a reclaimed ASR generation', async () => {
    seedFinalizedSession('lease-fence');
    const asr = new FakeAsr();
    const originalTranscribe = asr.transcribe.bind(asr);
    let signalStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    let signalRelease: (() => void) | undefined;
    const release = new Promise<void>((resolve) => {
      signalRelease = resolve;
    });
    asr.transcribe = async (request) => {
      signalStarted?.();
      await release;
      return originalTranscribe(request);
    };

    const pipeline = deps(asr);
    pipeline.jobs.enqueue({
      kind: 'asr',
      idempotencyKey: 'asr:lease-fence',
      payload: { sessionId: 'lease-fence' },
    });
    const stale = pipeline.jobs.claim(['asr']);
    assert.ok(stale);
    const staleWork = handleJob(pipeline, stale);
    await started;

    db.handle
      .prepare("UPDATE jobs SET lease_expires_at = '2000-01-01T00:00:00.000Z' WHERE job_id = ?")
      .run(stale.jobId);
    assert.equal(pipeline.jobs.recoverStaleLeases(), 1);
    const current = pipeline.jobs.claim(['asr']);
    assert.ok(current);
    asr.transcribe = originalTranscribe;
    signalRelease?.();

    await assert.rejects(staleWork, /lost its lease before the handler completed/);
    assert.equal(pipeline.jobs.fail(stale, 'late stale ASR completion'), 'lost');
    assert.equal(new TranscriptRepository(db.handle).current('lease-fence'), undefined);
    assert.equal(pipeline.jobs.pendingCount('deliver_transcript'), 0);
    assert.equal(pipeline.jobs.pendingCount('summarize'), 0);
    assert.equal(new SessionRepository(db.handle).get('lease-fence')?.state, 'PROCESSING');

    await handleJob(pipeline, current);
    assert.equal(pipeline.jobs.complete(current), true);
    assert.ok(new TranscriptRepository(db.handle).current('lease-fence'));
  });

  it('uses the language snapshotted in the job and records that auto-detection was skipped', async () => {
    seedFinalizedSession('s1');
    const asr = new FakeAsr();
    const original = asr.transcribe.bind(asr);
    let receivedHints: readonly string[] | undefined;
    asr.transcribe = async (request) => {
      receivedHints = request.languageHints;
      return original(request);
    };

    await handleJob(deps(asr), {
      jobId: 'j-forced',
      kind: 'asr',
      payload: { sessionId: 's1', forcedLanguage: 'Thai' },
      attempts: 1,
      maxAttempts: 5,
    });

    assert.deepEqual(receivedHints, ['Thai']);
    assert.equal(new TranscriptRepository(db.handle).current('s1')?.forced_language, 'Thai');
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

  it('replays an existing transcript into downstream jobs without retranscribing', async () => {
    seedFinalizedSession('s1');
    const asr = new FakeAsr();
    const d = deps(asr);
    const job = {
      jobId: 'j1',
      kind: 'asr' as const,
      payload: { sessionId: 's1' },
      attempts: 1,
      maxAttempts: 5,
    };
    await handleJob(d, job);
    asr.transcribe = async () => {
      throw new Error('ASR must not run during crash replay');
    };

    await handleJob(d, job);

    const revisions = db.handle
      .prepare('SELECT count(*) AS c FROM transcript_revisions WHERE session_id = ?')
      .get('s1') as { c: number };
    assert.equal(revisions.c, 1, 'retry must not replace the delivered current revision');
    assert.equal(d.jobs.pendingCount('deliver_transcript'), 1);
    assert.equal(d.jobs.pendingCount('summarize'), 1);
  });

  it('does not duplicate a summary when the summarize job is replayed', async () => {
    seedFinalizedSession('s1');
    const d = deps();
    await handleJob(d, {
      jobId: 'asr',
      kind: 'asr',
      payload: { sessionId: 's1' },
      attempts: 1,
      maxAttempts: 5,
    });
    const summarize = {
      jobId: 'summary',
      kind: 'summarize' as const,
      payload: { sessionId: 's1' },
      attempts: 1,
      maxAttempts: 5,
    };

    await handleJob(d, summarize);
    await handleJob(d, summarize);

    const count = db.handle
      .prepare('SELECT count(*) AS count FROM summaries WHERE session_id = ?')
      .get('s1') as { count: number };
    assert.equal(count.count, 1);
    assert.equal(d.jobs.pendingCount('deliver_report'), 1);
  });

  it('persists claim evidence bound to the immutable transcript revision', async () => {
    seedFinalizedSession('s1');
    const revisionId = new TranscriptRepository(db.handle).append({
      sessionId: 's1',
      engine: 'fixture',
      model: 'fixture-1',
      languages: ['ru'],
      text: 'Сначала обсудили сроки. Затем решили выпустить MVP.',
      segments: [
        {
          startMs: 0,
          endMs: 1_000,
          timestampSource: 'aligner',
          language: 'ru',
          text: 'Сначала обсудили сроки.',
        },
        {
          startMs: 1_000,
          endMs: 2_000,
          timestampSource: 'aligner',
          language: 'ru',
          text: 'Затем решили выпустить MVP.',
        },
      ],
    });
    const groundedLlm = {
      name: 'grounded-fake',
      async ready() {
        return { ok: true as const, model: 'grounded-fake-1' };
      },
      async summarize() {
        return {
          ...EMPTY_SUMMARY,
          summary: 'Решили выпустить MVP.',
          decisions: ['Выпустить MVP.'],
          claimEvidence: [
            { field: 'summary' as const, item: 0, segments: [1, 99] },
            { field: 'decisions' as const, item: 0, segments: [1] },
          ],
        };
      },
    };

    await handleJob(
      { ...deps(), llm: groundedLlm },
      {
        jobId: 'summary-provenance',
        kind: 'summarize',
        payload: { sessionId: 's1' },
        attempts: 1,
        maxAttempts: 5,
      },
    );

    const stored = db.handle
      .prepare('SELECT revision_id, payload FROM summaries WHERE session_id = ?')
      .get('s1') as { revision_id: string; payload: string };
    const payload = JSON.parse(stored.payload) as {
      claimEvidence: { field: string; item: number; segments: number[] }[];
    };
    assert.equal(stored.revision_id, revisionId);
    assert.deepEqual(payload.claimEvidence, [
      { field: 'summary', item: 0, segments: [1] },
      { field: 'decisions', item: 0, segments: [1] },
    ]);

    // A pre-release or manually corrupted stored payload must be bounded again
    // at delivery against the exact immutable revision it names.
    payload.claimEvidence[0]?.segments.push(99);
    db.handle
      .prepare('UPDATE summaries SET payload = ? WHERE session_id = ?')
      .run(JSON.stringify(payload), 's1');

    await handleJob(
      { ...deps(), llm: groundedLlm },
      {
        jobId: 'report-provenance',
        kind: 'deliver_report',
        payload: { sessionId: 's1', revisionId },
        attempts: 1,
        maxAttempts: 5,
      },
    );

    const newerRevisionId = new TranscriptRepository(db.handle).append({
      sessionId: 's1',
      engine: 'fixture',
      model: 'fixture-2',
      languages: ['en'],
      text: 'A newer transcript must not detach the stored summary from its source.',
      segments: [
        {
          startMs: 0,
          endMs: 1_000,
          timestampSource: 'aligner',
          language: 'en',
          text: 'A newer transcript must not detach the stored summary from its source.',
        },
      ],
    });
    assert.notEqual(newerRevisionId, revisionId);

    await handleJob(
      { ...deps(), llm: groundedLlm },
      {
        jobId: 'stale-report-provenance',
        kind: 'deliver_report',
        payload: { sessionId: 's1', revisionId },
        attempts: 1,
        maxAttempts: 5,
      },
    );

    const reportRow = db.handle
      .prepare('SELECT payload FROM telegram_outbox WHERE delivery_part_id = ?')
      .get(`report:s1:${revisionId}`) as { payload: string };
    const reportPayload = JSON.parse(reportRow.payload) as { type: string; text: string };
    assert.equal(reportPayload.type, 'text');
    assert.match(reportPayload.text, new RegExp(revisionId));
    assert.match(reportPayload.text, /\[сегм\. 2\] 0:01: Затем решили выпустить MVP\./);
    assert.doesNotMatch(reportPayload.text, /сегм\. 100/);
    assert.doesNotMatch(reportPayload.text, /A newer transcript must not detach/);
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
    assert.equal(
      new Outbox(db.handle).stateOf('session-status:asr-rejected:s1'),
      'pending',
      'the rejection and its truthful status commit together',
    );
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

  it('fences every delivery family after another generation reclaims the job', async () => {
    const kinds = ['deliver_audio', 'deliver_report', 'deliver_transcript', 'deliver'] as const;

    for (const kind of kinds) {
      const sessionId = `lease-${kind}`;
      seedFinalizedSession(sessionId);
      if (kind !== 'deliver_audio') await transcribeAndSummarize(sessionId);

      const queue = new JobQueue(db.handle, `owner-${kind}`);
      if (kind === 'deliver_audio' || kind === 'deliver') {
        queue.enqueue({
          kind,
          idempotencyKey: `lease-test:${kind}:${sessionId}`,
          payload: { sessionId },
        });
      }
      const stale = queue.claim([kind]);
      assert.ok(stale);
      db.handle
        .prepare("UPDATE jobs SET lease_expires_at = '2000-01-01T00:00:00.000Z' WHERE job_id = ?")
        .run(stale.jobId);
      assert.equal(queue.recoverStaleLeases(), 1);
      const current = queue.claim([kind]);
      assert.ok(current);
      new SessionRepository(db.handle).setState(sessionId, 'DONE');

      await assert.rejects(handleJob({ ...deps(), jobs: queue }, stale), /lost its lease/);
      assert.equal(new SessionRepository(db.handle).get(sessionId)?.state, 'DONE');
      const staleRows = db.handle
        .prepare('SELECT count(*) AS count FROM telegram_outbox WHERE session_id = ?')
        .get(sessionId) as { count: number };
      assert.equal(staleRows.count, 0, `${kind} stale generation published no outbox rows`);

      await handleJob({ ...deps(), jobs: queue }, current);
      assert.equal(queue.complete(current), true);
      const currentRows = db.handle
        .prepare('SELECT count(*) AS count FROM telegram_outbox WHERE session_id = ?')
        .get(sessionId) as { count: number };
      assert.ok(currentRows.count > 0, `${kind} replacement generation completed delivery`);
      db.handle.prepare("DELETE FROM jobs WHERE state = 'pending'").run();
    }
  });

  it('does not publish long text artifacts when the lease is lost during their write', async () => {
    for (const kind of ['transcript', 'report'] as const) {
      const sessionId = `lease-file-${kind}`;
      seedFinalizedSession(sessionId);
      writeFileSync(join(dir, 'audio', `${sessionId}.p000.expected.txt`), 'слово '.repeat(2_000));
      await transcribeAndSummarize(sessionId);
      const revisionId = new TranscriptRepository(db.handle).current(sessionId)?.revision_id;
      assert.ok(revisionId);
      new SessionRepository(db.handle).setState(sessionId, 'DONE');
      let checks = 0;
      const assertCurrent = () => {
        checks += 1;
        if (checks === 3) throw new Error('lease lost during atomic write');
      };

      if (kind === 'transcript') {
        await assert.rejects(
          enqueueSessionTranscript(db.handle, {
            sessionId,
            config: CONFIG,
            paths: paths(),
            assertCurrent,
          }),
          /lease lost during atomic write/,
        );
        assert.equal(existsSync(join(dir, 'transcripts', `${sessionId}.${revisionId}.md`)), false);
      } else {
        await assert.rejects(
          enqueueSessionReport(db.handle, {
            sessionId,
            summary: { ...EMPTY_SUMMARY, summary: 'длинный отчёт '.repeat(500) },
            summaryRevisionId: revisionId,
            config: CONFIG,
            paths: paths(),
            assertCurrent,
          }),
          /lease lost during atomic write/,
        );
        assert.equal(
          existsSync(join(dir, 'transcripts', `${sessionId}.${revisionId}.report.md`)),
          false,
        );
      }

      const rows = db.handle
        .prepare('SELECT count(*) AS count FROM telegram_outbox WHERE session_id = ?')
        .get(sessionId) as { count: number };
      assert.equal(rows.count, 0);
      assert.equal(new SessionRepository(db.handle).get(sessionId)?.state, 'DONE');
    }
  });

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

  it('shows languages and settings controls only on the input-owner transcript', async () => {
    seedFinalizedSession('owner');
    await transcribeAndSummarize('owner');
    await enqueueSessionDelivery(db.handle, {
      sessionId: 'owner',
      summary: EMPTY_SUMMARY,
      config: CONFIG,
      paths: paths(),
    });
    const ownerPayload = JSON.parse(
      (
        db.handle
          .prepare(
            "SELECT payload FROM telegram_outbox WHERE delivery_part_id = 'transcript:owner:1'",
          )
          .get() as { payload: string }
      ).payload,
    ) as { text: string; replyMarkup?: unknown };
    assert.match(ownerPayload.text, /Языки: английский/);
    assert.ok(ownerPayload.replyMarkup, 'the polling host offers working settings controls');

    seedFinalizedSession('send-only');
    await transcribeAndSummarize('send-only');
    await enqueueSessionDelivery(db.handle, {
      sessionId: 'send-only',
      summary: EMPTY_SUMMARY,
      config: {
        ...CONFIG,
        telegram: { ...CONFIG.telegram, receiveUpdates: false },
      },
      paths: paths(),
    });
    const sendOnlyPayload = JSON.parse(
      (
        db.handle
          .prepare(
            "SELECT payload FROM telegram_outbox WHERE delivery_part_id = 'transcript:send-only:1'",
          )
          .get() as { payload: string }
      ).payload,
    ) as { replyMarkup?: unknown };
    assert.equal(
      sendOnlyPayload.replyMarkup,
      undefined,
      'send-only dev must not show dead buttons',
    );
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
    const payload = JSON.parse(row.payload) as {
      type: string;
      path: string;
      filename: string;
      caption: string;
    };

    assert.equal(payload.type, 'document');
    assert.equal(payload.path, files[0], 'the source file itself is uploaded');
    assert.ok(payload.filename.endsWith('.flac'));
    assert.match(payload.caption, /фоновая запись OpenMurmur/);
    assert.match(payload.caption, /test-mac/);
    assert.match(payload.caption, /Europe\/Moscow/);
    assert.match(payload.caption, /UID сессии: <code>s1<\/code>/);
  });

  it('renders report times in the persisted capture timezone', async () => {
    seedFinalizedSession('s1');
    await transcribeAndSummarize('s1');
    await enqueueSessionDelivery(db.handle, {
      sessionId: 's1',
      summary: EMPTY_SUMMARY,
      config: CONFIG,
      paths: paths(),
    });

    const session = new SessionRepository(db.handle).get('s1');
    assert.ok(session);
    const row = db.handle
      .prepare("SELECT payload FROM telegram_outbox WHERE kind = 'report'")
      .get() as { payload: string };
    const payload = JSON.parse(row.payload) as { text: string };
    assert.match(
      payload.text,
      new RegExp(`Время: ${formatClock(Date.parse(session.started_at), 'Europe/Moscow')}`),
    );
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

  it('does not invoke ffmpeg or overwrite a split artifact owned by a pending row', async () => {
    seedFinalizedSession('s1', 1, 4096);
    const part = db.handle
      .prepare('SELECT part_id FROM audio_parts WHERE session_id = ?')
      .get('s1') as { part_id: string };
    const ownedPath = join(dir, 'tmp', 's1.p000.split000.flac');
    const ownedBytes = Buffer.from('pending split artifact');
    writeFileSync(ownedPath, ownedBytes);
    new Outbox(db.handle).enqueue({
      deliveryPartId: `audio:${part.part_id}:split0`,
      kind: 'audio',
      sessionId: 's1',
      ordinal: 0,
      payload: {
        type: 'document',
        path: ownedPath,
        filename: 's1.p000.split000.flac',
        partId: part.part_id,
        deleteAfterSend: true,
      },
    });

    const config = {
      ...CONFIG,
      audio: { ...CONFIG.audio, ffmpegPath: join(dir, 'ffmpeg-must-not-run') },
      telegram: { ...CONFIG.telegram, maxOutgoingBytes: 1024 },
    };
    const plan = await enqueueSessionAudio(db.handle, {
      sessionId: 's1',
      config,
      paths: paths(),
    });

    assert.equal(plan.audioRows, 0);
    assert.deepEqual(plan.oversizeParts, [part.part_id]);
    assert.deepEqual(readFileSync(ownedPath), ownedBytes, 'the live outbox row owns this path');
  });

  it('removes only the losing generation chunks when its lease expires after splitting', async () => {
    seedFinalizedSession('split-loser', 1, 4096);
    const fakeFfmpeg = join(dir, 'fake-split-ffmpeg');
    writeFileSync(
      fakeFfmpeg,
      `#!/bin/sh
for argument do pattern="$argument"; done
first=$(/usr/bin/printf "$pattern" 0)
second=$(/usr/bin/printf "$pattern" 1)
/usr/bin/head -c 256 /dev/zero > "$first"
/usr/bin/head -c 256 /dev/zero > "$second"
`,
      { mode: 0o700 },
    );
    let checks = 0;
    await assert.rejects(
      enqueueSessionAudio(db.handle, {
        sessionId: 'split-loser',
        config: {
          ...CONFIG,
          audio: { ...CONFIG.audio, ffmpegPath: fakeFfmpeg },
          telegram: { ...CONFIG.telegram, maxOutgoingBytes: 1024 },
        },
        paths: paths(),
        artifactGeneration: 'lease-A',
        assertCurrent: () => {
          checks += 1;
          if (checks === 5) throw new Error('split lease lost');
        },
      }),
      /split lease lost/,
    );
    assert.deepEqual(
      readdirSync(join(dir, 'tmp')).filter((name) => name.includes('.lease-A.split')),
      [],
    );
    const rows = db.handle
      .prepare("SELECT count(*) AS count FROM telegram_outbox WHERE kind = 'audio'")
      .get() as { count: number };
    assert.equal(rows.count, 0);
  });

  it('fails safely when a pending split row has lost its owned artifact', async () => {
    seedFinalizedSession('s1', 1, 4096);
    const part = db.handle
      .prepare('SELECT part_id FROM audio_parts WHERE session_id = ?')
      .get('s1') as { part_id: string };
    const missingPath = join(dir, 'tmp', 'missing.split000.flac');
    new Outbox(db.handle).enqueue({
      deliveryPartId: `audio:${part.part_id}:split0`,
      kind: 'audio',
      sessionId: 's1',
      ordinal: 0,
      payload: {
        type: 'document',
        path: missingPath,
        filename: 'missing.split000.flac',
        partId: part.part_id,
        deleteAfterSend: true,
      },
    });

    await assert.rejects(
      enqueueSessionAudio(db.handle, {
        sessionId: 's1',
        config: {
          ...CONFIG,
          audio: { ...CONFIG.audio, ffmpegPath: join(dir, 'ffmpeg-must-not-run') },
          telegram: { ...CONFIG.telegram, maxOutgoingBytes: 1024 },
        },
        paths: paths(),
      }),
      /owned artifact is unavailable/,
    );
  });

  it('fails explicitly when an unsplit live row no longer fits a reduced limit', async () => {
    const [sourcePath] = seedFinalizedSession('s1', 1, 4096);
    assert.ok(sourcePath);
    const part = db.handle
      .prepare('SELECT part_id FROM audio_parts WHERE session_id = ?')
      .get('s1') as { part_id: string };
    new Outbox(db.handle).enqueue({
      deliveryPartId: `audio:${part.part_id}`,
      kind: 'audio',
      sessionId: 's1',
      ordinal: 0,
      payload: {
        type: 'document',
        path: sourcePath,
        filename: 's1.p000.flac',
        partId: part.part_id,
      },
    });

    await assert.rejects(
      enqueueSessionAudio(db.handle, {
        sessionId: 's1',
        config: {
          ...CONFIG,
          audio: { ...CONFIG.audio, ffmpegPath: join(dir, 'ffmpeg-must-not-run') },
          telegram: { ...CONFIG.telegram, maxOutgoingBytes: 1024 },
        },
        paths: paths(),
      }),
      /unsplit audio delivery .* exceeds the current upload limit/,
    );
  });

  for (const state of ['sent', 'dead'] as const) {
    it(`does not recreate split artifacts for a ${state} delivery`, async () => {
      seedFinalizedSession('s1', 1, 4096);
      const part = db.handle
        .prepare('SELECT part_id FROM audio_parts WHERE session_id = ?')
        .get('s1') as { part_id: string };
      const absentPath = join(dir, 'tmp', 's1.p000.split000.flac');
      new Outbox(db.handle).enqueue({
        deliveryPartId: `audio:${part.part_id}:split0`,
        kind: 'audio',
        sessionId: 's1',
        ordinal: 0,
        payload: {
          type: 'document',
          path: absentPath,
          filename: 's1.p000.split000.flac',
          partId: part.part_id,
          deleteAfterSend: true,
        },
      });
      db.handle
        .prepare('UPDATE telegram_outbox SET state = ? WHERE delivery_part_id = ?')
        .run(state, `audio:${part.part_id}:split0`);

      const plan = await enqueueSessionAudio(db.handle, {
        sessionId: 's1',
        config: {
          ...CONFIG,
          audio: { ...CONFIG.audio, ffmpegPath: join(dir, 'ffmpeg-must-not-run') },
          telegram: { ...CONFIG.telegram, maxOutgoingBytes: 1024 },
        },
        paths: paths(),
      });

      assert.equal(plan.audioRows, 0);
      assert.equal(existsSync(absentPath), false);
    });
  }

  it('sends only a .md file when the transcript exceeds the inline limit', async () => {
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

    assert.equal(rows.length, 1, 'a long transcript must not flood the chat with quote chunks');
    const md = rows.find((r) => r.delivery_part_id.startsWith('transcript-md:'));
    assert.ok(md, 'a long transcript travels as one .md file');
    const revisionId = new TranscriptRepository(db.handle).current('s1')?.revision_id;
    assert.ok(revisionId);
    const transcriptFile = join(dir, 'transcripts', `s1.${revisionId}.md`);
    assert.ok(existsSync(transcriptFile));
    const transcriptPayload = JSON.parse(md.payload) as { caption: string };
    assert.match(transcriptPayload.caption, /^📝 Транскрипт с таймингами/);
    assert.match(transcriptPayload.caption, /UID сессии: <code>s1<\/code>/);
    assert.match(readFileSync(transcriptFile, 'utf8'), /0:00 {2}слово/);
  });

  it('still delivers the transcript when retention proved the audio was deleted', async () => {
    const files = seedFinalizedSession('s1');
    await transcribeAndSummarize('s1');
    rmSync(files[0] ?? '', { force: true });
    db.handle
      .prepare(
        "UPDATE audio_parts SET deleted_at = '2026-01-01T00:00:00.000Z' WHERE session_id = ?",
      )
      .run('s1');

    const plan = await enqueueSessionDelivery(db.handle, {
      sessionId: 's1',
      summary: EMPTY_SUMMARY,
      config: CONFIG,
      paths: paths(),
    });
    assert.equal(plan.audioRows, 0);
    assert.ok(plan.transcriptRows >= 1, 'losing the audio must not lose the transcript');
  });

  it('publishes no partial manifest when one finalized source is missing', async () => {
    const files = seedFinalizedSession('s1', 2);
    rmSync(files[1] ?? '', { force: true });

    await assert.rejects(
      enqueueSessionAudio(db.handle, {
        sessionId: 's1',
        config: CONFIG,
        paths: paths(),
      }),
      /finalized audio part .* is unavailable/,
    );
    const audio = db.handle
      .prepare("SELECT count(*) AS c FROM telegram_outbox WHERE kind = 'audio'")
      .get() as { c: number };
    assert.equal(audio.c, 0, 'no surviving part may send before the manifest is complete');
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

  it('sends an oversized structured report as one Markdown file', async () => {
    seedFinalizedSession('s1');
    await transcribeAndSummarize('s1');
    const reportRows = await enqueueSessionReport(db.handle, {
      sessionId: 's1',
      summary: { ...EMPTY_SUMMARY, summary: 'очень длинный отчёт '.repeat(400) },
      config: CONFIG,
      paths: paths(),
    });

    assert.equal(reportRows, 2, 'one compact summary quote plus one report file');
    const rows = db.handle
      .prepare("SELECT delivery_part_id, payload FROM telegram_outbox WHERE kind = 'report'")
      .all() as { delivery_part_id: string; payload: string }[];
    const revisionId = new TranscriptRepository(db.handle).current('s1')?.revision_id;
    assert.ok(revisionId);
    const preview = rows.find((row) => row.delivery_part_id === `report-summary:s1:${revisionId}`);
    assert.ok(preview);
    assert.match(preview.payload, /blockquote expandable/);
    const file = rows.find((row) => row.delivery_part_id === `report:s1:${revisionId}`);
    assert.ok(file);
    const payload = JSON.parse(file.payload) as { type: string; path: string; filename: string };
    assert.equal(payload.type, 'document');
    assert.equal(payload.filename, 's1.report.md');
    assert.ok(existsSync(payload.path));
    const report = readFileSync(payload.path, 'utf8');
    assert.match(report, /Источник: фоновая запись OpenMurmur/);
    assert.match(report, /UID сессии: `s1`/);
    assert.match(report, /## Сегменты-источники транскрипта\n/);
    assert.doesNotMatch(report, /Голос 1:/, 'отчёт не должен выдумывать голоса');
  });
});

describe('session completion and retention handoff', () => {
  it('commits the final incoming ACK and monotonic retention clock atomically', () => {
    const fileUid = 'incoming-atomic-clock';
    const oldAck = '2026-08-11T10:00:00.000Z';
    db.handle
      .prepare(
        `INSERT INTO incoming_telegram_files
           (file_uid, telegram_file_id, telegram_unique_id, chat_id, message_id,
            state, created_at, updated_at)
         VALUES (?, 'telegram-file', 'telegram-unique', 42, 1, 'transcribed', ?, ?)`,
      )
      .run(fileUid, oldAck, oldAck);
    db.handle
      .prepare(
        `INSERT INTO transcript_revisions
           (revision_id, incoming_file_id, revision_number, engine, model, languages,
            text, word_count, is_current, created_at)
         VALUES ('incoming-clock-r1', ?, 1, 'fake', 'fake', '[]', 'text', 1, 1, ?)`,
      )
      .run(fileUid, oldAck);

    const outbox = new Outbox(db.handle);
    outbox.enqueue({
      deliveryPartId: `incoming:${fileUid}:1`,
      kind: 'incoming_transcript',
      ordinal: 10,
      payload: { type: 'text', text: 'part 1' },
    });
    outbox.enqueue({
      deliveryPartId: `incoming:${fileUid}:2`,
      kind: 'incoming_transcript',
      ordinal: 10,
      payload: {
        type: 'text',
        text: 'part 2',
        replyMarkup: { inline_keyboard: [] },
      },
    });
    db.handle
      .prepare(
        `UPDATE telegram_outbox
            SET state = 'sent', updated_at = ?
          WHERE delivery_part_id = ?`,
      )
      .run(oldAck, `incoming:${fileUid}:1`);
    const afterPartialAck = db.handle
      .prepare('SELECT state, delivered_at FROM incoming_telegram_files WHERE file_uid = ?')
      .get(fileUid) as { state: string; delivered_at: string | null };
    assert.deepEqual(
      { ...afterPartialAck },
      { state: 'transcribed', delivered_at: null },
      'a partial manifest cannot start retention',
    );
    const finalRow = outbox.claimNext();
    assert.ok(finalRow);
    assert.equal(finalRow.delivery_part_id, `incoming:${fileUid}:2`);

    assert.throws(
      () =>
        outbox.markSent(finalRow.outbox_id, 501, () => {
          reconcileIncomingDelivery(db.handle, fileUid);
          throw new Error('injected failure after incoming delivery proof');
        }),
      /injected failure after incoming delivery proof/,
    );
    const afterFault = db.handle
      .prepare(
        `SELECT i.state, i.delivered_at, o.state AS outbox_state
           FROM incoming_telegram_files i
           JOIN telegram_outbox o ON o.outbox_id = ?
          WHERE i.file_uid = ?`,
      )
      .get(finalRow.outbox_id, fileUid) as {
      state: string;
      delivered_at: string | null;
      outbox_state: string;
    };
    assert.deepEqual(
      { ...afterFault },
      { state: 'transcribed', delivered_at: null, outbox_state: 'sending' },
    );

    outbox.markSent(finalRow.outbox_id, 501, () => {
      reconcileIncomingDelivery(db.handle, fileUid);
    });
    const delivered = db.handle
      .prepare(
        `SELECT i.state, i.delivered_at, o.state AS outbox_state, o.updated_at AS ack_at
           FROM incoming_telegram_files i
           JOIN telegram_outbox o ON o.outbox_id = ?
          WHERE i.file_uid = ?`,
      )
      .get(finalRow.outbox_id, fileUid) as {
      state: string;
      delivered_at: string | null;
      outbox_state: string;
      ack_at: string;
    };
    assert.deepEqual(
      { state: delivered.state, outboxState: delivered.outbox_state },
      { state: 'delivered', outboxState: 'sent' },
      'retrying finalization commits both facts exactly once',
    );
    assert.equal(
      delivered.delivered_at,
      delivered.ack_at,
      'the final Telegram ACK starts the retention clock',
    );

    db.handle
      .prepare("UPDATE telegram_outbox SET updated_at = ? WHERE kind = 'incoming_transcript'")
      .run('2020-01-01T00:00:00.000Z');
    db.handle
      .prepare("UPDATE incoming_telegram_files SET state = 'delivered' WHERE file_uid = ?")
      .run(fileUid);
    const afterOlderReplay = db.handle
      .prepare('SELECT delivered_at FROM incoming_telegram_files WHERE file_uid = ?')
      .get(fileUid) as { delivered_at: string | null };
    assert.equal(afterOlderReplay.delivered_at, delivered.delivered_at);
  });

  it('rolls back the sent audio row when its part delivery fact fails', () => {
    seedFinalizedSession('atomic-audio');
    const part = db.handle
      .prepare('SELECT part_id, path FROM audio_parts WHERE session_id = ?')
      .get('atomic-audio') as { part_id: string; path: string };
    const outbox = new Outbox(db.handle);
    outbox.enqueue({
      deliveryPartId: `audio:${part.part_id}`,
      kind: 'audio',
      sessionId: 'atomic-audio',
      ordinal: 0,
      payload: {
        type: 'document',
        path: part.path,
        filename: 'atomic-audio.p000.flac',
        partId: part.part_id,
      },
    });
    const claimed = outbox.claimNext();
    assert.ok(claimed);

    assert.throws(
      () =>
        outbox.markSent(claimed.outbox_id, 101, () => {
          markAudioDelivered(db.handle, part.part_id);
          throw new Error('injected failure after audio domain update');
        }),
      /injected failure after audio domain update/,
    );
    const afterFault = db.handle
      .prepare(
        `SELECT o.state, p.delivered, p.delivered_at
           FROM telegram_outbox o
           JOIN audio_parts p ON p.part_id = ?
          WHERE o.outbox_id = ?`,
      )
      .get(part.part_id, claimed.outbox_id) as {
      state: string;
      delivered: number;
      delivered_at: string | null;
    };
    assert.deepEqual(
      { ...afterFault },
      { state: 'sending', delivered: 0, delivered_at: null },
      'the Telegram acknowledgement and audio delivery proof are one commit',
    );

    outbox.markSent(claimed.outbox_id, 101, () => {
      markAudioDelivered(db.handle, part.part_id);
    });
    const retried = db.handle
      .prepare(
        `SELECT o.state, p.delivered, p.delivered_at
           FROM telegram_outbox o
           JOIN audio_parts p ON p.part_id = ?
          WHERE o.outbox_id = ?`,
      )
      .get(part.part_id, claimed.outbox_id) as {
      state: string;
      delivered: number;
      delivered_at: string | null;
    };
    assert.equal(retried.state, 'sent');
    assert.equal(retried.delivered, 1);
    assert.notEqual(retried.delivered_at, null);
  });

  it('rolls back final transcript and report acknowledgements with the DONE transition', () => {
    for (const finalKind of ['transcript', 'report'] as const) {
      const sessionId = `atomic-${finalKind}`;
      seedFinalizedSession(sessionId);
      new SessionRepository(db.handle).setState(sessionId, 'DELIVERING');
      const outbox = new Outbox(db.handle);
      for (const kind of ['audio', 'transcript', 'report'] as const) {
        outbox.enqueue({
          deliveryPartId: `${kind}:${sessionId}`,
          kind,
          sessionId,
          ordinal: 0,
          payload: { type: 'text', text: kind },
        });
      }
      db.handle
        .prepare(
          `UPDATE telegram_outbox
              SET state = CASE WHEN kind = ? THEN 'sending' ELSE 'sent' END
            WHERE session_id = ?`,
        )
        .run(finalKind, sessionId);
      const finalRow = db.handle
        .prepare('SELECT outbox_id FROM telegram_outbox WHERE session_id = ? AND kind = ?')
        .get(sessionId, finalKind) as { outbox_id: string };

      assert.throws(
        () =>
          outbox.markSent(finalRow.outbox_id, 202, () => {
            reconcileSessionDelivery(db.handle, sessionId, nullLogger);
            throw new Error(`injected failure after ${finalKind} domain update`);
          }),
        new RegExp(`injected failure after ${finalKind} domain update`),
      );
      assert.equal(outbox.stateOf(`${finalKind}:${sessionId}`), 'sending');
      assert.equal(new SessionRepository(db.handle).get(sessionId)?.state, 'DELIVERING');

      outbox.markSent(finalRow.outbox_id, 202, () => {
        reconcileSessionDelivery(db.handle, sessionId, nullLogger);
      });
      assert.equal(outbox.stateOf(`${finalKind}:${sessionId}`), 'sent');
      assert.equal(new SessionRepository(db.handle).get(sessionId)?.state, 'DONE');
    }
  });

  it('marks a split source delivered only after its last chunk is sent', () => {
    seedFinalizedSession('s1');
    const part = db.handle
      .prepare('SELECT part_id FROM audio_parts WHERE session_id = ?')
      .get('s1') as { part_id: string };
    const outbox = new Outbox(db.handle);
    for (let index = 0; index < 2; index += 1) {
      outbox.enqueue({
        deliveryPartId: `audio:${part.part_id}:split${index}`,
        kind: 'audio',
        sessionId: 's1',
        ordinal: 0,
        payload: {
          type: 'document',
          path: join(dir, `split${index}.flac`),
          filename: `split${index}.flac`,
          partId: part.part_id,
        },
      });
    }

    db.handle
      .prepare(
        "UPDATE telegram_outbox SET state = 'sent', updated_at = ? WHERE delivery_part_id = ?",
      )
      .run('2026-08-11T10:00:00.000Z', `audio:${part.part_id}:split0`);
    markAudioDelivered(db.handle, part.part_id);
    const partiallySent = db.handle
      .prepare('SELECT delivered, delivered_at FROM audio_parts WHERE part_id = ?')
      .get(part.part_id) as { delivered: number; delivered_at: string | null };
    assert.equal(partiallySent.delivered, 0);
    assert.equal(partiallySent.delivered_at, null);

    db.handle
      .prepare(
        "UPDATE telegram_outbox SET state = 'sent', updated_at = ? WHERE delivery_part_id = ?",
      )
      .run('2026-08-11T10:05:00.000Z', `audio:${part.part_id}:split1`);
    markAudioDelivered(db.handle, part.part_id);
    const fullySent = db.handle
      .prepare('SELECT delivered, delivered_at FROM audio_parts WHERE part_id = ?')
      .get(part.part_id) as { delivered: number; delivered_at: string | null };
    assert.equal(fullySent.delivered, 1);
    assert.equal(fullySent.delivered_at, '2026-08-11T10:05:00.000Z');
  });

  it('marks a direct source delivered after its single row is sent', () => {
    seedFinalizedSession('s1');
    const part = db.handle
      .prepare('SELECT part_id, path FROM audio_parts WHERE session_id = ?')
      .get('s1') as { part_id: string; path: string };
    new Outbox(db.handle).enqueue({
      deliveryPartId: `audio:${part.part_id}`,
      kind: 'audio',
      sessionId: 's1',
      ordinal: 0,
      payload: {
        type: 'document',
        path: part.path,
        filename: 's1.p000.flac',
        partId: part.part_id,
      },
    });
    db.handle
      .prepare("UPDATE telegram_outbox SET state = 'sent', updated_at = ?")
      .run('2026-08-11T10:00:00.000Z');

    markAudioDelivered(db.handle, part.part_id);

    const row = db.handle
      .prepare('SELECT delivered, delivered_at FROM audio_parts WHERE part_id = ?')
      .get(part.part_id) as { delivered: number; delivered_at: string | null };
    assert.equal(row.delivered, 1);
    assert.equal(row.delivered_at, '2026-08-11T10:00:00.000Z');
  });

  it('refuses an ambiguous direct-plus-split delivery manifest', () => {
    seedFinalizedSession('s1');
    const part = db.handle
      .prepare('SELECT part_id, path FROM audio_parts WHERE session_id = ?')
      .get('s1') as { part_id: string; path: string };
    const outbox = new Outbox(db.handle);
    for (const deliveryPartId of [`audio:${part.part_id}`, `audio:${part.part_id}:split0`]) {
      outbox.enqueue({
        deliveryPartId,
        kind: 'audio',
        sessionId: 's1',
        ordinal: 0,
        payload: {
          type: 'document',
          path: part.path,
          filename: 's1.p000.flac',
          partId: part.part_id,
        },
      });
    }
    db.handle
      .prepare("UPDATE telegram_outbox SET state = 'sent', updated_at = ?")
      .run('2026-08-11T10:00:00.000Z');

    markAudioDelivered(db.handle, part.part_id);

    const row = db.handle
      .prepare('SELECT delivered, delivered_at FROM audio_parts WHERE part_id = ?')
      .get(part.part_id) as { delivered: number; delivered_at: string | null };
    assert.equal(row.delivered, 0);
    assert.equal(row.delivered_at, null);
  });

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
    db.handle
      .prepare("UPDATE telegram_outbox SET state = 'sent', updated_at = ?")
      .run(new Date().toISOString());
    const part = db.handle
      .prepare('SELECT part_id FROM audio_parts WHERE session_id = ?')
      .get('s1') as { part_id: string };
    markAudioDelivered(db.handle, part.part_id);
    reconcileSessionDelivery(db.handle, 's1', nullLogger);

    // Still inside the 48-hour window.
    assert.equal(planRetention(db.handle, CONFIG.retention).candidates.length, 0);

    // Ending the session long ago is insufficient; age the proven ACK itself.
    db.handle.prepare("UPDATE audio_sessions SET ended_at = '2020-01-01T00:00:00.000Z'").run();
    assert.equal(planRetention(db.handle, CONFIG.retention).candidates.length, 0);
    db.handle.prepare("UPDATE audio_parts SET delivered_at = '2020-01-01T00:00:00.000Z'").run();
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
