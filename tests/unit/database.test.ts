import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { AsrPreferenceRepository, effectiveAsrLanguage } from '../../src/asr/preferences.ts';
import {
  compareVersions,
  type Database,
  migrate,
  openDatabase,
  transaction,
} from '../../src/database/db.ts';
import {
  countWords,
  IncomingFileRepository,
  SessionRepository,
  TranscriptRepository,
} from '../../src/database/repository.ts';
import { backoffMs, JobQueue } from '../../src/jobs/queue.ts';
import { Outbox } from '../../src/telegram/outbox.ts';

let dir: string;
let db: Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'om-db-'));
  db = openDatabase({ file: join(dir, 'test.db') });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('migrations', () => {
  it('creates every table the pipeline needs', () => {
    const tables = new Set(
      (
        db.handle.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as {
          name: string;
        }[]
      ).map((r) => r.name),
    );

    for (const table of [
      'audio_sessions',
      'audio_parts',
      'vad_segments',
      'transcript_revisions',
      'transcript_segments',
      'jobs',
      'summaries',
      'health_events',
      'alert_state',
      'telegram_updates',
      'telegram_outbox',
      'incoming_telegram_files',
      'asr_preferences',
      'schema_migrations',
    ]) {
      assert.ok(tables.has(table), `missing table ${table}`);
    }
  });

  it('is idempotent: re-running applies nothing and loses nothing', () => {
    new SessionRepository(db.handle).create('s1', new Date().toISOString());

    assert.deepEqual(migrate(db.handle), [], 'second run must apply no migrations');
    assert.deepEqual(migrate(db.handle), []);
    assert.ok(new SessionRepository(db.handle).get('s1'), 'existing data survives');
  });

  it('records what it applied', () => {
    const applied = db.handle.prepare('SELECT name FROM schema_migrations').all() as {
      name: string;
    }[];
    assert.ok(applied.length >= 1);
    assert.ok(applied.every((row) => row.name.endsWith('.sql')));
  });

  it('turns on WAL and foreign keys', () => {
    const journal = db.handle.prepare('PRAGMA journal_mode').get() as { journal_mode: string };
    const fk = db.handle.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number };
    assert.equal(journal.journal_mode, 'wal');
    assert.equal(fk.foreign_keys, 1);
  });

  it('enforces foreign keys', () => {
    assert.throws(
      () =>
        db.handle
          .prepare(
            `INSERT INTO audio_parts (part_id, session_id, part_index, path, started_at, created_at)
             VALUES ('p1','does-not-exist',0,'/tmp/a.flac','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')`,
          )
          .run(),
      /FOREIGN KEY/i,
    );
  });

  it('has FTS5 with the trigram tokenizer available', () => {
    assert.doesNotThrow(() => db.handle.prepare('SELECT count(*) FROM transcript_fts').get());
  });

  it('adds durable live and incoming provenance columns', () => {
    const sessionColumns = new Set(
      (db.handle.prepare('PRAGMA table_info(audio_sessions)').all() as { name: string }[]).map(
        (row) => row.name,
      ),
    );
    const incomingColumns = new Set(
      (
        db.handle.prepare('PRAGMA table_info(incoming_telegram_files)').all() as { name: string }[]
      ).map((row) => row.name),
    );
    assert.ok(sessionColumns.has('capture_host'));
    assert.ok(sessionColumns.has('capture_timezone'));
    const alertColumns = new Set(
      (db.handle.prepare('PRAGMA table_info(alert_state)').all() as { name: string }[]).map(
        (row) => row.name,
      ),
    );
    assert.ok(alertColumns.has('fingerprint'));
    for (const column of [
      'bot_scope',
      'update_id',
      'telegram_source',
      'attachment_type',
      'claimed_filename',
      'telegram_message_at',
      'original_sent_at',
      'daemon_host',
    ]) {
      assert.ok(incomingColumns.has(column), `missing provenance column ${column}`);
    }
    const updatePrimaryKey = db.handle.prepare('PRAGMA table_info(telegram_updates)').all() as {
      name: string;
      pk: number;
    }[];
    assert.deepEqual(
      updatePrimaryKey
        .filter((column) => column.pk > 0)
        .sort((a, b) => a.pk - b.pk)
        .map((column) => column.name),
      ['bot_scope', 'update_id'],
    );
  });

  it('upgrades a 005 database without replaying the legacy dead-job backlog alert', () => {
    const legacyPath = join(dir, 'legacy-005.db');
    const legacy = new DatabaseSync(legacyPath);
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
    ]) {
      legacy.exec(
        readFileSync(new URL(`../../src/database/migrations/${name}`, import.meta.url), 'utf8'),
      );
      legacy
        .prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)')
        .run(name, '2026-08-09T00:00:00.000Z');
    }
    legacy
      .prepare(
        `INSERT INTO alert_state
           (alert_id, active, last_sent_at, last_changed_at, occurrences)
         VALUES ('asr_backlog', 1, ?, ?, 8)`,
      )
      .run('2026-08-10T10:00:00.000Z', '2026-08-10T10:00:00.000Z');
    legacy
      .prepare(
        `INSERT INTO telegram_outbox
           (outbox_id, delivery_part_id, kind, ordinal, payload, state, run_after,
            created_at, updated_at)
         VALUES ('old-alert', 'alert:asr_backlog:raise:1', 'alert', 5, '{}', 'pending', ?, ?, ?)`,
      )
      .run('2026-08-10T10:00:00.000Z', '2026-08-10T10:00:00.000Z', '2026-08-10T10:00:00.000Z');
    legacy.close();

    const upgraded = openDatabase({ file: legacyPath });
    try {
      const alert = upgraded.handle
        .prepare("SELECT active, fingerprint FROM alert_state WHERE alert_id = 'asr_backlog'")
        .get() as { active: number; fingerprint: string | null };
      const outbox = upgraded.handle
        .prepare("SELECT state, last_error FROM telegram_outbox WHERE outbox_id = 'old-alert'")
        .get() as { state: string; last_error: string | null };
      assert.equal(alert?.active, 0);
      assert.equal(alert?.fingerprint, null);
      assert.equal(outbox.state, 'failed');
      assert.match(outbox.last_error ?? '', /dedicated dead-job diagnostics/);
    } finally {
      upgraded.close();
    }
  });
});

