import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { transaction } from '../database/db.ts';
import { markAudioDelivered, reconcileSessionDelivery } from '../jobs/pipeline.ts';
import { nullLogger } from '../logging/logger.ts';
import type { OutboxKind } from './outbox.ts';

const DEFAULT_REPORT_LIMIT = 200;
const EXACT_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

type ReconciledFromState = 'pending' | 'sending' | 'failed' | 'dead';

interface OutboxDeliveryRow {
  readonly outbox_id: string;
  readonly delivery_part_id: string;
  readonly session_id: string | null;
  readonly kind: OutboxKind;
  readonly payload: string;
  readonly state: string;
  readonly attempts: number;
  readonly max_attempts: number;
  readonly telegram_message_id: number | null;
  readonly created_at: string;
  readonly updated_at: string;
}

interface ReconciliationAuditRow {
  readonly reconciliation_id: string;
  readonly outbox_id: string;
  readonly delivery_part_id: string;
  readonly kind: OutboxKind;
  readonly session_id: string | null;
  readonly payload_sha256: string;
  readonly previous_state: ReconciledFromState;
  readonly previous_attempts: number;
  readonly previous_updated_at: string;
  readonly telegram_message_id: number;
  readonly acknowledged_at: string;
  readonly operator_id: string;
  readonly evidence: string;
  readonly applied_at: string;
}

interface AudioManifestRow {
  readonly delivery_part_id: string;
  readonly session_id: string | null;
  readonly kind: OutboxKind;
  readonly state: string;
  readonly updated_at: string;
}

export interface UnacknowledgedTelegramDelivery {
  readonly outboxId: string;
  readonly deliveryPartId: string;
  readonly sessionId: string | null;
  readonly kind: OutboxKind;
  readonly state: string;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly telegramMessageId: number | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly payloadSha256: string;
  readonly payloadBytes: number;
  readonly payloadType: 'text' | 'document' | 'invalid';
  readonly payloadPreview: string;
  readonly documentFilename: string | null;
  readonly remoteStatus: 'unknown';
  readonly blockedReason: string | null;
}

export interface TelegramDeliveryReconciliationReport {
  readonly deliveries: readonly UnacknowledgedTelegramDelivery[];
  readonly truncated: boolean;
}

export interface TelegramDeliveryReconciliationRequest {
  readonly deliveryPartId: string;
  readonly telegramMessageId: number;
  readonly acknowledgedAt: string;
  readonly operatorId: string;
  readonly evidence: string;
  /** Exact report snapshot; the first apply aborts if any local fact changed. */
  readonly expected?: UnacknowledgedTelegramDelivery | undefined;
  readonly now?: number | undefined;
}

export interface TelegramDeliveryReconciliationResult {
  readonly reconciliationId: string;
  readonly deliveryPartId: string;
  readonly telegramMessageId: number;
  readonly acknowledgedAt: string;
  readonly appliedAt: string;
  readonly payloadSha256: string;
  readonly alreadyApplied: boolean;
}

export class TelegramDeliveryReconciliationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TelegramDeliveryReconciliationError';
  }
}

function payloadSha256(payload: string): string {
  return createHash('sha256').update(payload).digest('hex');
}

function exactUtcAcknowledgement(value: string): string {
  if (!EXACT_UTC.test(value)) {
    throw new TelegramDeliveryReconciliationError(
      'acknowledgement must be exact UTC in YYYY-MM-DDTHH:mm:ss.sssZ format',
    );
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new TelegramDeliveryReconciliationError('acknowledgement is not a valid UTC timestamp');
  }
  return value;
}

function exactTelegramMessageId(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TelegramDeliveryReconciliationError(
      'Telegram message id must be a positive safe integer',
    );
  }
  return value;
}

function requiredMetadata(value: string, name: '--operator' | '--evidence', max: number): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > max) {
    throw new TelegramDeliveryReconciliationError(`${name} must contain 1-${max} characters`);
  }
  return normalized;
}

interface PayloadEvidence {
  readonly type: UnacknowledgedTelegramDelivery['payloadType'];
  readonly preview: string;
  readonly documentFilename: string | null;
  readonly error: string | null;
}

