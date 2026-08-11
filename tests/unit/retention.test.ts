import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { DEFAULT_CONFIG } from '../../src/config/schema.ts';
import { type Database, openDatabase } from '../../src/database/db.ts';
import { AlertEvaluator, renderAlert } from '../../src/health/alerts.ts';
import { evaluateHealth, renderHealthLines } from '../../src/health/monitor.ts';
import { applyRetention, planRetention } from '../../src/retention/policy.ts';

let dir: string;
let db: Database;

const RETENTION = DEFAULT_CONFIG.retention;
const OLD = '2020-01-01T00:00:00.000Z';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'om-ret-'));
  db = openDatabase({ file: join(dir, 'test.db') });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

/**
 * Creates a session whose audio is fully delivered — every condition retention
 * demands. Individual tests then break exactly one condition, so a failure
 * names the specific guarantee that regressed.
 */
interface SessionOptions {
  state?: string;
  rejectionReason?: string | null;
  finalized?: number;
  delivered?: number;
  deliveredAt?: string | null;
  sha256?: string | null;
  withTranscript?: boolean;
  transcriptSent?: boolean;
  outboxPending?: boolean;
  pendingJob?: boolean;
}

function seedDeliveredSession(id: string, options: SessionOptions = {}): string {
  const {
    state = 'DONE',
    rejectionReason = null,
    finalized = 1,
    delivered = 1,
    sha256 = 'abc123',
    withTranscript = true,
    transcriptSent = true,
    outboxPending = false,
    pendingJob = false,
  } = options;
  const deliveredAt =
    options.deliveredAt === undefined ? (delivered === 1 ? OLD : null) : options.deliveredAt;

  const path = join(dir, `${id}.flac`);
  writeFileSync(path, Buffer.alloc(1024));

  db.handle
    .prepare(
      `INSERT INTO audio_sessions
         (session_id, state, started_at, ended_at, duration_ms, speech_ms,
          part_count, rejection_reason, created_at, updated_at)
       VALUES (?, ?, ?, ?, 60000, 30000, 1, ?, ?, ?)`,
    )
    .run(id, state, OLD, OLD, rejectionReason, OLD, OLD);

  db.handle
    .prepare(
      `INSERT INTO audio_parts (part_id, session_id, part_index, path, started_at, ended_at,
                                bytes, sha256, finalized, delivered, delivered_at, created_at)
       VALUES (?, ?, 0, ?, ?, ?, 1024, ?, ?, ?, ?, ?)`,
    )
    .run(`${id}-p0`, id, path, OLD, OLD, sha256, finalized, delivered, deliveredAt, OLD);

  if (withTranscript) {
    db.handle
      .prepare(
        `INSERT INTO transcript_revisions (revision_id, session_id, revision_number, engine, model,
                                           languages, text, word_count, is_current, created_at)
         VALUES (?, ?, 1, 'e', 'm', '["ru"]', 'текст', 5, 1, ?)`,
      )
      .run(`${id}-r1`, id, OLD);
  }

  if (transcriptSent) {
    db.handle
      .prepare(
        `INSERT INTO telegram_outbox (outbox_id, delivery_part_id, session_id, kind, ordinal,
                                      payload, state, run_after, created_at, updated_at)
         VALUES (?, ?, ?, 'transcript', 10, '{}', 'sent', ?, ?, ?)`,
      )
      .run(`${id}-o1`, `transcript:${id}:1`, id, OLD, OLD, OLD);
  }

  if (outboxPending) {
    db.handle
      .prepare(
        `INSERT INTO telegram_outbox (outbox_id, delivery_part_id, session_id, kind, ordinal,
                                      payload, state, run_after, created_at, updated_at)
         VALUES (?, ?, ?, 'report', 20, '{}', 'pending', ?, ?, ?)`,
      )
      .run(`${id}-o2`, `report:${id}`, id, OLD, OLD, OLD);
  }

  if (pendingJob) {
    db.handle
      .prepare(
        `INSERT INTO jobs (job_id, kind, idempotency_key, payload, state, run_after,
                           created_at, updated_at)
         VALUES (?, 'asr', ?, '{}', 'pending', ?, ?, ?)`,
      )
      .run(`${id}-j1`, `asr:${id}`, OLD, OLD, OLD);
  }

  return path;
}

