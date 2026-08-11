import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  readLocalLiveStatus,
  readLocalStatusCounts,
  renderLiveStatus,
  renderQueueStatus,
  writeDaemonHeartbeat,
} from '../../src/cli/status.ts';
import { openDatabase } from '../../src/database/db.ts';
import { JobQueue } from '../../src/jobs/queue.ts';
import { Outbox } from '../../src/telegram/outbox.ts';

describe('local status', () => {
  it('reports terminal failures separately from active work', () => {
    const db = openDatabase({ file: ':memory:' });
    try {
      const jobs = new JobQueue(db.handle);
      jobs.enqueue({ kind: 'asr', idempotencyKey: 'leased', payload: {} });
      assert.ok(jobs.claim(['asr']));
      jobs.enqueue({ kind: 'asr', idempotencyKey: 'dead', payload: {}, maxAttempts: 1 });
      const deadJob = jobs.claim(['asr']);
      assert.ok(deadJob);
      assert.equal(jobs.fail(deadJob, 'terminal model failure'), 'dead');
      jobs.enqueue({ kind: 'asr', idempotencyKey: 'pending', payload: {} });

      const outbox = new Outbox(db.handle);
      outbox.enqueue({
        deliveryPartId: 'sending',
        kind: 'status',
        ordinal: 0,
        payload: { type: 'text', text: 'sending' },
      });
      assert.ok(outbox.claimNext());
      outbox.enqueue({
        deliveryPartId: 'dead',
        kind: 'status',
        ordinal: 1,
        payload: { type: 'text', text: 'dead' },
      });
      const deadMessage = outbox.claimNext();
      assert.ok(deadMessage);
      assert.equal(outbox.markFailed(deadMessage.outbox_id, 'terminal send failure', 8, 8), 'dead');
      outbox.enqueue({
        deliveryPartId: 'pending',
        kind: 'status',
        ordinal: 2,
        payload: { type: 'text', text: 'pending' },
      });

      const counts = readLocalStatusCounts(db.handle);
      assert.deepEqual(counts, {
        sessions: 0,
        done: 0,
        rejected: 0,
        jobs: 2,
        jobsPending: 1,
        jobsLeased: 1,
        jobsDead: 1,
        outbox: 2,
        outboxPending: 1,
        outboxSending: 1,
        outboxDead: 1,
        parts: 0,
      });

      const output = renderQueueStatus(counts, '/tmp/openmurmur.ndjson').join('\n');
      assert.match(output, /Jobs:\s+1 pending, 1 leased, 1 dead/);
      assert.match(output, /Telegram outbox:\s+1 pending, 1 sending, 1 dead/);
      assert.match(output, /Terminal failures: 1 job\(s\), 1 Telegram message\(s\)/);
      assert.match(output, /Inspect logs:\s+\/tmp\/openmurmur\.ndjson/);
    } finally {
      db.close();
    }
  });

  it('trusts fresh telemetry from the current daemon identity', () => {
    const db = openDatabase({ file: ':memory:' });
    try {
      const startedAt = '2026-08-11T20:00:00.000Z';
      const updatedAt = '2026-08-11T20:01:00.000Z';
      writeDaemonHeartbeat(db.handle, {
        daemonPid: 42,
        daemonStartedAt: startedAt,
        recorderRunning: true,
        sessionState: 'ACTIVE',
        lastSourceFrameAgeMs: 250,
        processingLagMs: 600,
        updatedAt,
      });

      const live = readLocalLiveStatus(db.handle, {
        daemonRunning: true,
        daemonPid: 42,
        daemonStartedAt: startedAt,
        nowMs: Date.parse(updatedAt) + 2000,
        freshForMs: 15_000,
      });

      assert.deepEqual(live, {
        heartbeatStatus: 'fresh',
        heartbeatUpdatedAt: updatedAt,
        heartbeatAgeMs: 2000,
        recorderRunning: true,
        sessionState: 'ACTIVE',
        lastSourceFrameAgeMs: 2250,
        processingLagMs: 600,
      });
      assert.deepEqual(renderLiveStatus(live), [
        'Heartbeat:         fresh (2.0s old)',
        'Recorder:          running',
        'Current session:   ACTIVE',
        'Last source frame: 2.3s ago',
        'Processing lag:    600 ms',
      ]);
    } finally {
      db.close();
    }
  });

  it('never exposes live fields from a stale, stopped or previous daemon snapshot', () => {
    const db = openDatabase({ file: ':memory:' });
    try {
      const startedAt = '2026-08-11T20:00:00.000Z';
      const updatedAt = '2026-08-11T20:01:00.000Z';
      writeDaemonHeartbeat(db.handle, {
        daemonPid: 42,
        daemonStartedAt: startedAt,
        recorderRunning: true,
        sessionState: 'ACTIVE',
        lastSourceFrameAgeMs: 0,
        processingLagMs: 0,
        updatedAt,
      });

      const base = {
        daemonPid: 42,
        daemonStartedAt: startedAt,
        nowMs: Date.parse(updatedAt) + 15_001,
        freshForMs: 15_000,
      };
      const stale = readLocalLiveStatus(db.handle, { ...base, daemonRunning: true });
      const stopped = readLocalLiveStatus(db.handle, { ...base, daemonRunning: false });
      const previousRun = readLocalLiveStatus(db.handle, {
        ...base,
        daemonRunning: true,
        daemonStartedAt: '2026-08-11T20:02:00.000Z',
      });

      for (const live of [stale, stopped, previousRun]) {
        assert.equal(live.recorderRunning, null);
        assert.equal(live.sessionState, null);
        assert.equal(live.lastSourceFrameAgeMs, null);
        assert.equal(live.processingLagMs, null);
      }
      assert.equal(stale.heartbeatStatus, 'stale');
      assert.equal(stopped.heartbeatStatus, 'daemon_stopped');
      assert.equal(previousRun.heartbeatStatus, 'identity_mismatch');
      assert.match(renderLiveStatus(stale).join('\n'), /Current session:\s+unknown.*stale/);
      assert.doesNotMatch(renderLiveStatus(stale).join('\n'), /Recorder:\s+running/);
    } finally {
      db.close();
    }
  });
});
