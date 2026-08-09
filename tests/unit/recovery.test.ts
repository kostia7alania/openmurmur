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
import { nullLogger } from '../../src/logging/logger.ts';

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

  it('removes stale split artifacts but keeps one still owned by the outbox', async () => {
    const stale = seedOrphan('session.p000.split000.flac', 100);
    const owned = seedOrphan('session.p000.split001.flac', 100);
    const now = nowIso();
    db.handle
      .prepare(
        `INSERT INTO telegram_outbox
           (outbox_id, delivery_part_id, kind, ordinal, payload, run_after, created_at, updated_at)
         VALUES ('owned', 'audio:p:split1', 'audio', 0, ?, ?, ?, ?)`,
      )
      .run(
        JSON.stringify({
          type: 'document',
          path: owned,
          filename: 'session.p000.split001.flac',
          deleteAfterSend: true,
        }),
        now,
        now,
        now,
      );

    const report = await recoverAfterCrash(db.handle, paths(), nullLogger, { remove: true });
    assert.equal(report.removed, 1);
    assert.equal(existsSync(stale), false);
    assert.equal(existsSync(owned), true);
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
