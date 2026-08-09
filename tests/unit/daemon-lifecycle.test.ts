import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import {
  claimDaemonPid,
  commandLooksLikeOpenMurmurDaemon,
  expectedDigestIsMissing,
  findIncomingFile,
  incomingFileUidFromDeliveryPart,
  markExhaustedAsrSession,
  parseDaemonPid,
  readDaemonPid,
  reconcileIncomingDelivery,
  recordIncomingDownload,
  releaseDaemonPid,
  releaseInterruptedJob,
} from '../../src/cli/daemon.ts';
import { type Database, openDatabase } from '../../src/database/db.ts';
import { JobQueue } from '../../src/jobs/queue.ts';

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
    assert.deepEqual(parseDaemonPid('123\n'), { pid: 123, root: null, startedAt: null });
    assert.deepEqual(parseDaemonPid('{"pid":456,"root":"/state","startedAt":"now"}'), {
      pid: 456,
      root: '/state',
      startedAt: 'now',
    });
    assert.equal(parseDaemonPid('not-a-pid'), null);
  });

  it('requires both the product identity and the start command', () => {
    assert.equal(
      commandLooksLikeOpenMurmurDaemon('/opt/node /Applications/openmurmur/src/cli/main.ts start'),
      true,
    );
    assert.equal(commandLooksLikeOpenMurmurDaemon('/opt/node unrelated.ts start'), false);
    assert.equal(commandLooksLikeOpenMurmurDaemon('/opt/openmurmur status'), false);
  });

  it('claims the PID file exclusively and only its owner releases it', async () => {
    const pidFile = join(dir, 'daemon.pid');
    await claimDaemonPid(pidFile, dir);
    assert.equal((await readDaemonPid(pidFile))?.pid, process.pid);

    await assert.rejects(
      claimDaemonPid(pidFile, dir),
      /refusing to replace/,
      'a second daemon must not overwrite a live owner',
    );
    await releaseDaemonPid(pidFile, process.pid + 1);
    assert.equal(existsSync(pidFile), true, 'a non-owner must not unlink the PID file');
    await releaseDaemonPid(pidFile, process.pid);
    assert.equal(existsSync(pidFile), false);
  });
});

describe('incoming Telegram retry identity', () => {
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
  it('returns shutdown-interrupted work without burning its attempt', () => {
    const jobs = new JobQueue(db.handle, 'test-worker');
    const jobId = jobs.enqueue({
      kind: 'asr',
      idempotencyKey: 'asr:shutdown',
      payload: { sessionId: 'shutdown' },
    });
    assert.ok(jobId);
    const claimed = jobs.claim(['asr']);
    assert.equal(claimed?.attempts, 1);

    releaseInterruptedJob(db.handle, jobId, new Error('ASR worker is closed'));

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
});