function seedIncomingAudio(id: string): string {
  const path = join(dir, `${id}.ogg`);
  writeFileSync(path, Buffer.alloc(100));
  db.handle
    .prepare(
      `INSERT INTO incoming_telegram_files
         (file_uid, telegram_file_id, telegram_unique_id, chat_id, message_id,
          actual_bytes, state, quarantine_path, created_at, updated_at)
       VALUES (?, ?, ?, 42, 1, 100, 'transcribed', ?, ?, ?)`,
    )
    .run(id, `file-${id}`, `unique-${id}`, path, OLD, OLD);
  db.handle
    .prepare(
      `INSERT INTO transcript_revisions
         (revision_id, incoming_file_id, revision_number, engine, model, languages,
          text, word_count, is_current, created_at)
       VALUES (?, ?, 1, 'e', 'm', '[]', 'text', 1, 1, ?)`,
    )
    .run(`${id}-r1`, id, OLD);
  return path;
}

function seedSentIncomingManifest(id: string, acknowledgedAt: string): void {
  db.handle
    .prepare(
      `INSERT INTO telegram_outbox
         (outbox_id, delivery_part_id, kind, ordinal, payload, state,
          run_after, created_at, updated_at)
       VALUES (?, ?, 'incoming_transcript', 10, ?, 'sent', ?, ?, ?)`,
    )
    .run(
      `${id}-outbox-1`,
      `incoming:${id}:1`,
      JSON.stringify({
        type: 'text',
        text: 'transcript',
        replyMarkup: { inline_keyboard: [] },
      }),
      acknowledgedAt,
      acknowledgedAt,
      acknowledgedAt,
    );
}

