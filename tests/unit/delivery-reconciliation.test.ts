import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { type Database, openDatabase } from '../../src/database/db.ts';
import {
  applyDeliveryReconciliation,
  DeliveryReconciliationError,
  exactUtcAcknowledgement,
  listHeldLegacyDeliveries,
} from '../../src/retention/reconcile-delivery.ts';

let directory: string;
let db: Database;

const STARTED = '2026-08-11T09:00:00.000Z';
const ENDED = '2026-08-11T10:00:00.000Z';
const ACK = '2026-08-11T10:05:00.000Z';
const NOW = Date.parse('2026-08-11T12:00:00.000Z');

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'om-delivery-reconcile-'));
  db = openDatabase({ file: join(directory, 'test.db') });
});

afterEach(() => {
  db.close();
  rmSync(directory, { recursive: true, force: true });
});

function seedHeldPart(sessionId: string, partId: string, partIndex = 0): void {
  db.handle
    .prepare(
      `INSERT OR IGNORE INTO audio_sessions
         (session_id, state, started_at, ended_at, duration_ms, speech_ms, part_count,
          created_at, updated_at)
       VALUES (?, 'DONE', ?, ?, 3600000, 3000000, 1, ?, ?)`,
    )
    .run(sessionId, STARTED, ENDED, STARTED, ENDED);
  db.handle
    .prepare(
      `INSERT INTO audio_parts
         (part_id, session_id, part_index, path, started_at, ended_at, duration_ms,
          bytes, sha256, finalized, delivered, delivered_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 3600000, 100, 'sha', 1, 1, NULL, ?)`,
    )
    .run(partId, sessionId, partIndex, join(directory, `${partId}.flac`), STARTED, ENDED, STARTED);
}

function request(partId: string) {
  return {
    selector: { partId },
    acknowledgedAt: ACK,
    operatorId: 'operator@example',
    evidence: 'Telegram export message 501 checked manually',
    expectedPartIds: [partId],
    now: NOW,
  } as const;
}

