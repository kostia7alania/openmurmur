import assert from 'node:assert/strict';
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { startRecorderBeforeBackgroundRecovery } from '../../src/cli/daemon.ts';
import { managedDirectories, resolvePaths } from '../../src/config/paths.ts';
import { type Database, openDatabase } from '../../src/database/db.ts';
import { createLogger, nullLogger } from '../../src/logging/logger.ts';
import { reconcileIncomingArtifacts } from '../../src/telegram/incoming-recovery.ts';

const UID_A = '11111111-1111-4111-8111-111111111111';
const UID_B = '22222222-2222-4222-8222-222222222222';
const UID_C = '33333333-3333-4333-8333-333333333333';
const UID_D = '44444444-4444-4444-8444-444444444444';

let dir: string;
let db: Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'om-incoming-recovery-'));
  const paths = resolvePaths(dir);
  for (const managed of managedDirectories(paths)) mkdirSync(managed, { recursive: true });
  db = openDatabase({ file: paths.databaseFile });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const paths = () => resolvePaths(dir);

function artifact(filename: string, bytes = 32): string {
  const path = join(paths().quarantineDir, filename);
  writeFileSync(path, Buffer.alloc(bytes));
  return path;
}

function seedIncoming(
  fileUid: string,
  quarantinePath: string | null,
  normalizedPath: string | null = null,
): void {
  const now = new Date().toISOString();
  db.handle
    .prepare(
      `INSERT INTO incoming_telegram_files
         (file_uid, telegram_file_id, telegram_unique_id, chat_id, message_id,
          state, quarantine_path, normalized_path, created_at, updated_at)
       VALUES (?, ?, ?, 42, 1, 'downloaded', ?, ?, ?, ?)`,
    )
    .run(fileUid, `file-${fileUid}`, `unique-${fileUid}`, quarantinePath, normalizedPath, now, now);
}