describe('retention: what may be deleted', () => {
  it('deletes audio only once every condition holds', () => {
    seedDeliveredSession('s1');
    const plan = planRetention(db.handle, RETENTION);

    assert.equal(plan.candidates.length, 1);
    assert.equal(plan.candidates[0]?.kind, 'session_audio');
    assert.equal(plan.totalBytes, 1024);
  });

  it('starts the retention window at confirmed delivery, not session end', () => {
    const now = Date.parse('2026-08-11T12:00:00.000Z');
    seedDeliveredSession('s1', {
      // The recording itself is years old, but Telegram only just acknowledged it.
      deliveredAt: new Date(now - 60 * 60_000).toISOString(),
    });
    const plan = planRetention(db.handle, RETENTION, now);
    assert.equal(plan.candidates.length, 0);
    assert.match(plan.blocked[0]?.reason ?? '', /window after confirmed audio delivery/);
  });

  it('makes delivered audio eligible after the configured delivery window', () => {
    const now = Date.parse('2026-08-11T12:00:00.000Z');
    seedDeliveredSession('s1', {
      deliveredAt: new Date(now - (RETENTION.sessionAudioHours + 1) * 60 * 60_000).toISOString(),
    });
    assert.equal(planRetention(db.handle, RETENTION, now).candidates.length, 1);
  });

  it('keeps legacy delivered audio when its exact delivery time is missing', () => {
    seedDeliveredSession('legacy', { deliveredAt: null });
    const plan = planRetention(db.handle, RETENTION);
    assert.equal(plan.candidates.length, 0);
    assert.match(plan.blocked[0]?.reason ?? '', /delivery time is not proven/);
  });

  it('deletes rejected-noise audio on its own shorter schedule', () => {
    seedDeliveredSession('noise', {
      state: 'REJECTED',
      rejectionReason: 'insufficient_speech',
      delivered: 0,
      withTranscript: false,
      transcriptSent: false,
    });

    const plan = planRetention(db.handle, RETENTION);
    assert.equal(plan.candidates.length, 1);
    assert.equal(plan.candidates[0]?.kind, 'rejected_session_audio');
  });

  it('keeps never-delivered insufficient speech on the short session-end clock', () => {
    const now = Date.parse('2026-08-11T12:00:00.000Z');
    seedDeliveredSession('noise', {
      state: 'REJECTED',
      rejectionReason: 'insufficient_speech',
      delivered: 0,
      withTranscript: false,
      transcriptSent: false,
    });
    db.handle
      .prepare('UPDATE audio_sessions SET ended_at = ? WHERE session_id = ?')
      .run(new Date(now - 60 * 60_000).toISOString(), 'noise');
    assert.equal(planRetention(db.handle, RETENTION, now).candidates.length, 0);

    db.handle
      .prepare('UPDATE audio_sessions SET ended_at = ? WHERE session_id = ?')
      .run(
        new Date(now - (RETENTION.rejectedSessionHours + 1) * 60 * 60_000).toISOString(),
        'noise',
      );
    assert.equal(planRetention(db.handle, RETENTION, now).candidates.length, 1);
  });

  it('keeps ASR-rejected audio until its audio-first delivery is confirmed', () => {
    seedDeliveredSession('asr-empty', {
      state: 'REJECTED',
      rejectionReason: 'asr_empty',
      delivered: 0,
      withTranscript: false,
      transcriptSent: false,
    });
    db.handle
      .prepare(
        `INSERT INTO telegram_outbox
           (outbox_id, delivery_part_id, session_id, kind, ordinal, payload,
            state, run_after, created_at, updated_at)
         VALUES ('audio-pending', 'audio:asr-empty-p0', 'asr-empty', 'audio', 0, '{}',
                 'pending', ?, ?, ?)`,
      )
      .run(OLD, OLD, OLD);
    db.handle
      .prepare(
        `INSERT INTO jobs
           (job_id, kind, idempotency_key, payload, state, run_after, created_at, updated_at)
         VALUES ('audio-job', 'deliver_audio', 'deliver-audio:asr-empty', '{}', 'done', ?, ?, ?)`,
      )
      .run(OLD, OLD, OLD);

    assert.equal(planRetention(db.handle, RETENTION).candidates.length, 0);

    db.handle.prepare("UPDATE telegram_outbox SET state = 'sent'").run();
    db.handle.prepare('UPDATE audio_parts SET delivered = 1, delivered_at = ?').run(OLD);
    assert.equal(planRetention(db.handle, RETENTION).candidates.length, 1);
  });

  it('gives delivered ASR-rejected audio the ordinary window from its ACK', () => {
    const now = Date.parse('2026-08-11T12:00:00.000Z');
    seedDeliveredSession('asr-recent', {
      state: 'REJECTED',
      rejectionReason: 'asr_empty',
      deliveredAt: new Date(now - (RETENTION.rejectedSessionHours + 1) * 60 * 60_000).toISOString(),
      withTranscript: false,
      transcriptSent: false,
    });
    db.handle
      .prepare(
        `INSERT INTO telegram_outbox
           (outbox_id, delivery_part_id, session_id, kind, ordinal, payload,
            state, run_after, created_at, updated_at)
         VALUES ('audio-sent', 'audio:asr-recent-p0', 'asr-recent', 'audio', 0, '{}',
                 'sent', ?, ?, ?)`,
      )
      .run(OLD, OLD, OLD);
    db.handle
      .prepare(
        `INSERT INTO jobs
           (job_id, kind, idempotency_key, payload, state, run_after, created_at, updated_at)
         VALUES ('audio-job', 'deliver_audio', 'deliver-audio:asr-recent', '{}', 'done', ?, ?, ?)`,
      )
      .run(OLD, OLD, OLD);

    assert.equal(
      planRetention(db.handle, RETENTION, now).candidates.length,
      0,
      'the short rejected-session clock must not delete audio that was delivered recently',
    );

    db.handle
      .prepare('UPDATE audio_parts SET delivered_at = ?')
      .run(new Date(now - (RETENTION.sessionAudioHours + 1) * 60 * 60_000).toISOString());
    assert.equal(planRetention(db.handle, RETENTION, now).candidates.length, 1);
  });

  it('keeps ASR-rejected audio when the delivery job or sent row is missing', () => {
    seedDeliveredSession('asr-words', {
      state: 'REJECTED',
      rejectionReason: 'insufficient_words',
      delivered: 1,
      withTranscript: false,
      transcriptSent: false,
    });

    assert.equal(planRetention(db.handle, RETENTION).candidates.length, 0);

    db.handle
      .prepare(
        `INSERT INTO telegram_outbox
           (outbox_id, delivery_part_id, session_id, kind, ordinal, payload,
            state, run_after, created_at, updated_at)
         VALUES ('audio-sent', 'audio:asr-words-p0', 'asr-words', 'audio', 0, '{}',
                 'sent', ?, ?, ?)`,
      )
      .run(OLD, OLD, OLD);
    db.handle
      .prepare(
        `INSERT INTO jobs
           (job_id, kind, idempotency_key, payload, state, run_after, created_at, updated_at)
         VALUES ('audio-dead', 'deliver_audio', 'deliver-audio:asr-words', '{}', 'dead', ?, ?, ?)`,
      )
      .run(OLD, OLD, OLD);

    assert.equal(planRetention(db.handle, RETENTION).candidates.length, 0);

    db.handle.prepare("UPDATE jobs SET state = 'done'").run();
    assert.equal(planRetention(db.handle, RETENTION).candidates.length, 1);
  });

  it('keeps incoming audio until every transcript message is confirmed delivered', () => {
    seedIncomingAudio('incoming-unproven');

    assert.equal(planRetention(db.handle, RETENTION).candidates.length, 0);
    db.handle
      .prepare(
        "UPDATE incoming_telegram_files SET state = 'delivered', updated_at = ? WHERE file_uid = ?",
      )
      .run(OLD, 'incoming-unproven');
    assert.equal(
      planRetention(db.handle, RETENTION).candidates.length,
      0,
      'state and an old processing timestamp are not delivery proof',
    );
    const unproven = db.handle
      .prepare('SELECT delivered_at FROM incoming_telegram_files WHERE file_uid = ?')
      .get('incoming-unproven') as { delivered_at: string | null };
    assert.equal(unproven.delivered_at, null);

    const recentAck = new Date().toISOString();
    seedIncomingAudio('incoming-recent');
    seedSentIncomingManifest('incoming-recent', recentAck);
    db.handle
      .prepare("UPDATE incoming_telegram_files SET state = 'delivered' WHERE file_uid = ?")
      .run('incoming-recent');
    const recent = db.handle
      .prepare('SELECT delivered_at FROM incoming_telegram_files WHERE file_uid = ?')
      .get('incoming-recent') as { delivered_at: string | null };
    assert.equal(recent.delivered_at, recentAck, 'the exact sent manifest derives the clock');
    assert.equal(
      planRetention(db.handle, RETENTION).candidates.length,
      0,
      'the retention window starts at delivery, not receipt or transcription',
    );
  });

  it('makes incoming audio eligible from an elapsed trigger-derived delivery clock', () => {
    seedIncomingAudio('incoming-old');
    seedSentIncomingManifest('incoming-old', OLD);
    db.handle
      .prepare("UPDATE incoming_telegram_files SET state = 'delivered' WHERE file_uid = ?")
      .run('incoming-old');

    const stored = db.handle
      .prepare('SELECT delivered_at FROM incoming_telegram_files WHERE file_uid = ?')
      .get('incoming-old') as { delivered_at: string | null };
    assert.equal(stored.delivered_at, OLD);
    const plan = planRetention(db.handle, RETENTION);
    assert.equal(plan.candidates.length, 1);
    assert.equal(plan.candidates[0]?.kind, 'incoming_audio');
  });
});

