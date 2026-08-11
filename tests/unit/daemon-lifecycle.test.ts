import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import {
  claimDaemonPid,
  claimIncomingRequest,
  commandLooksLikeOpenMurmurDaemon,
  enqueueIncomingRequest,
  expectedDigestIsMissing,
  findIncomingFile,
  incomingFileUidFromDeliveryPart,
  markExhaustedAsrSession,
  markExhaustedIncomingFile,
  parseDaemonPid,
  processIdentityMatches,
  readDaemonPid,
  reconcileIncomingDelivery,
  recordIncomingDownload,
  releaseDaemonPid,
  releaseInterruptedJob,
  retirePendingAlertDeliveries,
  retireStaleNotices,
  shouldEnqueueHealthAlert,
} from '../../src/cli/daemon.ts';
import { type Database, openDatabase } from '../../src/database/db.ts';
import { appendIncomingTranscript, IncomingFileRepository } from '../../src/database/repository.ts';
import { JobQueue } from '../../src/jobs/queue.ts';
import { Outbox } from '../../src/telegram/outbox.ts';
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
    await claimDaemonPid(pidFile, dir, dependencies);
    const claimed = await readDaemonPid(pidFile);
    assert.equal(claimed?.pid, process.pid);
    assert.ok(claimed?.processBirth);

    await assert.rejects(
      claimDaemonPid(pidFile, dir, dependencies),
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
      voice: { file_id: 'bot-a-file', file_unique_id: 'bot-a-unique' },
    };
    const secondMessage = {
      ...firstMessage,
      message_id: 41,
      voice: { file_id: 'bot-b-file', file_unique_id: 'bot-b-unique' },
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
    assert.equal(shouldEnqueueHealthAlert('asr_backlog', 'raised'), true);
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
