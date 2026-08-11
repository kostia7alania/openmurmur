import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { type Database, openDatabase } from '../../src/database/db.ts';
import {
  applyTelegramDeliveryReconciliation,
  listUnacknowledgedTelegramDeliveries,
  TelegramDeliveryReconciliationError,
} from '../../src/telegram/reconcile-delivery.ts';

const CREATED = '2026-08-11T10:00:00.000Z';
const ACK = '2026-08-11T10:05:00.000Z';
const NOW = Date.parse('2026-08-11T12:00:00.000Z');

let directory: string;
let db: Database;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'om-telegram-delivery-reconcile-'));
  db = openDatabase({ file: join(directory, 'test.db') });
});

afterEach(() => {
  db.close();
  rmSync(directory, { recursive: true, force: true });
});

function seedOutbox(input: {
  readonly id: string;
  readonly deliveryPartId: string;
  readonly kind?: string;
  readonly sessionId?: string | null;
  readonly payload?: unknown;
  readonly state?: string;
  readonly attempts?: number;
  readonly messageId?: number | null;
}): void {
  db.handle
    .prepare(
      `INSERT INTO telegram_outbox
         (outbox_id, delivery_part_id, session_id, kind, ordinal, payload, state,
          attempts, telegram_message_id, run_after, created_at, updated_at)
       VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.id,
      input.deliveryPartId,
      input.sessionId ?? null,
      input.kind ?? 'status',
      JSON.stringify(input.payload ?? { type: 'text', text: 'delivered text' }),
      input.state ?? 'pending',
      input.attempts ?? 1,
      input.messageId ?? null,
      CREATED,
      CREATED,
      CREATED,
    );
}

function seedAudioOwner(sessionId: string, partId: string): void {
  db.handle
    .prepare(
      `INSERT INTO audio_sessions
         (session_id, state, started_at, ended_at, duration_ms, speech_ms,
          part_count, created_at, updated_at)
       VALUES (?, 'DELIVERING', ?, ?, 1, 1, 1, ?, ?)`,
    )
    .run(sessionId, CREATED, CREATED, CREATED, CREATED);
  db.handle
    .prepare(
      `INSERT INTO audio_parts
         (part_id, session_id, part_index, path, started_at, ended_at, duration_ms,
          bytes, sha256, finalized, delivered, created_at)
       VALUES (?, ?, 0, ?, ?, ?, 1, 10, 'sha', 1, 0, ?)`,
    )
    .run(partId, sessionId, join(directory, `${partId}.flac`), CREATED, CREATED, CREATED);
}

function seedDeliveredSessionCompanions(sessionId: string): void {
  seedOutbox({
    id: `${sessionId}-transcript-row`,
    deliveryPartId: `transcript:${sessionId}:1`,
    kind: 'transcript',
    sessionId,
    state: 'sent',
    messageId: 401,
  });
  seedOutbox({
    id: `${sessionId}-report-row`,
    deliveryPartId: `report:${sessionId}`,
    kind: 'report',
    sessionId,
    state: 'sent',
    messageId: 402,
  });
}

function request(deliveryPartId: string, telegramMessageId = 501) {
  const report = listUnacknowledgedTelegramDeliveries(db.handle, { deliveryPartId });
  const expected = report.deliveries[0];
  assert.ok(expected);
  return {
    deliveryPartId,
    telegramMessageId,
    acknowledgedAt: ACK,
    operatorId: 'operator@example',
    evidence: 'Telegram Desktop JSON export message checked against payload sha256',
    expected,
    now: NOW,
  } as const;
}

describe('remote Telegram delivery reconciliation', () => {
  it('reports unknown remote status without changing local delivery facts', () => {
    seedOutbox({ id: 'report-row', deliveryPartId: 'status:report' });

    const report = listUnacknowledgedTelegramDeliveries(db.handle);

    assert.equal(report.truncated, false);
    assert.equal(report.deliveries.length, 1);
    assert.deepEqual(
      {
        deliveryPartId: report.deliveries[0]?.deliveryPartId,
        remoteStatus: report.deliveries[0]?.remoteStatus,
        blockedReason: report.deliveries[0]?.blockedReason,
      },
      {
        deliveryPartId: 'status:report',
        remoteStatus: 'unknown',
        blockedReason: null,
      },
    );
    const stored = db.handle
      .prepare('SELECT state, telegram_message_id FROM telegram_outbox WHERE outbox_id = ?')
      .get('report-row') as { state: string; telegram_message_id: number | null };
    assert.deepEqual({ ...stored }, { state: 'pending', telegram_message_id: null });
    const audits = db.handle
      .prepare('SELECT count(*) AS count FROM telegram_delivery_reconciliation_audit')
      .get() as { count: number };
    assert.equal(audits.count, 0);
  });

  it('stores one exact remote identity and immutable audit atomically', () => {
    seedOutbox({ id: 'apply-row', deliveryPartId: 'status:apply' });

    const result = applyTelegramDeliveryReconciliation(db.handle, request('status:apply'));

    assert.equal(result.telegramMessageId, 501);
    assert.equal(result.acknowledgedAt, ACK);
    assert.equal(result.alreadyApplied, false);
    const stored = db.handle
      .prepare(
        `SELECT state, telegram_message_id, updated_at
           FROM telegram_outbox WHERE outbox_id = 'apply-row'`,
      )
      .get() as { state: string; telegram_message_id: number; updated_at: string };
    assert.deepEqual({ ...stored }, { state: 'sent', telegram_message_id: 501, updated_at: ACK });
    const audit = db.handle
      .prepare(
        `SELECT delivery_part_id, previous_state, previous_attempts,
                telegram_message_id, acknowledged_at, operator_id, evidence,
                payload_sha256, applied_at
           FROM telegram_delivery_reconciliation_audit`,
      )
      .get() as Record<string, unknown>;
    assert.deepEqual(
      { ...audit },
      {
        delivery_part_id: 'status:apply',
        previous_state: 'pending',
        previous_attempts: 1,
        telegram_message_id: 501,
        acknowledged_at: ACK,
        operator_id: 'operator@example',
        evidence: 'Telegram Desktop JSON export message checked against payload sha256',
        payload_sha256: result.payloadSha256,
        applied_at: '2026-08-11T12:00:00.000Z',
      },
    );
    assert.throws(
      () =>
        db.handle
          .prepare('UPDATE telegram_delivery_reconciliation_audit SET evidence = ?')
          .run('changed'),
      /audit is immutable/,
    );
    assert.throws(
      () => db.handle.prepare('DELETE FROM telegram_delivery_reconciliation_audit').run(),
      /audit is immutable/,
    );
  });

  it('is idempotent only for the exact same operator evidence', () => {
    seedOutbox({ id: 'idempotent-row', deliveryPartId: 'status:idempotent' });
    const firstRequest = request('status:idempotent');
    const first = applyTelegramDeliveryReconciliation(db.handle, firstRequest);
    const replay = applyTelegramDeliveryReconciliation(db.handle, {
      ...firstRequest,
      expected: undefined,
    });

    assert.equal(replay.reconciliationId, first.reconciliationId);
    assert.equal(replay.alreadyApplied, true);
    assert.throws(
      () =>
        applyTelegramDeliveryReconciliation(db.handle, {
          ...firstRequest,
          expected: undefined,
          telegramMessageId: 999,
        }),
      /different operator evidence/,
    );
    const audits = db.handle
      .prepare('SELECT count(*) AS count FROM telegram_delivery_reconciliation_audit')
      .get() as { count: number };
    assert.equal(audits.count, 1);
  });

  it('rejects idempotent replay after any audit-bound outbox identity changes', () => {
    db.handle.exec(`
      INSERT INTO audio_sessions
        (session_id, state, started_at, created_at, updated_at)
      VALUES ('mutated-owner', 'DELIVERING', '${CREATED}', '${CREATED}', '${CREATED}')
    `);
    seedOutbox({ id: 'mutated-replay-row', deliveryPartId: 'status:mutated-replay' });
    const reconciliation = request('status:mutated-replay');
    applyTelegramDeliveryReconciliation(db.handle, reconciliation);
    const replay = () =>
      applyTelegramDeliveryReconciliation(db.handle, {
        ...reconciliation,
        expected: undefined,
      });

    db.handle
      .prepare("UPDATE telegram_outbox SET kind = 'alert' WHERE outbox_id = 'mutated-replay-row'")
      .run();
    assert.throws(replay, /facts changed after the immutable audit/);
    db.handle
      .prepare("UPDATE telegram_outbox SET kind = 'status' WHERE outbox_id = 'mutated-replay-row'")
      .run();

    db.handle
      .prepare(
        "UPDATE telegram_outbox SET session_id = 'mutated-owner' WHERE outbox_id = 'mutated-replay-row'",
      )
      .run();
    assert.throws(replay, /facts changed after the immutable audit/);
    db.handle
      .prepare(
        "UPDATE telegram_outbox SET session_id = NULL WHERE outbox_id = 'mutated-replay-row'",
      )
      .run();

    db.handle
      .prepare(
        "UPDATE telegram_outbox SET updated_at = '2026-08-11T10:06:00.000Z' WHERE outbox_id = 'mutated-replay-row'",
      )
      .run();
    assert.throws(replay, /facts changed after the immutable audit/);
  });

  it('preserves support for every non-audio outbound kind', () => {
    db.handle.exec(`
      INSERT INTO audio_sessions
        (session_id, state, started_at, created_at, updated_at)
      VALUES ('kind-session', 'DELIVERING', '${CREATED}', '${CREATED}', '${CREATED}')
    `);
    const rows = [
      { id: 'kind-status', deliveryPartId: 'status:kind', kind: 'status', sessionId: null },
      { id: 'kind-alert', deliveryPartId: 'alert:kind', kind: 'alert', sessionId: null },
      { id: 'kind-digest', deliveryPartId: 'digest:2026-08-11', kind: 'digest', sessionId: null },
      {
        id: 'kind-transcript',
        deliveryPartId: 'transcript:kind-session:1',
        kind: 'transcript',
        sessionId: 'kind-session',
      },
      {
        id: 'kind-report',
        deliveryPartId: 'report:kind-session',
        kind: 'report',
        sessionId: 'kind-session',
      },
    ] as const;
    for (const [index, row] of rows.entries()) {
      seedOutbox(row);
      applyTelegramDeliveryReconciliation(db.handle, request(row.deliveryPartId, 600 + index));
    }

    const states = db.handle
      .prepare(
        "SELECT kind, state FROM telegram_outbox WHERE outbox_id LIKE 'kind-%' ORDER BY kind",
      )
      .all() as { kind: string; state: string }[];
    assert.ok(states.every((row) => row.state === 'sent'));
    const session = db.handle
      .prepare('SELECT state FROM audio_sessions WHERE session_id = ?')
      .get('kind-session') as { state: string };
    assert.equal(
      session.state,
      'DELIVERING',
      'missing audio proof prevents remote reconciliation from inventing DONE',
    );
  });

  it('accepts an exact revision-scoped report after that revision stops being current', () => {
    db.handle.exec(`
      INSERT INTO audio_sessions
        (session_id, state, started_at, created_at, updated_at)
      VALUES ('report-session', 'DELIVERING', '${CREATED}', '${CREATED}', '${CREATED}');
      INSERT INTO transcript_revisions
        (revision_id, session_id, revision_number, engine, model, languages,
         text, word_count, is_current, created_at)
      VALUES ('report-revision', 'report-session', 1, 'fake', 'fake', '[]',
              'old transcript', 2, 0, '${CREATED}'),
             ('current-revision', 'report-session', 2, 'fake', 'fake', '[]',
              'current transcript', 2, 1, '${CREATED}');
      INSERT INTO summaries
        (summary_id, session_id, revision_id, engine, model, payload, created_at)
      VALUES ('report-summary-row', 'report-session', 'report-revision',
              'fake', 'fake', '{}', '${CREATED}');
    `);
    seedOutbox({
      id: 'scoped-report',
      deliveryPartId: 'report:report-session:report-revision',
      kind: 'report',
      sessionId: 'report-session',
    });
    seedOutbox({
      id: 'scoped-report-preview',
      deliveryPartId: 'report-summary:report-session:report-revision',
      kind: 'report',
      sessionId: 'report-session',
    });

    applyTelegramDeliveryReconciliation(
      db.handle,
      request('report:report-session:report-revision'),
    );
    applyTelegramDeliveryReconciliation(
      db.handle,
      request('report-summary:report-session:report-revision', 502),
    );

    const sent = db.handle
      .prepare(
        `SELECT count(*) AS count
           FROM telegram_outbox
          WHERE outbox_id IN ('scoped-report', 'scoped-report-preview')
            AND state = 'sent'`,
      )
      .get() as { count: number };
    assert.equal(sent.count, 2);
  });

  it('fails closed for malformed or unproven revision-scoped report ids', () => {
    db.handle.exec(`
      INSERT INTO audio_sessions
        (session_id, state, started_at, created_at, updated_at)
      VALUES ('unproven-report-session', 'DELIVERING', '${CREATED}', '${CREATED}', '${CREATED}');
      INSERT INTO transcript_revisions
        (revision_id, session_id, revision_number, engine, model, languages,
         text, word_count, is_current, created_at)
      VALUES ('unproven-revision', 'unproven-report-session', 1, 'fake', 'fake', '[]',
              'transcript', 1, 1, '${CREATED}');
    `);
    seedOutbox({
      id: 'malformed-report',
      deliveryPartId: 'report:unproven-report-session:unproven-revision:extra',
      kind: 'report',
      sessionId: 'unproven-report-session',
    });
    seedOutbox({
      id: 'summaryless-report',
      deliveryPartId: 'report:unproven-report-session:unproven-revision',
      kind: 'report',
      sessionId: 'unproven-report-session',
    });

    assert.throws(
      () =>
        applyTelegramDeliveryReconciliation(
          db.handle,
          request('report:unproven-report-session:unproven-revision:extra'),
        ),
      /does not match its durable session owner/,
    );
    assert.throws(
      () =>
        applyTelegramDeliveryReconciliation(
          db.handle,
          request('report:unproven-report-session:unproven-revision'),
        ),
      /no matching durable session summary/,
    );
  });

  it('fails closed for an unattempted row, stale preview, or impossible ACK time', () => {
    seedOutbox({
      id: 'unattempted-row',
      deliveryPartId: 'status:unattempted',
      attempts: 0,
    });
    const unattempted = request('status:unattempted');
    assert.throws(
      () => applyTelegramDeliveryReconciliation(db.handle, unattempted),
      /no local send attempt/,
    );

    seedOutbox({ id: 'stale-row', deliveryPartId: 'status:stale' });
    const stale = request('status:stale');
    db.handle
      .prepare('UPDATE telegram_outbox SET attempts = 2 WHERE delivery_part_id = ?')
      .run('status:stale');
    assert.throws(
      () => applyTelegramDeliveryReconciliation(db.handle, stale),
      /changed after preview/,
    );

    seedOutbox({ id: 'time-row', deliveryPartId: 'status:time' });
    const timed = request('status:time');
    assert.throws(
      () =>
        applyTelegramDeliveryReconciliation(db.handle, {
          ...timed,
          acknowledgedAt: '2026-08-11T09:59:59.999Z',
        }),
      /predates the durable outbox request/,
    );
  });

  it('rolls back outbox and audit if the audio domain callback fails', () => {
    db.handle.exec(`
      INSERT INTO audio_sessions
        (session_id, state, started_at, ended_at, duration_ms, speech_ms,
         part_count, created_at, updated_at)
      VALUES ('audio-session', 'DELIVERING', '${CREATED}', '${CREATED}', 1, 1, 1,
              '${CREATED}', '${CREATED}');
      INSERT INTO audio_parts
        (part_id, session_id, part_index, path, started_at, ended_at, duration_ms,
         bytes, sha256, finalized, delivered, created_at)
      VALUES ('audio-part', 'audio-session', 0, '${directory}/audio.flac', '${CREATED}',
              '${CREATED}', 1, 10, 'sha', 1, 0, '${CREATED}');
    `);
    seedOutbox({
      id: 'audio-row',
      deliveryPartId: 'audio:audio-part',
      kind: 'audio',
      sessionId: 'audio-session',
      payload: {
        type: 'document',
        path: join(directory, 'audio.flac'),
        filename: 'audio.flac',
        partId: 'audio-part',
      },
    });
    const reconciliation = request('audio:audio-part');
    db.handle.exec(`
      CREATE TEMP TRIGGER fail_reconciled_audio_domain
      BEFORE UPDATE OF delivered ON audio_parts
      BEGIN SELECT RAISE(ABORT, 'injected audio domain failure'); END
    `);

    assert.throws(
      () => applyTelegramDeliveryReconciliation(db.handle, reconciliation),
      /injected audio domain failure/,
    );
    const afterFault = db.handle
      .prepare(
        `SELECT o.state, o.telegram_message_id, p.delivered, p.delivered_at
           FROM telegram_outbox o
           JOIN audio_parts p ON p.part_id = 'audio-part'
          WHERE o.outbox_id = 'audio-row'`,
      )
      .get() as Record<string, unknown>;
    assert.deepEqual(
      { ...afterFault },
      { state: 'pending', telegram_message_id: null, delivered: 0, delivered_at: null },
    );
    db.handle.exec('DROP TRIGGER fail_reconciled_audio_domain');

    applyTelegramDeliveryReconciliation(db.handle, reconciliation);
    const delivered = db.handle
      .prepare('SELECT delivered, delivered_at FROM audio_parts WHERE part_id = ?')
      .get('audio-part') as { delivered: number; delivered_at: string };
    assert.deepEqual({ ...delivered }, { delivered: 1, delivered_at: ACK });
  });

  it('rejects lone, gapped, and mixed audio manifests without inventing DONE', () => {
    const cases = [
      { name: 'lone', currentSuffix: ':split7', sentSuffixes: [] },
      { name: 'gapped', currentSuffix: ':split2', sentSuffixes: [':split0'] },
      { name: 'mixed', currentSuffix: ':split0', sentSuffixes: [''] },
    ] as const;

    for (const testCase of cases) {
      const sessionId = `${testCase.name}-manifest-session`;
      const partId = `${testCase.name}-manifest-part`;
      seedAudioOwner(sessionId, partId);
      seedDeliveredSessionCompanions(sessionId);
      for (const [index, suffix] of testCase.sentSuffixes.entries()) {
        seedOutbox({
          id: `${testCase.name}-sent-audio-${index}`,
          deliveryPartId: `audio:${partId}${suffix}`,
          kind: 'audio',
          sessionId,
          payload: {
            type: 'document',
            path: join(directory, `${partId}${suffix}.flac`),
            filename: `${partId}${suffix}.flac`,
            partId,
          },
          state: 'sent',
          messageId: 450 + index,
        });
      }
      const currentDeliveryId = `audio:${partId}${testCase.currentSuffix}`;
      seedOutbox({
        id: `${testCase.name}-current-audio`,
        deliveryPartId: currentDeliveryId,
        kind: 'audio',
        sessionId,
        payload: {
          type: 'document',
          path: join(directory, `${partId}${testCase.currentSuffix}.flac`),
          filename: `${partId}${testCase.currentSuffix}.flac`,
          partId,
        },
      });

      assert.throws(
        () => applyTelegramDeliveryReconciliation(db.handle, request(currentDeliveryId)),
        TelegramDeliveryReconciliationError,
      );
      const facts = db.handle
        .prepare(
          `SELECT s.state AS session_state, p.delivered, p.delivered_at, o.state AS outbox_state
             FROM audio_sessions s
             JOIN audio_parts p ON p.session_id = s.session_id
             JOIN telegram_outbox o ON o.outbox_id = ?
            WHERE s.session_id = ?`,
        )
        .get(`${testCase.name}-current-audio`, sessionId) as Record<string, unknown>;
      assert.deepEqual(
        { ...facts },
        {
          session_state: 'DELIVERING',
          delivered: 0,
          delivered_at: null,
          outbox_state: 'pending',
        },
      );
    }
  });

  it('reconciles a contiguous pending split manifest one remote ACK at a time', () => {
    const sessionId = 'sequential-manifest-session';
    const partId = 'sequential-manifest-part';
    seedAudioOwner(sessionId, partId);
    seedDeliveredSessionCompanions(sessionId);
    for (const index of [0, 1]) {
      seedOutbox({
        id: `sequential-split${index}`,
        deliveryPartId: `audio:${partId}:split${index}`,
        kind: 'audio',
        sessionId,
        payload: {
          type: 'document',
          path: join(directory, `${partId}.split00${index}.flac`),
          filename: `${partId}.split00${index}.flac`,
          partId,
        },
      });
    }

    const firstDeliveryId = `audio:${partId}:split0`;
    applyTelegramDeliveryReconciliation(db.handle, request(firstDeliveryId));

    const afterFirst = db.handle
      .prepare(
        `SELECT s.state AS session_state, p.delivered, p.delivered_at,
                first.state AS first_state, second.state AS second_state,
                (SELECT count(*) FROM telegram_delivery_reconciliation_audit) AS audits
           FROM audio_sessions s
           JOIN audio_parts p ON p.session_id = s.session_id
           JOIN telegram_outbox first ON first.outbox_id = 'sequential-split0'
           JOIN telegram_outbox second ON second.outbox_id = 'sequential-split1'
          WHERE s.session_id = ?`,
      )
      .get(sessionId) as Record<string, unknown>;
    assert.deepEqual(
      { ...afterFirst },
      {
        session_state: 'DELIVERING',
        delivered: 0,
        delivered_at: null,
        first_state: 'sent',
        second_state: 'pending',
        audits: 1,
      },
    );

    const finalDeliveryId = `audio:${partId}:split1`;
    applyTelegramDeliveryReconciliation(db.handle, request(finalDeliveryId, 502));

    const completed = db.handle
      .prepare(
        `SELECT s.state AS session_state, p.delivered, p.delivered_at,
                sum(o.state = 'sent') AS sent_rows,
                (SELECT count(*) FROM telegram_delivery_reconciliation_audit) AS audits
           FROM audio_sessions s
           JOIN audio_parts p ON p.session_id = s.session_id
           JOIN telegram_outbox o ON o.kind = 'audio' AND o.session_id = s.session_id
          WHERE s.session_id = ?`,
      )
      .get(sessionId) as Record<string, unknown>;
    assert.deepEqual(
      { ...completed },
      {
        session_state: 'DONE',
        delivered: 1,
        delivered_at: ACK,
        sent_rows: 2,
        audits: 2,
      },
    );
  });

  it('accepts only a contiguous split0-through-final audio manifest', () => {
    const sessionId = 'contiguous-manifest-session';
    const partId = 'contiguous-manifest-part';
    seedAudioOwner(sessionId, partId);
    seedDeliveredSessionCompanions(sessionId);
    seedOutbox({
      id: 'contiguous-split0',
      deliveryPartId: `audio:${partId}:split0`,
      kind: 'audio',
      sessionId,
      payload: {
        type: 'document',
        path: join(directory, `${partId}.split000.flac`),
        filename: `${partId}.split000.flac`,
        partId,
      },
      state: 'sent',
      messageId: 450,
    });
    const finalDeliveryId = `audio:${partId}:split1`;
    seedOutbox({
      id: 'contiguous-split1',
      deliveryPartId: finalDeliveryId,
      kind: 'audio',
      sessionId,
      payload: {
        type: 'document',
        path: join(directory, `${partId}.split001.flac`),
        filename: `${partId}.split001.flac`,
        partId,
      },
    });

    applyTelegramDeliveryReconciliation(db.handle, request(finalDeliveryId));

    const facts = db.handle
      .prepare(
        `SELECT s.state AS session_state, p.delivered, p.delivered_at
           FROM audio_sessions s
           JOIN audio_parts p ON p.session_id = s.session_id
          WHERE s.session_id = ?`,
      )
      .get(sessionId) as Record<string, unknown>;
    assert.deepEqual({ ...facts }, { session_state: 'DONE', delivered: 1, delivered_at: ACK });
  });

  it('atomically completes an exact incoming transcript manifest', () => {
    db.handle
      .prepare(
        `INSERT INTO incoming_telegram_files
           (file_uid, telegram_file_id, telegram_unique_id, chat_id, message_id,
            state, created_at, updated_at)
         VALUES ('incoming-owner', 'file', 'unique', 42, 1, 'transcribed', ?, ?)`,
      )
      .run(CREATED, CREATED);
    db.handle
      .prepare(
        `INSERT INTO transcript_revisions
           (revision_id, incoming_file_id, revision_number, engine, model, languages,
            text, word_count, is_current, created_at)
         VALUES ('incoming-revision', 'incoming-owner', 1, 'fake', 'fake', '[]',
                 'transcript', 1, 1, ?)`,
      )
      .run(CREATED);
    seedOutbox({
      id: 'incoming-first',
      deliveryPartId: 'incoming:incoming-owner:1',
      kind: 'incoming_transcript',
      payload: { type: 'text', text: 'first' },
      state: 'sent',
      attempts: 1,
      messageId: 500,
    });
    seedOutbox({
      id: 'incoming-final',
      deliveryPartId: 'incoming:incoming-owner:2',
      kind: 'incoming_transcript',
      payload: {
        type: 'text',
        text: 'final',
        replyMarkup: { inline_keyboard: [] },
      },
    });

    applyTelegramDeliveryReconciliation(db.handle, request('incoming:incoming-owner:2', 501));

    const incoming = db.handle
      .prepare('SELECT state, delivered_at FROM incoming_telegram_files WHERE file_uid = ?')
      .get('incoming-owner') as { state: string; delivered_at: string };
    assert.deepEqual({ ...incoming }, { state: 'delivered', delivered_at: ACK });
  });

  it('preserves every fact when an audio payload cannot prove its domain owner', () => {
    db.handle.exec(`
      INSERT INTO audio_sessions
        (session_id, state, started_at, created_at, updated_at)
      VALUES ('broken-session', 'DELIVERING', '${CREATED}', '${CREATED}', '${CREATED}')
    `);
    seedOutbox({
      id: 'broken-audio',
      deliveryPartId: 'audio:missing-part',
      kind: 'audio',
      sessionId: 'broken-session',
      payload: { type: 'document', path: '/tmp/missing.flac', filename: 'missing.flac' },
    });

    assert.throws(
      () => applyTelegramDeliveryReconciliation(db.handle, request('audio:missing-part')),
      TelegramDeliveryReconciliationError,
    );
    const row = db.handle
      .prepare('SELECT state, telegram_message_id FROM telegram_outbox WHERE outbox_id = ?')
      .get('broken-audio') as Record<string, unknown>;
    assert.deepEqual({ ...row }, { state: 'pending', telegram_message_id: null });
  });

  it('rejects a transcript row whose delivery id does not match its session', () => {
    db.handle.exec(`
      INSERT INTO audio_sessions
        (session_id, state, started_at, created_at, updated_at)
      VALUES ('transcript-session', 'DELIVERING', '${CREATED}', '${CREATED}', '${CREATED}')
    `);
    seedOutbox({
      id: 'broken-transcript',
      deliveryPartId: 'transcript:another-session:1',
      kind: 'transcript',
      sessionId: 'transcript-session',
    });

    assert.throws(
      () => applyTelegramDeliveryReconciliation(db.handle, request('transcript:another-session:1')),
      /does not match its durable session owner/,
    );
    const row = db.handle
      .prepare('SELECT state, telegram_message_id FROM telegram_outbox WHERE outbox_id = ?')
      .get('broken-transcript') as Record<string, unknown>;
    assert.deepEqual({ ...row }, { state: 'pending', telegram_message_id: null });
  });
});