describe('retention: what must never be deleted', () => {
  const cases: { name: string; options: SessionOptions; expectedBlock: RegExp }[] = [
    {
      name: 'ASR has not finished',
      options: { state: 'PROCESSING', delivered: 0, withTranscript: false, transcriptSent: false },
      expectedBlock: /ASR has not finished/,
    },
    {
      name: 'the checksum was never computed',
      options: { sha256: null },
      expectedBlock: /checksum not computed/,
    },
    {
      name: 'the audio part was never finalized',
      options: { finalized: 0 },
      expectedBlock: /never finalized/,
    },
    {
      name: 'Telegram never confirmed this audio part',
      options: { delivered: 0 },
      expectedBlock: /not confirmed delivered/,
    },
    {
      name: 'the transcript was never delivered',
      options: { transcriptSent: false },
      expectedBlock: /transcript delivery not confirmed/,
    },
    {
      name: 'a message for this session is still queued',
      options: { outboxPending: true },
      expectedBlock: /./,
    },
    {
      name: 'a job still references the session',
      options: { pendingJob: true },
      expectedBlock: /./,
    },
    {
      name: 'there is no transcript at all',
      options: { withTranscript: false },
      expectedBlock: /./,
    },
  ];

  for (const { name, options, expectedBlock } of cases) {
    it(`refuses to delete when ${name}`, () => {
      const path = seedDeliveredSession('s1', options);
      const plan = planRetention(db.handle, RETENTION);

      assert.equal(plan.candidates.length, 0, `audio was wrongly eligible when ${name}`);
      assert.equal(plan.blocked.length, 1, 'the reason for keeping it must be reported');
      assert.match(plan.blocked[0]?.reason ?? '', expectedBlock);
      assert.ok(existsSync(path));
    });
  }

  it('explains why a file is being kept rather than staying silent', () => {
    seedDeliveredSession('s1', { delivered: 0 });
    const plan = planRetention(db.handle, RETENTION);
    assert.ok((plan.blocked[0]?.reason.length ?? 0) > 0);
    assert.ok(plan.blocked[0]?.path.endsWith('.flac'));
  });
});