describe('output provenance persistence', () => {
  it('persists the original capture host and timezone with a live session', () => {
    const sessions = new SessionRepository(db.handle);
    sessions.create('live-1', '2026-08-09T10:00:00.000Z', {
      hostName: 'studio-mac',
      timezone: 'Europe/Moscow',
    });
    const row = sessions.get('live-1');
    assert.equal(row?.capture_host, 'studio-mac');
    assert.equal(row?.capture_timezone, 'Europe/Moscow');
  });

  it('claims one stable incoming UID with distinct forwarded and Telegram dates', () => {
    const incoming = new IncomingFileRepository(db.handle);
    const first = incoming.claim({
      telegramFileId: 'file-id',
      telegramUniqueId: 'telegram-unique',
      chatId: 42,
      messageId: 10,
      updateId: 99,
      telegramSource: 'forwarded',
      attachmentType: 'document',
      claimedFilename: '<unsafe>.mp3',
      telegramMessageAt: '2026-08-09T12:00:00.000Z',
      originalSentAt: '2026-08-08T08:00:00.000Z',
      daemonHost: 'studio-mac',
      declaredBytes: 12,
      declaredMime: 'audio/mpeg',
    });
    const replay = incoming.claim({
      telegramFileId: 'new-file-id',
      telegramUniqueId: 'telegram-unique',
      chatId: 42,
      messageId: 11,
      updateId: 100,
      telegramSource: 'direct',
      attachmentType: 'audio',
      claimedFilename: 'replacement.mp3',
      telegramMessageAt: '2026-08-10T12:00:00.000Z',
      originalSentAt: null,
      daemonHost: 'other-host',
      declaredBytes: null,
      declaredMime: null,
    });

    assert.equal(replay.fileUid, first.fileUid);
    assert.equal(replay.updateId, 99, 'a resend must not rewrite the original request identity');
    assert.equal(replay.telegramSource, 'forwarded');
    assert.equal(replay.originalSentAt, '2026-08-08T08:00:00.000Z');
    assert.equal(replay.telegramMessageAt, '2026-08-09T12:00:00.000Z');
    assert.equal(replay.claimedFilename, '<unsafe>.mp3');
  });
});

describe('ASR language preference', () => {
  it('distinguishes config fallback, explicit auto and a forced language', () => {
    const preferences = new AsrPreferenceRepository(db.handle);
    assert.equal(effectiveAsrLanguage(db.handle, ['Thai']), 'Thai');

    preferences.set(null);
    assert.equal(effectiveAsrLanguage(db.handle, ['Thai']), null, 'explicit auto overrides config');

    preferences.set('ru');
    assert.equal(effectiveAsrLanguage(db.handle, []), 'Russian');
  });
});

