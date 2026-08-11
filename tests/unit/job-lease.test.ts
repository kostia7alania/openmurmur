import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { type Database, openDatabase } from '../../src/database/db.ts';
import { JobQueue } from '../../src/jobs/queue.ts';

let dir: string;
let db: Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'om-job-lease-'));
  db = openDatabase({ file: join(dir, 'test.db') });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('job lease generations', () => {
  it('renews an in-memory generation before post-sleep stale recovery', () => {
    const activeWorker = new JobQueue(db.handle, 'worker-before-sleep');
    activeWorker.enqueue({ kind: 'asr', idempotencyKey: 'asr:sleep-gap', payload: {} });
    const active = activeWorker.claim(['asr']);
    assert.ok(active);
    db.handle
      .prepare("UPDATE jobs SET lease_expires_at = '2000-01-01T00:00:00.000Z' WHERE job_id = ?")
      .run(active.jobId);

    assert.equal(activeWorker.renew(active), true);
    assert.equal(activeWorker.recoverStaleLeases(), 0);
    assert.equal(new JobQueue(db.handle, 'worker-after-sleep').claim(['asr']), null);
    assert.equal(activeWorker.complete(active), true);
  });

  it('fences a stale worker after another generation reclaims its job', () => {
    const firstWorker = new JobQueue(db.handle, 'worker-a');
    firstWorker.enqueue({ kind: 'asr', idempotencyKey: 'asr:fenced', payload: {} });
    const stale = firstWorker.claim(['asr']);
    assert.ok(stale);

    db.handle
      .prepare("UPDATE jobs SET lease_expires_at = '2000-01-01T00:00:00.000Z' WHERE job_id = ?")
      .run(stale.jobId);
    assert.equal(firstWorker.recoverStaleLeases(), 1);

    const secondWorker = new JobQueue(db.handle, 'worker-b');
    const current = secondWorker.claim(['asr']);
    assert.ok(current);
    assert.notEqual(current.leaseToken, stale.leaseToken);

    assert.equal(firstWorker.renew(stale), false);
    assert.equal(firstWorker.complete(stale), false);
    assert.equal(firstWorker.fail(stale, 'late failure from stale worker'), 'lost');
    assert.deepEqual(
      {
        ...(db.handle
          .prepare('SELECT state, lease_owner, attempts, last_error FROM jobs WHERE job_id = ?')
          .get(current.jobId) as Record<string, unknown>),
      },
      {
        state: 'leased',
        lease_owner: current.leaseToken,
        attempts: 2,
        last_error: null,
      },
    );
    assert.equal(secondWorker.complete(current), true);
  });

  it('reclaims a proven-dead daemon lease immediately without burning an attempt', () => {
    const deadDaemon = new JobQueue(db.handle, 'daemon-that-died');
    const liveDaemon = new JobQueue(db.handle, 'daemon-still-live');
    const jobId = deadDaemon.enqueue({
      kind: 'asr',
      idempotencyKey: 'asr:daemon-death',
      payload: {},
    });
    assert.ok(jobId);
    const abandoned = deadDaemon.claim(['asr']);
    assert.ok(abandoned);
    assert.equal(abandoned.attempts, 1);

    const liveJobId = liveDaemon.enqueue({
      kind: 'asr',
      idempotencyKey: 'asr:other-daemon',
      payload: {},
    });
    assert.ok(liveJobId);
    const live = liveDaemon.claim(['asr']);
    assert.ok(live);

    assert.equal(deadDaemon.recoverLeasesAfterProvenDaemonDeath(), 1);
    assert.deepEqual(
      {
        ...(db.handle
          .prepare(
            'SELECT state, attempts, lease_owner, lease_expires_at FROM jobs WHERE job_id = ?',
          )
          .get(jobId) as Record<string, unknown>),
      },
      {
        state: 'pending',
        attempts: 0,
        lease_owner: null,
        lease_expires_at: null,
      },
    );
    assert.equal(deadDaemon.renew(abandoned), false);
    assert.equal(liveDaemon.renew(live), true, 'another daemon generation must remain leased');

    const replacement = new JobQueue(db.handle, 'replacement-daemon').claim(['asr']);
    assert.ok(replacement);
    assert.equal(replacement.jobId, jobId);
    assert.equal(replacement.attempts, 1);
  });

  it('renews a short lease while a slow handler is still running', async () => {
    const activeWorker = new JobQueue(db.handle, 'worker-active');
    activeWorker.enqueue({ kind: 'asr', idempotencyKey: 'asr:heartbeat', payload: {} });
    const active = activeWorker.claim(['asr'], 250);
    assert.ok(active);
    const competingWorker = new JobQueue(db.handle, 'worker-competing');

    await activeWorker.withLeaseHeartbeat(
      active,
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 600));
        assert.equal(competingWorker.recoverStaleLeases(), 0);
        assert.equal(competingWorker.claim(['asr']), null);
      },
      { leaseMs: 250, heartbeatMs: 20 },
    );

    assert.equal(activeWorker.complete(active), true);
  });
});