describe('retention: dry-run and apply agree', () => {
  it('apply deletes exactly what dry-run listed', async () => {
    const deletable = seedDeliveredSession('s1');
    const kept = seedDeliveredSession('s2', { delivered: 0 });

    const plan = planRetention(db.handle, RETENTION);
    assert.deepEqual(
      plan.candidates.map((c) => c.path),
      [deletable],
    );

    const result = await applyRetention(db.handle, plan);

    assert.equal(result.deleted, 1);
    assert.equal(result.freedBytes, 1024);
    assert.equal(existsSync(deletable), false);
    assert.equal(existsSync(kept), true, 'a blocked file must survive apply');
  });

  it('cancels every incoming unlink when another connection adds a job after planning', async () => {
    const quarantinePath = seedIncomingAudio('incoming-race');
    const normalizedPath = join(dir, 'incoming-race.wav');
    writeFileSync(normalizedPath, Buffer.alloc(100));
    seedSentIncomingManifest('incoming-race', OLD);
    db.handle
      .prepare(
        `UPDATE incoming_telegram_files
            SET state = 'delivered', normalized_path = ?
          WHERE file_uid = ?`,
      )
      .run(normalizedPath, 'incoming-race');

    const plan = planRetention(db.handle, RETENTION);
    assert.deepEqual(
      plan.candidates.map((candidate) => candidate.path),
      [quarantinePath, normalizedPath],
    );

    const concurrent = openDatabase({ file: join(dir, 'test.db') });
    try {
      concurrent.handle
        .prepare(
          `INSERT INTO jobs
             (job_id, kind, idempotency_key, payload, state, run_after, created_at, updated_at)
           VALUES ('incoming-race-job', 'incoming_audio', 'incoming:bot-scope:77', ?,
                   'pending', ?, ?, ?)`,
        )
        .run(
          JSON.stringify({
            updateId: 77,
            botScope: 'bot-scope',
            fileUid: 'incoming-race',
            message: {},
            forcedLanguage: null,
          }),
          OLD,
          OLD,
          OLD,
        );
    } finally {
      concurrent.close();
    }

    const result = await applyRetention(db.handle, plan);

    assert.equal(result.deleted, 0);
    assert.equal(result.errors.length, 2);
    assert.ok(result.errors.every((error) => /plan became stale/.test(error.error)));
    assert.equal(existsSync(quarantinePath), true);
    assert.equal(existsSync(normalizedPath), true);
    assert.equal(
      (
        db.handle
          .prepare('SELECT deleted_at FROM incoming_telegram_files WHERE file_uid = ?')
          .get('incoming-race') as { deleted_at: string | null }
      ).deleted_at,
      null,
    );
  });

  it('dry-run changes nothing on disk or in the database', () => {
    const path = seedDeliveredSession('s1');
    planRetention(db.handle, RETENTION);
    planRetention(db.handle, RETENTION);

    assert.ok(existsSync(path));
    const row = db.handle.prepare('SELECT deleted_at FROM audio_parts').get() as {
      deleted_at: string | null;
    };
    assert.equal(row.deleted_at, null);
  });

  it('marks the row deleted only after the file is really gone', async () => {
    seedDeliveredSession('s1');
    const plan = planRetention(db.handle, RETENTION);
    await applyRetention(db.handle, plan);

    const row = db.handle.prepare('SELECT deleted_at FROM audio_parts').get() as {
      deleted_at: string | null;
    };
    assert.ok(row.deleted_at !== null);
  });

  it('does not re-offer a file it already deleted', async () => {
    seedDeliveredSession('s1');
    await applyRetention(db.handle, planRetention(db.handle, RETENTION));
    assert.equal(planRetention(db.handle, RETENTION).candidates.length, 0);
  });
});

