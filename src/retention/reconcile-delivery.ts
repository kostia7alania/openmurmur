import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { transaction } from '../database/db.ts';

export interface DeliveryReconciliationSelector {
  readonly partId?: string | null | undefined;
  readonly sessionId?: string | null | undefined;
}

export interface HeldLegacyDelivery {
  readonly partId: string;
  readonly sessionId: string;
  readonly partIndex: number;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly sessionEndedAt: string | null;
  readonly finalized: boolean;
  readonly hasChecksum: boolean;
  readonly outboxRows: number;
  readonly sentOutboxRows: number;
}

interface HeldLegacyDeliveryRow {
  readonly part_id: string;
  readonly session_id: string;
  readonly part_index: number;
  readonly started_at: string;
  readonly ended_at: string | null;
  readonly session_ended_at: string | null;
  readonly finalized: number;
  readonly has_checksum: number;
  readonly outbox_rows: number;
  readonly sent_outbox_rows: number;
}

export interface DeliveryReconciliationRequest {
  readonly selector: DeliveryReconciliationSelector;
  readonly acknowledgedAt: string;
  readonly operatorId: string;
  readonly evidence: string;
  /** Exact preview set; apply aborts if concurrent state changed it. */
  readonly expectedPartIds: readonly string[];
  readonly now?: number | undefined;
}

export interface DeliveryReconciliationResult {
  readonly acknowledgedAt: string;
  readonly appliedAt: string;
  readonly partIds: readonly string[];
  readonly reconciliationIds: readonly string[];
}

export class DeliveryReconciliationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeliveryReconciliationError';
  }
}

function normalizedSelector(selector: DeliveryReconciliationSelector): {
  readonly partId: string | null;
  readonly sessionId: string | null;
} {
  const partId = selector.partId?.trim() || null;
  const sessionId = selector.sessionId?.trim() || null;
  if (partId !== null && sessionId !== null) {
    throw new DeliveryReconciliationError('choose exactly one of --part or --session');
  }
  return { partId, sessionId };
}

export function listHeldLegacyDeliveries(
  db: DatabaseSync,
  selector: DeliveryReconciliationSelector = {},
): HeldLegacyDelivery[] {
  const selected = normalizedSelector(selector);
  const rows = db
    .prepare(
      `SELECT p.part_id,
              p.session_id,
              p.part_index,
              p.started_at,
              p.ended_at,
              s.ended_at AS session_ended_at,
              p.finalized,
              CASE WHEN p.sha256 IS NULL THEN 0 ELSE 1 END AS has_checksum,
              (
                SELECT count(*)
                  FROM telegram_outbox o
                 WHERE o.kind = 'audio'
                   AND o.session_id = p.session_id
                   AND (
                     o.delivery_part_id = 'audio:' || p.part_id
                     OR substr(
                            o.delivery_part_id,
                            1,
                            length('audio:' || p.part_id || ':split')
                          ) = 'audio:' || p.part_id || ':split'
                   )
              ) AS outbox_rows,
              (
                SELECT count(*)
                  FROM telegram_outbox o
                 WHERE o.state = 'sent'
                   AND o.kind = 'audio'
                   AND o.session_id = p.session_id
                   AND (
                     o.delivery_part_id = 'audio:' || p.part_id
                     OR substr(
                          o.delivery_part_id,
                          1,
                          length('audio:' || p.part_id || ':split')
                        ) = 'audio:' || p.part_id || ':split'
                   )
              ) AS sent_outbox_rows
         FROM audio_parts p
         JOIN audio_sessions s ON s.session_id = p.session_id
        WHERE p.delivered = 1
          AND p.delivered_at IS NULL
          AND p.deleted_at IS NULL
          AND (? IS NULL OR p.part_id = ?)
          AND (? IS NULL OR p.session_id = ?)
        ORDER BY s.started_at, p.part_index, p.part_id`,
    )
    .all(
      selected.partId,
      selected.partId,
      selected.sessionId,
      selected.sessionId,
    ) as unknown as HeldLegacyDeliveryRow[];
  return rows.map((row) => ({
    partId: row.part_id,
    sessionId: row.session_id,
    partIndex: row.part_index,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    sessionEndedAt: row.session_ended_at,
    finalized: row.finalized === 1,
    hasChecksum: row.has_checksum === 1,
    outboxRows: row.outbox_rows,
    sentOutboxRows: row.sent_outbox_rows,
  }));
}

const EXACT_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export function exactUtcAcknowledgement(value: string): string {
  if (!EXACT_UTC.test(value)) {
    throw new DeliveryReconciliationError(
      'acknowledgement must be exact UTC in YYYY-MM-DDTHH:mm:ss.sssZ format',
    );
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new DeliveryReconciliationError('acknowledgement is not a valid UTC timestamp');
  }
  return value;
}

function requiredMetadata(value: string, name: '--operator' | '--evidence', max: number): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > max) {
    throw new DeliveryReconciliationError(`${name} must contain 1-${max} characters`);
  }
  return normalized;
}

