import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import {
  hasRecoverableTelegramWork,
  recoverAfterCrash,
  renderRecoveryReport,
  sessionIdFromPartFilename,
} from '../../src/capture/recovery.ts';
import { managedDirectories, resolvePaths } from '../../src/config/paths.ts';
import { type Database, openDatabase } from '../../src/database/db.ts';
import {
  AudioFinalizationJournalRepository,
  TranscriptRepository,
} from '../../src/database/repository.ts';
import { JobQueue } from '../../src/jobs/queue.ts';
import { createLogger, nullLogger } from '../../src/logging/logger.ts';

let dir: string;
let db: Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'om-recover-'));
  for (const sub of managedDirectories(resolvePaths(dir))) {
    mkdirSync(sub, { recursive: true });
  }
  db = openDatabase({ file: resolvePaths(dir).databaseFile });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const paths = () => resolvePaths(dir);
const nowIso = () => new Date().toISOString();

/** A session the daemon was still recording when it died. */
function seedLiveSession(id: string, finalizedParts: number): void {
  const at = nowIso();
  db.handle
    .prepare(
      `INSERT INTO audio_sessions (session_id, state, started_at, created_at, updated_at)
       VALUES (?, 'ACTIVE', ?, ?, ?)`,
    )
    .run(id, at, at, at);

  for (let i = 0; i < finalizedParts; i += 1) {
    db.handle
      .prepare(
        `INSERT INTO audio_parts (part_id, session_id, part_index, path, started_at, ended_at,
                                  bytes, sha256, finalized, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 100, 'sha', 1, ?)`,
      )
      .run(`${id}-p${i}`, id, i, join(dir, 'audio', `${id}.p00${i}.flac`), at, at, at);
  }
}

function seedProcessingSession(id: string, finalizedParts = 1): void {
  seedLiveSession(id, finalizedParts);
  db.handle.prepare("UPDATE audio_sessions SET state = 'PROCESSING' WHERE session_id = ?").run(id);
}

function seedInitialJob(sessionId: string, kind: 'deliver_audio' | 'asr'): string {
  const jobId = new JobQueue(db.handle).enqueue({
    kind,
    idempotencyKey: kind === 'deliver_audio' ? `deliver-audio:${sessionId}` : `asr:${sessionId}`,
    payload: { sessionId },
  });
  assert.ok(jobId);
  return jobId;
}

function seedOrphan(name: string, bytes = 4096): string {
  const path = join(paths().tempDir, name);
  writeFileSync(path, Buffer.alloc(bytes));
  return path;
}

function seedPendingPublication(id: string, publish: boolean): { partId: string; path: string } {
  const at = nowIso();
  const path = join(paths().audioDir, `${id}.p000.flac`);
  db.handle
    .prepare(
      `INSERT INTO audio_sessions (session_id, state, started_at, created_at, updated_at)
       VALUES (?, 'ACTIVE', ?, ?, ?)`,
    )
    .run(id, at, at, at);
  const partId = `${id}-p0`;
  db.handle
    .prepare(
      `INSERT INTO audio_parts
         (part_id, session_id, part_index, path, started_at, finalized, created_at)
       VALUES (?, ?, 0, ?, ?, 0, ?)`,
    )
    .run(partId, id, path, at, at);
  if (publish) writeFileSync(path, Buffer.from(`published:${id}`));
  return { partId, path };
}