describe('version comparison', () => {
  it('orders versions numerically, not lexically', () => {
    assert.equal(compareVersions('3.53.4', '3.53.4'), 0);
    assert.equal(compareVersions('3.53.3', '3.53.4'), -1);
    assert.equal(compareVersions('3.9.0', '3.10.0'), -1, '9 < 10 numerically');
    assert.equal(compareVersions('3.54', '3.53.9'), 1);
  });
});

describe('transactions', () => {
  it('rolls back everything on failure', () => {
    const sessions = new SessionRepository(db.handle);
    assert.throws(() =>
      transaction(db.handle, () => {
        sessions.create('s-rollback', new Date().toISOString());
        throw new Error('boom');
      }),
    );
    assert.equal(sessions.get('s-rollback'), undefined);
  });

  it('commits on success', () => {
    const sessions = new SessionRepository(db.handle);
    transaction(db.handle, () => sessions.create('s-commit', new Date().toISOString()));
    assert.ok(sessions.get('s-commit'));
  });
});

describe('immutable transcript revisions', () => {
  it('appends rather than overwrites, and moves the current pointer', () => {
    const sessions = new SessionRepository(db.handle);
    const transcripts = new TranscriptRepository(db.handle);
    sessions.create('s1', new Date().toISOString());

    transcripts.append({
      sessionId: 's1',
      engine: 'e',
      model: 'v1',
      languages: ['ru'],
      text: 'первый вариант',
      segments: [],
    });
    transcripts.append({
      sessionId: 's1',
      engine: 'e',
      model: 'v2',
      languages: ['ru'],
      text: 'второй вариант',
      segments: [],
    });

    const rows = db.handle
      .prepare(
        'SELECT revision_number, text, is_current FROM transcript_revisions WHERE session_id = ? ORDER BY revision_number',
      )
      .all('s1') as { revision_number: number; text: string; is_current: number }[];

    assert.equal(rows.length, 2, 'the old revision is kept, not replaced');
    assert.equal(rows[0]?.is_current, 0);
    assert.equal(rows[1]?.is_current, 1);
    assert.equal(rows[0]?.text, 'первый вариант', 'a re-run must not destroy the original');
    assert.equal(transcripts.current('s1')?.text, 'второй вариант');
  });

  it('stores segments with their timestamp provenance', () => {
    const sessions = new SessionRepository(db.handle);
    const transcripts = new TranscriptRepository(db.handle);
    sessions.create('s1', new Date().toISOString());

    const revisionId = transcripts.append({
      sessionId: 's1',
      engine: 'e',
      model: 'm',
      languages: ['ru', 'th'],
      text: 'привет สวัสดี',
      segments: [
        { startMs: 0, endMs: 1000, timestampSource: 'aligner', language: 'ru', text: 'привет' },
        { startMs: 1000, endMs: 2000, timestampSource: 'vad', language: 'th', text: 'สวัสดี' },
      ],
    });

    const segments = transcripts.segments(revisionId);
    assert.equal(segments[0]?.timestampSource, 'aligner');
    assert.equal(segments[1]?.timestampSource, 'vad', 'Thai never claims aligner timings');
  });

  it('rolls back the revision when an atomic downstream fact fails', () => {
    const sessions = new SessionRepository(db.handle);
    const transcripts = new TranscriptRepository(db.handle);
    sessions.create('s1', new Date().toISOString());

    assert.throws(
      () =>
        transcripts.append(
          {
            sessionId: 's1',
            engine: 'e',
            model: 'm',
            languages: ['ru'],
            text: 'атомарный транскрипт',
            segments: [
              {
                startMs: 0,
                endMs: 1000,
                timestampSource: 'aligner',
                language: 'ru',
                text: 'атомарный',
              },
            ],
          },
          () => {
            throw new Error('downstream insert failed');
          },
        ),
      /downstream insert failed/,
    );
    assert.equal(transcripts.current('s1'), undefined);
    const rows = db.handle.prepare('SELECT count(*) AS c FROM transcript_segments').get() as {
      c: number;
    };
    assert.equal(rows.c, 0, 'segments roll back with their revision');
  });

  it('refuses a transcript that belongs to nothing', () => {
    assert.throws(
      () =>
        new TranscriptRepository(db.handle).append({
          engine: 'e',
          model: 'm',
          languages: [],
          text: 'x',
          segments: [],
        }),
      /must belong to/,
    );
  });
});