function boundedPreview(value: string): string {
  return [...terminalText(value)].slice(0, 160).join('');
}

function inspectPayload(payload: string): PayloadEvidence {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return {
      type: 'invalid',
      preview: '',
      documentFilename: null,
      error: 'outbox payload is not valid JSON',
    };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return {
      type: 'invalid',
      preview: '',
      documentFilename: null,
      error: 'outbox payload is not an object',
    };
  }
  const record = parsed as Record<string, unknown>;
  if (record['type'] === 'text' && typeof record['text'] === 'string') {
    return {
      type: 'text',
      preview: boundedPreview(record['text']),
      documentFilename: null,
      error: null,
    };
  }
  if (
    record['type'] === 'document' &&
    typeof record['path'] === 'string' &&
    typeof record['filename'] === 'string'
  ) {
    return {
      type: 'document',
      preview: typeof record['caption'] === 'string' ? boundedPreview(record['caption']) : '',
      documentFilename: boundedPreview(record['filename']),
      error: null,
    };
  }
  return {
    type: 'invalid',
    preview: '',
    documentFilename: null,
    error: 'outbox payload is not a canonical text or document request',
  };
}

function blockedReason(row: OutboxDeliveryRow, payloadError: string | null): string | null {
  if (row.state === 'sent') return 'the row is already locally acknowledged';
  if (!['pending', 'sending', 'failed', 'dead'].includes(row.state)) {
    return `unsupported local outbox state ${row.state}`;
  }
  if (!Number.isSafeInteger(row.attempts) || row.attempts <= 0) {
    return 'no local send attempt was recorded';
  }
  if (row.telegram_message_id !== null) {
    return 'an unsent row already contains a Telegram message id';
  }
  if (payloadError !== null) return payloadError;
  return null;
}

function deliveryFromRow(row: OutboxDeliveryRow): UnacknowledgedTelegramDelivery {
  const payload = inspectPayload(row.payload);
  return {
    outboxId: row.outbox_id,
    deliveryPartId: row.delivery_part_id,
    sessionId: row.session_id,
    kind: row.kind,
    state: row.state,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    telegramMessageId: row.telegram_message_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    payloadSha256: payloadSha256(row.payload),
    payloadBytes: Buffer.byteLength(row.payload),
    payloadType: payload.type,
    payloadPreview: payload.preview,
    documentFilename: payload.documentFilename,
    remoteStatus: 'unknown',
    blockedReason: blockedReason(row, payload.error),
  };
}

function outboxRows(
  db: DatabaseSync,
  deliveryPartId: string | undefined,
  limit: number,
): OutboxDeliveryRow[] {
  return db
    .prepare(
      `SELECT outbox_id, delivery_part_id, session_id, kind, payload, state,
              attempts, max_attempts, telegram_message_id, created_at, updated_at
         FROM telegram_outbox
        WHERE state <> 'sent'
          AND (? IS NULL OR delivery_part_id = ?)
        ORDER BY created_at, rowid, ordinal
        LIMIT ?`,
    )
    .all(deliveryPartId ?? null, deliveryPartId ?? null, limit) as unknown as OutboxDeliveryRow[];
}

/**
 * Lists local rows for which Telegram's remote result is unknown. This never
 * treats age, attempts or state as a remote acknowledgement.
 */
export function listUnacknowledgedTelegramDeliveries(
  db: DatabaseSync,
  options: {
    readonly deliveryPartId?: string | undefined;
    readonly limit?: number | undefined;
  } = {},
): TelegramDeliveryReconciliationReport {
  const deliveryPartId = options.deliveryPartId?.trim() || undefined;
  const limit = options.limit ?? DEFAULT_REPORT_LIMIT;
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new TelegramDeliveryReconciliationError('report limit must be a positive integer');
  }
  const rows = outboxRows(db, deliveryPartId, limit + 1);
  return {
    deliveries: rows.slice(0, limit).map(deliveryFromRow),
    truncated: rows.length > limit,
  };
}