describe('alert deduplication', () => {
  function evaluator(nowRef: { value: number }) {
    return new AlertEvaluator(db.handle, { cooldownMinutes: 30, now: () => nowRef.value });
  }

  it('says nothing while a condition is false', () => {
    const now = { value: Date.now() };
    const alerts = evaluator(now);
    for (let i = 0; i < 10; i += 1) {
      assert.equal(alerts.evaluate('disk_low', false).send, false);
    }
  });

  it('alerts once when a condition becomes true', () => {
    const now = { value: Date.now() };
    const alerts = evaluator(now);

    const first = alerts.evaluate('recorder_stale', true);
    assert.equal(first.send, true);
    assert.equal(first.transition, 'raised');

    // A health poll runs every few seconds; it must not message every time.
    for (let i = 0; i < 20; i += 1) {
      now.value += 5000;
      assert.equal(alerts.evaluate('recorder_stale', true).send, false);
    }
  });

  it('sends a recovery message when the condition clears', () => {
    const now = { value: Date.now() };
    const alerts = evaluator(now);
    alerts.evaluate('recorder_stale', true);

    const cleared = alerts.evaluate('recorder_stale', false);
    assert.equal(cleared.send, true);
    assert.equal(cleared.transition, 'cleared');

    assert.equal(alerts.evaluate('recorder_stale', false).send, false, 'and only once');
  });

  it('re-reminds after the cooldown, but no sooner', () => {
    const now = { value: Date.now() };
    const alerts = evaluator(now);
    alerts.evaluate('disk_low', true);

    now.value += 29 * 60_000;
    assert.equal(alerts.evaluate('disk_low', true).send, false);

    now.value += 2 * 60_000;
    const repeated = alerts.evaluate('disk_low', true);
    assert.equal(repeated.send, true);
    assert.equal(repeated.transition, 'repeated');
  });

  it('does not repeat an unchanged dead-job set and reports only real changes', () => {
    const now = { value: Date.now() };
    const alerts = evaluator(now);

    assert.equal(alerts.evaluate('dead_jobs', true, 'job-set-a').transition, 'raised');
    now.value += 24 * 60 * 60_000;
    assert.equal(alerts.evaluate('dead_jobs', true, 'job-set-a').send, false);
    assert.equal(alerts.evaluate('dead_jobs', true, 'job-set-b').transition, 'changed');
    assert.equal(alerts.evaluate('dead_jobs', false, '').transition, 'cleared');
    assert.equal(alerts.evaluate('dead_jobs', true, 'job-set-b').transition, 'raised');
  });

  it('does not consume an alert edge when durable notification creation fails', () => {
    const now = { value: Date.now() };
    const alerts = evaluator(now);

    assert.throws(
      () =>
        alerts.evaluate('dead_jobs', true, 'job-set-a', () => {
          throw new Error('outbox insert failed');
        }),
      /outbox insert failed/,
    );
    assert.equal(alerts.isActive('dead_jobs'), false);
    assert.equal(alerts.evaluate('dead_jobs', true, 'job-set-a').transition, 'raised');
  });

  it('tracks each alert independently', () => {
    const now = { value: Date.now() };
    const alerts = evaluator(now);

    assert.equal(alerts.evaluate('disk_low', true).send, true);
    assert.equal(alerts.evaluate('asr_backlog', true).send, true);
    assert.equal(alerts.isActive('disk_low'), true);
    assert.equal(alerts.isActive('telegram_delivery'), false);
  });

  it('gives each alert edge a stable delivery id', () => {
    const raise = renderAlert('recorder_stale', 'raised', 'нет аудио 20 сек', 12345);
    const again = renderAlert('recorder_stale', 'raised', 'нет аудио 25 сек', 12345);
    const clear = renderAlert('recorder_stale', 'cleared', '', 12345);

    assert.equal(raise.deliveryPartId, again.deliveryPartId, 'same edge, same id, no duplicate');
    assert.notEqual(raise.deliveryPartId, clear.deliveryPartId);
    assert.match(raise.text, /🟡 Запись временно недоступна/);
    assert.match(clear.text, /🟢 Запись восстановлена/);
    assert.match(
      renderAlert('dead_jobs', 'raised', 'Причина: model missing', 12345).text,
      /остановилась после повторных ошибок/,
    );
    assert.match(
      renderAlert('llm_unavailable', 'raised', 'Причина: not reachable', 12345).text,
      /Структурный отчёт временно недоступен/,
    );
  });
});