describe('word counting', () => {
  it('counts space-separated words', () => {
    assert.equal(countWords('one two three'), 3);
    assert.equal(countWords('  padded   words  '), 2);
    assert.equal(countWords(''), 0);
  });

  it('approximates Thai, which is written without spaces', () => {
    // A pure character count would make the 5-word gate reject all Thai.
    assert.ok(countWords('สวัสดีครับผมชื่อสมชาย') >= 5);
    assert.equal(countWords('สวัสดี'), 1);
  });

  it('handles mixed scripts', () => {
    assert.ok(countWords('hello สวัสดีครับผมชื่อ world') >= 3);
  });
});

describe('job queue', () => {
  it('is idempotent on the natural key', () => {
    const jobs = new JobQueue(db.handle);
    assert.ok(
      jobs.enqueue({ kind: 'asr', idempotencyKey: 'asr:s1', payload: { sessionId: 's1' } }),
    );
    assert.equal(
      jobs.enqueue({ kind: 'asr', idempotencyKey: 'asr:s1', payload: { sessionId: 's1' } }),
      null,
      'the same unit of work must not be queued twice',
    );
    assert.equal(jobs.pendingCount('asr'), 1);
  });

  it('claims a job exactly once', () => {
    const jobs = new JobQueue(db.handle);
    jobs.enqueue({ kind: 'asr', idempotencyKey: 'asr:s1', payload: {} });

    assert.ok(jobs.claim(['asr']));
    assert.equal(jobs.claim(['asr']), null, 'a leased job must not be claimable again');
  });

  it('only claims the kinds asked for', () => {
    const jobs = new JobQueue(db.handle);
    jobs.enqueue({ kind: 'summarize', idempotencyKey: 'sum:s1', payload: {} });
    assert.equal(jobs.claim(['asr']), null);
    assert.ok(jobs.claim(['summarize']));
  });

  it('prepares audio delivery before starting the slower ASR job', () => {
    const jobs = new JobQueue(db.handle);
    jobs.enqueue({ kind: 'asr', idempotencyKey: 'asr:s1', payload: { sessionId: 's1' } });
    jobs.enqueue({
      kind: 'deliver_audio',
      idempotencyKey: 'deliver-audio:s1',
      payload: { sessionId: 's1' },
    });

    assert.equal(jobs.claim(['asr', 'deliver_audio'])?.kind, 'deliver_audio');
  });

  it('recovers a lease abandoned by a crashed worker', () => {
    const jobs = new JobQueue(db.handle, 'worker-that-died');
    jobs.enqueue({ kind: 'asr', idempotencyKey: 'asr:s1', payload: {} });

    const claimed = jobs.claim(['asr'], 50);
    assert.ok(claimed);
    assert.equal(jobs.claim(['asr']), null);

    // Expire the lease the way the passage of time would.
    db.handle
      .prepare("UPDATE jobs SET lease_expires_at = '2000-01-01T00:00:00.000Z' WHERE job_id = ?")
      .run(claimed.jobId);

    assert.equal(jobs.recoverStaleLeases(), 1);
    const reclaimed = jobs.claim(['asr']);
    assert.ok(reclaimed, 'the job returns to the pool rather than being lost');
    assert.equal(reclaimed.jobId, claimed.jobId);
    assert.equal(reclaimed.attempts, 2, 'the attempt counter carries across the crash');
  });

  it('does not steal a lease that is still valid', () => {
    const jobs = new JobQueue(db.handle);
    jobs.enqueue({ kind: 'asr', idempotencyKey: 'asr:s1', payload: {} });
    jobs.claim(['asr'], 600_000);
    assert.equal(jobs.recoverStaleLeases(), 0);
  });

  it('retries with backoff, then gives up loudly', () => {
    const jobs = new JobQueue(db.handle);
    jobs.enqueue({ kind: 'asr', idempotencyKey: 'asr:s1', payload: {}, maxAttempts: 2 });

    const first = jobs.claim(['asr']);
    assert.ok(first);
    assert.equal(jobs.fail(first.jobId, 'model unavailable'), 'retry');

    db.handle.prepare("UPDATE jobs SET run_after = '2000-01-01T00:00:00.000Z'").run();
    const second = jobs.claim(['asr']);
    assert.ok(second);
    assert.equal(jobs.fail(second.jobId, 'model unavailable again'), 'dead');

    const row = db.handle.prepare('SELECT state, last_error FROM jobs').get() as {
      state: string;
      last_error: string;
    };
    assert.equal(row.state, 'dead', 'an exhausted job stays visible, not silently dropped');
    assert.match(row.last_error, /model unavailable again/);
  });

  it('lists exhausted work with its cause and explicitly re-queues it', () => {
    const jobs = new JobQueue(db.handle);
    jobs.enqueue({
      kind: 'summarize',
      idempotencyKey: 'summarize:s1',
      payload: { sessionId: 's1' },
      maxAttempts: 1,
    });
    const claimed = jobs.claim(['summarize']);
    assert.ok(claimed);
    assert.equal(jobs.fail(claimed.jobId, 'Ollama is not reachable'), 'dead');

    assert.deepEqual(jobs.deadJobs(), [
      {
        jobId: claimed.jobId,
        kind: 'summarize',
        idempotencyKey: 'summarize:s1',
        attempts: 1,
        maxAttempts: 1,
        updatedAt: jobs.deadJobs()[0]?.updatedAt,
        lastError: 'Ollama is not reachable',
      },
    ]);
    assert.equal(jobs.retryDead(claimed.jobId), 'requeued');
    assert.equal(jobs.deadCount(), 0);
    assert.equal(
      jobs.claim(['summarize'])?.attempts,
      1,
      'manual retry starts a fresh attempt budget',
    );
    assert.equal(jobs.retryDead('missing'), 'not_found');
  });

  it('revives an ASR session and retires its stale failure notice with the job', () => {
    const sessions = new SessionRepository(db.handle);
    sessions.create('s1', new Date().toISOString());
    db.handle
      .prepare(
        "UPDATE audio_sessions SET state = 'FAILED', rejection_reason = 'asr_failed' WHERE session_id = 's1'",
      )
      .run();
    const outbox = new Outbox(db.handle);
    outbox.enqueue({
      deliveryPartId: 'session-status:asr-failed:s1',
      kind: 'status',
      sessionId: 's1',
      ordinal: 1,
      payload: { type: 'text', text: 'failed' },
    });
    const jobs = new JobQueue(db.handle);
    jobs.enqueue({
      kind: 'asr',
      idempotencyKey: 'asr:s1',
      payload: { sessionId: 's1' },
      maxAttempts: 1,
    });
    const claimed = jobs.claim(['asr']);
    assert.ok(claimed);
    jobs.fail(claimed.jobId, 'model missing');

    assert.equal(jobs.retryDead(claimed.jobId), 'requeued');
    const session = sessions.get('s1');
    assert.equal(session?.state, 'PROCESSING');
    assert.equal(session?.rejection_reason, null);
    assert.equal(outbox.stateOf('session-status:asr-failed:s1'), 'failed');
  });

  it('refuses to re-queue a legacy kind that no daemon worker can claim', () => {
    const jobs = new JobQueue(db.handle);
    jobs.enqueue({ kind: 'retention', idempotencyKey: 'retention:legacy', payload: {} });
    const claimed = jobs.claim(['retention']);
    assert.ok(claimed);
    db.handle.prepare("UPDATE jobs SET state = 'dead' WHERE job_id = ?").run(claimed.jobId);

    assert.equal(jobs.retryDead(claimed.jobId), 'unsupported');
    assert.equal(jobs.deadCount(), 1);
  });

  it('grows the backoff and caps it', () => {
    assert.ok(backoffMs(1) < backoffMs(3));
    assert.ok(backoffMs(3) < backoffMs(5));
    assert.equal(backoffMs(100), 15 * 60 * 1000);
  });

  it('does not claim a job scheduled for the future', () => {
    const jobs = new JobQueue(db.handle);
    jobs.enqueue({ kind: 'asr', idempotencyKey: 'asr:s1', payload: {}, runAfterMs: 60_000 });
    assert.equal(jobs.claim(['asr']), null);
  });

  it('reports backlog age', () => {
    const jobs = new JobQueue(db.handle);
    jobs.enqueue({ kind: 'asr', idempotencyKey: 'asr:s1', payload: {} });
    db.handle.prepare("UPDATE jobs SET created_at = '2000-01-01T00:00:00.000Z'").run();
    assert.ok(jobs.oldestPendingAgeMinutes('asr') > 1000);
  });

  it('reports zero backlog when the queue is empty', () => {
    assert.equal(new JobQueue(db.handle).oldestPendingAgeMinutes(), 0);
  });
});
