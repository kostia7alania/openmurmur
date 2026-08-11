import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import {
  recoverAfterCrash,
  renderRecoveryReport,
  sessionIdFromPartFilename,
} from '../../src/capture/recovery.ts';
import { managedDirectories, resolvePaths } from '../../src/config/paths.ts';
import { type Database, openDatabase } from '../../src/database/db.ts';
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

function seedOrphan(name: string, bytes = 4096): string {
  const path = join(paths().tempDir, name);
  writeFileSync(path, Buffer.alloc(bytes));
  return path;
}

function seedAudioOutbox(
  id: string,
  state: 'pending' | 'sending' | 'sent' | 'dead',
  payload: Record<string, unknown>,
): void {
  const now = nowIso();
  db.handle
    .prepare(
      `INSERT INTO telegram_outbox
         (outbox_id, delivery_part_id, kind, ordinal, payload, state,
          run_after, created_at, updated_at)
       VALUES (?, ?, 'audio', 0, ?, ?, ?, ?, ?)`,
    )
    .run(id, `audio:${id}`, JSON.stringify(payload), state, now, now, now);
}

describe('crash recovery', () => {
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

  it('keeps live outbox-owned splits and removes unowned or terminal ones', async () => {
    const stale = seedOrphan('session.p000.split000.flac', 100);
    const pending = seedOrphan('session.p000.split001.flac', 100);
    const sending = seedOrphan('session.p000.split002.flac', 100);
    const dead = seedOrphan('session.p000.split003.flac', 100);
    seedAudioOutbox('pending-owner', 'pending', {
      type: 'document',
      path: pending,
      filename: 'session.p000.split001.flac',
    });
    seedAudioOutbox('sending-owner', 'sending', {
      type: 'document',
      path: sending,
      filename: 'session.p000.split002.flac',
      deleteAfterSend: true,
    });
    seedAudioOutbox('dead-owner', 'dead', {
      type: 'document',
      path: dead,
      filename: 'session.p000.split003.flac',
      deleteAfterSend: true,
    });

    const report = await recoverAfterCrash(db.handle, paths(), nullLogger, { remove: true });
    assert.deepEqual(report.orphans.map((orphan) => orphan.path).sort(), [dead, stale].sort());
    assert.equal(report.removed, 2);
    assert.equal(existsSync(stale), false);
    assert.equal(existsSync(dead), false);
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

  it('preserves every split but still recovers .part files when ownership is ambiguous', async () => {
    const split = seedOrphan('ambiguous.p000.split005.flac', 100);
    const partial = seedOrphan('01J-AMBIGUOUS.p000.flac.part', 200);
    const now = nowIso();
    db.handle
      .prepare(
        `INSERT INTO telegram_outbox
           (outbox_id, delivery_part_id, kind, ordinal, payload,
            run_after, created_at, updated_at)
         VALUES ('broken-owner', 'audio:broken:split5', 'audio', 0, '{', ?, ?, ?)`,
      )
      .run(now, now, now);
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
    const split = seedOrphan('raced.p000.split006.flac', 100);
    let ownershipReads = 0;
    const guardedDb = new Proxy(db.handle, {
      get(target, property) {
        if (property === 'prepare') {
          return (sql: string) => {
            if (sql.includes('SELECT outbox_id, payload FROM telegram_outbox')) {
              ownershipReads += 1;
              if (ownershipReads === 2) {
                seedAudioOutbox('late-owner', 'pending', {
                  type: 'document',
                  path: split,
                  filename: 'raced.p000.split006.flac',
                  deleteAfterSend: true,
                });
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
      .prepare('SELECT finalized, bytes, sha256 FROM audio_parts WHERE part_id = ?')
      .get('published-p0') as { finalized: number; bytes: number; sha256: string };
    assert.equal(part.finalized, 1);
    assert.equal(part.bytes, Buffer.byteLength('complete archive bytes'));
    assert.match(part.sha256, /^[0-9a-f]{64}$/);
    assert.equal(new JobQueue(db.handle).pendingCount('deliver_audio'), 1);
    assert.equal(new JobQueue(db.handle).pendingCount('asr'), 1);
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