describe('health evaluation', () => {
  const base = {
    recorderRunning: true,
    msSinceLastFrame: 100,
    processingLagMs: 0,
    minutesSinceLastClosedPart: 2,
    workerReady: true,
    workerDetail: 'ready',
    ollamaReady: true,
    ollamaDetail: 'ready',
    activeSessionMs: null,
    asrBacklogMinutes: 0,
    deadJobs: 0,
    outboxAgeMinutes: 0,
    deadOutbox: 0,
    diskFreeGb: 200,
    sqliteWritable: true,
    hoursSinceLastDigest: 1,
  };

  it('reports OK when everything is fine', () => {
    const report = evaluateHealth(base, DEFAULT_CONFIG.health);
    assert.equal(report.overall, 'healthy');
    assert.equal(renderHealthLines(report), '✅ Всё в порядке');
  });

  it('fails when audio has stopped arriving', () => {
    const report = evaluateHealth(
      { ...base, msSinceLastFrame: 16 * 60_000 },
      DEFAULT_CONFIG.health,
    );
    assert.equal(report.overall, 'failed');
    assert.equal(renderHealthLines(report), 'ОШИБКА: запись — нет аудиокадров 960 сек');
  });

  it('is "recovering", not "failed", before the first frame arrives', () => {
    // Startup is not a failure; announcing one would be a false alarm.
    const report = evaluateHealth({ ...base, msSinceLastFrame: null }, DEFAULT_CONFIG.health);
    assert.equal(report.overall, 'recovering');
  });

  it('distinguishes downstream processing lag from a silent microphone', () => {
    const report = evaluateHealth({ ...base, processingLagMs: 16_000 }, DEFAULT_CONFIG.health);
    assert.equal(report.overall, 'degraded');
    assert.equal(
      renderHealthLines(report),
      'ВНИМАНИЕ: обработка аудио — обработка отстаёт на 16 сек',
    );
    assert.equal(report.checks.find((check) => check.component === 'recorder')?.status, 'healthy');
  });

  it('warns on low disk without failing', () => {
    const report = evaluateHealth({ ...base, diskFreeGb: 5 }, DEFAULT_CONFIG.health);
    assert.equal(report.overall, 'degraded');
    assert.equal(renderHealthLines(report), 'ВНИМАНИЕ: диск — свободно 5 ГБ');
  });

  it('warns on ASR backlog', () => {
    const report = evaluateHealth({ ...base, asrBacklogMinutes: 63 }, DEFAULT_CONFIG.health);
    assert.equal(
      renderHealthLines(report),
      'ВНИМАНИЕ: очередь распознавания — старейшей задаче 63 мин',
    );
  });

  it('keeps raw adapter failures out of the Russian chat boundary', () => {
    const report = evaluateHealth(
      {
        ...base,
        workerReady: false,
        workerDetail: 'spawn failed: /Users/alice/private/model.bin',
        ollamaReady: false,
        ollamaDetail: 'ECONNREFUSED 127.0.0.1:11434',
      },
      DEFAULT_CONFIG.health,
    );
    assert.equal(
      renderHealthLines(report),
      'ОШИБКА: распознавание — локальный ASR недоступен\n' +
        'ВНИМАНИЕ: отчёты — локальные отчёты недоступны; транскрипты продолжат работать',
    );
  });

  it('makes exhausted jobs and messages visible', () => {
    const report = evaluateHealth({ ...base, deadJobs: 2, deadOutbox: 1 }, DEFAULT_CONFIG.health);
    assert.equal(report.checks.find((check) => check.component === 'dead_jobs')?.status, 'failed');
    assert.equal(
      report.checks.find((check) => check.component === 'dead_outbox')?.status,
      'degraded',
    );
  });

  it('treats a missing LLM as degraded, never as a stop', () => {
    // Audio and transcripts must still be delivered without a summarizer.
    const report = evaluateHealth(
      { ...base, ollamaReady: false, ollamaDetail: 'not reachable' },
      DEFAULT_CONFIG.health,
    );
    assert.equal(report.overall, 'degraded');
    assert.equal(report.checks.find((c) => c.component === 'llm')?.status, 'degraded');
  });

  it('fails when the database is unwritable', () => {
    const report = evaluateHealth({ ...base, sqliteWritable: false }, DEFAULT_CONFIG.health);
    assert.equal(report.overall, 'failed');
  });

  it('reports the worst status across all components', () => {
    const report = evaluateHealth(
      { ...base, diskFreeGb: 1, recorderRunning: false },
      DEFAULT_CONFIG.health,
    );
    assert.equal(report.overall, 'failed');
  });
});