function currentOutboxRow(db: DatabaseSync, deliveryPartId: string): OutboxDeliveryRow | undefined {
  return db
    .prepare(
      `SELECT outbox_id, delivery_part_id, session_id, kind, payload, state,
              attempts, max_attempts, telegram_message_id, created_at, updated_at
         FROM telegram_outbox
        WHERE delivery_part_id = ?`,
    )
    .get(deliveryPartId) as OutboxDeliveryRow | undefined;
}

function auditRow(db: DatabaseSync, deliveryPartId: string): ReconciliationAuditRow | undefined {
  return db
    .prepare(
      `SELECT reconciliation_id, outbox_id, delivery_part_id, kind, session_id,
              payload_sha256, previous_state, previous_attempts, previous_updated_at,
              telegram_message_id, acknowledged_at, operator_id, evidence, applied_at
         FROM telegram_delivery_reconciliation_audit
        WHERE delivery_part_id = ?`,
    )
    .get(deliveryPartId) as ReconciliationAuditRow | undefined;
}

function sameSnapshot(
  expected: UnacknowledgedTelegramDelivery,
  current: UnacknowledgedTelegramDelivery,
): boolean {
  return (
    expected.outboxId === current.outboxId &&
    expected.deliveryPartId === current.deliveryPartId &&
    expected.sessionId === current.sessionId &&
    expected.kind === current.kind &&
    expected.state === current.state &&
    expected.attempts === current.attempts &&
    expected.maxAttempts === current.maxAttempts &&
    expected.telegramMessageId === current.telegramMessageId &&
    expected.createdAt === current.createdAt &&
    expected.updatedAt === current.updatedAt &&
    expected.payloadSha256 === current.payloadSha256 &&
    expected.payloadBytes === current.payloadBytes &&
    expected.payloadType === current.payloadType &&
    expected.payloadPreview === current.payloadPreview &&
    expected.documentFilename === current.documentFilename
  );
}

function parsePayload(payload: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    throw new TelegramDeliveryReconciliationError('outbox payload is not valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new TelegramDeliveryReconciliationError('outbox payload is not an object');
  }
  return parsed as Record<string, unknown>;
}

function exactAudioManifestAck(rows: readonly AudioManifestRow[]): string {
  const acknowledgements = rows.map((manifestRow) => manifestRow.updated_at);
  for (const acknowledgement of acknowledgements) {
    const parsed = Date.parse(acknowledgement);
    if (
      !EXACT_UTC.test(acknowledgement) ||
      !Number.isFinite(parsed) ||
      new Date(parsed).toISOString() !== acknowledgement
    ) {
      throw new TelegramDeliveryReconciliationError(
        'audio delivery manifest contains an invalid acknowledgement clock',
      );
    }
  }
  const finalAcknowledgement = acknowledgements.sort().at(-1);
  if (finalAcknowledgement === undefined) {
    throw new TelegramDeliveryReconciliationError('audio delivery manifest is empty');
  }
  return finalAcknowledgement;
}

function proveAudioManifest(
  db: DatabaseSync,
  partId: string,
  sessionId: string,
): { readonly complete: boolean; readonly finalAcknowledgement: string | null } {
  const directId = `audio:${partId}`;
  const splitPrefix = `${directId}:split`;
  const rows = db
    .prepare(
      `SELECT delivery_part_id, session_id, kind, state, updated_at
         FROM telegram_outbox
        WHERE delivery_part_id = ?
           OR substr(delivery_part_id, 1, ?) = ?`,
    )
    .all(directId, splitPrefix.length, splitPrefix) as unknown as AudioManifestRow[];
  if (
    rows.length === 0 ||
    rows.some((manifestRow) => manifestRow.kind !== 'audio' || manifestRow.session_id !== sessionId)
  ) {
    throw new TelegramDeliveryReconciliationError(
      'audio delivery manifest does not match its durable session part',
    );
  }

  const directRows = rows.filter((manifestRow) => manifestRow.delivery_part_id === directId);
  if (directRows.length > 0) {
    if (directRows.length !== 1 || rows.length !== 1) {
      throw new TelegramDeliveryReconciliationError(
        'audio delivery manifest mixes direct and split rows',
      );
    }
    return { complete: true, finalAcknowledgement: exactAudioManifestAck(rows) };
  }

  const suffixes = new Set(
    rows.map((manifestRow) => manifestRow.delivery_part_id.slice(splitPrefix.length)),
  );
  if (suffixes.size !== rows.length || rows.some((_, index) => !suffixes.has(String(index)))) {
    throw new TelegramDeliveryReconciliationError(
      'audio split manifest must be contiguous from split0 through its final row',
    );
  }
  const sentRows = rows.filter((manifestRow) => manifestRow.state === 'sent');
  const finalAcknowledgement = exactAudioManifestAck(sentRows);
  if (sentRows.length !== rows.length) {
    return { complete: false, finalAcknowledgement: null };
  }
  return { complete: true, finalAcknowledgement };
}