function parsedDurableTime(value: string | null, label: string): number {
  if (value === null) {
    throw new DeliveryReconciliationError(
      `${label} is missing; acknowledgement ordering is unproven`,
    );
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new DeliveryReconciliationError(
      `${label} is invalid; acknowledgement ordering is unproven`,
    );
  }
  return parsed;
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const expected = [...left].sort();
  const actual = [...right].sort();
  return expected.every((id, index) => id === actual[index]);
}

export function applyDeliveryReconciliation(
  db: DatabaseSync,
  request: DeliveryReconciliationRequest,
): DeliveryReconciliationResult {
  const selector = normalizedSelector(request.selector);
  if (selector.partId === null && selector.sessionId === null) {
    throw new DeliveryReconciliationError(
      'apply requires exactly one --part or --session selector',
    );
  }
  const acknowledgedAt = exactUtcAcknowledgement(request.acknowledgedAt);
  const acknowledgedMs = Date.parse(acknowledgedAt);
  const appliedMs = request.now ?? Date.now();
  if (!Number.isFinite(appliedMs)) {
    throw new DeliveryReconciliationError('apply time is invalid');
  }
  const appliedAt = new Date(appliedMs).toISOString();
  if (acknowledgedMs > appliedMs) {
    throw new DeliveryReconciliationError('acknowledgement cannot be in the future');
  }
  const operatorId = requiredMetadata(request.operatorId, '--operator', 200);
  const evidence = requiredMetadata(request.evidence, '--evidence', 2_000);
  if (request.expectedPartIds.length === 0) {
    throw new DeliveryReconciliationError('no held legacy delivery matches the selector');
  }

  return transaction(db, () => {
    const held = listHeldLegacyDeliveries(db, selector);
    const currentIds = held.map((row) => row.partId);
    if (!sameIds(currentIds, request.expectedPartIds)) {
      throw new DeliveryReconciliationError(
        'held delivery selection changed after preview; rerun the report before applying',
      );
    }

    for (const row of held) {
      const partEndedMs = parsedDurableTime(row.endedAt, `part ${row.partId} ended_at`);
      const sessionEndedMs = parsedDurableTime(
        row.sessionEndedAt,
        `session ${row.sessionId} ended_at`,
      );
      if (acknowledgedMs < partEndedMs || acknowledgedMs < sessionEndedMs) {
        throw new DeliveryReconciliationError(
          `acknowledgement predates the recording boundary for part ${row.partId}`,
        );
      }
    }

    const reconciliationIds: string[] = [];
    for (const row of held) {
      const reconciliationId = randomUUID();
      db.prepare(
        `INSERT INTO audio_delivery_reconciliation_audit
           (reconciliation_id, part_id, session_id, scope_kind, scope_id,
            acknowledged_at, operator_id, evidence, previous_delivered,
            previous_delivered_at, applied_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, NULL, ?)`,
      ).run(
        reconciliationId,
        row.partId,
        row.sessionId,
        selector.partId === null ? 'session' : 'part',
        selector.partId ?? selector.sessionId,
        acknowledgedAt,
        operatorId,
        evidence,
        appliedAt,
      );
      const update = db
        .prepare(
          `UPDATE audio_parts
              SET delivered_at = ?
            WHERE part_id = ?
              AND delivered = 1
              AND delivered_at IS NULL
              AND deleted_at IS NULL`,
        )
        .run(acknowledgedAt, row.partId);
      if (update.changes !== 1) {
        throw new DeliveryReconciliationError(
          `part ${row.partId} changed while reconciliation was applying`,
        );
      }
      reconciliationIds.push(reconciliationId);
    }

    return {
      acknowledgedAt,
      appliedAt,
      partIds: currentIds,
      reconciliationIds,
    };
  });
}

function terminalText(value: string): string {
  let safe = '';
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    const bidiControl =
      code === 0x061c ||
      code === 0x200e ||
      code === 0x200f ||
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2066 && code <= 0x2069);
    if (bidiControl) continue;
    safe += code <= 31 || (code >= 127 && code <= 159) ? ' ' : character;
  }
  return safe.replace(/\s+/gu, ' ').trim();
}

export function renderHeldLegacyDeliveries(rows: readonly HeldLegacyDelivery[]): string {
  if (rows.length === 0) return 'No held legacy delivered audio is missing an exact ACK time.';
  const lines = [
    `${rows.length} delivered audio part(s) remain held because exact ACK time is unproven:`,
    '',
  ];
  for (const row of rows) {
    lines.push(
      `  part ${terminalText(row.partId)} · session ${terminalText(row.sessionId)} · index ${row.partIndex}`,
    );
    lines.push(
      `    ended ${terminalText(row.endedAt ?? 'missing')} · outbox ${row.sentOutboxRows}/${row.outboxRows} sent`,
    );
    lines.push(
      `    finalized ${row.finalized ? 'yes' : 'no'} · checksum ${row.hasChecksum ? 'yes' : 'no'}`,
    );
  }
  lines.push('', 'No ACK timestamp was inferred. Apply requires explicit UTC evidence.');
  return lines.join('\n');
}
