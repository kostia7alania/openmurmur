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

    assert.deepEqual(report.stalledSessions, [], 'B is recovered, not failed');
    const row = db.handle
      .prepare('SELECT state FROM audio_sessions WHERE session_id = ?')
      .get('B') as { state: string };
    assert.equal(row.state, 'PROCESSING');
    assert.equal(new JobQueue(db.handle).pendingCount('asr'), 1, 'and is queued for transcription');
  });

  it('is idempotent, so running it twice queues nothing extra', async () => {
    seedLiveSession('B', 1);
    await recoverAfterCrash(db.handle, paths(), nullLogger);
    await recoverAfterCrash(db.handle, paths(), nullLogger);

    assert.equal(new JobQueue(db.handle).pendingCount('asr'), 1);
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
