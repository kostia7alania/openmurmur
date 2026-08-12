import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { recoverAfterCrash } from '../../src/capture/recovery.ts';
import {
  asrWorkerAlertActive,
  claimDaemonPid,
  claimIncomingRequest,
  commandLooksLikeOpenMurmurDaemon,
  enqueueIncomingRequest,
  enqueueRecoveryNotice,
  expectedDigestIsMissing,
  findIncomingFile,
  incomingFileUidFromDeliveryPart,
  incomingRejectionDeliveryPartId,
  markExhaustedAsrSession,
  markExhaustedIncomingFile,
  parseDaemonPid,
  processIdentityMatches,
  readDaemonPid,
  reconcileIncomingDelivery,
  recordCaptureAvailabilityAlert,
  recordIncomingDownload,
  recordKeychainAccessAlert,
  releaseDaemonPid,
  releaseInterruptedJob,
  retirePendingAlertDeliveries,
  retireStaleNotices,
  shouldEnqueueHealthAlert,
  shouldSendRecordingStartedNotice,
} from '../../src/cli/daemon.ts';
import {
  assertCurrentDaemonMaintenance,
  claimDaemonMaintenance,
  daemonJobOwner,
  inspectDaemonControl,
  readDaemonOwnership,
  releaseDaemonMaintenance,
  renewDaemonMaintenance,
  stopOwnedDaemon,
} from '../../src/cli/daemon-ownership.ts';
import { main, withStoppedDaemonForRecovery } from '../../src/cli/main.ts';
import { resolvePaths } from '../../src/config/paths.ts';
import { DEFAULT_CONFIG } from '../../src/config/schema.ts';
import { type Database, openDatabase } from '../../src/database/db.ts';
import { appendIncomingTranscript, IncomingFileRepository } from '../../src/database/repository.ts';
import { AlertEvaluator } from '../../src/health/alerts.ts';
import { JobQueue } from '../../src/jobs/queue.ts';
import { nullLogger } from '../../src/logging/logger.ts';
import { TelegramClient } from '../../src/telegram/client.ts';
import { drainOutbox, Outbox } from '../../src/telegram/outbox.ts';
import {
  incomingTelegramProvenance,
  renderProvenancePlain,
} from '../../src/telegram/provenance.ts';
import { recordUpdate } from '../../src/telegram/router.ts';