function reconcileAudioDomain(db: DatabaseSync, row: OutboxDeliveryRow): boolean {
  const payload = parsePayload(row.payload);
  const partId = payload['partId'];
  if (payload['type'] !== 'document' || typeof partId !== 'string' || partId.length === 0) {
    throw new TelegramDeliveryReconciliationError(
      'audio delivery payload does not identify one source part',
    );
  }
  const directId = `audio:${partId}`;
  const splitSuffix = row.delivery_part_id.startsWith(`${directId}:split`)
    ? row.delivery_part_id.slice(`${directId}:split`.length)
    : null;
  const canonicalSplit =
    splitSuffix !== null &&
    /^\d+$/.test(splitSuffix) &&
    String(Number.parseInt(splitSuffix, 10)) === splitSuffix;
  if (row.delivery_part_id !== directId && !canonicalSplit) {
    throw new TelegramDeliveryReconciliationError(
      'audio delivery id does not match its payload source part',
    );
  }
  const part = db.prepare('SELECT session_id FROM audio_parts WHERE part_id = ?').get(partId) as
    | { session_id: string }
    | undefined;
  if (part === undefined || row.session_id === null || part.session_id !== row.session_id) {
    throw new TelegramDeliveryReconciliationError(
      'audio delivery does not match one durable session part',
    );
  }
  const manifest = proveAudioManifest(db, partId, row.session_id);
  if (!manifest.complete || manifest.finalAcknowledgement === null) return false;
  markAudioDelivered(db, partId);
  const delivered = db
    .prepare('SELECT delivered, delivered_at FROM audio_parts WHERE part_id = ?')
    .get(partId) as { delivered: number; delivered_at: string | null } | undefined;
  if (delivered?.delivered !== 1 || delivered.delivered_at !== manifest.finalAcknowledgement) {
    throw new TelegramDeliveryReconciliationError(
      'audio part did not acquire the exact final manifest acknowledgement',
    );
  }
  return true;
}

function incomingOwner(db: DatabaseSync, deliveryPartId: string): string {
  const rows = db
    .prepare(
      `SELECT file_uid,
              substr(?, length('incoming:' || file_uid || ':') + 1) AS suffix
         FROM incoming_telegram_files
        WHERE substr(?, 1, length('incoming:' || file_uid || ':')) =
              'incoming:' || file_uid || ':'`,
    )
    .all(deliveryPartId, deliveryPartId) as unknown as {
    file_uid: string;
    suffix: string;
  }[];
  const canonical = rows.filter(
    (row) =>
      /^[1-9]\d*$/.test(row.suffix) && String(Number.parseInt(row.suffix, 10)) === row.suffix,
  );
  if (canonical.length !== 1) {
    throw new TelegramDeliveryReconciliationError(
      'incoming transcript delivery does not identify one canonical durable manifest',
    );
  }
  const fileUid = canonical[0]?.file_uid;
  if (fileUid === undefined) {
    throw new TelegramDeliveryReconciliationError('incoming transcript owner is missing');
  }
  const hasRevision = db
    .prepare(
      `SELECT 1 AS present
         FROM transcript_revisions
        WHERE incoming_file_id = ? AND is_current = 1
        LIMIT 1`,
    )
    .get(fileUid);
  if (hasRevision === undefined) {
    throw new TelegramDeliveryReconciliationError(
      'incoming transcript manifest has no immutable current revision',
    );
  }
  return fileUid;
}

