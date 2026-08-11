import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { FakeAsr } from '../../src/asr/fake.ts';
import { resolvePaths } from '../../src/config/paths.ts';
import { DEFAULT_CONFIG, type OpenMurmurConfig } from '../../src/config/schema.ts';
import { type Database, migrate, openDatabase } from '../../src/database/db.ts';
import {
  PartRepository,
  SessionRepository,
  TranscriptRepository,
} from '../../src/database/repository.ts';
import { handleJob } from '../../src/jobs/pipeline.ts';
import { type JobKind, JobQueue } from '../../src/jobs/queue.ts';
import { type LlmBackend, OllamaLlm } from '../../src/llm/ollama.ts';
import { EMPTY_SUMMARY, type StructuredSummary } from '../../src/llm/schema.ts';
import { nullLogger } from '../../src/logging/logger.ts';

let dir: string;
let db: Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'om-summary-reliability-'));
  db = openDatabase({ file: join(dir, 'test.db') });
  for (const sub of ['audio', 'tmp', 'transcripts']) mkdirSync(join(dir, sub), { recursive: true });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function seedSession(sessionId: string, transcript: string): string {
  const now = new Date().toISOString();
  const sessions = new SessionRepository(db.handle);
  sessions.create(sessionId, now, { hostName: 'offline-test-mac', timezone: 'UTC' });
  sessions.finalize(sessionId, now, 60_000, 30_000, 1);
  sessions.setLanguages(sessionId, ['en']);

  const audioPath = join(dir, 'audio', `${sessionId}.p000.flac`);
  writeFileSync(audioPath, Buffer.alloc(2_048));
  const parts = new PartRepository(db.handle);
  const partId = parts.open(sessionId, 0, audioPath, now);
  parts.finalizePart(partId, now, 60_000, 2_048, `sha-${sessionId}`);

  new TranscriptRepository(db.handle).append({
    sessionId,
    engine: 'offline-fixture',
    model: 'offline-fixture-1',
    languages: ['en'],
    text: transcript,
    segments: [
      {
        startMs: 0,
        endMs: 60_000,
        timestampSource: 'aligner',
        language: 'en',
        text: transcript,
      },
    ],
  });
  return audioPath;
}

function deps(llm: LlmBackend, config: OpenMurmurConfig = DEFAULT_CONFIG) {
  return {
    db: db.handle,
    config,
    paths: resolvePaths(dir),
    asr: new FakeAsr(),
    llm,
    jobs: new JobQueue(db.handle),
    logger: nullLogger,
  };
}

function job(kind: JobKind, sessionId: string, revisionId?: string) {
  return {
    jobId: `${kind}-${sessionId}`,
    kind,
    payload: { sessionId, ...(revisionId === undefined ? {} : { revisionId }) },
    attempts: 1,
    maxAttempts: 5,
  };
}

function responseSummary(overrides: Partial<StructuredSummary>): string {
  return JSON.stringify({ ...EMPTY_SUMMARY, ...overrides });
}

function storedSummary(sessionId: string): StructuredSummary {
  const row = db.handle
    .prepare('SELECT payload FROM summaries WHERE session_id = ?')
    .get(sessionId) as { payload: string };
  return JSON.parse(row.payload) as StructuredSummary;
}

function reportArtifacts(sessionId: string): string {
  const rows = db.handle
    .prepare("SELECT payload FROM telegram_outbox WHERE session_id = ? AND kind = 'report'")
    .all(sessionId) as { payload: string }[];
  return rows
    .map(({ payload }) => {
      const parsed = JSON.parse(payload) as { type: string; text?: string; path?: string };
      if (parsed.type === 'text') return parsed.text ?? '';
      return parsed.type === 'document' && parsed.path !== undefined
        ? readFileSync(parsed.path, 'utf8')
        : '';
    })
    .join('\n');
}