let dir: string;
let db: Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'om-daemon-'));
  db = openDatabase({ file: join(dir, 'test.db') });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('daemon PID ownership', () => {
  it('reads legacy and identity-bearing PID records', () => {
    assert.deepEqual(parseDaemonPid('123\n'), {
      pid: 123,
      root: null,
      startedAt: null,
      processBirth: null,
    });
    assert.deepEqual(parseDaemonPid('{"pid":456,"root":"/state","startedAt":"now"}'), {
      pid: 456,
      root: '/state',
      startedAt: 'now',
      processBirth: null,
    });
    assert.deepEqual(
      parseDaemonPid('{"pid":456,"root":"/state","startedAt":"now","processBirth":"birth-1"}'),
      {
        pid: 456,
        root: '/state',
        startedAt: 'now',
        processBirth: 'birth-1',
      },
    );
    assert.equal(
      parseDaemonPid('{"pid":456,"root":"/state","startedAt":"now","processBirth":123}'),
      null,
    );
    assert.equal(parseDaemonPid('not-a-pid'), null);
  });

  it('requires both the product identity and the start command', () => {
    assert.equal(
      commandLooksLikeOpenMurmurDaemon('/opt/node /Applications/openmurmur/src/cli/main.ts start'),
      true,
    );
    assert.equal(commandLooksLikeOpenMurmurDaemon('/opt/node unrelated.ts start'), false);
    assert.equal(commandLooksLikeOpenMurmurDaemon('/opt/openmurmur status'), false);
    assert.equal(processIdentityMatches('/opt/openmurmur start', 'birth-1', 'birth-1'), true);
    assert.equal(
      processIdentityMatches('/opt/openmurmur start', 'birth-2', 'birth-1'),
      false,
      'a reused PID must not inherit the previous daemon identity',
    );
    assert.equal(processIdentityMatches('/opt/openmurmur start', 'birth-1', null), false);
  });

  it('claims the PID file exclusively and only its owner releases it', async () => {
    const pidFile = join(dir, 'daemon.pid');
    const dependencies = {
      birthMarker: async () => 'birth-1',
      inspect: async () => ({
        alive: true,
        identityMatches: false,
        command: 'test process',
        processBirth: 'birth-1',
      }),
    };
    const firstClaim = await claimDaemonPid(db.handle, pidFile, dir, dependencies);
    assert.equal(firstClaim.reclaimedPreviousDaemon, false);
    assert.equal(firstClaim.reclaimedJobOwner, null);
    assert.equal(firstClaim.reclaimedJobs, 0);
    const claimed = await readDaemonPid(pidFile);
    assert.equal(claimed?.pid, process.pid);
    assert.ok(claimed?.processBirth);

    await assert.rejects(
      claimDaemonPid(db.handle, pidFile, dir, dependencies),
      /refusing to replace/,
      'a second daemon must not overwrite a live owner',
    );
    await releaseDaemonPid(db.handle, pidFile, { ...firstClaim, pid: process.pid + 1 });
    assert.equal(existsSync(pidFile), true, 'a non-owner must not unlink the PID file');
    await releaseDaemonPid(db.handle, pidFile, firstClaim);
    assert.equal(existsSync(pidFile), false);

    writeFileSync(
      pidFile,
      `${JSON.stringify({
        pid: process.pid + 1000,
        root: dir,
        startedAt: '2026-08-11T00:00:00.000Z',
        processBirth: 'dead-birth',
      })}\n`,
    );
    const legacyJobs = new JobQueue(db.handle, String(process.pid + 1000));
    const legacyJobId = legacyJobs.enqueue({
      kind: 'asr',
      idempotencyKey: 'asr:legacy-daemon-death',
      payload: {},
    });
    assert.ok(legacyJobId);
    assert.ok(legacyJobs.claim(['asr']));
    const reclaimed = await claimDaemonPid(db.handle, pidFile, dir, {
      birthMarker: async () => 'birth-2',
      inspect: async () => ({
        alive: false,
        identityMatches: false,
        command: null,
        processBirth: null,
      }),
    });
    assert.equal(reclaimed.reclaimedPreviousDaemon, true);
    assert.equal(reclaimed.reclaimedJobOwner, String(process.pid + 1000));
    assert.equal(reclaimed.reclaimedJobs, 1);
    assert.deepEqual(
      {
        ...(db.handle
          .prepare('SELECT state, attempts, lease_owner FROM jobs WHERE job_id = ?')
          .get(legacyJobId) as Record<string, unknown>),
      },
      { state: 'pending', attempts: 0, lease_owner: null },
    );
    await releaseDaemonPid(db.handle, pidFile, reclaimed);
  });

  it('serializes daemon startup with renewable maintenance and recovers a dead holder', async () => {
    const pidFile = join(dir, 'daemon.pid');
    await assert.rejects(
      claimDaemonMaintenance(db.handle, pidFile, dir, { birthMarker: async () => null }),
      /could not establish maintenance process birth identity/,
    );
    assert.equal(readDaemonOwnership(db.handle, dir), null);

    const maintenanceBirth = 'maintenance-birth';
    const maintenance = await claimDaemonMaintenance(db.handle, pidFile, dir, {
      birthMarker: async () => maintenanceBirth,
    });
    assert.equal(existsSync(pidFile), false, 'maintenance must not publish a daemon PID mirror');
    assert.equal(renewDaemonMaintenance(db.handle, maintenance), true);
    assertCurrentDaemonMaintenance(db.handle, maintenance);
    const lostGeneration = { ...maintenance, processBirth: 'not-the-current-generation' };
    assert.equal(renewDaemonMaintenance(db.handle, lostGeneration), false);
    assert.throws(
      () => assertCurrentDaemonMaintenance(db.handle, lostGeneration),
      /maintenance ownership was lost/,
    );

    await assert.rejects(
      claimDaemonPid(db.handle, pidFile, dir, {
        birthMarker: async () => 'blocked-daemon-birth',
        inspect: async (_pid, expectedBirth) => ({
          alive: true,
          identityMatches: false,
          command: 'pnpm openmurmur setup telegram owner',
          processBirth: expectedBirth,
        }),
      }),
      /maintenance operation is still active/,
    );
    db.handle
      .prepare('UPDATE daemon_ownership SET claimed_at = ? WHERE ownership_id = 1')
      .run('1970-01-01T00:00:00.000Z');
    const exactLiveInspect = async () => ({
      alive: true,
      identityMatches: false,
      command: null,
      processBirth: maintenanceBirth,
    });
    await assert.rejects(
      claimDaemonPid(db.handle, pidFile, dir, {
        birthMarker: async () => 'after-renewal-failure-daemon-birth',
        inspect: exactLiveInspect,
      }),
      /maintenance operation is still active/,
    );
    assert.equal(await releaseDaemonMaintenance(db.handle, pidFile, maintenance), true);

    const afterAction = await claimDaemonPid(db.handle, pidFile, dir, {
      birthMarker: async () => 'after-action-daemon-birth',
    });
    assert.equal(afterAction.reclaimedPreviousDaemon, false);
    await releaseDaemonPid(db.handle, pidFile, afterAction);

    const staleMaintenance = await claimDaemonMaintenance(db.handle, pidFile, dir, {
      birthMarker: async () => 'dead-maintenance-birth',
    });
    const afterProcessDeath = await claimDaemonPid(db.handle, pidFile, dir, {
      birthMarker: async () => 'after-death-daemon-birth',
      inspect: async () => ({
        alive: false,
        identityMatches: false,
        command: null,
        processBirth: null,
      }),
    });
    assert.equal(
      await releaseDaemonMaintenance(db.handle, pidFile, staleMaintenance),
      false,
      'a stale maintenance token must not release its replacement',
    );
    assert.equal(afterProcessDeath.reclaimedPreviousDaemon, false);
    await releaseDaemonPid(db.handle, pidFile, afterProcessDeath);
  });

  it('runs mutating recovery under a distinct exclusive owner and releases it after one repair', async () => {
    const paths = resolvePaths(dir);
    db.close();
    db = openDatabase({ file: paths.databaseFile });
    mkdirSync(paths.tempDir, { recursive: true });
    mkdirSync(paths.audioDir, { recursive: true });
    mkdirSync(paths.runtimeDir, { recursive: true });
    const sessionId = 'recovery-owner-session';
    const at = '2026-08-12T12:00:00.000Z';
    db.handle
      .prepare(
        `INSERT INTO audio_sessions
           (session_id, state, started_at, created_at, updated_at)
         VALUES (?, 'ACTIVE', ?, ?, ?)`,
      )
      .run(sessionId, at, at, at);
    db.handle
      .prepare(
        `INSERT INTO audio_parts
           (part_id, session_id, part_index, path, started_at, ended_at, duration_ms,
            bytes, sha256, finalized, created_at)
         VALUES (?, ?, 0, ?, ?, ?, 1000, 100, 'sha', 1, ?)`,
      )
      .run(`${sessionId}-p0`, sessionId, join(paths.audioDir, 'source.flac'), at, at, at);

    const liveDaemon = await claimDaemonPid(db.handle, paths.pidFile, paths.root, {
      birthMarker: async () => 'live-daemon-birth',
    });
    assert.equal(existsSync(paths.quarantineDir), false);
    await assert.rejects(
      main(['recover', '--yes', '--root', paths.root]),
      /stop[\s\S]*recover --yes[\s\S]*start/,
    );
    assert.equal(
      existsSync(paths.quarantineDir),
      false,
      'a rejected mutating recovery must not create managed directories',
    );
    assert.equal(
      (db.handle.prepare('SELECT state FROM audio_sessions').get() as { state: string }).state,
      'ACTIVE',
    );
    assert.equal(new JobQueue(db.handle).pendingCount(), 0);
    await releaseDaemonPid(db.handle, paths.pidFile, liveDaemon);

    await withStoppedDaemonForRecovery(
      { config: DEFAULT_CONFIG, paths, fromFile: false },
      async (recoveryDb) => {
        const owner = recoveryDb
          .prepare('SELECT process_birth FROM daemon_ownership WHERE ownership_id = 1')
          .get() as { process_birth: string };
        assert.match(owner.process_birth, /^openmurmur-recovery-maintenance:v1:/);

        const aliveMaintenance = async (_pid: number, processBirth: string | null) => ({
          alive: true,
          identityMatches: false,
          command: 'node src/cli/main.ts recover --yes',
          processBirth,
        });
        await assert.rejects(
          claimDaemonPid(db.handle, paths.pidFile, paths.root, {
            birthMarker: async () => 'concurrent-daemon-birth',
            inspect: aliveMaintenance,
          }),
          /maintenance operation is still active/,
        );
        await assert.rejects(
          claimDaemonMaintenance(db.handle, paths.pidFile, paths.root, {
            birthMarker: async () => 'concurrent-telegram-birth',
            inspect: aliveMaintenance,
          }),
          /maintenance operation is still active/,
        );

        const repaired = await recoverAfterCrash(recoveryDb, paths, nullLogger);
        assert.deepEqual(repaired.stalledSessions, [sessionId]);
        const repeated = await recoverAfterCrash(recoveryDb, paths, nullLogger);
        assert.deepEqual(repeated.stalledSessions, []);
      },
      { birthMarker: async () => 'recovery-maintenance-birth' },
    );

    assert.equal(new JobQueue(db.handle).pendingCount('deliver_audio'), 1);
    assert.equal(new JobQueue(db.handle).pendingCount('asr'), 1);
    assert.equal(
      (
        db.handle
          .prepare(
            "SELECT count(*) AS count FROM telegram_outbox WHERE delivery_part_id = 'session-status:finalized:recovery-owner-session'",
          )
          .get() as { count: number }
      ).count,
      1,
    );
    const afterRecovery = await claimDaemonPid(db.handle, paths.pidFile, paths.root, {
      birthMarker: async () => 'after-recovery-daemon-birth',
    });
    assert.equal(afterRecovery.reclaimedPreviousDaemon, false);
    await releaseDaemonPid(db.handle, paths.pidFile, afterRecovery);
  });

  it('never changes predecessor-owned leases while acquiring maintenance', async () => {
    const pidFile = join(dir, 'daemon.pid');
    const cases = [
      {
        kind: 'legacy',
        owner: String(process.pid + 1000),
        predecessor: {
          pid: process.pid + 1000,
          root: dir,
          startedAt: '2026-08-11T00:00:00.000Z',
          processBirth: 'legacy-dead-birth',
        },
      },
      {
        kind: 'sqlite',
        owner: daemonJobOwner({
          pid: process.pid + 2000,
          root: dir,
          startedAt: '2026-08-11T00:01:00.000Z',
          processBirth: 'sqlite-dead-birth',
        }),
        predecessor: {
          pid: process.pid + 2000,
          root: dir,
          startedAt: '2026-08-11T00:01:00.000Z',
          processBirth: 'sqlite-dead-birth',
        },
      },
    ] as const;

    for (const item of cases) {
      if (item.kind === 'legacy') {
        writeFileSync(pidFile, `${JSON.stringify(item.predecessor)}\n`);
      } else {
        db.handle
          .prepare(
            `INSERT INTO daemon_ownership
               (ownership_id, daemon_pid, daemon_root, daemon_started_at, process_birth, claimed_at)
             VALUES (1, ?, ?, ?, ?, ?)`,
          )
          .run(
            item.predecessor.pid,
            item.predecessor.root,
            item.predecessor.startedAt,
            item.predecessor.processBirth,
            item.predecessor.startedAt,
          );
      }
      const jobs = new JobQueue(db.handle, item.owner);
      const jobId = jobs.enqueue({
        kind: 'asr',
        idempotencyKey: `maintenance-predecessor:${item.kind}`,
        payload: {},
      });
      assert.ok(jobId);
      assert.ok(jobs.claim(['asr'], 10 * 60_000));
      const before = db.handle.prepare('SELECT * FROM jobs WHERE job_id = ?').get(jobId);

      await assert.rejects(
        claimDaemonMaintenance(db.handle, pidFile, dir, {
          birthMarker: async () => 'maintenance-birth',
          inspect: async () => ({
            alive: false,
            identityMatches: false,
            command: null,
            processBirth: null,
          }),
        }),
        /start OpenMurmur once to recover jobs/,
      );
      assert.deepEqual(db.handle.prepare('SELECT * FROM jobs WHERE job_id = ?').get(jobId), before);
      assert.deepEqual(
        item.kind === 'legacy' ? await readDaemonPid(pidFile) : readDaemonOwnership(db.handle, dir),
        item.predecessor,
      );

      db.handle.prepare('DELETE FROM jobs WHERE job_id = ?').run(jobId);
      if (item.kind === 'legacy') rmSync(pidFile, { force: true });
      else db.handle.prepare('DELETE FROM daemon_ownership').run();
    }
  });

  it('lets only one concurrent claimant replace a proven-dead daemon', async () => {
    const pidFile = join(dir, 'daemon.pid');
    const oldOwner = {
      pid: process.pid + 1000,
      root: dir,
      startedAt: '2026-08-11T00:00:00.000Z',
      processBirth: 'dead-birth',
    };
    db.handle
      .prepare(
        `INSERT INTO daemon_ownership
           (ownership_id, daemon_pid, daemon_root, daemon_started_at, process_birth, claimed_at)
         VALUES (1, ?, ?, ?, ?, ?)`,
      )
      .run(
        oldOwner.pid,
        oldOwner.root,
        oldOwner.startedAt,
        oldOwner.processBirth,
        oldOwner.startedAt,
      );
    writeFileSync(pidFile, `${JSON.stringify(oldOwner)}\n`);

    const competingDb = openDatabase({ file: join(dir, 'test.db') });
    let inspectedDeadOwner = 0;
    let releaseInspections: (() => void) | undefined;
    const bothInspected = new Promise<void>((resolve) => {
      releaseInspections = resolve;
    });
    const inspect = async (_pid: number, processBirth: string | null) => {
      if (processBirth === 'dead-birth') {
        inspectedDeadOwner += 1;
        if (inspectedDeadOwner === 2) releaseInspections?.();
        await bothInspected;
        return {
          alive: false,
          identityMatches: false,
          command: null,
          processBirth: null,
        };
      }
      return {
        alive: true,
        identityMatches: true,
        command: '/opt/openmurmur start',
        processBirth,
      };
    };

    try {
      const claims = await Promise.allSettled([
        claimDaemonPid(db.handle, pidFile, dir, {
          birthMarker: async () => 'claim-a',
          inspect,
        }),
        claimDaemonPid(competingDb.handle, pidFile, dir, {
          birthMarker: async () => 'claim-b',
          inspect,
        }),
      ]);
      const winners = claims.filter(
        (claim): claim is PromiseFulfilledResult<Awaited<ReturnType<typeof claimDaemonPid>>> =>
          claim.status === 'fulfilled',
      );
      assert.equal(winners.length, 1, 'SQLite CAS must elect exactly one daemon owner');
      assert.equal(claims.filter((claim) => claim.status === 'rejected').length, 1);

      const winner = winners[0]?.value;
      assert.ok(winner);
      assert.equal(winner.reclaimedJobOwner, daemonJobOwner(oldOwner));
      assert.equal((await readDaemonPid(pidFile))?.processBirth, winner.processBirth);
      const winnerDb = winner.processBirth === 'claim-a' ? db : competingDb;
      await releaseDaemonPid(winnerDb.handle, pidFile, winner);
    } finally {
      competingDb.close();
    }
  });

  it('never removes or signals from a stale mirror after SQLite ownership changes', async () => {
    const pidFile = join(dir, 'daemon.pid');
    const oldOwner = {
      pid: process.pid + 1000,
      root: dir,
      startedAt: '2026-08-11T00:00:00.000Z',
      processBirth: 'old-birth',
    };
    const newOwner = {
      pid: process.pid + 2000,
      root: dir,
      startedAt: '2026-08-11T00:01:00.000Z',
      processBirth: 'new-birth',
    };
    db.handle
      .prepare(
        `INSERT INTO daemon_ownership
           (ownership_id, daemon_pid, daemon_root, daemon_started_at, process_birth, claimed_at)
         VALUES (1, ?, ?, ?, ?, ?)`,
      )
      .run(
        oldOwner.pid,
        oldOwner.root,
        oldOwner.startedAt,
        oldOwner.processBirth,
        oldOwner.startedAt,
      );
    writeFileSync(pidFile, `${JSON.stringify(oldOwner)}\n`);

    const signalled: number[] = [];
    const result = await stopOwnedDaemon(db.handle, pidFile, dir, {
      inspect: async (pid) => {
        if (pid === oldOwner.pid) {
          db.handle
            .prepare(
              `UPDATE daemon_ownership
                  SET daemon_pid = ?, daemon_root = ?, daemon_started_at = ?,
                      process_birth = ?, claimed_at = ?
                WHERE ownership_id = 1`,
            )
            .run(
              newOwner.pid,
              newOwner.root,
              newOwner.startedAt,
              newOwner.processBirth,
              newOwner.startedAt,
            );
          writeFileSync(pidFile, `${JSON.stringify(newOwner)}\n`);
          return {
            alive: false,
            identityMatches: false,
            command: null,
            processBirth: null,
          };
        }
        return {
          alive: true,
          identityMatches: true,
          command: '/opt/openmurmur start',
          processBirth: newOwner.processBirth,
        };
      },
      signal: (pid) => signalled.push(pid),
    });

    assert.deepEqual(result, { outcome: 'signalled', pid: newOwner.pid });
    assert.deepEqual(signalled, [newOwner.pid]);
    assert.deepEqual(readDaemonOwnership(db.handle, dir), newOwner);
    assert.deepEqual(await readDaemonPid(pidFile), newOwner);
  });

  it('refuses an ownership bootstrap while an unexpired legacy lease is ambiguous', async () => {
    const jobs = new JobQueue(db.handle);
    jobs.enqueue({ kind: 'asr', idempotencyKey: 'asr:legacy-live', payload: {} });
    assert.ok(jobs.claim(['asr'], 10 * 60_000));

    await assert.rejects(
      inspectDaemonControl(db.handle, join(dir, 'missing.pid'), dir),
      /unexpired work leases make legacy daemon ownership ambiguous/,
    );
    await assert.rejects(
      claimDaemonPid(db.handle, join(dir, 'missing.pid'), dir, {
        birthMarker: async () => 'new-birth',
      }),
      /unexpired work leases make legacy daemon ownership ambiguous/,
    );
    assert.equal(readDaemonOwnership(db.handle, dir), null);
  });

  it('fails closed on semantically invalid stored ownership', async () => {
    db.handle
      .prepare(
        `INSERT INTO daemon_ownership
           (ownership_id, daemon_pid, daemon_root, daemon_started_at, process_birth, claimed_at)
         VALUES (1, ?, ?, 'not-a-time', 'birth', 'also-not-a-time')`,
      )
      .run(process.pid + 1000, dir);

    await assert.rejects(
      claimDaemonPid(db.handle, join(dir, 'daemon.pid'), dir, {
        birthMarker: async () => 'new-birth',
      }),
      /timestamps are not canonical UTC instants/,
    );
  });

  it('does not replace corrupt ownership over a conflicting live generation', async () => {
    const pidFile = join(dir, 'daemon.pid');
    const stale = {
      pid: process.pid + 1000,
      root: dir,
      startedAt: '2026-08-11T00:00:00.000Z',
      processBirth: 'stale-birth',
    };
    const live = {
      pid: process.pid + 2000,
      root: dir,
      startedAt: '2026-08-11T00:01:00.000Z',
      processBirth: 'live-birth',
    };
    db.handle
      .prepare(
        `INSERT INTO daemon_ownership
           (ownership_id, daemon_pid, daemon_root, daemon_started_at, process_birth, claimed_at)
         VALUES (1, ?, ?, ?, ?, ?)`,
      )
      .run(stale.pid, stale.root, stale.startedAt, stale.processBirth, stale.startedAt);
    db.handle
      .prepare(
        `INSERT INTO daemon_heartbeat
           (heartbeat_id, daemon_pid, daemon_started_at, recorder_running, session_state,
            last_source_frame_age_ms, processing_lag_ms, updated_at)
         VALUES (1, ?, ?, 1, 'ACTIVE', 0, 0, ?)`,
      )
      .run(live.pid, live.startedAt, live.startedAt);
    writeFileSync(pidFile, `${JSON.stringify(live)}\n`);
    const jobs = new JobQueue(db.handle);
    jobs.enqueue({ kind: 'asr', idempotencyKey: 'asr:live-generation', payload: {} });
    const leased = jobs.claim(['asr'], 10 * 60_000);
    assert.ok(leased);

    await assert.rejects(
      claimDaemonPid(db.handle, pidFile, dir, {
        birthMarker: async () => 'replacement-birth',
        inspect: async (pid, processBirth) => ({
          alive: pid === live.pid,
          identityMatches: pid === live.pid,
          command: pid === live.pid ? '/opt/openmurmur start' : null,
          processBirth: pid === live.pid ? processBirth : null,
        }),
      }),
      /another live daemon/,
    );
    assert.deepEqual(readDaemonOwnership(db.handle, dir), stale);
    assert.equal(jobs.renew(leased, 10 * 60_000), true);
  });

  it('does not overwrite a daemon mirror published after conflict inspection', async () => {
    const pidFile = join(dir, 'daemon.pid');
    const stale = {
      pid: process.pid + 1000,
      root: dir,
      startedAt: '2026-08-11T00:00:00.000Z',
      processBirth: 'stale-birth',
    };
    const live = {
      pid: process.pid + 2000,
      root: dir,
      startedAt: '2026-08-11T00:01:00.000Z',
      processBirth: 'live-birth',
    };
    db.handle
      .prepare(
        `INSERT INTO daemon_ownership
           (ownership_id, daemon_pid, daemon_root, daemon_started_at, process_birth, claimed_at)
         VALUES (1, ?, ?, ?, ?, ?)`,
      )
      .run(stale.pid, stale.root, stale.startedAt, stale.processBirth, stale.startedAt);
    writeFileSync(pidFile, `${JSON.stringify(stale)}\n`);
    const liveJobs = new JobQueue(db.handle, String(live.pid));
    liveJobs.enqueue({ kind: 'asr', idempotencyKey: 'asr:late-live-mirror', payload: {} });
    const liveLease = liveJobs.claim(['asr'], 10 * 60_000);
    assert.ok(liveLease);

    await assert.rejects(
      claimDaemonPid(db.handle, pidFile, dir, {
        birthMarker: async () => 'replacement-birth',
        inspect: async () => ({
          alive: false,
          identityMatches: false,
          command: null,
          processBirth: null,
        }),
        beforeMirrorPublish: () => writeFileSync(pidFile, `${JSON.stringify(live)}\n`),
      }),
      /EEXIST/,
    );

    assert.equal(readDaemonOwnership(db.handle, dir), null);
    assert.deepEqual(await readDaemonPid(pidFile), live);
    assert.equal(liveJobs.renew(liveLease, 10 * 60_000), true);
  });
});