function reconcileIncomingDomain(
  db: DatabaseSync,
  row: OutboxDeliveryRow,
  appliedAt: string,
): void {
  const payload = parsePayload(row.payload);
  if (payload['type'] !== 'text' || typeof payload['text'] !== 'string') {
    throw new TelegramDeliveryReconciliationError(
      'incoming transcript delivery payload is not canonical text',
    );
  }
  const fileUid = incomingOwner(db, row.delivery_part_id);
  const proof = db
    .prepare('SELECT delivered_at FROM incoming_delivery_manifest_proof WHERE file_uid = ?')
    .get(fileUid) as { delivered_at: string } | undefined;
  if (proof === undefined) return;

  const incoming = db
    .prepare('SELECT state FROM incoming_telegram_files WHERE file_uid = ?')
    .get(fileUid) as { state: string } | undefined;
  if (incoming?.state === 'transcribed') {
    db.prepare(
      `UPDATE incoming_telegram_files
          SET state = 'delivered', updated_at = ?
        WHERE file_uid = ? AND state = 'transcribed'`,
    ).run(appliedAt, fileUid);
  } else if (incoming?.state !== 'delivered') {
    throw new TelegramDeliveryReconciliationError(
      `incoming transcript owner ${fileUid} is not ready for delivery reconciliation`,
    );
  }
  const delivered = db
    .prepare('SELECT delivered_at FROM incoming_telegram_files WHERE file_uid = ?')
    .get(fileUid) as { delivered_at: string | null } | undefined;
  if (delivered?.delivered_at === null || delivered === undefined) {
    throw new TelegramDeliveryReconciliationError(
      'incoming transcript retention clock was not proven by its complete manifest',
    );
  }
}

function validateReportDeliveryIdentity(
  db: DatabaseSync,
  row: OutboxDeliveryRow,
  sessionId: string,
): void {
  if (
    row.delivery_part_id === `report:${sessionId}` ||
    row.delivery_part_id === `report-summary:${sessionId}`
  ) {
    return;
  }
  const primaryPrefix = `report:${sessionId}:`;
  const previewPrefix = `report-summary:${sessionId}:`;
  const prefix = row.delivery_part_id.startsWith(primaryPrefix)
    ? primaryPrefix
    : row.delivery_part_id.startsWith(previewPrefix)
      ? previewPrefix
      : null;
  const revisionId = prefix === null ? null : row.delivery_part_id.slice(prefix.length);
  if (revisionId === null || revisionId.length === 0 || revisionId.includes(':')) {
    throw new TelegramDeliveryReconciliationError(
      'report delivery id does not match its durable session owner',
    );
  }

  if (revisionId === 'no-transcript') {
    const current = db
      .prepare(
        `SELECT 1 AS present
           FROM transcript_revisions
          WHERE session_id = ? AND is_current = 1
          LIMIT 1`,
      )
      .get(sessionId);
    if (current === undefined) return;
    throw new TelegramDeliveryReconciliationError(
      'no-transcript report conflicts with the durable current transcript',
    );
  }

  const source = db
    .prepare(
      `SELECT r.is_current
         FROM transcript_revisions r
         JOIN summaries s
           ON s.revision_id = r.revision_id
          AND s.session_id = r.session_id
        WHERE r.revision_id = ?
          AND r.session_id = ?`,
    )
    .get(revisionId, sessionId);
  if (source === undefined) {
    throw new TelegramDeliveryReconciliationError(
      'revision-scoped report has no matching durable session summary',
    );
  }
}

function validateSessionDeliveryIdentity(db: DatabaseSync, row: OutboxDeliveryRow): void {
  const sessionId = row.session_id;
  if (sessionId === null) return;
  const validTranscriptId =
    row.delivery_part_id === `transcript:${sessionId}:1` ||
    row.delivery_part_id === `transcript-md:${sessionId}`;
  if (row.kind === 'transcript' && !validTranscriptId) {
    throw new TelegramDeliveryReconciliationError(
      'transcript delivery id does not match its durable session owner',
    );
  }
  if (row.kind === 'report') validateReportDeliveryIdentity(db, row, sessionId);
}