describe('offline summary reliability', () => {
  it('does not call the LLM or duplicate durable work when a summarize job replays', async () => {
    seedSession('replay', 'The team discussed a release plan and assigned the next action.');
    let calls = 0;
    const llm: LlmBackend = {
      name: 'counting-fixture',
      async ready() {
        return { ok: true, model: 'counting-fixture-1' };
      },
      async summarize() {
        calls += 1;
        return { ...EMPTY_SUMMARY, summary: 'The team discussed a release plan.' };
      },
    };
    const pipeline = deps(llm);

    await handleJob(pipeline, job('summarize', 'replay'));
    await handleJob(pipeline, job('summarize', 'replay'));

    const count = db.handle
      .prepare('SELECT count(*) AS count FROM summaries WHERE session_id = ?')
      .get('replay') as { count: number };
    assert.equal(calls, 1, 'replay must reuse the summary stored for this immutable revision');
    assert.equal(count.count, 1);
    assert.equal(pipeline.jobs.pendingCount('deliver_report'), 1);
  });

  it('keeps summarize and report work bound to revision A across B and replay', async () => {
    seedSession('revision-replay', 'Revision A records the original release decision.');
    const transcripts = new TranscriptRepository(db.handle);
    const revisionA = transcripts.current('revision-replay')?.revision_id;
    assert.ok(revisionA);
    const seenTranscripts: string[] = [];
    const llm: LlmBackend = {
      name: 'revision-fixture',
      async ready() {
        return { ok: true, model: 'revision-fixture-1' };
      },
      async summarize(input) {
        seenTranscripts.push(input.transcript);
        return { ...EMPTY_SUMMARY, summary: `Grounded in ${input.transcript}` };
      },
    };
    const pipeline = deps(llm);

    await handleJob(pipeline, job('asr', 'revision-replay'));
    const queuedA = db.handle
      .prepare("SELECT idempotency_key, payload FROM jobs WHERE kind = 'summarize'")
      .get() as { idempotency_key: string; payload: string };
    assert.equal(queuedA.idempotency_key, `summarize:revision-replay:${revisionA}`);
    assert.deepEqual(JSON.parse(queuedA.payload), {
      sessionId: 'revision-replay',
      revisionId: revisionA,
    });

    const revisionB = transcripts.append({
      sessionId: 'revision-replay',
      engine: 'offline-fixture',
      model: 'offline-fixture-2',
      languages: ['en'],
      text: 'Revision B records the corrected current release decision.',
      segments: [
        {
          startMs: 0,
          endMs: 60_000,
          timestampSource: 'aligner',
          language: 'en',
          text: 'Revision B records the corrected current release decision.',
        },
      ],
    });

    const summarizeA = pipeline.jobs.claim(['summarize']);
    assert.ok(summarizeA);
    await handleJob(pipeline, summarizeA);
    pipeline.jobs.complete(summarizeA);
    const reportA = pipeline.jobs.claim(['deliver_report']);
    assert.ok(reportA);
    await handleJob(pipeline, reportA);
    pipeline.jobs.complete(reportA);
    assert.equal(
      db.handle.prepare("SELECT count(*) AS c FROM telegram_outbox WHERE kind = 'report'").get()?.[
        'c'
      ],
      0,
      'revision A becomes stale before report publication and is skipped',
    );

    await handleJob(pipeline, job('asr', 'revision-replay'));
    const summarizeB = pipeline.jobs.claim(['summarize']);
    assert.ok(summarizeB);
    assert.equal(summarizeB.payload['revisionId'], revisionB);
    await handleJob(pipeline, summarizeB);
    pipeline.jobs.complete(summarizeB);
    await handleJob(pipeline, job('summarize', 'revision-replay', revisionB));

    const reportB = pipeline.jobs.claim(['deliver_report']);
    assert.ok(reportB);
    assert.equal(reportB.payload['revisionId'], revisionB);
    await handleJob(pipeline, reportB);
    pipeline.jobs.complete(reportB);

    assert.deepEqual(seenTranscripts, [
      'Revision A records the original release decision.',
      'Revision B records the corrected current release decision.',
    ]);
    const summaries = db.handle
      .prepare('SELECT revision_id FROM summaries WHERE session_id = ? ORDER BY created_at, rowid')
      .all('revision-replay') as unknown as { revision_id: string }[];
    assert.deepEqual(
      new Set(summaries.map((row) => row.revision_id)),
      new Set([revisionA, revisionB]),
    );
    const report = db.handle
      .prepare("SELECT delivery_part_id, payload FROM telegram_outbox WHERE kind = 'report'")
      .get() as { delivery_part_id: string; payload: string };
    assert.equal(report.delivery_part_id, `report:revision-replay:${revisionB}`);
    assert.match(report.payload, /Revision B records the corrected current release decision/);
    assert.doesNotMatch(report.payload, /Revision A records the original release decision/);
  });

  it('durably binds a legacy summarize payload before the current revision changes', async () => {
    seedSession('legacy-bind', 'Legacy revision A remains the retry source.');
    const transcripts = new TranscriptRepository(db.handle);
    const revisionA = transcripts.current('legacy-bind')?.revision_id;
    assert.ok(revisionA);
    const started = promiseSignal();
    const release = promiseSignal();
    let calls = 0;
    const pipeline = deps({
      name: 'legacy-binding-fixture',
      async ready() {
        return { ok: true, model: 'legacy-binding-fixture-1' };
      },
      async summarize() {
        calls += 1;
        started.resolve();
        await release.promise;
        return { ...EMPTY_SUMMARY, summary: 'Summary for legacy revision A.' };
      },
    });
    pipeline.jobs.enqueue({
      kind: 'summarize',
      idempotencyKey: 'summarize:legacy-bind',
      payload: { sessionId: 'legacy-bind' },
    });
    const legacyJob = pipeline.jobs.claim(['summarize']);
    assert.ok(legacyJob);
    const handling = handleJob(pipeline, legacyJob);
    await started.promise;

    const durablePayload = db.handle
      .prepare('SELECT payload FROM jobs WHERE job_id = ?')
      .get(legacyJob.jobId) as { payload: string };
    assert.equal(JSON.parse(durablePayload.payload).revisionId, revisionA);
    transcripts.append({
      sessionId: 'legacy-bind',
      engine: 'offline-fixture',
      model: 'offline-fixture-2',
      languages: ['en'],
      text: 'Revision B must not become the source of the reclaimed legacy job.',
      segments: [],
    });
    release.resolve();
    await handling;
    await handleJob(pipeline, legacyJob);

    const stored = db.handle
      .prepare('SELECT revision_id FROM summaries WHERE session_id = ?')
      .get('legacy-bind') as { revision_id: string };
    assert.equal(stored.revision_id, revisionA);
    assert.equal(calls, 1, 'replay reuses the summary for the durably bound revision');
  });

  it('does not let a reclaimed generation bind or summarize a legacy payload', async () => {
    seedSession('legacy-fenced', 'Only the current lease may bind this legacy summary job.');
    let calls = 0;
    const pipeline = deps({
      name: 'lease-fence-fixture',
      async ready() {
        return { ok: true, model: 'lease-fence-fixture-1' };
      },
      async summarize() {
        calls += 1;
        return { ...EMPTY_SUMMARY, summary: 'Current generation summary.' };
      },
    });
    pipeline.jobs.enqueue({
      kind: 'summarize',
      idempotencyKey: 'summarize:legacy-fenced',
      payload: { sessionId: 'legacy-fenced' },
    });
    const stale = pipeline.jobs.claim(['summarize']);
    assert.ok(stale);
    db.handle
      .prepare("UPDATE jobs SET lease_expires_at = '2000-01-01T00:00:00.000Z' WHERE job_id = ?")
      .run(stale.jobId);
    assert.equal(pipeline.jobs.recoverStaleLeases(), 1);
    const current = pipeline.jobs.claim(['summarize']);
    assert.ok(current);

    await assert.rejects(handleJob(pipeline, stale), /lost its lease before the handler completed/);
    const stalePayload = db.handle
      .prepare('SELECT payload FROM jobs WHERE job_id = ?')
      .get(stale.jobId) as { payload: string };
    assert.equal(JSON.parse(stalePayload.payload).revisionId, undefined);
    assert.equal(calls, 0);
    assert.equal(pipeline.jobs.pendingCount('deliver_report'), 0);

    await handleJob(pipeline, current);
    assert.equal(pipeline.jobs.complete(current), true);
    assert.equal(calls, 1);
    assert.equal(pipeline.jobs.pendingCount('deliver_report'), 1);
  });

  it('commits one summary when reclaimed workers finish the same revision concurrently', async () => {
    seedSession('concurrent', 'Both workers summarize this exact immutable revision.');
    const revisionId = new TranscriptRepository(db.handle).current('concurrent')?.revision_id;
    assert.ok(revisionId);
    const bothStarted = promiseSignal();
    const release = promiseSignal();
    let calls = 0;
    const pipeline = deps({
      name: 'concurrent-fixture',
      async ready() {
        return { ok: true, model: 'concurrent-fixture-1' };
      },
      async summarize() {
        calls += 1;
        if (calls === 2) bothStarted.resolve();
        await release.promise;
        return { ...EMPTY_SUMMARY, summary: 'One durable summary wins.' };
      },
    });

    const first = handleJob(pipeline, {
      ...job('summarize', 'concurrent', revisionId),
      jobId: 'concurrent-first',
    });
    const reclaimed = handleJob(pipeline, {
      ...job('summarize', 'concurrent', revisionId),
      jobId: 'concurrent-reclaimed',
    });
    await bothStarted.promise;
    release.resolve();
    await Promise.all([first, reclaimed]);

    const summaryCount = db.handle
      .prepare('SELECT count(*) AS c FROM summaries WHERE revision_id = ?')
      .get(revisionId) as { c: number };
    assert.equal(calls, 2, 'both reclaimed workers reached the model before either committed');
    assert.equal(summaryCount.c, 1, 'the database accepts one summary per immutable revision');
    assert.equal(pipeline.jobs.pendingCount('deliver_report'), 1);
  });

  it('archives ambiguous pre-012 duplicates before enforcing revision uniqueness', () => {
    const legacy = new DatabaseSync(join(dir, 'pre-012.db'));
    try {
      legacy.exec(`
        CREATE TABLE schema_migrations (
          name TEXT PRIMARY KEY,
          applied_at TEXT NOT NULL
        ) STRICT
      `);
      for (const name of [
        '001_initial.sql',
        '002_speaker_diarization.sql',
        '003_output_provenance.sql',
        '004_telegram_bot_scope.sql',
        '005_asr_preferences.sql',
        '006_alert_fingerprints.sql',
        '007_audio_delivery_time.sql',
        '008_daemon_heartbeat.sql',
        '009_incoming_delivery_time.sql',
        '010_audio_delivery_reconciliation.sql',
        '011_telegram_delivery_reconciliation.sql',
      ]) {
        legacy.exec(
          readFileSync(new URL(`../../src/database/migrations/${name}`, import.meta.url), 'utf8'),
        );
        legacy
          .prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)')
          .run(name, '2026-08-11T00:00:00.000Z');
      }

      new SessionRepository(legacy).create('legacy-duplicates', '2026-08-11T00:00:00.000Z');
      const revisionId = new TranscriptRepository(legacy).append({
        sessionId: 'legacy-duplicates',
        engine: 'legacy',
        model: 'legacy-1',
        languages: ['en'],
        text: 'A legacy database contains duplicate summary rows.',
        segments: [],
      });
      const insertSummary = legacy.prepare(
        `INSERT INTO summaries
           (summary_id, session_id, revision_id, engine, model, payload, created_at)
         VALUES (?, 'legacy-duplicates', ?, 'legacy', 'legacy-1', ?, ?)`,
      );
      insertSummary.run(
        'summary-first',
        revisionId,
        JSON.stringify({ ...EMPTY_SUMMARY, summary: 'First committed result.' }),
        '2026-08-11T00:00:00.000Z',
      );
      insertSummary.run(
        'summary-second',
        revisionId,
        JSON.stringify({ ...EMPTY_SUMMARY, summary: 'Conflicting later result.' }),
        '2026-08-11T00:00:01.000Z',
      );

      assert.deepEqual(migrate(legacy), [
        '012_summary_revision_uniqueness.sql',
        '013_audio_finalization_journal.sql',
        '014_current_transcript_uniqueness.sql',
        '015_telegram_outbox_claim_generation.sql',
        '016_transcript_timestamp_provenance.sql',
        '017_daemon_ownership.sql',
      ]);
      const live = legacy
        .prepare('SELECT summary_id FROM summaries WHERE revision_id = ?')
        .all(revisionId) as unknown as { summary_id: string }[];
      const archived = legacy
        .prepare(
          'SELECT summary_id, archive_reason FROM summary_revision_conflicts WHERE revision_id = ?',
        )
        .all(revisionId) as unknown as { summary_id: string; archive_reason: string }[];
      assert.deepEqual(
        live.map((row) => ({ ...row })),
        [{ summary_id: 'summary-first' }],
      );
      assert.deepEqual(
        archived.map((row) => ({ ...row })),
        [
          {
            summary_id: 'summary-second',
            archive_reason: 'duplicate_revision_before_012',
          },
        ],
      );
      assert.throws(
        () =>
          legacy
            .prepare(
              `INSERT INTO summaries
                 (summary_id, session_id, revision_id, engine, model, payload, created_at)
               VALUES ('summary-third', ?, ?, 'legacy', 'legacy-1', '{}', ?)`,
            )
            .run('legacy-duplicates', revisionId, '2026-08-11T00:00:02.000Z'),
        /UNIQUE constraint failed: summaries\.revision_id/,
      );
    } finally {
      legacy.close();
    }
  });

  for (const scenario of [
    {
      id: 'malformed',
      transcript: 'The team discussed the release plan and assigned the next action.',
      content: () => '{',
      expectedNotice: /malformed JSON chunk response/i,
      expectedPartial: null,
    },
    {
      id: 'schema-invalid',
      transcript: 'The team discussed the release plan and assigned the next action.',
      content: () => '{}',
      expectedNotice: /schema-invalid chunk response/i,
      expectedPartial: null,
    },
    {
      id: 'partial',
      transcript: 'The team discussed the release plan and assigned the next action. '.repeat(40),
      content: (call: number) =>
        call === 1 ? responseSummary({ summary: 'The team discussed the release plan.' }) : '{',
      expectedNotice: /malformed JSON chunk response/i,
      expectedPartial: 'The team discussed the release plan.',
    },
  ] as const) {
    it(`keeps audio, transcript and report delivery after ${scenario.id} Ollama output`, async () => {
      const sessionId = `output-${scenario.id}`;
      const audioPath = seedSession(sessionId, scenario.transcript);
      let calls = 0;
      const config = {
        ...DEFAULT_CONFIG,
        llm: { ...DEFAULT_CONFIG.llm, contextTokens: 8_192 },
      };
      const llm = new OllamaLlm(config.llm, async () => {
        calls += 1;
        return Response.json({ message: { content: scenario.content(calls) } });
      });
      const pipeline = deps(llm, config);

      await handleJob(pipeline, job('deliver_audio', sessionId));
      await handleJob(pipeline, job('deliver_transcript', sessionId));
      await handleJob(pipeline, job('summarize', sessionId));
      await handleJob(pipeline, job('deliver_report', sessionId));

      const summary = storedSummary(sessionId);
      assert.match(summary.uncertainties.at(-1) ?? '', scenario.expectedNotice);
      assert.match(summary.uncertainties.at(-1) ?? '', /complete transcript remains available/i);
      if (scenario.expectedPartial !== null) {
        assert.ok(calls > 1, 'partial output requires a later rejected chunk');
        assert.equal(summary.summary, scenario.expectedPartial);
      }

      assert.equal(existsSync(audioPath), true, 'the source FLAC remains durable');
      assert.equal(
        new TranscriptRepository(db.handle).current(sessionId)?.text,
        scenario.transcript,
        'the complete transcript remains durable',
      );
      const outbox = db.handle
        .prepare('SELECT kind, state FROM telegram_outbox WHERE session_id = ? ORDER BY ordinal')
        .all(sessionId) as { kind: string; state: string }[];
      assert.deepEqual(
        new Set(outbox.map((row) => row.kind)),
        new Set(['audio', 'transcript', 'report']),
      );
      assert.ok(outbox.every((row) => row.state === 'pending'));
      assert.match(reportArtifacts(sessionId), scenario.expectedNotice);
    });
  }
});

function promiseSignal(): {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
} {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