describe('incoming Telegram retry identity', () => {
  it('claims direct provenance before atomically queueing the job and acknowledgement', () => {
    const message = {
      message_id: 10,
      date: Date.parse('2025-08-09T12:00:00.000Z') / 1000,
      chat: { id: 42, type: 'private' },
      audio: {
        file_id: 'telegram-file-direct',
        file_unique_id: 'telegram-unique-direct',
        file_name: 'meeting <one>.mp3',
        mime_type: 'audio/mpeg',
      },
    };
    assert.equal(recordUpdate(db.handle, 501, 'audio'), true);

    const claimed = enqueueIncomingRequest(
      db.handle,
      501,
      message,
      'capture-mac',
      'legacy',
      'Thai',
    );

    assert.equal(claimed.telegramSource, 'direct');
    assert.equal(claimed.originalSentAt, null);
    assert.equal(claimed.telegramMessageAt, '2025-08-09T12:00:00.000Z');
    assert.equal(claimed.claimedFilename, 'meeting <one>.mp3');
    assert.equal(claimed.daemonHost, 'capture-mac');
    const job = db.handle
      .prepare("SELECT payload FROM jobs WHERE idempotency_key = 'incoming:501'")
      .get() as { payload: string };
    const jobPayload = JSON.parse(job.payload) as {
      fileUid: string;
      forcedLanguage: string | null;
    };
    assert.equal(jobPayload.fileUid, claimed.fileUid);
    assert.equal(jobPayload.forcedLanguage, 'Thai');
    const ack = db.handle
      .prepare("SELECT payload FROM telegram_outbox WHERE delivery_part_id = 'ack:501'")
      .get() as { payload: string };
    const ackText = (JSON.parse(ack.payload) as { text: string }).text;
    assert.match(ackText, /загруженное аудио из Telegram/);
    assert.match(ackText, /capture-mac/);
    assert.match(ackText, new RegExp(claimed.fileUid));
    const update = db.handle
      .prepare('SELECT handled FROM telegram_updates WHERE update_id = 501')
      .get() as { handled: number };
    assert.equal(update.handled, 1);

    enqueueIncomingRequest(db.handle, 501, message, 'different-host-on-replay');
    const jobCount = db.handle
      .prepare("SELECT count(*) AS count FROM jobs WHERE idempotency_key = 'incoming:501'")
      .get() as { count: number };
    assert.equal(jobCount.count, 1);
    assert.equal(findIncomingFile(db.handle, 'telegram-unique-direct')?.daemonHost, 'capture-mac');
  });

  it('keeps message and original dates distinct for every forwarded origin variant', () => {
    const originTypes = ['user', 'hidden_user', 'chat', 'channel'] as const;
    for (const [index, type] of originTypes.entries()) {
      const updateId = 600 + index;
      const message = {
        message_id: 20 + index,
        date: Date.parse('2025-08-09T12:00:00.000Z') / 1000,
        chat: { id: 42, type: 'private' },
        forward_origin: {
          type,
          date: Date.parse('2025-08-08T12:00:00.000Z') / 1000,
        },
        voice: {
          file_id: `telegram-file-${type}`,
          file_unique_id: `telegram-unique-${type}`,
        },
      };
      assert.equal(recordUpdate(db.handle, updateId, 'audio'), true);

      const claimed = enqueueIncomingRequest(db.handle, updateId, message, 'forward-host');

      assert.equal(claimed.telegramSource, 'forwarded');
      assert.equal(claimed.telegramMessageAt, '2025-08-09T12:00:00.000Z');
      assert.equal(claimed.originalSentAt, '2025-08-08T12:00:00.000Z');
      assert.equal(claimed.updateId, updateId);
    }
  });

  it('does not collide incoming work when another bot reuses an update id', () => {
    const firstMessage = {
      message_id: 40,
      date: Date.parse('2025-08-09T12:00:00.000Z') / 1000,
      chat: { id: 42, type: 'private' },
      voice: { file_id: 'bot-a-file', file_unique_id: 'shared-unique' },
    };
    const secondMessage = {
      ...firstMessage,
      message_id: 41,
      voice: { file_id: 'bot-b-file', file_unique_id: 'shared-unique' },
    };
    assert.equal(recordUpdate(db.handle, 800, 'audio', 'bot-a'), true);
    assert.equal(recordUpdate(db.handle, 800, 'audio', 'bot-b'), true);

    const first = enqueueIncomingRequest(db.handle, 800, firstMessage, 'host-a', 'bot-a');
    const second = enqueueIncomingRequest(db.handle, 800, secondMessage, 'host-b', 'bot-b');

    assert.notEqual(first.fileUid, second.fileUid);
    assert.equal(first.botScope, 'bot-a');
    assert.equal(second.botScope, 'bot-b');
    const jobs = db.handle
      .prepare(
        "SELECT idempotency_key FROM jobs WHERE kind = 'incoming_audio' ORDER BY idempotency_key",
      )
      .all() as { idempotency_key: string }[];
    assert.deepEqual(
      jobs.map((row) => row.idempotency_key),
      ['incoming:bot-a:800', 'incoming:bot-b:800'],
    );

    const outbox = new Outbox(db.handle);
    const enqueueRejection = (fileUid: string) =>
      outbox.enqueue({
        deliveryPartId: incomingRejectionDeliveryPartId(fileUid),
        kind: 'status',
        ordinal: 1,
        payload: { type: 'text', text: 'bounded rejection' },
      });
    assert.equal(enqueueRejection(first.fileUid), true);
    assert.equal(enqueueRejection(second.fileUid), true);
    assert.equal(enqueueRejection(first.fileUid), false, 'one scoped rejection stays idempotent');
    assert.deepEqual(
      db.handle
        .prepare(
          "SELECT delivery_part_id FROM telegram_outbox WHERE delivery_part_id GLOB 'reject:*'",
        )
        .all()
        .map((row) => (row as { delivery_part_id: string }).delivery_part_id)
        .sort(),
      [
        incomingRejectionDeliveryPartId(first.fileUid),
        incomingRejectionDeliveryPartId(second.fileUid),
      ].sort(),
    );
  });

  it('rolls back the claim and job when acknowledgement enqueue fails', () => {
    const message = {
      message_id: 30,
      date: Date.parse('2025-08-09T12:00:00.000Z') / 1000,
      chat: { id: 42, type: 'private' },
      voice: { file_id: 'rollback-file', file_unique_id: 'rollback-unique' },
    };
    assert.equal(recordUpdate(db.handle, 700, 'audio'), true);
    db.handle.exec(`CREATE TRIGGER fail_incoming_ack
      BEFORE INSERT ON telegram_outbox
      WHEN NEW.delivery_part_id = 'ack:700'
      BEGIN SELECT RAISE(ABORT, 'simulated ack failure'); END`);

    assert.throws(
      () => enqueueIncomingRequest(db.handle, 700, message, 'rollback-host'),
      /simulated ack failure/,
    );

    assert.equal(findIncomingFile(db.handle, 'rollback-unique'), undefined);
    const jobCount = db.handle
      .prepare("SELECT count(*) AS count FROM jobs WHERE idempotency_key = 'incoming:700'")
      .get() as { count: number };
    assert.equal(jobCount.count, 0);
    const update = db.handle
      .prepare('SELECT handled FROM telegram_updates WHERE update_id = 700')
      .get() as { handled: number };
    assert.equal(update.handled, 0);
  });

  it('keeps one file_uid for every telegram_unique_id across retries', () => {
    const attachment = {
      fileId: 'telegram-file-1',
      fileUniqueId: 'stable-telegram-id',
      declaredBytes: 12,
      declaredMime: 'audio/ogg',
      declaredDurationSeconds: 1,
      claimedFilename: 'voice.ogg',
      source: 'voice' as const,
    };
    const message = {
      message_id: 10,
      date: 0,
      chat: { id: 42, type: 'private' },
      voice: {
        file_id: attachment.fileId,
        file_unique_id: attachment.fileUniqueId,
      },
    };

    const first = recordIncomingDownload(db.handle, {
      attachment,
      message,
      downloaded: { fileUid: 'our-id-1', path: join(dir, 'first.ogg'), actualBytes: 12 },
    });
    const retry = recordIncomingDownload(db.handle, {
      attachment,
      message,
      downloaded: { fileUid: 'our-id-2', path: join(dir, 'retry.ogg'), actualBytes: 12 },
    });

    assert.equal(first.fileUid, 'our-id-1');
    assert.equal(retry.fileUid, 'our-id-1');
    assert.equal(findIncomingFile(db.handle, attachment.fileUniqueId)?.fileUid, 'our-id-1');
    const count = db.handle
      .prepare('SELECT count(*) AS count FROM incoming_telegram_files')
      .get() as {
      count: number;
    };
    assert.equal(count.count, 1);
  });

  it('reserves normalized ownership before publication and keeps it across restart', () => {
    const message = {
      message_id: 11,
      date: 0,
      chat: { id: 42, type: 'private' },
      voice: { file_id: 'atomic-file', file_unique_id: 'atomic-unique' },
    };
    const incoming = claimIncomingRequest(db.handle, 11, message, 'test-host');
    assert.ok(incoming);
    const files = new IncomingFileRepository(db.handle);
    const quarantinePath = join(dir, `${incoming.fileUid}.ogg`);
    const normalizedPath = join(dir, `${incoming.fileUid}.16k.wav`);
    files.markDownloaded(incoming.fileUid, quarantinePath, 12);
    files.reserveNormalizedPath(incoming.fileUid, normalizedPath);

    db.close();
    db = openDatabase({ file: join(dir, 'test.db') });
    assert.equal(
      new IncomingFileRepository(db.handle).get(incoming.fileUid)?.normalizedPath,
      normalizedPath,
    );
  });

  it('rolls back transcript state and outbox together, then retries once', () => {
    const message = {
      message_id: 12,
      date: 0,
      chat: { id: 42, type: 'private' },
      voice: { file_id: 'atomic-file', file_unique_id: 'atomic-unique' },
    };
    const incoming = claimIncomingRequest(db.handle, 12, message, 'test-host');
    assert.ok(incoming);
    const files = new IncomingFileRepository(db.handle);
    const quarantinePath = join(dir, `${incoming.fileUid}.ogg`);
    const normalizedPath = join(dir, `${incoming.fileUid}.16k.wav`);
    files.markDownloaded(incoming.fileUid, quarantinePath, 12);
    files.reserveNormalizedPath(incoming.fileUid, normalizedPath);
    files.markNormalized(incoming.fileUid, normalizedPath, 'ogg', 1_000);
    db.handle.exec(`CREATE TRIGGER fail_incoming_outbox
      BEFORE INSERT ON telegram_outbox
      WHEN NEW.delivery_part_id = 'incoming:${incoming.fileUid}:1'
      BEGIN SELECT RAISE(ABORT, 'simulated incoming outbox failure'); END`);

    const append = () =>
      appendIncomingTranscript(
        db.handle,
        {
          incomingFileId: incoming.fileUid,
          engine: 'fake',
          model: 'fake',
          languages: ['en'],
          text: 'hello',
          segments: [],
        },
        () => {
          new Outbox(db.handle).enqueue({
            deliveryPartId: `incoming:${incoming.fileUid}:1`,
            kind: 'incoming_transcript',
            ordinal: 10,
            payload: { type: 'text', text: 'hello' },
          });
        },
      );

    assert.throws(append, /simulated incoming outbox failure/);
    files.markFailedIfUntranscribed(incoming.fileUid);
    assert.equal(
      (
        db.handle
          .prepare('SELECT count(*) AS count FROM transcript_revisions WHERE incoming_file_id = ?')
          .get(incoming.fileUid) as { count: number }
      ).count,
      0,
    );
    assert.deepEqual(
      { ...files.get(incoming.fileUid) },
      {
        ...incoming,
        state: 'failed',
        quarantinePath,
        normalizedPath,
      },
      'the retry retains exact DB ownership of both audio files',
    );
    assert.equal(
      (
        db.handle
          .prepare(
            "SELECT count(*) AS count FROM telegram_outbox WHERE kind = 'incoming_transcript'",
          )
          .get() as { count: number }
      ).count,
      0,
    );

    db.handle.exec('DROP TRIGGER fail_incoming_outbox');
    assert.doesNotThrow(append);
    files.markFailedIfUntranscribed(incoming.fileUid);
    assert.equal(files.get(incoming.fileUid)?.state, 'transcribed');
    assert.equal(markExhaustedIncomingFile(db.handle, { fileUid: incoming.fileUid }), false);
    assert.equal(files.get(incoming.fileUid)?.normalizedPath, normalizedPath);
    assert.equal(
      (
        db.handle
          .prepare('SELECT count(*) AS count FROM transcript_revisions WHERE incoming_file_id = ?')
          .get(incoming.fileUid) as { count: number }
      ).count,
      1,
    );
    assert.equal(
      (
        db.handle
          .prepare(
            "SELECT count(*) AS count FROM telegram_outbox WHERE kind = 'incoming_transcript'",
          )
          .get() as { count: number }
      ).count,
      1,
    );
  });

  it('marks incoming audio delivered only after every transcript chunk is sent', () => {
    const now = new Date().toISOString();
    db.handle
      .prepare(
        `INSERT INTO incoming_telegram_files
           (file_uid, telegram_file_id, telegram_unique_id, chat_id, message_id,
            state, created_at, updated_at)
         VALUES ('file:with-colon', 'f', 'u', 42, 1, 'transcribed', ?, ?)`,
      )
      .run(now, now);
    for (const part of [1, 2]) {
      db.handle
        .prepare(
          `INSERT INTO telegram_outbox
             (outbox_id, delivery_part_id, kind, ordinal, payload, state,
              run_after, created_at, updated_at)
           VALUES (?, ?, 'incoming_transcript', 10, '{}', ?, ?, ?, ?)`,
        )
        .run(
          `o${part}`,
          `incoming:file:with-colon:${part}`,
          part === 1 ? 'sent' : 'pending',
          now,
          now,
          now,
        );
    }

    assert.equal(incomingFileUidFromDeliveryPart('incoming:file:with-colon:2'), 'file:with-colon');
    reconcileIncomingDelivery(db.handle, 'file:with-colon');
    let row = db.handle
      .prepare('SELECT state FROM incoming_telegram_files WHERE file_uid = ?')
      .get('file:with-colon') as { state: string };
    assert.equal(row.state, 'transcribed');

    db.handle.prepare("UPDATE telegram_outbox SET state = 'sent'").run();
    reconcileIncomingDelivery(db.handle, 'file:with-colon');
    row = db.handle
      .prepare('SELECT state FROM incoming_telegram_files WHERE file_uid = ?')
      .get('file:with-colon') as { state: string };
    assert.equal(row.state, 'delivered');
  });
});