describe('incoming artifact recovery', () => {
  it('reports only unowned generated artifacts by default and never scans ambient audio', async () => {
    const current = artifact(`${UID_A}.ogg`, 10);
    const currentNormalized = artifact(`${UID_A}.16k.wav`, 20);
    const staleDownload = artifact(`${UID_B}.mp3`, 30);
    const staleNormalized = artifact(`${UID_C}.16k.wav`, 40);
    const archive = join(paths().audioDir, `${UID_D}.flac`);
    writeFileSync(archive, Buffer.alloc(50));
    seedIncoming(UID_A, current, currentNormalized);

    const report = await reconcileIncomingArtifacts(db.handle, paths(), nullLogger);

    assert.equal(report.applied, false);
    assert.equal(report.removed, 0);
    assert.deepEqual(
      report.superseded.map((item) => [item.path, item.kind]).sort(),
      [
        [staleDownload, 'quarantine'],
        [staleNormalized, 'normalized'],
      ].sort(),
    );
    for (const path of [current, currentNormalized, staleDownload, staleNormalized, archive]) {
      assert.equal(existsSync(path), true);
    }
  });

  it('deletes only absent UIDs and preserves a non-NULL same-UID extension crash window', async () => {
    const currentDownload = artifact(`${UID_A}.ogg`, 11);
    const publishedBeforeReplacement = artifact(`${UID_A}.mp3`, 12);
    const currentNormalized = artifact(`${UID_A}.16k.wav`, 13);
    const staleDownload = artifact(`${UID_B}.ogg`, 14);
    const staleNormalized = artifact(`${UID_C}.16k.wav`, 15);
    seedIncoming(UID_A, currentDownload, currentNormalized);

    const first = await reconcileIncomingArtifacts(db.handle, paths(), nullLogger, {
      remove: true,
    });
    const second = await reconcileIncomingArtifacts(db.handle, paths(), nullLogger, {
      remove: true,
    });

    assert.equal(first.removed, 2);
    assert.equal(first.freedBytes, 29);
    assert.deepEqual(
      first.superseded.map((item) => item.path).sort(),
      [staleDownload, staleNormalized].sort(),
    );
    assert.equal(existsSync(currentDownload), true);
    assert.equal(existsSync(currentNormalized), true);
    assert.equal(
      existsSync(publishedBeforeReplacement),
      true,
      'a durable UID prevents deleting a newly published extension before its path update',
    );
    assert.equal(existsSync(staleDownload), false);
    assert.equal(existsSync(staleNormalized), false);
    assert.equal(second.removed, 0, 'repeated startup cleanup converges without new mutations');
    assert.deepEqual(second.superseded, []);
  });

  it('treats a same-path retry as still owned', async () => {
    const current = artifact(`${UID_A}.flac`);
    const currentNormalized = artifact(`${UID_A}.16k.wav`);
    seedIncoming(UID_A, current, currentNormalized);

    const report = await reconcileIncomingArtifacts(db.handle, paths(), nullLogger, {
      remove: true,
    });

    assert.equal(report.removed, 0);
    assert.deepEqual(report.superseded, []);
    assert.equal(existsSync(current), true);
    assert.equal(existsSync(currentNormalized), true);
  });

  it('preserves a downloaded artifact published before its path ownership update', async () => {
    const published = artifact(`${UID_A}.opus`);
    seedIncoming(UID_A, null);

    const report = await reconcileIncomingArtifacts(db.handle, paths(), nullLogger, {
      remove: true,
    });

    assert.equal(report.removed, 0);
    assert.deepEqual(report.superseded, []);
    assert.equal(
      existsSync(published),
      true,
      'NULL path leaves the same quarantine UID unresolved',
    );
  });

  it('preserves normalized WAV published before its path ownership update', async () => {
    const quarantine = artifact(`${UID_A}.ogg`);
    const normalized = artifact(`${UID_A}.16k.wav`);
    seedIncoming(UID_A, quarantine, null);

    const report = await reconcileIncomingArtifacts(db.handle, paths(), nullLogger, {
      remove: true,
    });

    assert.equal(report.removed, 0);
    assert.deepEqual(report.superseded, []);
    assert.equal(existsSync(normalized), true, 'NULL normalized path keeps its UID namespace live');
  });

  it('fails closed without throwing when durable ownership is corrupt', async () => {
    const stale = artifact(`${UID_B}.wav`);
    seedIncoming(UID_A, 'relative-path.ogg');
    const records: Record<string, unknown>[] = [];
    const logger = createLogger({
      level: 'debug',
      sink: (record) => records.push(record),
    });

    const report = await reconcileIncomingArtifacts(db.handle, paths(), logger, { remove: true });

    assert.equal(report.ownershipCertain, false);
    assert.equal(report.removed, 0);
    assert.equal(existsSync(stale), true);
    assert.ok(
      records.some(
        (record) =>
          record['level'] === 'error' &&
          String(record['msg']).includes('cleanup proof is ambiguous') &&
          String(record['action']).includes('incoming_telegram_files'),
      ),
      'the non-fatal startup error includes an actionable ownership repair hint',
    );
  });

  it('fails closed when a populated owner path has a different UID or kind', async () => {
    const mismatched = artifact(`${UID_B}.ogg`);
    const stale = artifact(`${UID_C}.wav`);
    seedIncoming(UID_A, mismatched);

    const report = await reconcileIncomingArtifacts(db.handle, paths(), nullLogger, {
      remove: true,
    });

    assert.equal(report.ownershipCertain, false);
    assert.equal(report.removed, 0);
    assert.equal(existsSync(mismatched), true);
    assert.equal(existsSync(stale), true);
  });

  it('rechecks UID ownership immediately before filesystem cleanup', async () => {
    const candidate = artifact(`${UID_A}.aac`);
    let ownershipReads = 0;
    const guardedDb = new Proxy(db.handle, {
      get(target, property) {
        if (property === 'prepare') {
          return (sql: string) => {
            if (sql.includes('SELECT file_uid, quarantine_path, normalized_path')) {
              ownershipReads += 1;
              if (ownershipReads === 2) seedIncoming(UID_A, null);
            }
            return target.prepare(sql);
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as Database['handle'];

    const report = await reconcileIncomingArtifacts(guardedDb, paths(), nullLogger, {
      remove: true,
    });

    assert.equal(ownershipReads, 2);
    assert.equal(report.removed, 0);
    assert.deepEqual(report.superseded, []);
    assert.equal(existsSync(candidate), true, 'the durable UID namespace wins the final recheck');
  });

  it('preserves both roots when the quarantine directory is swapped before unlink', async () => {
    const candidate = artifact(`${UID_B}.aac`);
    const originalRoot = `${paths().quarantineDir}.original`;
    let ownershipReads = 0;
    const guardedDb = new Proxy(db.handle, {
      get(target, property) {
        if (property === 'prepare') {
          return (sql: string) => {
            if (sql.includes('SELECT file_uid, quarantine_path, normalized_path')) {
              ownershipReads += 1;
              if (ownershipReads === 2) {
                renameSync(paths().quarantineDir, originalRoot);
                mkdirSync(paths().quarantineDir);
                linkSync(join(originalRoot, `${UID_B}.aac`), candidate);
              }
            }
            return target.prepare(sql);
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as Database['handle'];

    const report = await reconcileIncomingArtifacts(guardedDb, paths(), nullLogger, {
      remove: true,
    });

    assert.equal(ownershipReads, 2);
    assert.equal(report.removed, 0);
    assert.equal(report.ownershipCertain, false);
    assert.equal(existsSync(candidate), true, 'replacement-root link is preserved');
    assert.equal(
      existsSync(join(originalRoot, `${UID_B}.aac`)),
      true,
      'the original-root artifact is preserved',
    );
  });
});

describe('daemon incoming recovery ordering', () => {
  it('starts capture before background cleanup can be scheduled', async () => {
    const events: string[] = [];
    let finishCapture = () => {};
    const recorderDone = startRecorderBeforeBackgroundRecovery(
      () => {
        events.push('capture-started');
        return new Promise<void>((resolve) => {
          finishCapture = resolve;
        });
      },
      () => events.push('cleanup-scheduled'),
    );

    assert.deepEqual(events, ['capture-started', 'cleanup-scheduled']);
    finishCapture();
    await recorderDone;
  });
});
