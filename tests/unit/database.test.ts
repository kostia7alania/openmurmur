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
  AudioFinalizationJournalRepository,
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
      'audio_delivery_reconciliation_audit',
      'telegram_delivery_reconciliation_audit',
      'audio_finalization_journal',
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

  it('backfills delivery clocks only from exact, fully sent legacy manifests', () => {
    const legacy = new DatabaseSync(join(dir, 'legacy.db'));
    try {
      legacy.exec(`
        CREATE TABLE schema_migrations (
          name TEXT PRIMARY KEY,
          applied_at TEXT NOT NULL
        ) STRICT;
        CREATE TABLE audio_parts (
          part_id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          ended_at TEXT,
          duration_ms INTEGER,
          bytes INTEGER,
          sha256 TEXT,
          finalized INTEGER NOT NULL DEFAULT 0,
          delivered INTEGER NOT NULL,
          deleted_at TEXT
        ) STRICT;
        CREATE TABLE audio_sessions (
          session_id TEXT PRIMARY KEY,
          state TEXT NOT NULL DEFAULT 'DONE',
          ended_at TEXT,
          duration_ms INTEGER,
          rejection_reason TEXT
        ) STRICT;
        CREATE TABLE telegram_outbox (
          outbox_id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
          delivery_part_id TEXT NOT NULL UNIQUE,
          session_id TEXT,
          kind TEXT NOT NULL,
          payload TEXT NOT NULL DEFAULT '{}',
          state TEXT NOT NULL,
          last_error TEXT,
          updated_at TEXT NOT NULL
        ) STRICT;
        CREATE TABLE incoming_telegram_files (
          file_uid TEXT PRIMARY KEY,
          state TEXT NOT NULL,
          deleted_at TEXT
        ) STRICT;
        CREATE TABLE transcript_revisions (
          revision_id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
          session_id TEXT,
          incoming_file_id TEXT,
          revision_number INTEGER NOT NULL DEFAULT 1,
          is_current INTEGER NOT NULL
        ) STRICT;
        CREATE TABLE summaries (
          summary_id TEXT PRIMARY KEY,
          session_id TEXT,
          incoming_file_id TEXT,
          revision_id TEXT NOT NULL,
          engine TEXT NOT NULL,
          model TEXT NOT NULL,
          payload TEXT NOT NULL,
          created_at TEXT NOT NULL
        ) STRICT;
        CREATE TABLE alert_state (
          alert_id TEXT PRIMARY KEY,
          active INTEGER NOT NULL DEFAULT 0 CHECK (active IN (0, 1)),
          last_sent_at TEXT,
          last_changed_at TEXT,
          occurrences INTEGER NOT NULL DEFAULT 0
        ) STRICT;
      `);
      const applied = legacy.prepare(
        'INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)',
      );
      for (const name of [
        '001_initial.sql',
        '002_speaker_diarization.sql',
        '003_output_provenance.sql',
        '004_telegram_bot_scope.sql',
        '005_asr_preferences.sql',
      ]) {
        applied.run(name, '2026-08-01T00:00:00.000Z');
      }

      const addPart = legacy.prepare(
        'INSERT INTO audio_parts (part_id, session_id, delivered) VALUES (?, ?, ?)',
      );
      for (const [partId, sessionId, delivered] of [
        ['direct', 's-direct', 1],
        ['split', 's-split', 1],
        ['absent', 's-absent', 1],
        ['pending', 's-pending', 1],
        ['ambiguous', 's-ambiguous', 1],
        ['gapped', 's-gapped', 1],
        ['noncanonical', 's-noncanonical', 1],
        ['wrong-session', 's-right', 1],
        ['unconfirmed-domain', 's-domain', 0],
      ] as const) {
        addPart.run(partId, sessionId, delivered);
      }

      const addOutbox = legacy.prepare(
        `INSERT INTO telegram_outbox
           (delivery_part_id, session_id, kind, state, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
      );
      const early = '2026-08-01T10:00:00.000Z';
      const late = '2026-08-01T10:05:00.000Z';
      addOutbox.run('audio:direct', 's-direct', 'audio', 'sent', early);
      addOutbox.run('audio:split:split0', 's-split', 'audio', 'sent', early);
      addOutbox.run('audio:split:split1', 's-split', 'audio', 'sent', late);
      addOutbox.run('audio:pending:split0', 's-pending', 'audio', 'sent', early);
      addOutbox.run('audio:pending:split1', 's-pending', 'audio', 'pending', late);
      addOutbox.run('audio:ambiguous', 's-ambiguous', 'audio', 'sent', early);
      addOutbox.run('audio:ambiguous:split0', 's-ambiguous', 'audio', 'sent', late);
      addOutbox.run('audio:gapped:split0', 's-gapped', 'audio', 'sent', early);
      addOutbox.run('audio:gapped:split2', 's-gapped', 'audio', 'sent', late);
      addOutbox.run('audio:noncanonical:split00', 's-noncanonical', 'audio', 'sent', early);
      addOutbox.run('audio:wrong-session', 's-other', 'audio', 'sent', early);
      addOutbox.run('audio:unconfirmed-domain', 's-domain', 'audio', 'sent', early);

      const addIncoming = legacy.prepare(
        "INSERT INTO incoming_telegram_files (file_uid, state) VALUES (?, 'delivered')",
      );
      const addIncomingRevision = legacy.prepare(
        'INSERT INTO transcript_revisions (incoming_file_id, is_current) VALUES (?, 1)',
      );
      for (const fileUid of [
        'incoming-valid',
        'incoming-absent',
        'incoming-pending',
        'incoming-missing-tail',
        'incoming-gapped',
        'incoming-ambiguous',
        'incoming-invalid-payload',
        'incoming-malformed-head',
        'incoming-non-text',
        'incoming-no-transcript',
      ]) {
        addIncoming.run(fileUid);
        if (fileUid !== 'incoming-no-transcript') addIncomingRevision.run(fileUid);
      }
      const addIncomingOutbox = legacy.prepare(
        `INSERT INTO telegram_outbox
           (delivery_part_id, kind, payload, state, updated_at)
         VALUES (?, 'incoming_transcript', ?, ?, ?)`,
      );
      const ordinaryPayload = JSON.stringify({ type: 'text', text: 'part' });
      const finalPayload = JSON.stringify({
        type: 'text',
        text: 'final',
        replyMarkup: { inline_keyboard: [] },
      });
      addIncomingOutbox.run('incoming:incoming-valid:1', ordinaryPayload, 'sent', early);
      addIncomingOutbox.run('incoming:incoming-valid:2', finalPayload, 'sent', late);
      addIncomingOutbox.run('incoming:incoming-pending:1', ordinaryPayload, 'sent', early);
      addIncomingOutbox.run('incoming:incoming-pending:2', finalPayload, 'pending', late);
      addIncomingOutbox.run('incoming:incoming-missing-tail:1', ordinaryPayload, 'sent', early);
      addIncomingOutbox.run('incoming:incoming-gapped:1', ordinaryPayload, 'sent', early);
      addIncomingOutbox.run('incoming:incoming-gapped:3', finalPayload, 'sent', late);
      addIncomingOutbox.run('incoming:incoming-ambiguous:1', finalPayload, 'sent', early);
      addIncomingOutbox.run('incoming:incoming-ambiguous:2', finalPayload, 'sent', late);
      addIncomingOutbox.run('incoming:incoming-invalid-payload:1', 'not-json', 'sent', early);
      addIncomingOutbox.run(
        'incoming:incoming-malformed-head:1',
        JSON.stringify({
          type: 'text',
          text: 'head',
          replyMarkup: { inline_keyboard: 'not-an-array' },
        }),
        'sent',
        early,
      );
      addIncomingOutbox.run('incoming:incoming-malformed-head:2', finalPayload, 'sent', late);
      addIncomingOutbox.run(
        'incoming:incoming-non-text:1',
        JSON.stringify({
          type: 'text',
          text: 42,
          replyMarkup: { inline_keyboard: [] },
        }),
        'sent',
        late,
      );
      addIncomingOutbox.run('incoming:incoming-no-transcript:1', finalPayload, 'sent', early);

      assert.deepEqual(migrate(legacy), [
        '006_alert_fingerprints.sql',
        '007_audio_delivery_time.sql',
        '008_daemon_heartbeat.sql',
        '009_incoming_delivery_time.sql',
        '010_audio_delivery_reconciliation.sql',
        '011_telegram_delivery_reconciliation.sql',
        '012_summary_revision_uniqueness.sql',
        '013_audio_finalization_journal.sql',
        '014_current_transcript_uniqueness.sql',
      ]);
      const rows = legacy
        .prepare('SELECT part_id, delivered_at FROM audio_parts ORDER BY part_id')
        .all() as { part_id: string; delivered_at: string | null }[];
      const deliveryTime = new Map(rows.map((row) => [row.part_id, row.delivered_at]));

      assert.equal(deliveryTime.get('direct'), early);
      assert.equal(deliveryTime.get('split'), late, 'split retention starts at its last ACK');
      for (const partId of [
        'absent',
        'pending',
        'ambiguous',
        'gapped',
        'noncanonical',
        'wrong-session',
        'unconfirmed-domain',
      ]) {
        assert.equal(deliveryTime.get(partId), null, `${partId} must remain fail-closed`);
      }

      const incomingRows = legacy
        .prepare('SELECT file_uid, delivered_at FROM incoming_telegram_files ORDER BY file_uid')
        .all() as { file_uid: string; delivered_at: string | null }[];
      const incomingDeliveryTime = new Map(
        incomingRows.map((row) => [row.file_uid, row.delivered_at]),
      );
      assert.equal(incomingDeliveryTime.get('incoming-valid'), late);
      for (const fileUid of [
        'incoming-absent',
        'incoming-pending',
        'incoming-missing-tail',
        'incoming-gapped',
        'incoming-ambiguous',
        'incoming-invalid-payload',
        'incoming-malformed-head',
        'incoming-non-text',
        'incoming-no-transcript',
      ]) {
        assert.equal(incomingDeliveryTime.get(fileUid), null, `${fileUid} must remain fail-closed`);
      }
    } finally {
      legacy.close();
    }
  });

  it('turns on WAL and foreign keys', () => {
    const journal = db.handle.prepare('PRAGMA journal_mode').get() as { journal_mode: string };
    const fk = db.handle.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number };
    assert.equal(journal.journal_mode, 'wal');
    assert.equal(fk.foreign_keys, 1);
  });

  it('refuses a future migration ledger before changing or migrating the database', () => {
    const futurePath = join(dir, 'future.db');
    const seed = new DatabaseSync(futurePath);
    seed.exec(`
      CREATE TABLE schema_migrations (
        name TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL
      ) STRICT
    `);
    seed
      .prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)')
      .run('999_future_schema.sql', '2026-08-11T00:00:00.000Z');
    assert.equal(
      (seed.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode,
      'delete',
    );
    seed.close();

    assert.throws(
      () => openDatabase({ file: futurePath }),
      /unknown or future migrations: 999_future_schema\.sql.*Upgrade OpenMurmur.*refusing to downgrade or write/is,
    );

    const inspected = new DatabaseSync(futurePath);
    try {
      assert.equal(
        (inspected.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode,
        'delete',
        'the read-only guard must run before WAL changes the database',
      );
      const tables = inspected
        .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name")
        .all() as { name: string }[];
      assert.deepEqual(
        tables.map((row) => row.name),
        ['schema_migrations'],
        'no known migration may run before the future-ledger refusal',
      );
      assert.deepEqual(
        inspected
          .prepare('SELECT name, applied_at FROM schema_migrations')
          .all()
          .map((row) => ({ ...row })),
        [
          {
            name: '999_future_schema.sql',
            applied_at: '2026-08-11T00:00:00.000Z',
          },
        ],
      );
    } finally {
      inspected.close();
    }
  });

  it('refuses a malformed migration ledger before changing the database', () => {
    const malformedPath = join(dir, 'malformed-ledger.db');
    const seed = new DatabaseSync(malformedPath);
    seed.exec(`
      CREATE TABLE schema_migrations (name, applied_at);
      INSERT INTO schema_migrations (name, applied_at)
      VALUES ('001_initial.sql', NULL), ('001_initial.sql', 17);
    `);
    seed.close();

    assert.throws(
      () => openDatabase({ file: malformedPath }),
      /Invalid database migration ledger: schema_migrations does not have the canonical STRICT shape.*refusing to downgrade or write/is,
    );

    const inspected = new DatabaseSync(malformedPath);
    try {
      assert.equal(
        (inspected.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode,
        'delete',
      );
      assert.deepEqual(
        inspected
          .prepare(
            `SELECT name, applied_at, typeof(name) AS name_type,
                    typeof(applied_at) AS applied_at_type
               FROM schema_migrations ORDER BY rowid`,
          )
          .all()
          .map((row) => ({ ...row })),
        [
          {
            name: '001_initial.sql',
            applied_at: null,
            name_type: 'text',
            applied_at_type: 'null',
          },
          {
            name: '001_initial.sql',
            applied_at: 17,
            name_type: 'text',
            applied_at_type: 'integer',
          },
        ],
        'the malformed, duplicate ledger remains byte-for-byte logical input',
      );
      assert.deepEqual(
        (
          inspected
            .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name")
            .all() as { name: string }[]
        ).map((row) => row.name),
        ['schema_migrations'],
      );
    } finally {
      inspected.close();
    }
  });

  it('refuses malformed values in a canonical ledger before changing the database', () => {
    const malformedValuePath = join(dir, 'malformed-ledger-value.db');
    const seed = new DatabaseSync(malformedValuePath);
    seed.exec(`
      CREATE TABLE schema_migrations (
        name TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL
      ) STRICT
    `);
    seed
      .prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)')
      .run('001_initial.sql', 'not-a-timestamp');
    seed.close();

    assert.throws(
      () => openDatabase({ file: malformedValuePath }),
      /applied_at must be a canonical UTC timestamp.*refusing to downgrade or write/is,
    );

    const inspected = new DatabaseSync(malformedValuePath);
    try {
      assert.equal(
        (inspected.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode,
        'delete',
      );
      assert.deepEqual(
        inspected
          .prepare('SELECT name, applied_at FROM schema_migrations')
          .all()
          .map((row) => ({ ...row })),
        [{ name: '001_initial.sql', applied_at: 'not-a-timestamp' }],
      );
    } finally {
      inspected.close();
    }
  });

  it('refuses known migrations after a ledger gap before changing the database', () => {
    const gapPath = join(dir, 'known-gap.db');
    const seed = new DatabaseSync(gapPath);
    seed.exec(`
      CREATE TABLE schema_migrations (
        name TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL
      ) STRICT
    `);
    const insert = seed.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)');
    insert.run('001_initial.sql', '2026-08-11T00:00:00.000Z');
    insert.run('003_output_provenance.sql', '2026-08-11T00:03:00.000Z');
    seed.close();

    assert.throws(
      () => openDatabase({ file: gapPath }),
      /not a contiguous filename-ordered prefix; expected 002_speaker_diarization\.sql but found 003_output_provenance\.sql.*refusing to downgrade or write/is,
    );

    const inspected = new DatabaseSync(gapPath);
    try {
      assert.equal(
        (inspected.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode,
        'delete',
      );
      assert.deepEqual(
        (
          inspected.prepare('SELECT name FROM schema_migrations ORDER BY name').all() as {
            name: string;
          }[]
        ).map((row) => row.name),
        ['001_initial.sql', '003_output_provenance.sql'],
      );
      assert.deepEqual(
        (
          inspected
            .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name")
            .all() as { name: string }[]
        ).map((row) => row.name),
        ['schema_migrations'],
      );
    } finally {
      inspected.close();
    }
  });

  it('repairs duplicate current pointers before installing the database constraint', () => {
    db.handle.exec(`
      DROP INDEX idx_transcript_current_session;
      DROP INDEX idx_transcript_current_incoming;
      DELETE FROM schema_migrations WHERE name = '014_current_transcript_uniqueness.sql';
    `);
    const at = '2026-08-11T01:00:00.000Z';
    new SessionRepository(db.handle).create('duplicate-session', at);
    db.handle
      .prepare(
        `INSERT INTO incoming_telegram_files
           (file_uid, telegram_file_id, telegram_unique_id, chat_id, message_id,
            state, created_at, updated_at)
         VALUES ('duplicate-incoming', 'file-id', 'unique-id', 42, 1,
                 'transcribed', ?, ?)`,
      )
      .run(at, at);
    const insertRevision = db.handle.prepare(
      `INSERT INTO transcript_revisions
         (revision_id, session_id, incoming_file_id, revision_number, engine, model,
          languages, text, word_count, is_current, created_at)
       VALUES (?, ?, ?, ?, 'e', 'm', '[]', ?, 1, 1, ?)`,
    );
    insertRevision.run('session-r1', 'duplicate-session', null, 1, 'old session', at);
    insertRevision.run('session-r2', 'duplicate-session', null, 2, 'new session', at);
    insertRevision.run('incoming-r1', null, 'duplicate-incoming', 1, 'old incoming', at);
    insertRevision.run('incoming-r2', null, 'duplicate-incoming', 2, 'new incoming', at);

    assert.deepEqual(migrate(db.handle), ['014_current_transcript_uniqueness.sql']);
    const pointers = db.handle
      .prepare(
        `SELECT revision_id, is_current
           FROM transcript_revisions
          WHERE session_id = 'duplicate-session'
             OR incoming_file_id = 'duplicate-incoming'
          ORDER BY revision_id`,
      )
      .all() as { revision_id: string; is_current: number }[];
    assert.deepEqual(
      pointers.map((row) => ({ ...row })),
      [
        { revision_id: 'incoming-r1', is_current: 0 },
        { revision_id: 'incoming-r2', is_current: 1 },
        { revision_id: 'session-r1', is_current: 0 },
        { revision_id: 'session-r2', is_current: 1 },
      ],
      'the migration preserves all immutable rows and retains the highest revision pointer',
    );
    assert.deepEqual(migrate(db.handle), []);
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
    const addLegacySession = legacy.prepare(
      `INSERT INTO audio_sessions
         (session_id, state, started_at, ended_at, duration_ms, created_at, updated_at)
       VALUES (?, 'DONE', ?, ?, ?, ?, ?)`,
    );
    addLegacySession.run(
      'legacy-exact',
      '2026-08-10T09:00:00.000Z',
      '2026-08-10T09:00:12.345Z',
      12_345,
      '2026-08-10T09:00:00.000Z',
      '2026-08-10T09:00:00.000Z',
    );
    addLegacySession.run(
      'legacy-unknown',
      '2026-08-10T09:00:00.000Z',
      null,
      null,
      '2026-08-10T09:00:00.000Z',
      '2026-08-10T09:00:00.000Z',
    );
    addLegacySession.run(
      'legacy-asr-empty',
      '2026-08-10T09:00:00.000Z',
      '2026-08-10T10:30:00.000Z',
      300_000,
      '2026-08-10T09:00:00.000Z',
      '2026-08-10T09:00:00.000Z',
    );
    addLegacySession.run(
      'legacy-asr-thin',
      '2026-08-10T09:00:00.000Z',
      '2026-08-10T10:31:00.000Z',
      301_000,
      '2026-08-10T09:00:00.000Z',
      '2026-08-10T09:00:00.000Z',
    );
    legacy
      .prepare(
        `UPDATE audio_sessions
            SET state = 'REJECTED', rejection_reason = ?
          WHERE session_id = ?`,
      )
      .run('asr_empty', 'legacy-asr-empty');
    legacy
      .prepare(
        `UPDATE audio_sessions
            SET state = 'REJECTED', rejection_reason = ?
          WHERE session_id = ?`,
      )
      .run('insufficient_words', 'legacy-asr-thin');
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
      const timing = upgraded.handle
        .prepare(
          `SELECT session_id, timing_exact
             FROM audio_sessions
            WHERE session_id LIKE 'legacy-%'
            ORDER BY session_id`,
        )
        .all() as { session_id: string; timing_exact: number }[];
      assert.deepEqual(
        timing.map((row) => ({ ...row })),
        [
          { session_id: 'legacy-asr-empty', timing_exact: 0 },
          { session_id: 'legacy-asr-thin', timing_exact: 0 },
          { session_id: 'legacy-exact', timing_exact: 1 },
          { session_id: 'legacy-unknown', timing_exact: 0 },
        ],
      );
    } finally {
      upgraded.close();
    }
  });
});

describe('audio finalization journal', () => {
  it('accepts only an identical replay and remains immutable', () => {
    const at = '2026-08-11T04:00:00.000Z';
    new SessionRepository(db.handle).create('journal-session', at);
    db.handle
      .prepare(
        `INSERT INTO audio_parts
           (part_id, session_id, part_index, path, started_at, created_at)
         VALUES ('journal-part', 'journal-session', 0, '/audio/journal.flac', ?, ?)`,
      )
      .run(at, at);
    const journal = new AudioFinalizationJournalRepository(db.handle);
    const facts = {
      partId: 'journal-part',
      sessionId: 'journal-session',
      partEndedAtIso: '2026-08-11T04:00:01.000Z',
      partDurationMs: 1_000,
      finalSession: {
        endedAtIso: '2026-08-11T04:00:02.000Z',
        durationMs: 2_000,
        speechMs: 1_500,
      },
    } as const;

    journal.record(facts);
    assert.doesNotThrow(() => journal.record(facts));
    assert.throws(
      () => journal.record({ ...facts, partDurationMs: 999 }),
      /conflicting finalization journal/,
    );
    assert.throws(
      () =>
        db.handle
          .prepare('UPDATE audio_finalization_journal SET part_duration_ms = 999 WHERE part_id = ?')
          .run('journal-part'),
      /immutable/,
    );
    assert.equal(journal.forPart('journal-part')?.partDurationMs, 1_000);
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

  it('rejects a second current revision from an independent direct SQL writer', () => {
    const at = '2026-08-11T02:00:00.000Z';
    const sessions = new SessionRepository(db.handle);
    const transcripts = new TranscriptRepository(db.handle);
    sessions.create('unique-session', at);
    transcripts.append({
      sessionId: 'unique-session',
      engine: 'e',
      model: 'm',
      languages: ['ru'],
      text: 'session current',
      segments: [],
    });
    db.handle
      .prepare(
        `INSERT INTO incoming_telegram_files
           (file_uid, telegram_file_id, telegram_unique_id, chat_id, message_id,
            state, created_at, updated_at)
         VALUES ('unique-incoming', 'file-id', 'unique-id', 42, 1,
                 'transcribed', ?, ?)`,
      )
      .run(at, at);
    transcripts.append({
      incomingFileId: 'unique-incoming',
      engine: 'e',
      model: 'm',
      languages: ['ru'],
      text: 'incoming current',
      segments: [],
    });

    const otherWriter = new DatabaseSync(join(dir, 'test.db'));
    try {
      const insertCurrent = otherWriter.prepare(
        `INSERT INTO transcript_revisions
           (revision_id, session_id, incoming_file_id, revision_number, engine, model,
            languages, text, word_count, is_current, created_at)
         VALUES (?, ?, ?, 2, 'e', 'm2', '[]', 'duplicate', 1, 1, ?)`,
      );
      assert.throws(
        () => insertCurrent.run('direct-session-r2', 'unique-session', null, at),
        /UNIQUE constraint failed: transcript_revisions\.session_id/,
      );
      assert.throws(
        () => insertCurrent.run('direct-incoming-r2', null, 'unique-incoming', at),
        /UNIQUE constraint failed: transcript_revisions\.incoming_file_id/,
      );
    } finally {
      otherWriter.close();
    }

    const currentCounts = db.handle
      .prepare(
        `SELECT
           (SELECT count(*) FROM transcript_revisions
             WHERE session_id = 'unique-session' AND is_current = 1) AS session_count,
           (SELECT count(*) FROM transcript_revisions
             WHERE incoming_file_id = 'unique-incoming' AND is_current = 1) AS incoming_count`,
      )
      .get() as { session_count: number; incoming_count: number };
    assert.deepEqual({ ...currentCounts }, { session_count: 1, incoming_count: 1 });
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

  it('does not supersede the revision whose incoming delivery was proven', () => {
    const at = '2026-08-11T10:00:00.000Z';
    db.handle
      .prepare(
        `INSERT INTO incoming_telegram_files
           (file_uid, telegram_file_id, telegram_unique_id, chat_id, message_id,
            state, created_at, updated_at)
         VALUES ('incoming-delivered', 'file-id', 'unique-id', 42, 1,
                 'transcribed', ?, ?)`,
      )
      .run(at, at);
    const transcripts = new TranscriptRepository(db.handle);
    const originalRevision = transcripts.append({
      incomingFileId: 'incoming-delivered',
      engine: 'e',
      model: 'm',
      languages: ['ru'],
      text: 'доставленный вариант',
      segments: [],
    });
    db.handle
      .prepare("UPDATE incoming_telegram_files SET state = 'delivered' WHERE file_uid = ?")
      .run('incoming-delivered');

    assert.throws(
      () =>
        transcripts.append({
          incomingFileId: 'incoming-delivered',
          engine: 'e',
          model: 'm2',
          languages: ['ru'],
          text: 'новый вариант',
          segments: [],
        }),
      /cannot supersede a delivered incoming transcript revision/,
    );
    const current = db.handle
      .prepare(
        `SELECT revision_id, text
           FROM transcript_revisions
          WHERE incoming_file_id = ? AND is_current = 1`,
      )
      .get('incoming-delivered') as { revision_id: string; text: string };
    assert.deepEqual(
      { ...current },
      { revision_id: originalRevision, text: 'доставленный вариант' },
    );
  });

  it('freezes an incoming revision as soon as its delivery manifest exists', () => {
    const at = '2026-08-11T10:00:00.000Z';
    db.handle
      .prepare(
        `INSERT INTO incoming_telegram_files
           (file_uid, telegram_file_id, telegram_unique_id, chat_id, message_id,
            state, created_at, updated_at)
         VALUES ('incoming-pending', 'file-pending', 'unique-pending', 42, 2,
                 'transcribed', ?, ?)`,
      )
      .run(at, at);
    const transcripts = new TranscriptRepository(db.handle);
    const originalRevision = transcripts.append({
      incomingFileId: 'incoming-pending',
      engine: 'e',
      model: 'm',
      languages: ['ru'],
      text: 'вариант в очереди',
      segments: [],
    });
    db.handle
      .prepare(
        `INSERT INTO telegram_outbox
           (outbox_id, delivery_part_id, kind, ordinal, payload, state,
            run_after, created_at, updated_at)
         VALUES ('incoming-pending-o1', 'incoming:incoming-pending:1',
                 'incoming_transcript', 10, '{}', 'pending', ?, ?, ?)`,
      )
      .run(at, at, at);

    assert.throws(
      () =>
        transcripts.append({
          incomingFileId: 'incoming-pending',
          engine: 'e',
          model: 'm2',
          languages: ['ru'],
          text: 'отвязанный вариант',
          segments: [],
        }),
      /cannot supersede an incoming transcript revision after delivery starts/,
    );
    assert.throws(
      () =>
        db.handle
          .prepare(
            `INSERT INTO transcript_revisions
               (revision_id, incoming_file_id, revision_number, engine, model, languages,
                text, word_count, is_current, created_at)
             VALUES ('incoming-pending-r2', 'incoming-pending', 2, 'e', 'm2', '[]',
                     'обход repository', 2, 1, ?)`,
          )
          .run(at),
      /cannot supersede an incoming transcript revision after delivery starts/,
      'the database invariant must also reject direct inserts',
    );
    const current = db.handle
      .prepare(
        `SELECT revision_id, text
           FROM transcript_revisions
          WHERE incoming_file_id = ? AND is_current = 1`,
      )
      .get('incoming-pending') as { revision_id: string; text: string };
    assert.deepEqual({ ...current }, { revision_id: originalRevision, text: 'вариант в очереди' });
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
    assert.equal(jobs.fail(first, 'model unavailable'), 'retry');

    db.handle.prepare("UPDATE jobs SET run_after = '2000-01-01T00:00:00.000Z'").run();
    const second = jobs.claim(['asr']);
    assert.ok(second);
    assert.equal(jobs.fail(second, 'model unavailable again'), 'dead');

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
    assert.equal(jobs.fail(claimed, 'Ollama is not reachable'), 'dead');

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
    jobs.fail(claimed, 'model missing');

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