function seedAudioOutbox(
  id: string,
  state: 'pending' | 'sending' | 'sent' | 'dead',
  payload: Record<string, unknown>,
  identity: { readonly deliveryPartId?: string; readonly sessionId?: string } = {},
): void {
  const now = nowIso();
  db.handle
    .prepare(
      `INSERT INTO telegram_outbox
         (outbox_id, delivery_part_id, session_id, kind, ordinal, payload, state,
          run_after, created_at, updated_at)
       VALUES (?, ?, ?, 'audio', 0, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      identity.deliveryPartId ?? `audio:${id}`,
      identity.sessionId ?? null,
      JSON.stringify(payload),
      state,
      now,
      now,
      now,
    );
}

describe('crash recovery', () => {
  it('shares the exact recoverable Telegram-work boundary with credential setup', async () => {
    seedLiveSession('recoverable-finalizing', 1);
    db.handle
      .prepare("UPDATE audio_sessions SET state = 'FINALIZING' WHERE session_id = ?")
      .run('recoverable-finalizing');
    seedProcessingSession('recoverable-processing');

    assert.equal(hasRecoverableTelegramWork(db.handle), true);

    db.handle
      .prepare("UPDATE audio_sessions SET state = 'FAILED' WHERE session_id = ?")
      .run('recoverable-finalizing');
    assert.equal(hasRecoverableTelegramWork(db.handle), true);

    db.handle
      .prepare("UPDATE audio_sessions SET state = 'FAILED' WHERE session_id = ?")
      .run('recoverable-processing');
    assert.equal(hasRecoverableTelegramWork(db.handle), false);

    const { partId } = seedPendingPublication('failed-provisional', false);
    db.handle
      .prepare(
        `UPDATE audio_sessions
            SET state = 'FAILED', rejection_reason = 'audio_finalize_failed'
          WHERE session_id = ?`,
      )
      .run('failed-provisional');
    assert.equal(hasRecoverableTelegramWork(db.handle), true);

    const missing = await recoverAfterCrash(db.handle, paths(), nullLogger);
    assert.deepEqual(missing.settledMissingParts, [partId]);
    assert.equal(hasRecoverableTelegramWork(db.handle), false);

    const journalPart = seedPendingPublication('failed-journal-owned', false).partId;
    db.handle
      .prepare(
        `UPDATE audio_sessions
            SET state = 'FAILED', rejection_reason = 'audio_finalize_failed'
          WHERE session_id = ?`,
      )
      .run('failed-journal-owned');
    const journal = new AudioFinalizationJournalRepository(db.handle);
    journal.record({
      partId: journalPart,
      sessionId: 'failed-journal-owned',
      partEndedAtIso: '2026-08-12T00:00:03.000Z',
      partDurationMs: 3_000,
      finalSession: {
        endedAtIso: '2026-08-12T00:00:03.000Z',
        durationMs: 3_000,
        speechMs: 2_000,
      },
    });
    assert.equal(
      hasRecoverableTelegramWork(db.handle),
      true,
      'an exact journal still owns future publication recovery',
    );
    journal.deletePart(journalPart);
    assert.equal(hasRecoverableTelegramWork(db.handle), true);
  });

  it('reports a clean shutdown as nothing to do', async () => {
    const report = await recoverAfterCrash(db.handle, paths(), nullLogger);
    assert.deepEqual(report.orphans, []);
    assert.deepEqual(report.stalledSessions, []);
    assert.match(renderRecoveryReport(report), /last shutdown was clean/);
  });

  it('finds partial writes left in the temp directory', async () => {
    seedOrphan('01J-ABC.p000.flac.part', 8192);
    const report = await recoverAfterCrash(db.handle, paths(), nullLogger, { remove: false });

    assert.equal(report.orphans.length, 1);
    assert.equal(report.orphans[0]?.sessionId, '01J-ABC');
    assert.equal(report.orphans[0]?.bytes, 8192);
  });

  it('reports without deleting unless asked', async () => {
    const path = seedOrphan('01J-ABC.p000.flac.part');
    const report = await recoverAfterCrash(db.handle, paths(), nullLogger, { remove: false });

    assert.equal(report.removed, 0);
    assert.ok(existsSync(path), 'seeing what a crash left is not agreeing to delete it');
  });

  it('removes them when asked, and reports what it freed', async () => {
    const path = seedOrphan('01J-ABC.p000.flac.part', 2048);
    const report = await recoverAfterCrash(db.handle, paths(), nullLogger, { remove: true });

    assert.equal(report.removed, 1);
    assert.equal(report.freedBytes, 2048);
    assert.equal(existsSync(path), false);
  });

  it('never touches the archive', async () => {
    const archived = join(dir, 'audio', 'keep.flac');
    writeFileSync(archived, Buffer.alloc(128));
    seedOrphan('01J-ABC.p000.flac.part');

    await recoverAfterCrash(db.handle, paths(), nullLogger, { remove: true });
    assert.ok(
      existsSync(archived),
      'anything under audio/ was fsynced and renamed; it is complete',
    );
  });

  it('keeps pending, sending, and dead outbox-owned splits while removing unowned ones', async () => {
    const stale = seedOrphan('session.p000.split000.flac', 100);
    const pending = seedOrphan('pending.p000.split000.flac', 100);
    const sending = seedOrphan('sending.p000.split000.flac', 100);
    const dead = seedOrphan('dead.p000.split000.flac', 100);
    for (const sessionId of ['pending', 'sending', 'dead']) {
      seedLiveSession(sessionId, 1);
      db.handle
        .prepare("UPDATE audio_sessions SET state = 'DONE' WHERE session_id = ?")
        .run(sessionId);
    }
    seedAudioOutbox(
      'pending-owner',
      'pending',
      {
        type: 'document',
        path: pending,
        filename: 'pending.p000.split000.flac',
        partId: 'pending-p0',
        deleteAfterSend: true,
      },
      { deliveryPartId: 'audio:pending-p0:split0', sessionId: 'pending' },
    );
    seedAudioOutbox(
      'sending-owner',
      'sending',
      {
        type: 'document',
        path: sending,
        filename: 'sending.p000.split000.flac',
        partId: 'sending-p0',
        deleteAfterSend: true,
      },
      { deliveryPartId: 'audio:sending-p0:split0', sessionId: 'sending' },
    );
    seedAudioOutbox(
      'dead-owner',
      'dead',
      {
        type: 'document',
        path: dead,
        filename: 'dead.p000.split000.flac',
        partId: 'dead-p0',
        deleteAfterSend: true,
      },
      { deliveryPartId: 'audio:dead-p0:split0', sessionId: 'dead' },
    );

    const report = await recoverAfterCrash(db.handle, paths(), nullLogger, { remove: true });
    assert.deepEqual(
      report.orphans.map((orphan) => orphan.path),
      [stale],
    );
    assert.equal(report.removed, 1);
    assert.equal(existsSync(stale), false);
    assert.equal(existsSync(dead), true, 'an exact dead delivery remains available for retry');
    assert.equal(existsSync(pending), true);
    assert.equal(existsSync(sending), true);
  });

  it('finds gapped split names without touching their source FLAC', async () => {
    const source = join(paths().audioDir, 'session.p000.flac');
    writeFileSync(source, Buffer.alloc(200));
    const stale = [
      seedOrphan('session.p000.split000.flac', 10),
      seedOrphan('session.p000.split002.flac', 20),
      seedOrphan('session.p000.split999.flac', 30),
      seedOrphan('session.p000.split1000.flac', 40),
    ];

    const report = await recoverAfterCrash(db.handle, paths(), nullLogger, { remove: true });

    assert.equal(report.removed, 4);
    for (const path of stale) assert.equal(existsSync(path), false);
    assert.equal(existsSync(source), true, 'startup cleanup never removes the archived source');
  });

  it('reports a stale split without mutating files in report-only mode', async () => {
    const source = join(paths().audioDir, 'report-only.p000.flac');
    writeFileSync(source, Buffer.alloc(200));
    const stale = seedOrphan('report-only.p000.split007.flac', 100);

    const report = await recoverAfterCrash(db.handle, paths(), nullLogger, {
      remove: false,
      repair: false,
    });

    assert.deepEqual(
      report.orphans.map((orphan) => orphan.path),
      [stale],
    );
    assert.equal(report.removed, 0);
    assert.equal(existsSync(stale), true);
    assert.equal(existsSync(source), true);
  });

  it('preserves every split when a parseable dead owner has a mismatched path', async () => {
    const split = seedOrphan('ambiguous.p000.split005.flac', 100);
    const partial = seedOrphan('01J-AMBIGUOUS.p000.flac.part', 200);
    seedLiveSession('broken', 1);
    db.handle.prepare("UPDATE audio_sessions SET state = 'DONE' WHERE session_id = 'broken'").run();
    const now = nowIso();
    const wrongPath = join(dir, 'outside-temp', 'broken.p000.split000.flac');
    db.handle
      .prepare(
        `INSERT INTO telegram_outbox
           (outbox_id, delivery_part_id, session_id, kind, ordinal, payload,
            state, run_after, created_at, updated_at)
         VALUES ('broken-owner', 'audio:broken-p0:split0', 'broken', 'audio', 0, ?, 'dead', ?, ?, ?)`,
      )
      .run(
        JSON.stringify({
          type: 'document',
          path: wrongPath,
          filename: 'broken.p000.split000.flac',
          partId: 'broken-p0',
          deleteAfterSend: true,
        }),
        now,
        now,
        now,
      );
    const records: Record<string, unknown>[] = [];
    const logger = createLogger({
      level: 'debug',
      sink: (record) => records.push(record),
    });

    const report = await recoverAfterCrash(db.handle, paths(), logger, { remove: true });

    assert.equal(report.removed, 1);
    assert.equal(existsSync(partial), false, 'unrelated interrupted writes still recover');
    assert.equal(existsSync(split), true, 'ambiguous ownership is not deletion proof');
    assert.ok(
      records.some(
        (record) =>
          record['level'] === 'error' &&
          String(record['msg']).includes('preserving every split artifact') &&
          String(record['action']).includes('Repair or retire'),
      ),
      'the local log explains how to unblock conservative split preservation',
    );
  });

  it('rechecks ownership immediately before deleting a stale split', async () => {
    const split = seedOrphan('raced.p000.split000.flac', 100);
    let ownershipReads = 0;
    const guardedDb = new Proxy(db.handle, {
      get(target, property) {
        if (property === 'prepare') {
          return (sql: string) => {
            if (sql.includes("WHERE state IN ('pending','sending','dead')")) {
              ownershipReads += 1;
              if (ownershipReads === 2) {
                seedLiveSession('raced', 1);
                db.handle
                  .prepare("UPDATE audio_sessions SET state = 'DONE' WHERE session_id = 'raced'")
                  .run();
                seedAudioOutbox(
                  'late-owner',
                  'pending',
                  {
                    type: 'document',
                    path: split,
                    filename: 'raced.p000.split000.flac',
                    partId: 'raced-p0',
                    deleteAfterSend: true,
                  },
                  { deliveryPartId: 'audio:raced-p0:split0', sessionId: 'raced' },
                );
              }
            }
            return target.prepare(sql);
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as Database['handle'];

    const report = await recoverAfterCrash(guardedDb, paths(), nullLogger, { remove: true });

    assert.equal(ownershipReads, 2);
    assert.equal(report.removed, 0);
    assert.deepEqual(report.orphans, []);
    assert.equal(existsSync(split), true, 'a newly durable owner wins the final deletion check');
  });

  it('reconciles stale splits idempotently across repeated startup recovery', async () => {
    const stale = seedOrphan('repeat.p000.split042.flac', 100);

    const first = await recoverAfterCrash(db.handle, paths(), nullLogger, { remove: true });
    const second = await recoverAfterCrash(db.handle, paths(), nullLogger, { remove: true });

    assert.equal(first.removed, 1);
    assert.equal(existsSync(stale), false);
    assert.deepEqual(second.orphans, []);
    assert.equal(second.removed, 0);
  });

  it('fails a session that was interrupted before any audio landed', async () => {
    seedLiveSession('A', 0);
    const report = await recoverAfterCrash(db.handle, paths(), nullLogger);

    assert.deepEqual(report.stalledSessions, ['A']);
    const row = db.handle
      .prepare('SELECT state, rejection_reason FROM audio_sessions WHERE session_id = ?')
      .get('A') as { state: string; rejection_reason: string };
    assert.equal(row.state, 'FAILED');
    assert.equal(row.rejection_reason, 'interrupted');
  });

  it('still delivers a session whose audio partly survived', async () => {
    // Discarding a recording the user may want would be the worse failure.
    seedLiveSession('B', 1);
    const report = await recoverAfterCrash(db.handle, paths(), nullLogger);

    assert.deepEqual(report.stalledSessions, ['B']);
    const row = db.handle
      .prepare('SELECT state FROM audio_sessions WHERE session_id = ?')
      .get('B') as { state: string };
    assert.equal(row.state, 'PROCESSING');
    assert.equal(new JobQueue(db.handle).pendingCount('asr'), 1, 'and is queued for transcription');
    assert.equal(
      new JobQueue(db.handle).pendingCount('deliver_audio'),
      1,
      'and its surviving audio is queued without waiting for ASR',
    );
    const status = db.handle
      .prepare('SELECT payload FROM telegram_outbox WHERE delivery_part_id = ?')
      .get('session-status:finalized:B') as { payload: string } | undefined;
    assert.ok(status, 'recovery must restore the stable finish/upload lifecycle notice');
    assert.match(JSON.parse(status.payload).text as string, /сохранившиеся части/);
  });

  it('reconciles a complete archive file published just before a crash', async () => {
    seedLiveSession('published', 0);
    const archived = join(paths().audioDir, 'published.p000.flac');
    writeFileSync(archived, Buffer.from('complete archive bytes'));
    const at = nowIso();
    db.handle
      .prepare(
        `INSERT INTO audio_parts
           (part_id, session_id, part_index, path, started_at, finalized, created_at)
         VALUES ('published-p0', 'published', 0, ?, ?, 0, ?)`,
      )
      .run(archived, at, at);

    const report = await recoverAfterCrash(db.handle, paths(), nullLogger);
    assert.deepEqual(report.recoveredPublishedParts, ['published-p0']);
    const part = db.handle
      .prepare(
        'SELECT finalized, ended_at, duration_ms, bytes, sha256 FROM audio_parts WHERE part_id = ?',
      )
      .get('published-p0') as {
      finalized: number;
      ended_at: string | null;
      duration_ms: number | null;
      bytes: number;
      sha256: string;
    };
    assert.equal(part.finalized, 1);
    assert.equal(part.ended_at, null, 'filesystem mtime is not an exact capture clock');
    assert.equal(part.duration_ms, null, 'a legacy archive cannot invent monotonic duration');
    assert.equal(part.bytes, Buffer.byteLength('complete archive bytes'));
    assert.match(part.sha256, /^[0-9a-f]{64}$/);
    const session = db.handle
      .prepare(
        'SELECT ended_at, duration_ms, timing_exact FROM audio_sessions WHERE session_id = ?',
      )
      .get('published') as {
      ended_at: string | null;
      duration_ms: number | null;
      timing_exact: number;
    };
    assert.deepEqual({ ...session }, { ended_at: null, duration_ms: null, timing_exact: 0 });
    assert.equal(new JobQueue(db.handle).pendingCount('deliver_audio'), 1);
    assert.equal(new JobQueue(db.handle).pendingCount('asr'), 1);
  });

  it('converges journal, archive, part finalization, and session outcome after every write fault', async () => {
    const { partId } = seedPendingPublication('exact-window', true);
    const journal = new AudioFinalizationJournalRepository(db.handle);
    const exact = {
      endedAtIso: '2026-08-11T01:02:03.400Z',
      durationMs: 12_345,
      speechMs: 8_765,
    };
    journal.record({
      partId,
      sessionId: 'exact-window',
      partEndedAtIso: '2026-08-11T01:02:03.000Z',
      partDurationMs: 10_000,
      finalSession: exact,
    });

    db.handle.exec(`
      CREATE TRIGGER inject_part_finalize_failure
      BEFORE UPDATE ON audio_parts
      WHEN OLD.part_id = 'exact-window-p0'
      BEGIN
        SELECT RAISE(ABORT, 'injected part finalize failure');
      END;
    `);
    await assert.rejects(recoverAfterCrash(db.handle, paths(), nullLogger), (error) => {
      assert.match(String(error), /could not reconcile published audio part/);
      assert.match(String((error as Error).cause), /injected part finalize failure/);
      return true;
    });
    assert.equal(
      (
        db.handle.prepare('SELECT finalized FROM audio_parts WHERE part_id = ?').get(partId) as {
          finalized: number;
        }
      ).finalized,
      0,
    );
    assert.ok(journal.forPart(partId), 'part update failure cannot consume its proof');

    db.handle.exec('DROP TRIGGER inject_part_finalize_failure');
    db.handle.exec(`
      CREATE TRIGGER inject_exact_session_failure
      BEFORE INSERT ON jobs
      WHEN NEW.kind = 'asr'
      BEGIN
        SELECT RAISE(ABORT, 'injected exact session failure');
      END;
    `);
    await assert.rejects(
      recoverAfterCrash(db.handle, paths(), nullLogger),
      /injected exact session failure/,
    );
    const afterSessionFault = db.handle
      .prepare(
        'SELECT state, ended_at, duration_ms, timing_exact FROM audio_sessions WHERE session_id = ?',
      )
      .get('exact-window') as {
      state: string;
      ended_at: string | null;
      duration_ms: number | null;
      timing_exact: number;
    };
    assert.deepEqual(
      { ...afterSessionFault },
      { state: 'ACTIVE', ended_at: null, duration_ms: null, timing_exact: 0 },
      'session facts and work roll back together',
    );
    assert.ok(journal.forPart(partId), 'session transaction failure preserves the exact proof');
    assert.equal(new JobQueue(db.handle).pendingCount(), 0);

    db.handle.exec('DROP TRIGGER inject_exact_session_failure');
    await recoverAfterCrash(db.handle, paths(), nullLogger);
    const recoveredPart = db.handle
      .prepare('SELECT ended_at, duration_ms, finalized FROM audio_parts WHERE part_id = ?')
      .get(partId) as { ended_at: string; duration_ms: number; finalized: number };
    assert.deepEqual(
      { ...recoveredPart },
      { ended_at: '2026-08-11T01:02:03.000Z', duration_ms: 10_000, finalized: 1 },
    );
    const recoveredSession = db.handle
      .prepare(
        `SELECT state, ended_at, duration_ms, speech_ms, timing_exact, part_count
           FROM audio_sessions WHERE session_id = ?`,
      )
      .get('exact-window') as {
      state: string;
      ended_at: string;
      duration_ms: number;
      speech_ms: number;
      timing_exact: number;
      part_count: number;
    };
    assert.deepEqual(
      { ...recoveredSession },
      {
        state: 'PROCESSING',
        ended_at: exact.endedAtIso,
        duration_ms: exact.durationMs,
        speech_ms: exact.speechMs,
        timing_exact: 1,
        part_count: 1,
      },
    );
    assert.equal(journal.forPart(partId), undefined);

    await recoverAfterCrash(db.handle, paths(), nullLogger);
    assert.equal(new JobQueue(db.handle).pendingCount(), 2, 'replay creates no duplicate work');
  });

  it('uses an exact final journal even when no archive survived publication', async () => {
    const { partId } = seedPendingPublication('journal-only', false);
    const journal = new AudioFinalizationJournalRepository(db.handle);
    journal.record({
      partId,
      sessionId: 'journal-only',
      partEndedAtIso: '2026-08-11T02:00:01.000Z',
      partDurationMs: 1_000,
      finalSession: {
        endedAtIso: '2026-08-11T02:00:02.000Z',
        durationMs: 2_000,
        speechMs: 900,
      },
    });

    await recoverAfterCrash(db.handle, paths(), nullLogger);

    const session = db.handle
      .prepare(
        `SELECT state, rejection_reason, ended_at, duration_ms, speech_ms, timing_exact
           FROM audio_sessions WHERE session_id = ?`,
      )
      .get('journal-only') as Record<string, unknown>;
    assert.deepEqual(
      { ...session },
      {
        state: 'FAILED',
        rejection_reason: 'interrupted',
        ended_at: '2026-08-11T02:00:02.000Z',
        duration_ms: 2_000,
        speech_ms: 900,
        timing_exact: 1,
      },
    );
    assert.equal(journal.forPart(partId), undefined);
    assert.equal(new JobQueue(db.handle).pendingCount(), 0);
  });

  it('rejects conflicting durable session timing without consuming the journal', async () => {
    const { partId } = seedPendingPublication('timing-conflict', true);
    const journal = new AudioFinalizationJournalRepository(db.handle);
    journal.record({
      partId,
      sessionId: 'timing-conflict',
      partEndedAtIso: '2026-08-11T03:00:01.000Z',
      partDurationMs: 1_000,
      finalSession: {
        endedAtIso: '2026-08-11T03:00:02.000Z',
        durationMs: 2_000,
        speechMs: 1_000,
      },
    });
    db.handle
      .prepare(
        `UPDATE audio_sessions
            SET state = 'FAILED', rejection_reason = 'audio_finalize_failed', ended_at = ?,
                duration_ms = 9999, speech_ms = 1, timing_exact = 1
          WHERE session_id = ?`,
      )
      .run('2026-08-11T03:00:09.999Z', 'timing-conflict');

    await assert.rejects(recoverAfterCrash(db.handle, paths(), nullLogger), (error) => {
      assert.match(String(error), /could not reconcile published audio part/);
      assert.match(String((error as Error).cause), /conflicting durable timing facts/);
      return true;
    });
    assert.equal(
      (
        db.handle.prepare('SELECT finalized FROM audio_parts WHERE part_id = ?').get(partId) as {
          finalized: number;
        }
      ).finalized,
      0,
      'the part update rolls back with the conflicting proof check',
    );
    assert.ok(journal.forPart(partId), 'an operator-visible conflict is never consumed');
    assert.equal(new JobQueue(db.handle).pendingCount(), 0);
  });

  it('recovers published audio after DB finalization failed and retries atomically', async () => {
    const at = nowIso();
    const archived = join(paths().audioDir, 'db-finalize.p000.flac');
    writeFileSync(archived, Buffer.from('published before the database fault'));
    db.handle
      .prepare(
        `INSERT INTO audio_sessions
           (session_id, state, started_at, ended_at, duration_ms, speech_ms,
            rejection_reason, created_at, updated_at)
         VALUES ('db-finalize', 'FAILED', ?, ?, 42000, 30000,
                 'audio_finalize_failed', ?, ?)`,
      )
      .run(at, at, at, at);
    db.handle
      .prepare(
        `INSERT INTO audio_parts
           (part_id, session_id, part_index, path, started_at, finalized, created_at)
         VALUES ('db-finalize-p0', 'db-finalize', 0, ?, ?, 0, ?)`,
      )
      .run(archived, at, at);
    assert.equal(
      hasRecoverableTelegramWork(db.handle),
      true,
      'a legacy published archive without a journal must block rebind before recovery',
    );

    db.handle.exec(`
      CREATE TRIGGER inject_initial_job_failure
      BEFORE INSERT ON jobs
      WHEN NEW.kind = 'asr'
      BEGIN
        SELECT RAISE(ABORT, 'injected initial job failure');
      END;
    `);
    await assert.rejects(
      recoverAfterCrash(db.handle, paths(), nullLogger),
      /injected initial job failure/,
    );

    const afterFault = db.handle
      .prepare('SELECT state, rejection_reason FROM audio_sessions WHERE session_id = ?')
      .get('db-finalize') as { state: string; rejection_reason: string };
    assert.equal(afterFault.state, 'FAILED', 'the session transition rolls back with its jobs');
    assert.equal(afterFault.rejection_reason, 'audio_finalize_failed');
    assert.equal(
      new JobQueue(db.handle).pendingCount(),
      0,
      'deliver_audio cannot commit alone before the injected ASR failure',
    );
    assert.equal(
      (
        db.handle
          .prepare('SELECT finalized FROM audio_parts WHERE part_id = ?')
          .get('db-finalize-p0') as { finalized: number }
      ).finalized,
      1,
      'the separately idempotent archive proof survives for the next startup',
    );

    db.handle.exec('DROP TRIGGER inject_initial_job_failure');
    db.handle.exec(`
      CREATE TRIGGER inject_recovery_status_failure
      BEFORE INSERT ON telegram_outbox
      WHEN NEW.delivery_part_id = 'session-status:finalized:db-finalize'
      BEGIN
        SELECT RAISE(ABORT, 'injected recovery status failure');
      END;
    `);
    await assert.rejects(
      recoverAfterCrash(db.handle, paths(), nullLogger),
      /injected recovery status failure/,
    );
    assert.equal(
      (
        db.handle
          .prepare('SELECT state FROM audio_sessions WHERE session_id = ?')
          .get('db-finalize') as { state: string }
      ).state,
      'FAILED',
      'the session cannot commit even after both jobs if the final durable write fails',
    );
    assert.equal(new JobQueue(db.handle).pendingCount(), 0, 'both initial jobs roll back together');
    assert.equal(
      (
        db.handle
          .prepare('SELECT count(*) AS count FROM telegram_outbox WHERE session_id = ?')
          .get('db-finalize') as { count: number }
      ).count,
      0,
    );

    db.handle.exec('DROP TRIGGER inject_recovery_status_failure');
    const retried = await recoverAfterCrash(db.handle, paths(), nullLogger);
    assert.deepEqual(retried.stalledSessions, ['db-finalize']);
    const recovered = db.handle
      .prepare(
        `SELECT state, rejection_reason, duration_ms, speech_ms, part_count
           FROM audio_sessions WHERE session_id = ?`,
      )
      .get('db-finalize') as {
      state: string;
      rejection_reason: string | null;
      duration_ms: number;
      speech_ms: number;
      part_count: number;
    };
    assert.deepEqual(
      { ...recovered },
      {
        state: 'PROCESSING',
        rejection_reason: null,
        duration_ms: 42000,
        speech_ms: 30000,
        part_count: 1,
      },
    );
    assert.equal(new JobQueue(db.handle).pendingCount('deliver_audio'), 1);
    assert.equal(new JobQueue(db.handle).pendingCount('asr'), 1);

    await recoverAfterCrash(db.handle, paths(), nullLogger);
    assert.equal(
      new JobQueue(db.handle).pendingCount(),
      2,
      'stable recovery creates no duplicates',
    );
  });

  it('is idempotent, so running it twice queues nothing extra', async () => {
    seedLiveSession('B', 1);
    await recoverAfterCrash(db.handle, paths(), nullLogger);
    await recoverAfterCrash(db.handle, paths(), nullLogger);

    assert.equal(new JobQueue(db.handle).pendingCount('asr'), 1);
    const statuses = db.handle
      .prepare(
        "SELECT count(*) AS c FROM telegram_outbox WHERE delivery_part_id = 'session-status:finalized:B'",
      )
      .get() as { c: number };
    assert.equal(statuses.c, 1);
  });

  it('reports and atomically restores both missing initial PROCESSING jobs', async () => {
    seedProcessingSession('missing-both');

    const reportOnly = await recoverAfterCrash(db.handle, paths(), nullLogger, {
      remove: false,
      repair: false,
    });
    assert.deepEqual(reportOnly.stalledSessions, ['missing-both']);
    assert.equal(new JobQueue(db.handle).pendingCount(), 0);
    assert.equal(
      (
        db.handle
          .prepare('SELECT part_count FROM audio_sessions WHERE session_id = ?')
          .get('missing-both') as { part_count: number }
      ).part_count,
      0,
      'report-only recovery must not repair even session metadata',
    );

    const repaired = await recoverAfterCrash(db.handle, paths(), nullLogger);
    assert.deepEqual(repaired.stalledSessions, ['missing-both']);
    assert.equal(new JobQueue(db.handle).pendingCount('deliver_audio'), 1);
    assert.equal(new JobQueue(db.handle).pendingCount('asr'), 1);
    const facts = db.handle
      .prepare(
        `SELECT s.state, s.part_count,
                (SELECT count(*) FROM telegram_outbox
                  WHERE delivery_part_id = 'session-status:finalized:missing-both') AS statuses
           FROM audio_sessions s
          WHERE s.session_id = 'missing-both'`,
      )
      .get() as { state: string; part_count: number; statuses: number };
    assert.deepEqual({ ...facts }, { state: 'PROCESSING', part_count: 1, statuses: 1 });

    const repeated = await recoverAfterCrash(db.handle, paths(), nullLogger);
    assert.deepEqual(repeated.stalledSessions, []);
    assert.equal(new JobQueue(db.handle).pendingCount(), 2);
    assert.equal(
      (
        db.handle
          .prepare(
            "SELECT count(*) AS count FROM telegram_outbox WHERE delivery_part_id = 'session-status:finalized:missing-both'",
          )
          .get() as { count: number }
      ).count,
      1,
    );
  });

  it('inserts only the missing companion when one initial job already exists', async () => {
    seedProcessingSession('has-asr');
    const asrId = seedInitialJob('has-asr', 'asr');
    seedProcessingSession('has-audio');
    const audioId = seedInitialJob('has-audio', 'deliver_audio');

    const report = await recoverAfterCrash(db.handle, paths(), nullLogger);

    assert.deepEqual(report.stalledSessions, ['has-asr', 'has-audio']);
    for (const sessionId of ['has-asr', 'has-audio']) {
      const jobs = db.handle
        .prepare(
          `SELECT kind, count(*) AS count
             FROM jobs
            WHERE json_extract(payload, '$.sessionId') = ?
            GROUP BY kind
            ORDER BY kind`,
        )
        .all(sessionId) as { kind: string; count: number }[];
      assert.deepEqual(
        jobs.map((job) => ({ ...job })),
        [
          { kind: 'asr', count: 1 },
          { kind: 'deliver_audio', count: 1 },
        ],
      );
    }
    assert.ok(db.handle.prepare('SELECT 1 FROM jobs WHERE job_id = ?').get(asrId));
    assert.ok(db.handle.prepare('SELECT 1 FROM jobs WHERE job_id = ?').get(audioId));
  });

  it('fails closed for zero-part, dead, conflicting, downstream, and terminal sessions', async () => {
    seedProcessingSession('zero-part', 0);
    seedProcessingSession('dead-job');
    seedInitialJob('dead-job', 'asr');
    db.handle
      .prepare("UPDATE jobs SET state = 'dead' WHERE idempotency_key = 'asr:dead-job'")
      .run();
    seedProcessingSession('failed-job');
    seedInitialJob('failed-job', 'asr');
    db.handle
      .prepare("UPDATE jobs SET state = 'failed' WHERE idempotency_key = 'asr:failed-job'")
      .run();
    seedProcessingSession('conflicting-job');
    const at = nowIso();
    db.handle
      .prepare(
        `INSERT INTO jobs
           (job_id, kind, idempotency_key, payload, state, run_after, created_at, updated_at)
         VALUES ('conflicting-job-row', 'deliver_audio', 'asr:conflicting-job',
                 '{"sessionId":"conflicting-job"}', 'pending', ?, ?, ?)`,
      )
      .run(at, at, at);
    seedProcessingSession('alternate-key');
    db.handle
      .prepare(
        `INSERT INTO jobs
           (job_id, kind, idempotency_key, payload, state, run_after, created_at, updated_at)
         VALUES ('alternate-key-row', 'asr', 'legacy-asr:alternate-key',
                 '{"sessionId":"alternate-key"}', 'pending', ?, ?, ?)`,
      )
      .run(at, at, at);
    seedProcessingSession('downstream');
    seedInitialJob('downstream', 'deliver_audio');
    db.handle
      .prepare(
        `INSERT INTO transcript_revisions
           (revision_id, session_id, revision_number, engine, model, languages,
            text, word_count, is_current, created_at)
         VALUES ('downstream-revision', 'downstream', 1, 'fake', 'fake', '[]',
                 'done', 1, 1, ?)`,
      )
      .run(at);
    seedProcessingSession('terminal');
    db.handle
      .prepare("UPDATE audio_sessions SET state = 'DONE' WHERE session_id = 'terminal'")
      .run();
    const records: Record<string, unknown>[] = [];
    const logger = createLogger({
      level: 'debug',
      sink: (record) => records.push(record),
    });

    const report = await recoverAfterCrash(db.handle, paths(), logger);

    assert.deepEqual(report.stalledSessions, []);
    for (const sessionId of [
      'zero-part',
      'dead-job',
      'failed-job',
      'conflicting-job',
      'alternate-key',
      'downstream',
    ]) {
      assert.equal(
        (
          db.handle
            .prepare(
              `SELECT count(*) AS count FROM jobs
                WHERE json_valid(payload) = 1
                  AND json_extract(payload, '$.sessionId') = ?`,
            )
            .get(sessionId) as { count: number }
        ).count,
        sessionId === 'zero-part' ? 0 : 1,
      );
      assert.equal(
        (
          db.handle
            .prepare('SELECT count(*) AS count FROM telegram_outbox WHERE session_id = ?')
            .get(sessionId) as { count: number }
        ).count,
        0,
      );
    }
    assert.equal(
      (
        db.handle
          .prepare("SELECT state FROM audio_sessions WHERE session_id = 'terminal'")
          .get() as { state: string }
      ).state,
      'DONE',
    );
    assert.ok(
      records.filter((record) => record['level'] === 'error').length >= 6,
      'every ambiguous PROCESSING session is loud and remains operator-owned',
    );
  });

  it('does not recreate missing audio work after any durable downstream progress', async () => {
    const transcriptSession = 'progress-transcript';
    seedProcessingSession(transcriptSession);
    seedInitialJob(transcriptSession, 'asr');
    new TranscriptRepository(db.handle).append({
      sessionId: transcriptSession,
      engine: 'fake',
      model: 'fake',
      languages: ['en'],
      text: 'already transcribed',
      segments: [],
    });

    const downstreamKinds = [
      'deliver_transcript',
      'summarize',
      'deliver_report',
      'deliver',
    ] as const;
    const downstreamSessions: string[] = [];
    for (const kind of downstreamKinds) {
      const sessionId = `progress-${kind.replaceAll('_', '-')}`;
      downstreamSessions.push(sessionId);
      seedProcessingSession(sessionId);
      seedInitialJob(sessionId, 'asr');
      assert.ok(
        new JobQueue(db.handle).enqueue({
          kind,
          idempotencyKey: `downstream:${kind}:${sessionId}`,
          payload: { sessionId },
        }),
      );
    }
    const records: Record<string, unknown>[] = [];
    const logger = createLogger({
      level: 'debug',
      sink: (record) => records.push(record),
    });

    const report = await recoverAfterCrash(db.handle, paths(), logger);

    assert.deepEqual(report.stalledSessions, []);
    for (const sessionId of [transcriptSession, ...downstreamSessions]) {
      const facts = db.handle
        .prepare(
          `SELECT s.state,
                  (SELECT count(*) FROM jobs
                    WHERE idempotency_key = 'deliver-audio:' || s.session_id) AS audio_jobs,
                  (SELECT count(*) FROM telegram_outbox
                    WHERE session_id = s.session_id) AS statuses
             FROM audio_sessions s
            WHERE s.session_id = ?`,
        )
        .get(sessionId) as Record<string, unknown>;
      assert.deepEqual({ ...facts }, { state: 'PROCESSING', audio_jobs: 0, statuses: 0 });
    }
    assert.equal(
      records.filter((record) => record['level'] === 'error').length,
      downstreamSessions.length + 1,
    );
  });

  it('rolls back session, jobs, and lifecycle status on every repair write fault', async () => {
    const faults = [
      {
        name: 'deliver',
        trigger:
          "BEFORE INSERT ON jobs WHEN NEW.kind = 'deliver_audio' AND json_extract(NEW.payload, '$.sessionId') = 'fault-deliver'",
      },
      {
        name: 'asr',
        trigger:
          "BEFORE INSERT ON jobs WHEN NEW.kind = 'asr' AND json_extract(NEW.payload, '$.sessionId') = 'fault-asr'",
      },
      {
        name: 'status',
        trigger:
          "BEFORE INSERT ON telegram_outbox WHEN NEW.delivery_part_id = 'session-status:finalized:fault-status'",
      },
    ] as const;

    for (const fault of faults) {
      const sessionId = `fault-${fault.name}`;
      seedProcessingSession(sessionId);
      db.handle.exec(`
        CREATE TRIGGER inject_processing_repair_fault
        ${fault.trigger}
        BEGIN SELECT RAISE(ABORT, 'injected ${fault.name} repair failure'); END
      `);

      await assert.rejects(
        recoverAfterCrash(db.handle, paths(), nullLogger),
        new RegExp(`injected ${fault.name} repair failure`),
      );
      const facts = db.handle
        .prepare(
          `SELECT s.state, s.part_count,
                  (SELECT count(*) FROM jobs
                    WHERE json_valid(payload) = 1
                      AND json_extract(payload, '$.sessionId') = s.session_id) AS jobs,
                  (SELECT count(*) FROM telegram_outbox
                    WHERE session_id = s.session_id) AS statuses
             FROM audio_sessions s
            WHERE s.session_id = ?`,
        )
        .get(sessionId) as Record<string, unknown>;
      assert.deepEqual({ ...facts }, { state: 'PROCESSING', part_count: 0, jobs: 0, statuses: 0 });
      db.handle.exec('DROP TRIGGER inject_processing_repair_fault');
    }
  });

  it('does not disguise a non-file archive path as a missing temp write', async () => {
    seedLiveSession('invalid-published', 0);
    const at = nowIso();
    db.handle
      .prepare(
        `INSERT INTO audio_parts
           (part_id, session_id, part_index, path, started_at, finalized, created_at)
         VALUES ('invalid-p0', 'invalid-published', 0, ?, ?, 0, ?)`,
      )
      .run(paths().audioDir, at, at);

    await assert.rejects(
      recoverAfterCrash(db.handle, paths(), nullLogger),
      /could not reconcile published audio part invalid-p0/,
    );
    const session = db.handle
      .prepare('SELECT state FROM audio_sessions WHERE session_id = ?')
      .get('invalid-published') as { state: string };
    assert.equal(session.state, 'ACTIVE', 'ambiguous I/O must not rewrite session state');
  });

  it('does not change database state or queue jobs in report-only mode', async () => {
    seedLiveSession('dry', 1);
    const report = await recoverAfterCrash(db.handle, paths(), nullLogger, {
      remove: false,
      repair: false,
    });

    assert.deepEqual(report.stalledSessions, ['dry']);
    const row = db.handle
      .prepare('SELECT state FROM audio_sessions WHERE session_id = ?')
      .get('dry') as { state: string };
    assert.equal(row.state, 'ACTIVE');
    assert.equal(new JobQueue(db.handle).pendingCount(), 0);
  });

  it('leaves already-finished sessions alone', async () => {
    const at = nowIso();
    db.handle
      .prepare(
        `INSERT INTO audio_sessions (session_id, state, started_at, created_at, updated_at)
         VALUES ('done', 'DONE', ?, ?, ?)`,
      )
      .run(at, at, at);

    await recoverAfterCrash(db.handle, paths(), nullLogger);
    const row = db.handle
      .prepare("SELECT state FROM audio_sessions WHERE session_id = 'done'")
      .get() as { state: string };
    assert.equal(row.state, 'DONE');
  });

  it('ignores files that are not partial parts', async () => {
    writeFileSync(join(paths().tempDir, 'scratch.wav'), Buffer.alloc(64));
    const report = await recoverAfterCrash(db.handle, paths(), nullLogger, { remove: false });
    assert.deepEqual(report.orphans, []);
  });
});

describe('part filename parsing', () => {
  it('recovers the session id from a partial part', () => {
    assert.equal(sessionIdFromPartFilename('01J-ABC.p000.flac.part'), '01J-ABC');
    assert.equal(sessionIdFromPartFilename('01J-ABC.p042.flac.part'), '01J-ABC');
  });

  it('returns null for anything else', () => {
    for (const name of ['notapart.txt', '01J-ABC.flac', 'x.p00.flac.part', '.part']) {
      assert.equal(sessionIdFromPartFilename(name), null);
    }
  });
});