function reconcileDomain(db: DatabaseSync, row: OutboxDeliveryRow, appliedAt: string): void {
  const audioComplete = row.kind === 'audio' ? reconcileAudioDomain(db, row) : true;
  if (row.kind === 'incoming_transcript') reconcileIncomingDomain(db, row, appliedAt);

  if (
    (row.kind === 'audio' || row.kind === 'transcript' || row.kind === 'report') &&
    row.session_id === null
  ) {
    throw new TelegramDeliveryReconciliationError(
      `${row.kind} delivery has no durable session owner`,
    );
  }
  validateSessionDeliveryIdentity(db, row);
  if (row.session_id !== null && audioComplete) {
    reconcileSessionDelivery(db, row.session_id, nullLogger);
  }
}

function resultFromAudit(
  audit: ReconciliationAuditRow,
  alreadyApplied: boolean,
): TelegramDeliveryReconciliationResult {
  return {
    reconciliationId: audit.reconciliation_id,
    deliveryPartId: audit.delivery_part_id,
    telegramMessageId: audit.telegram_message_id,
    acknowledgedAt: audit.acknowledged_at,
    appliedAt: audit.applied_at,
    payloadSha256: audit.payload_sha256,
    alreadyApplied,
  };
}

function verifyIdempotentReplay(
  db: DatabaseSync,
  audit: ReconciliationAuditRow,
  request: {
    readonly telegramMessageId: number;
    readonly acknowledgedAt: string;
    readonly operatorId: string;
    readonly evidence: string;
  },
): TelegramDeliveryReconciliationResult {
  const row = currentOutboxRow(db, audit.delivery_part_id);
  if (
    row === undefined ||
    row.outbox_id !== audit.outbox_id ||
    row.delivery_part_id !== audit.delivery_part_id ||
    row.kind !== audit.kind ||
    row.session_id !== audit.session_id ||
    row.state !== 'sent' ||
    row.attempts !== audit.previous_attempts ||
    row.telegram_message_id !== audit.telegram_message_id ||
    row.updated_at !== audit.acknowledged_at ||
    payloadSha256(row.payload) !== audit.payload_sha256
  ) {
    throw new TelegramDeliveryReconciliationError(
      'reconciled outbox facts changed after the immutable audit was recorded',
    );
  }
  if (
    request.telegramMessageId !== audit.telegram_message_id ||
    request.acknowledgedAt !== audit.acknowledged_at ||
    request.operatorId !== audit.operator_id ||
    request.evidence !== audit.evidence
  ) {
    throw new TelegramDeliveryReconciliationError(
      'this delivery was already reconciled with different operator evidence',
    );
  }
  return resultFromAudit(audit, true);
}

/**
 * Applies one operator-proven remote acknowledgement. Nothing here infers a
 * Telegram result: attempts and timestamps are only local safety bounds.
 */