describe('daemon terminal state reconciliation', () => {
  it('does not clear a worker failure while the replacement model is still loading', () => {
    assert.equal(asrWorkerAlertActive(false, false), true);
    assert.equal(asrWorkerAlertActive(false, true), null);
    assert.equal(asrWorkerAlertActive(true, false), false);
  });

  it('retires prior-run notices and preserves current and durable session statuses', () => {
    const outbox = new Outbox(db.handle);
    for (const deliveryPartId of [
      'notice:shutdown:old-pending',
      'notice:shutdown:old-sending',
      'notice:recording:old',
      'session-status:finalized:session-1',
    ]) {
      outbox.enqueue({
        deliveryPartId,
        kind: 'status',
        ordinal: 1,
        payload: { type: 'text', text: deliveryPartId },
      });
    }
    db.handle
      .prepare(
        `UPDATE telegram_outbox SET state = 'sending'
          WHERE delivery_part_id = 'notice:shutdown:old-sending'`,
      )
      .run();
    const cutoff = new Date(Date.now() + 1000).toISOString();
    outbox.enqueue({
      deliveryPartId: 'notice:recovery:current',
      kind: 'status',
      ordinal: 1,
      payload: { type: 'text', text: 'current startup notice' },
    });
    db.handle
      .prepare(
        `UPDATE telegram_outbox SET created_at = ?
          WHERE delivery_part_id = 'notice:recovery:current'`,
      )
      .run(cutoff);

    assert.equal(retireStaleNotices(db.handle, cutoff, 'superseded by startup'), 3);

    const rows = db.handle
      .prepare(
        `SELECT delivery_part_id, state, last_error
           FROM telegram_outbox ORDER BY delivery_part_id`,
      )
      .all() as unknown as { delivery_part_id: string; state: string; last_error: string | null }[];
    assert.deepEqual(
      rows.map((row) => ({ ...row })),
      [
        {
          delivery_part_id: 'notice:recording:old',
          state: 'failed',
          last_error: 'superseded by startup',
        },
        {
          delivery_part_id: 'notice:recovery:current',
          state: 'pending',
          last_error: null,
        },
        {
          delivery_part_id: 'notice:shutdown:old-pending',
          state: 'failed',
          last_error: 'superseded by startup',
        },
        {
          delivery_part_id: 'notice:shutdown:old-sending',
          state: 'failed',
          last_error: 'superseded by startup',
        },
        {
          delivery_part_id: 'session-status:finalized:session-1',
          state: 'pending',
          last_error: null,
        },
      ],
    );
  });

  it('collapses failed capture generations into one incident until real-frame recovery', async () => {
    const outbox = new Outbox(db.handle);
    const firstFailureAt = Date.parse('2026-08-12T10:20:30.000Z');

    for (const legacyGeneration of ['old-a', 'old-b']) {
      outbox.enqueue({
        deliveryPartId: `capture-failure:${legacyGeneration}`,
        kind: 'status',
        ordinal: 1,
        payload: { type: 'text', text: 'legacy capture failure' },
      });
    }

    const restartCutoff = new Date(firstFailureAt - 1000).toISOString();
    db.handle
      .prepare(
        `UPDATE telegram_outbox SET created_at = ?, updated_at = ?
          WHERE delivery_part_id GLOB 'capture-failure:*'`,
      )
      .run(restartCutoff, restartCutoff);

    for (let generation = 0; generation < 3; generation += 1) {
      const now = firstFailureAt + generation * 31_000;
      const alerts = new AlertEvaluator(db.handle, { cooldownMinutes: 30, now: () => now });
      recordCaptureAvailabilityAlert(alerts, outbox, true, generation > 0, now);
    }

    assert.equal(outbox.recoverSending(), 0);
    assert.equal(retireStaleNotices(db.handle, new Date(firstFailureAt).toISOString()), 2);
    assert.equal(
      db.handle
        .prepare(
          "SELECT COUNT(*) AS count FROM telegram_outbox WHERE delivery_part_id GLOB 'capture-failure:*' AND state = 'failed'",
        )
        .get()?.['count'],
      2,
    );

    const raised = db.handle
      .prepare(
        `SELECT outbox_id, state, attempts, payload, last_error
           FROM telegram_outbox
          WHERE delivery_part_id GLOB 'alert:capture_failed:raise:*'`,
      )
      .all() as {
      outbox_id: string;
      state: string;
      attempts: number;
      payload: string;
      last_error: string | null;
    }[];
    assert.equal(raised.length, 1, 'continuous launchd failures are one durable incident');
    assert.equal(raised[0]?.state, 'pending');
    assert.equal(raised[0]?.attempts, 0);
    assert.equal(raised[0]?.last_error, null);
    assert.deepEqual(JSON.parse(raised[0]?.payload ?? ''), {
      type: 'text',
      text:
        '🔴 Запись не запустилась\n\n' +
        'Не удалось получать аудио с микрофона.\n' +
        `Проверьте доступ к микрофону и запустите \`pnpm openmurmur --root "\${OPENMURMUR_STATE_ROOT:?set exact daemon state root locally}" doctor\` в корне репозитория.\n` +
        'Технические подробности сохранены в локальном журнале.',
    });
    assert.doesNotMatch(raised[0]?.payload ?? '', /CaptureError|ffmpeg|\/private\//u);

    const recoveredAt = firstFailureAt + 120_000;
    const recoveryAlerts = new AlertEvaluator(db.handle, {
      cooldownMinutes: 30,
      now: () => recoveredAt,
    });
    assert.equal(
      recordCaptureAvailabilityAlert(recoveryAlerts, outbox, false, true, recoveredAt).transition,
      'cleared',
    );
    assert.equal(
      shouldSendRecordingStartedNotice({ send: true, transition: 'cleared' }),
      false,
      'the durable capture recovery edge replaces the ordinary first-frame green notice',
    );
    assert.equal(
      shouldSendRecordingStartedNotice({ send: false, transition: 'none' }),
      true,
      'a normal first frame still gets the ordinary green notice',
    );
    assert.equal(
      shouldSendRecordingStartedNotice(null),
      false,
      'a failed durable clear must not split from an independently committed green notice',
    );
    assert.equal(
      recordCaptureAvailabilityAlert(recoveryAlerts, outbox, false, true, recoveredAt).transition,
      'none',
    );

    const secondFailureAt = recoveredAt + 60_000;
    const nextAlerts = new AlertEvaluator(db.handle, {
      cooldownMinutes: 30,
      now: () => secondFailureAt,
    });
    assert.equal(
      recordCaptureAvailabilityAlert(nextAlerts, outbox, true, true, secondFailureAt).transition,
      'raised',
    );

    const counts = db.handle
      .prepare(
        `SELECT
           SUM(delivery_part_id GLOB 'alert:capture_failed:raise:*') AS raises,
           SUM(delivery_part_id GLOB 'alert:capture_failed:clear:*') AS clears
         FROM telegram_outbox`,
      )
      .get() as { raises: number; clears: number };
    assert.deepEqual({ ...counts }, { raises: 2, clears: 1 });

    const requests: string[] = [];
    const client = new TelegramClient({
      token: 'test-token',
      baseUrl: 'https://api.telegram.org',
      fetchImpl: (async (input: string | URL | Request) => {
        requests.push(String(input));
        return new Response(
          JSON.stringify({
            ok: true,
            result: { message_id: 77, date: 0, chat: { id: 42, type: 'private' } },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }) as typeof fetch,
    });
    const deps = {
      outbox: new Outbox(db.handle),
      client,
      chatId: 42,
      logger: nullLogger,
      maxOutgoingBytes: 50 * 1024 * 1024,
    };

    assert.equal(await drainOutbox(deps), 3);
    assert.equal(await drainOutbox(deps), 0);
    assert.equal(requests.length, 3);
    const sent = db.handle
      .prepare(
        `SELECT state, attempts, telegram_message_id
           FROM telegram_outbox WHERE outbox_id = ?`,
      )
      .get(raised[0]?.outbox_id) as {
      state: string;
      attempts: number;
      telegram_message_id: number | null;
    };
    assert.deepEqual({ ...sent }, { state: 'sent', attempts: 1, telegram_message_id: 77 });
  });

  it('keeps a capture incident active when its first-frame clear cannot commit', () => {
    const now = Date.parse('2026-08-12T10:20:30.000Z');
    const alerts = new AlertEvaluator(db.handle, { cooldownMinutes: 30, now: () => now });
    const outbox = new Outbox(db.handle);

    assert.equal(
      recordCaptureAvailabilityAlert(alerts, outbox, true, false, now).transition,
      'raised',
    );
    db.handle.exec(`
      CREATE TRIGGER fail_capture_clear
      BEFORE INSERT ON telegram_outbox
      WHEN NEW.delivery_part_id GLOB 'alert:capture_failed:clear:*'
      BEGIN
        SELECT RAISE(ABORT, 'injected capture clear enqueue failure');
      END;
    `);
    assert.throws(
      () => recordCaptureAvailabilityAlert(alerts, outbox, false, true, now + 1000),
      /injected capture clear enqueue failure/,
    );
    assert.equal(alerts.isActive('capture_failed'), true, 'failed clear rolls back alert state');
    assert.equal(shouldSendRecordingStartedNotice(null), false);
    assert.equal(
      db.handle
        .prepare(
          "SELECT COUNT(*) AS count FROM telegram_outbox WHERE payload LIKE '%Запись включена%'",
        )
        .get()?.['count'],
      0,
    );

    db.handle.exec('DROP TRIGGER fail_capture_clear');
    assert.equal(
      recordCaptureAvailabilityAlert(alerts, outbox, true, true, now + 2000).transition,
      'none',
      'a failure before a durable green clear remains the same incident',
    );
    assert.equal(
      db.handle
        .prepare(
          "SELECT COUNT(*) AS count FROM telegram_outbox WHERE delivery_part_id GLOB 'alert:capture_failed:raise:*'",
        )
        .get()?.['count'],
      1,
    );
  });

  it('preserves one count-only recovery notice across a second startup and delivers it once', async () => {
    const generation = '2026-08-12T10:20:30.000Z';
    const sessionId = 'private-session-/private/operator/audio.flac';
    const firstIdentity = {
      pid: 101,
      root: '/private/operator/state',
      startedAt: generation,
      processBirth: 'private-process-birth-a',
    };
    const replacementIdentity = {
      pid: 202,
      root: '/private/operator/state',
      startedAt: '2026-08-12T10:21:00.000Z',
      processBirth: 'private-process-birth-b',
    };
    db.handle
      .prepare(
        `INSERT INTO audio_sessions
           (session_id, state, started_at, created_at, updated_at)
         VALUES (?, 'ACTIVE', ?, ?, ?)`,
      )
      .run(sessionId, generation, generation, generation);

    const firstPreview = await recoverAfterCrash(db.handle, resolvePaths(dir), nullLogger, {
      remove: false,
      repair: false,
    });
    assert.deepEqual(firstPreview.stalledSessions, [sessionId]);

    const outbox = new Outbox(db.handle);
    assert.equal(enqueueRecoveryNotice(db.handle, outbox, firstIdentity, firstPreview), true);
    assert.equal(
      (db.handle.prepare('SELECT state FROM audio_sessions').get() as { state: string }).state,
      'ACTIVE',
      'the durable notice must precede every recovery mutation',
    );
    db.handle.exec(`
      CREATE TRIGGER fail_recovery_after_notice
      BEFORE UPDATE OF state ON audio_sessions
      WHEN OLD.session_id = '${sessionId.replaceAll("'", "''")}'
      BEGIN
        SELECT RAISE(ABORT, 'injected recovery failure after notice');
      END
    `);
    await assert.rejects(
      recoverAfterCrash(db.handle, resolvePaths(dir), nullLogger),
      /injected recovery failure after notice/,
    );
    assert.equal(
      (db.handle.prepare('SELECT state FROM audio_sessions').get() as { state: string }).state,
      'ACTIVE',
    );
    db.handle.exec('DROP TRIGGER fail_recovery_after_notice');

    const replacementPreview = await recoverAfterCrash(db.handle, resolvePaths(dir), nullLogger, {
      remove: false,
      repair: false,
    });
    assert.equal(
      enqueueRecoveryNotice(db.handle, outbox, replacementIdentity, replacementPreview),
      false,
      'the replacement generation must reuse the same unresolved recovery event',
    );

    const repaired = await recoverAfterCrash(db.handle, resolvePaths(dir), nullLogger);
    assert.deepEqual(repaired.stalledSessions, [sessionId]);
    const cleanRestart = await recoverAfterCrash(db.handle, resolvePaths(dir), nullLogger);
    assert.deepEqual(cleanRestart.stalledSessions, []);
    assert.equal(outbox.recoverSending(), 0);
    assert.equal(retireStaleNotices(db.handle, new Date(Date.now() + 1000).toISOString()), 0);

    const pending = db.handle
      .prepare(
        `SELECT outbox_id, delivery_part_id, state, payload
           FROM telegram_outbox WHERE delivery_part_id GLOB 'recovery:*'`,
      )
      .get() as {
      outbox_id: string;
      delivery_part_id: string;
      state: string;
      payload: string;
    };
    assert.equal(pending.state, 'pending');
    assert.match(pending.delivery_part_id, /^recovery:[0-9a-f]{64}:[0-9a-f]{64}$/);
    assert.equal(
      (
        db.handle
          .prepare(
            "SELECT count(*) AS count FROM telegram_outbox WHERE delivery_part_id GLOB 'recovery:*'",
          )
          .get() as { count: number }
      ).count,
      1,
    );
    assert.doesNotMatch(
      `${pending.delivery_part_id}\n${pending.payload}`,
      /private-session|\/private\/operator|audio\.flac|process-birth/u,
    );
    assert.deepEqual(JSON.parse(pending.payload), {
      type: 'text',
      text:
        '🟡 После некорректного завершения обнаружены данные; выполняю локальное восстановление\n\n' +
        'Временных артефактов: 0\n' +
        'Частей для восстановления: 0\n' +
        'Неопубликованных недоступных частей: 0\n' +
        'Незавершённых сессий: 1',
    });

    const requests: string[] = [];
    const client = new TelegramClient({
      token: 'test-token',
      baseUrl: 'https://api.telegram.org',
      fetchImpl: (async (input: string | URL | Request) => {
        requests.push(String(input));
        return new Response(
          JSON.stringify({
            ok: true,
            result: { message_id: 78, date: 0, chat: { id: 42, type: 'private' } },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }) as typeof fetch,
    });
    const restartedOutbox = new Outbox(db.handle);
    const deps = {
      outbox: restartedOutbox,
      client,
      chatId: 42,
      logger: nullLogger,
      maxOutgoingBytes: 50 * 1024 * 1024,
    };

    assert.equal(await drainOutbox(deps), 1);
    assert.equal(await drainOutbox(deps), 0);
    assert.equal(requests.length, 1);
    assert.deepEqual(
      {
        ...db.handle
          .prepare(
            'SELECT state, attempts, telegram_message_id FROM telegram_outbox WHERE outbox_id = ?',
          )
          .get(pending.outbox_id),
      },
      { state: 'sent', attempts: 1, telegram_message_id: 78 },
    );
  });

  it('coalesces pending alerts and never queues a stale delivery-down warning', () => {
    const outbox = new Outbox(db.handle);
    for (const [deliveryPartId, kind] of [
      ['alert:telegram_delivery:raise:1', 'alert'],
      ['alert:telegram_delivery:raise:2', 'alert'],
      ['alert:asr_backlog:raise:1', 'alert'],
      ['notice:recording', 'status'],
    ] as const) {
      outbox.enqueue({
        deliveryPartId,
        kind,
        ordinal: 1,
        payload: { type: 'text', text: deliveryPartId },
      });
    }

    assert.equal(
      retirePendingAlertDeliveries(db.handle, 'telegram_delivery', 'newer state wins'),
      2,
    );
    assert.equal(outbox.stateOf('alert:telegram_delivery:raise:1'), 'failed');
    assert.equal(outbox.stateOf('alert:telegram_delivery:raise:2'), 'failed');
    assert.equal(outbox.stateOf('alert:asr_backlog:raise:1'), 'pending');
    assert.equal(outbox.stateOf('notice:recording'), 'pending');
    assert.equal(shouldEnqueueHealthAlert('telegram_delivery', 'raised'), false);
    assert.equal(shouldEnqueueHealthAlert('telegram_delivery', 'repeated'), false);
    assert.equal(shouldEnqueueHealthAlert('telegram_delivery', 'cleared'), true);
    assert.equal(shouldEnqueueHealthAlert('keychain_unavailable', 'raised'), false);
    assert.equal(shouldEnqueueHealthAlert('keychain_unavailable', 'cleared'), true);
    assert.equal(shouldEnqueueHealthAlert('asr_backlog', 'raised'), true);
  });

  it('persists a Keychain outage and atomically publishes one safe recovery edge', () => {
    const now = Date.parse('2026-08-12T10:00:00.000Z');
    const alerts = new AlertEvaluator(db.handle, { cooldownMinutes: 30, now: () => now });
    const outbox = new Outbox(db.handle);
    const unavailable = () =>
      recordKeychainAccessAlert(db.handle, alerts, outbox, 'unavailable', now);

    assert.equal(unavailable().transition, 'raised');
    assert.equal(unavailable().transition, 'none');
    assert.deepEqual(
      {
        ...db.handle
          .prepare(
            "SELECT active, occurrences FROM alert_state WHERE alert_id = 'keychain_unavailable'",
          )
          .get(),
      },
      { active: 1, occurrences: 1 },
    );
    assert.equal(outbox.pendingCount(), 0, 'an unavailable channel cannot deliver its own warning');

    assert.equal(
      recordKeychainAccessAlert(db.handle, alerts, outbox, 'available_without_credentials', now)
        .transition,
      'cleared',
    );
    assert.equal(outbox.pendingCount(), 0, 'missing setup must not emit a stale recovery');
    assert.equal(unavailable().transition, 'raised');

    db.handle.exec(`
      CREATE TRIGGER fail_keychain_recovery
      BEFORE INSERT ON telegram_outbox
      WHEN NEW.delivery_part_id GLOB 'alert:keychain_unavailable:clear:*'
      BEGIN
        SELECT RAISE(ABORT, 'injected Keychain recovery enqueue failure');
      END;
    `);
    assert.throws(
      () => recordKeychainAccessAlert(db.handle, alerts, outbox, 'available_with_credentials', now),
      /injected Keychain recovery enqueue failure/,
    );
    assert.equal(alerts.isActive('keychain_unavailable'), true, 'failed enqueue rolls back clear');
    db.handle.exec('DROP TRIGGER fail_keychain_recovery');

    assert.equal(
      recordKeychainAccessAlert(db.handle, alerts, outbox, 'available_with_credentials', now)
        .transition,
      'cleared',
    );
    assert.equal(
      recordKeychainAccessAlert(db.handle, alerts, outbox, 'available_with_credentials', now)
        .transition,
      'none',
    );

    const rows = db.handle
      .prepare(
        `SELECT delivery_part_id, payload FROM telegram_outbox
          WHERE delivery_part_id GLOB 'alert:keychain_unavailable:*'`,
      )
      .all() as { delivery_part_id: string; payload: string }[];
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.delivery_part_id, `alert:keychain_unavailable:clear:${now}`);
    assert.deepEqual(JSON.parse(rows[0]?.payload ?? ''), {
      type: 'text',
      text: '🟢 Учётные данные Telegram снова доступны из Keychain — возобновляю попытки доставки.',
    });
    assert.doesNotMatch(
      rows[0]?.payload ?? '',
      /Telegram восстановлен|secret|token|Users|KeychainError/i,
    );
  });

  it('returns shutdown-interrupted work without burning its attempt', () => {
    const jobs = new JobQueue(db.handle, 'test-worker');
    const jobId = jobs.enqueue({
      kind: 'asr',
      idempotencyKey: 'asr:shutdown',
      payload: { sessionId: 'shutdown' },
    });
    assert.ok(jobId);
    const claimed = jobs.claim(['asr']);
    assert.ok(claimed);
    assert.equal(claimed.attempts, 1);

    assert.equal(
      releaseInterruptedJob(db.handle, claimed, new Error('ASR worker is closed')),
      true,
    );

    const row = db.handle
      .prepare('SELECT state, attempts, lease_owner, lease_expires_at FROM jobs WHERE job_id = ?')
      .get(jobId) as {
      state: string;
      attempts: number;
      lease_owner: string | null;
      lease_expires_at: string | null;
    };
    assert.deepEqual(
      { ...row },
      {
        state: 'pending',
        attempts: 0,
        lease_owner: null,
        lease_expires_at: null,
      },
    );
  });

  it('does not release a replacement lease when a stale worker shuts down', () => {
    const staleWorker = new JobQueue(db.handle, 'stale-worker');
    const jobId = staleWorker.enqueue({
      kind: 'incoming_audio',
      idempotencyKey: 'incoming:reclaimed',
      payload: { fileUid: 'reclaimed' },
    });
    assert.ok(jobId);
    const stale = staleWorker.claim(['incoming_audio']);
    assert.ok(stale);
    db.handle
      .prepare("UPDATE jobs SET lease_expires_at = '2000-01-01T00:00:00.000Z' WHERE job_id = ?")
      .run(jobId);
    assert.equal(staleWorker.recoverStaleLeases(), 1);

    const currentWorker = new JobQueue(db.handle, 'current-worker');
    const current = currentWorker.claim(['incoming_audio']);
    assert.ok(current);
    assert.equal(
      releaseInterruptedJob(db.handle, stale, new Error('old daemon is stopping late')),
      false,
    );
    assert.deepEqual(
      {
        ...(db.handle
          .prepare('SELECT state, attempts, lease_owner FROM jobs WHERE job_id = ?')
          .get(jobId) as Record<string, unknown>),
      },
      { state: 'leased', attempts: 2, lease_owner: current.leaseToken },
    );
    assert.equal(currentWorker.complete(current), true);
  });

  it('marks an exhausted ASR session failed and enqueues one durable status', () => {
    const now = new Date().toISOString();
    db.handle
      .prepare(
        `INSERT INTO audio_sessions
           (session_id, state, started_at, created_at, updated_at)
         VALUES ('asr-dead', 'PROCESSING', ?, ?, ?)`,
      )
      .run(now, now, now);

    assert.equal(markExhaustedAsrSession(db.handle, { sessionId: 'asr-dead' }), true);
    assert.equal(markExhaustedAsrSession(db.handle, { sessionId: 'asr-dead' }), true);

    const session = db.handle
      .prepare('SELECT state, rejection_reason FROM audio_sessions WHERE session_id = ?')
      .get('asr-dead') as { state: string; rejection_reason: string };
    assert.equal(session.state, 'FAILED');
    assert.equal(session.rejection_reason, 'asr_failed');
    const status = db.handle
      .prepare(
        `SELECT count(*) AS count, state
           FROM telegram_outbox
          WHERE delivery_part_id = 'session-status:asr-failed:asr-dead'`,
      )
      .get() as { count: number; state: string };
    assert.equal(status.count, 1);
    assert.equal(status.state, 'pending');
  });

  it('reports an exhausted incoming-audio job without exposing its retry error', () => {
    const message = {
      message_id: 77,
      date: Date.parse('2026-08-11T12:00:00.000Z') / 1000,
      chat: { id: 42, type: 'private' },
      voice: {
        file_id: 'incoming-failure-file',
        file_unique_id: 'incoming-failure-unique',
      },
    };
    const incoming = enqueueIncomingRequest(db.handle, 707, message, 'capture-mac');
    const technicalError = 'ffmpeg failed at /Users/alice/private/audio.bin';
    db.handle
      .prepare("UPDATE jobs SET state = 'dead', last_error = ? WHERE kind = 'incoming_audio'")
      .run(technicalError);

    assert.equal(markExhaustedIncomingFile(db.handle, { fileUid: incoming.fileUid }), true);
    assert.equal(markExhaustedIncomingFile(db.handle, { fileUid: incoming.fileUid }), true);

    const stored = db.handle
      .prepare('SELECT state, rejection_reason FROM incoming_telegram_files WHERE file_uid = ?')
      .get(incoming.fileUid) as { state: string; rejection_reason: string };
    assert.deepEqual({ ...stored }, { state: 'failed', rejection_reason: 'processing_failed' });
    const status = db.handle
      .prepare('SELECT payload FROM telegram_outbox WHERE delivery_part_id = ?')
      .get(`incoming-failed:${incoming.fileUid}`) as { payload: string };
    const text = (JSON.parse(status.payload) as { text: string }).text;
    assert.equal(
      text,
      '🔴 Не удалось обработать аудио после нескольких попыток.\n\n' +
        'Технические подробности сохранены в локальном журнале.\n\n' +
        renderProvenancePlain(incomingTelegramProvenance(incoming)),
    );
    assert.ok(!text.includes(technicalError));
  });
});

describe('digest missing schedule', () => {
  const schedule = {
    enabled: true,
    atLocalTime: '21:00',
    timezone: 'Europe/Moscow',
  } as const;

  it('uses the most recent due date and stays disabled with the feature', () => {
    const beforeDue = Date.parse('2026-08-09T17:59:00.000Z');
    assert.equal(expectedDigestIsMissing(db.handle, beforeDue, schedule), true);
    assert.equal(
      expectedDigestIsMissing(db.handle, beforeDue, { ...schedule, enabled: false }),
      false,
    );
    db.handle
      .prepare(
        `INSERT INTO digests
           (digest_id, digest_date, session_count, speech_ms, payload, created_at)
         VALUES ('digest-previous', '2026-08-08', 0, 0, '{}', ?)`,
      )
      .run(new Date(beforeDue).toISOString());
    assert.equal(expectedDigestIsMissing(db.handle, beforeDue, schedule), false);
  });

  it('reports a missing row after due time and clears once it exists', () => {
    const atDue = Date.parse('2026-08-09T18:00:00.000Z');
    assert.equal(expectedDigestIsMissing(db.handle, atDue, schedule), true);
    db.handle
      .prepare(
        `INSERT INTO digests
           (digest_id, digest_date, session_count, speech_ms, payload, created_at)
         VALUES ('digest-1', '2026-08-09', 0, 0, '{}', ?)`,
      )
      .run(new Date(atDue).toISOString());
    assert.equal(expectedDigestIsMissing(db.handle, atDue, schedule), false);
  });

  it('does not report missing during the scheduler grace window', () => {
    const shortlyAfterDue = Date.parse('2026-08-09T18:01:00.000Z');
    const afterGrace = Date.parse('2026-08-09T18:06:00.000Z');

    assert.equal(expectedDigestIsMissing(db.handle, shortlyAfterDue, schedule, 305_000), false);
    assert.equal(expectedDigestIsMissing(db.handle, afterGrace, schedule, 305_000), true);
  });
});