describe('legacy delivery reconciliation', () => {
  it('reports held rows without inventing or writing an acknowledgement', () => {
    seedHeldPart('session-report', 'part-report');
    db.handle
      .prepare(
        `INSERT INTO telegram_outbox
           (outbox_id, delivery_part_id, session_id, kind, ordinal, payload, state,
            run_after, created_at, updated_at)
         VALUES ('direct', 'audio:part-report', 'session-report', 'audio', 0, '{}', 'sent', ?, ?, ?),
                ('split', 'audio:part-report:split0', 'session-report', 'audio', 0, '{}',
                 'sent', ?, ?, ?)`,
      )
      .run(STARTED, STARTED, STARTED, STARTED, STARTED, STARTED);

    const held = listHeldLegacyDeliveries(db.handle);
    assert.deepEqual(held, [
      {
        partId: 'part-report',
        sessionId: 'session-report',
        partIndex: 0,
        startedAt: STARTED,
        endedAt: ENDED,
        sessionEndedAt: ENDED,
        finalized: true,
        hasChecksum: true,
        outboxRows: 2,
        sentOutboxRows: 2,
      },
    ]);
    const row = db.handle
      .prepare('SELECT delivered_at FROM audio_parts WHERE part_id = ?')
      .get('part-report') as { delivered_at: string | null };
    assert.equal(row.delivered_at, null);
    const audit = db.handle
      .prepare('SELECT count(*) AS count FROM audio_delivery_reconciliation_audit')
      .get() as { count: number };
    assert.equal(audit.count, 0);
  });

  it('atomically stores the exact supplied ACK and immutable audit metadata', () => {
    seedHeldPart('session-apply', 'part-apply');
    const result = applyDeliveryReconciliation(db.handle, request('part-apply'));

    assert.equal(result.acknowledgedAt, ACK);
    assert.deepEqual(result.partIds, ['part-apply']);
    const stored = db.handle
      .prepare('SELECT delivered_at FROM audio_parts WHERE part_id = ?')
      .get('part-apply') as { delivered_at: string | null };
    assert.equal(stored.delivered_at, ACK);
    const audit = db.handle
      .prepare(
        `SELECT part_id, session_id, scope_kind, scope_id, acknowledged_at,
                operator_id, evidence, previous_delivered, previous_delivered_at, applied_at
           FROM audio_delivery_reconciliation_audit`,
      )
      .get() as Record<string, unknown>;
    assert.deepEqual(
      { ...audit },
      {
        part_id: 'part-apply',
        session_id: 'session-apply',
        scope_kind: 'part',
        scope_id: 'part-apply',
        acknowledged_at: ACK,
        operator_id: 'operator@example',
        evidence: 'Telegram export message 501 checked manually',
        previous_delivered: 1,
        previous_delivered_at: null,
        applied_at: '2026-08-11T12:00:00.000Z',
      },
    );
    assert.throws(
      () => db.handle.prepare('DELETE FROM audio_delivery_reconciliation_audit').run(),
      /audit is immutable/,
    );
    assert.throws(
      () =>
        db.handle.prepare('UPDATE audio_delivery_reconciliation_audit SET evidence = ?').run('x'),
      /audit is immutable/,
    );
  });

  it('fails closed on invalid, future, or pre-recording timestamps', () => {
    seedHeldPart('session-time', 'part-time');
    assert.throws(
      () => exactUtcAcknowledgement('2026-08-11T10:05:00Z'),
      /YYYY-MM-DDTHH:mm:ss.sssZ/,
    );
    for (const acknowledgedAt of ['2026-08-11T08:00:00.000Z', '2026-08-11T13:00:00.000Z']) {
      assert.throws(
        () => applyDeliveryReconciliation(db.handle, { ...request('part-time'), acknowledgedAt }),
        DeliveryReconciliationError,
      );
    }
    const row = db.handle
      .prepare('SELECT delivered_at FROM audio_parts WHERE part_id = ?')
      .get('part-time') as { delivered_at: string | null };
    assert.equal(row.delivered_at, null);
    const audit = db.handle
      .prepare('SELECT count(*) AS count FROM audio_delivery_reconciliation_audit')
      .get() as { count: number };
    assert.equal(audit.count, 0);
  });

  it('aborts atomically when the held selection changed after preview', () => {
    seedHeldPart('session-stale', 'part-stale');
    assert.throws(
      () =>
        applyDeliveryReconciliation(db.handle, {
          ...request('part-stale'),
          expectedPartIds: ['part-stale', 'part-never-previewed'],
        }),
      /selection changed after preview/,
    );
    const row = db.handle
      .prepare('SELECT delivered_at FROM audio_parts WHERE part_id = ?')
      .get('part-stale') as { delivered_at: string | null };
    assert.equal(row.delivered_at, null);
    const audit = db.handle
      .prepare('SELECT count(*) AS count FROM audio_delivery_reconciliation_audit')
      .get() as { count: number };
    assert.equal(audit.count, 0);
  });

  it('rolls the audit back when the clock update fails', () => {
    seedHeldPart('session-fault', 'part-fault');
    db.handle.exec(`
      CREATE TEMP TRIGGER inject_reconciliation_clock_fault
      BEFORE UPDATE OF delivered_at ON audio_parts
      WHEN new.part_id = 'part-fault'
      BEGIN
        SELECT RAISE(ABORT, 'injected clock write fault');
      END
    `);

    assert.throws(
      () => applyDeliveryReconciliation(db.handle, request('part-fault')),
      /injected clock write fault/,
    );
    const row = db.handle
      .prepare('SELECT delivered_at FROM audio_parts WHERE part_id = ?')
      .get('part-fault') as { delivered_at: string | null };
    assert.equal(row.delivered_at, null);
    const audit = db.handle
      .prepare('SELECT count(*) AS count FROM audio_delivery_reconciliation_audit')
      .get() as { count: number };
    assert.equal(audit.count, 0, 'audit and delivery clock must be one commit');
  });

  it('applies one conservative final session ACK to every previewed held part', () => {
    seedHeldPart('session-all', 'part-all-0', 0);
    db.handle
      .prepare('UPDATE audio_sessions SET part_count = 2 WHERE session_id = ?')
      .run('session-all');
    seedHeldPart('session-all', 'part-all-1', 1);
    const held = listHeldLegacyDeliveries(db.handle, { sessionId: 'session-all' });
    const result = applyDeliveryReconciliation(db.handle, {
      selector: { sessionId: 'session-all' },
      acknowledgedAt: ACK,
      operatorId: 'operator@example',
      evidence: 'Final session audio ACK from Telegram export',
      expectedPartIds: held.map((row) => row.partId),
      now: NOW,
    });

    assert.deepEqual(result.partIds, ['part-all-0', 'part-all-1']);
    const clocks = db.handle
      .prepare('SELECT delivered_at FROM audio_parts WHERE session_id = ? ORDER BY part_index')
      .all('session-all') as { delivered_at: string | null }[];
    assert.deepEqual(
      clocks.map((row) => row.delivered_at),
      [ACK, ACK],
    );
  });
});