export function applyTelegramDeliveryReconciliation(
  db: DatabaseSync,
  request: TelegramDeliveryReconciliationRequest,
): TelegramDeliveryReconciliationResult {
  const deliveryPartId = request.deliveryPartId.trim();
  if (deliveryPartId.length === 0 || deliveryPartId.length > 500) {
    throw new TelegramDeliveryReconciliationError('--delivery-part must contain 1-500 characters');
  }
  const telegramMessageId = exactTelegramMessageId(request.telegramMessageId);
  const acknowledgedAt = exactUtcAcknowledgement(request.acknowledgedAt);
  const acknowledgedMs = Date.parse(acknowledgedAt);
  const appliedMs = request.now ?? Date.now();
  if (!Number.isFinite(appliedMs)) {
    throw new TelegramDeliveryReconciliationError('apply time is invalid');
  }
  const appliedAt = new Date(appliedMs).toISOString();
  if (acknowledgedMs > appliedMs) {
    throw new TelegramDeliveryReconciliationError('acknowledgement cannot be in the future');
  }
  const operatorId = requiredMetadata(request.operatorId, '--operator', 200);
  const evidence = requiredMetadata(request.evidence, '--evidence', 2_000);

  return transaction(db, () => {
    const existingAudit = auditRow(db, deliveryPartId);
    if (existingAudit !== undefined) {
      return verifyIdempotentReplay(db, existingAudit, {
        telegramMessageId,
        acknowledgedAt,
        operatorId,
        evidence,
      });
    }

    const row = currentOutboxRow(db, deliveryPartId);
    if (row === undefined) {
      throw new TelegramDeliveryReconciliationError(
        `no outbox delivery exists with id ${deliveryPartId}`,
      );
    }
    const current = deliveryFromRow(row);
    if (request.expected === undefined || !sameSnapshot(request.expected, current)) {
      throw new TelegramDeliveryReconciliationError(
        'outbox delivery changed after preview; rerun the report before applying',
      );
    }
    if (current.blockedReason !== null) {
      throw new TelegramDeliveryReconciliationError(current.blockedReason);
    }
    const createdMs = Date.parse(row.created_at);
    if (!Number.isFinite(createdMs)) {
      throw new TelegramDeliveryReconciliationError(
        'outbox creation time is invalid; acknowledgement ordering is unproven',
      );
    }
    if (acknowledgedMs < createdMs) {
      throw new TelegramDeliveryReconciliationError(
        'acknowledgement predates the durable outbox request',
      );
    }

    const update = db
      .prepare(
        `UPDATE telegram_outbox
            SET state = 'sent', telegram_message_id = ?, updated_at = ?
          WHERE outbox_id = ?
            AND state = ?
            AND attempts = ?
            AND telegram_message_id IS NULL
            AND updated_at = ?
            AND payload = ?`,
      )
      .run(
        telegramMessageId,
        acknowledgedAt,
        row.outbox_id,
        row.state,
        row.attempts,
        row.updated_at,
        row.payload,
      );
    if (update.changes !== 1) {
      throw new TelegramDeliveryReconciliationError(
        'outbox delivery changed while reconciliation was applying',
      );
    }

    reconcileDomain(db, row, appliedAt);

    const reconciliationId = randomUUID();
    db.prepare(
      `INSERT INTO telegram_delivery_reconciliation_audit
         (reconciliation_id, outbox_id, delivery_part_id, kind, session_id,
          payload_sha256, previous_state, previous_attempts, previous_updated_at,
          telegram_message_id, acknowledged_at, operator_id, evidence, applied_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      reconciliationId,
      row.outbox_id,
      row.delivery_part_id,
      row.kind,
      row.session_id,
      current.payloadSha256,
      row.state,
      row.attempts,
      row.updated_at,
      telegramMessageId,
      acknowledgedAt,
      operatorId,
      evidence,
      appliedAt,
    );

    return {
      reconciliationId,
      deliveryPartId,
      telegramMessageId,
      acknowledgedAt,
      appliedAt,
      payloadSha256: current.payloadSha256,
      alreadyApplied: false,
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

export function renderUnacknowledgedTelegramDeliveries(
  report: TelegramDeliveryReconciliationReport,
): string {
  if (report.deliveries.length === 0) {
    return 'No locally unacknowledged Telegram delivery matches the selected scope.';
  }
  const lines = [
    `${report.deliveries.length} local delivery row(s) have unknown remote status:`,
    '',
  ];
  for (const row of report.deliveries) {
    const visiblePayload =
      row.payloadType === 'document'
        ? `document ${terminalText(row.documentFilename ?? 'missing filename')}${row.payloadPreview.length === 0 ? '' : ` · caption ${terminalText(row.payloadPreview)}`}`
        : `${row.payloadType}${row.payloadPreview.length === 0 ? '' : ` · ${terminalText(row.payloadPreview)}`}`;
    lines.push(
      `  ${terminalText(row.deliveryPartId)} · ${row.kind} · local ${row.state} · attempts ${row.attempts}/${row.maxAttempts}`,
      `    visible payload ${visiblePayload}`,
      `    payload sha256 ${row.payloadSha256} · ${row.payloadBytes} bytes`,
      `    remote status unknown${row.blockedReason === null ? '' : ` · blocked: ${terminalText(row.blockedReason)}`}`,
    );
  }
  if (report.truncated) lines.push('', 'Report truncated; select one exact --delivery-part.');
  lines.push(
    '',
    'No Telegram ACK was inferred. Compare the exact payload with independent Telegram evidence.',
  );
  return lines.join('\n');
}
