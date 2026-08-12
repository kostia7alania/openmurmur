import { createHash } from 'node:crypto';
import { lstatSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { Paths } from '../config/paths.ts';
import { transaction } from '../database/db.ts';
import { redact } from '../logging/redact.ts';
import type { OutboxKind } from './outbox.ts';

const REPORT_LIMIT = 200;
const TEXT_LIMIT = 240;

interface StoredOutboxRow {
  readonly outbox_id: string;
  readonly delivery_part_id: string;
  readonly session_id: string | null;
  readonly kind: OutboxKind;
  readonly ordinal: number;
  readonly payload: string;
  readonly state: string;
  readonly attempts: number;
  readonly max_attempts: number;
  readonly claim_generation: number;
  readonly telegram_message_id: number | null;
  readonly last_error: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

interface StoredPart {
  readonly session_id: string;
  readonly path: string;
  readonly finalized: number;
  readonly deleted_at: string | null;
}

interface AudioIdentity {
  readonly outboxId: string;
  readonly mode: 'direct' | 'split';
  readonly ordinal: number;
  readonly path: string;
  readonly filename: string;
}

interface AudioManifestProof {
  readonly certain: boolean;
  readonly reason: string | null;
  readonly identities: readonly AudioIdentity[];
}

export interface TemporaryAudioOwnershipProof {
  readonly certain: boolean;
  readonly paths: ReadonlySet<string>;
  readonly ambiguousOutboxIds: readonly string[];
}

export interface DeadOutboxDelivery {
  readonly deliveryPartId: string;
  readonly kind: OutboxKind;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly claimGeneration: number;
  readonly lastError: string;
  readonly snapshotSha256: string;
  readonly payloadSha256: string;
  readonly payloadBytes: number;
  readonly payloadType: 'text' | 'document' | 'invalid';
  readonly documentFilename: string | null;
  readonly artifactStatus: 'not_applicable' | 'available' | 'missing' | 'unsafe';
  readonly artifactBytes: number | null;
  readonly retryable: boolean;
  readonly blockedReason: string | null;
}

export interface DeadOutboxReport {
  readonly deliveries: readonly DeadOutboxDelivery[];
  readonly truncated: boolean;
}

export interface RetryDeadOutboxResult {
  readonly deliveryPartId: string;
  readonly payloadSha256: string;
  readonly claimGeneration: number;
}

export class DeadOutboxRecoveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeadOutboxRecoveryError';
  }
}

interface PayloadInspection {
  readonly type: DeadOutboxDelivery['payloadType'];
  readonly filename: string | null;
  readonly artifactStatus: DeadOutboxDelivery['artifactStatus'];
  readonly artifactBytes: number | null;
  readonly error: string | null;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function terminalText(value: string): string {
  let safe = '';
  for (const character of redact(value)) {
    const code = character.codePointAt(0) ?? 0;
    const bidi =
      code === 0x061c ||
      code === 0x200e ||
      code === 0x200f ||
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2066 && code <= 0x2069);
    if (!bidi) safe += code <= 31 || (code >= 127 && code <= 159) ? ' ' : character;
  }
  return safe.replace(/\s+/gu, ' ').trim();
}

function bounded(value: string, limit = TEXT_LIMIT): string {
  const characters = [...terminalText(value)];
  return characters.length <= limit
    ? characters.join('')
    : `${characters.slice(0, limit - 1).join('')}…`;
}

function safeError(value: string): string {
  const category = /\b(?:400|401|403|404|413)\b|bad request|too (?:large|big)/iu.test(value)
    ? 'Telegram rejected the delivery'
    : /\b429\b|rate.?limit/iu.test(value)
      ? 'Telegram rate-limited the delivery'
      : /timeout|timed out|abort/iu.test(value)
        ? 'Telegram delivery timed out'
        : 'Telegram delivery failed';
  return `${category}; private details sha256 ${sha256(value)}`;
}

function snapshotSha256(row: StoredOutboxRow): string {
  return sha256(
    JSON.stringify([
      row.outbox_id,
      row.delivery_part_id,
      row.session_id,
      row.kind,
      row.ordinal,
      row.payload,
      row.state,
      row.attempts,
      row.max_attempts,
      row.claim_generation,
      row.telegram_message_id,
      row.last_error,
      row.created_at,
      row.updated_at,
    ]),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnly(record: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(record).every((key) => allowed.has(key));
}

function within(root: string, path: string): boolean {
  const child = relative(root, path);
  return child.length > 0 && child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

function canonicalManagedPath(path: string, root: string, directChild: boolean): boolean {
  const canonicalRoot = resolve(root);
  return (
    isAbsolute(path) &&
    path === resolve(path) &&
    within(canonicalRoot, path) &&
    (!directChild || dirname(path) === canonicalRoot)
  );
}

function inspectFile(path: string, root: string, directChild: boolean): PayloadInspection {
  const canonicalRoot = resolve(root);
  if (!canonicalManagedPath(path, root, directChild)) {
    return blockedDocument('document path is outside its canonical OpenMurmur directory');
  }
  try {
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink()) {
      return blockedDocument('document artifact is not a regular non-symlink file');
    }
    if (!within(realpathSync(canonicalRoot), realpathSync(path))) {
      return blockedDocument('document artifact resolves outside its OpenMurmur directory');
    }
    return {
      type: 'document',
      filename: null,
      artifactStatus: 'available',
      artifactBytes: info.size,
      error: null,
    };
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? blockedDocument('document artifact is missing; exact retry is unavailable', 'missing')
      : blockedDocument('document artifact could not be inspected safely');
  }
}

function blockedDocument(
  error: string,
  artifactStatus: PayloadInspection['artifactStatus'] = 'unsafe',
): PayloadInspection {
  return {
    type: 'document',
    filename: null,
    artifactStatus,
    artifactBytes: null,
    error,
  };
}

function partFor(db: DatabaseSync, partId: string): StoredPart | undefined {
  return db
    .prepare('SELECT session_id, path, finalized, deleted_at FROM audio_parts WHERE part_id = ?')
    .get(partId) as StoredPart | undefined;
}

function parseRecord(payload: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(payload);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function canonicalDocumentPayload(payload: Record<string, unknown>): boolean {
  const filename = payload['filename'];
  return (
    payload['type'] === 'document' &&
    hasOnly(
      payload,
      new Set([
        'type',
        'path',
        'filename',
        'caption',
        'partId',
        'replyMarkup',
        'deleteAfterSend',
        'contentSha256',
        'contentBytes',
        'digestTimezone',
      ]),
    ) &&
    typeof payload['path'] === 'string' &&
    typeof filename === 'string' &&
    filename.length > 0 &&
    basename(filename) === filename &&
    (payload['caption'] === undefined || typeof payload['caption'] === 'string') &&
    (payload['replyMarkup'] === undefined || isRecord(payload['replyMarkup'])) &&
    (payload['contentSha256'] === undefined ||
      (typeof payload['contentSha256'] === 'string' &&
        /^[0-9a-f]{64}$/u.test(payload['contentSha256']))) &&
    (payload['contentBytes'] === undefined ||
      (Number.isSafeInteger(payload['contentBytes']) &&
        (payload['contentBytes'] as number) >= 0)) &&
    (payload['digestTimezone'] === undefined || typeof payload['digestTimezone'] === 'string')
  );
}

function audioIdentity(
  paths: Paths,
  partId: string,
  part: StoredPart,
  row: StoredOutboxRow,
  payload: Record<string, unknown>,
): AudioIdentity | string {
  const path = payload['path'];
  const filename = payload['filename'];
  if (
    row.kind !== 'audio' ||
    row.session_id !== part.session_id ||
    payload['partId'] !== partId ||
    !canonicalDocumentPayload(payload) ||
    typeof path !== 'string' ||
    typeof filename !== 'string'
  ) {
    return 'audio manifest row has the wrong kind, session, part, or payload';
  }

  if (row.delivery_part_id === `audio:${partId}`) {
    if (
      payload['deleteAfterSend'] !== undefined ||
      path !== part.path ||
      filename !== basename(path) ||
      !canonicalManagedPath(path, paths.audioDir, false)
    ) {
      return 'direct audio manifest row conflicts with its owned part';
    }
    return { outboxId: row.outbox_id, mode: 'direct', ordinal: 0, path, filename };
  }

  const match = new RegExp(`^audio:${escapeRegExp(partId)}:split(0|[1-9]\\d*)$`).exec(
    row.delivery_part_id,
  );
  const ordinal = match === null ? Number.NaN : Number(match[1]);
  const sourceStem = basename(part.path).replace(/\.flac$/i, '');
  const suffix = `.split${String(ordinal).padStart(3, '0')}.flac`;
  if (
    !Number.isSafeInteger(ordinal) ||
    payload['deleteAfterSend'] !== true ||
    filename !== `${sourceStem}${suffix}` ||
    !basename(path).startsWith(`${sourceStem}.`) ||
    !basename(path).endsWith(suffix) ||
    !canonicalManagedPath(path, paths.tempDir, true)
  ) {
    return 'split audio manifest row has a noncanonical identity or path';
  }
  return { outboxId: row.outbox_id, mode: 'split', ordinal, path, filename };
}

function audioManifestRows(db: DatabaseSync, partId: string): StoredOutboxRow[] {
  const directId = `audio:${partId}`;
  const splitPrefix = `${directId}:split`;
  return db
    .prepare(
      `SELECT outbox_id, delivery_part_id, session_id, kind, ordinal, payload, state,
              attempts, max_attempts, claim_generation, telegram_message_id, last_error,
              created_at, updated_at
         FROM telegram_outbox
        WHERE delivery_part_id = ?
           OR substr(delivery_part_id, 1, ?) = ?
           OR (kind = 'audio' AND json_valid(payload) = 1
               AND json_extract(payload, '$.partId') = ?)`,
    )
    .all(directId, splitPrefix.length, splitPrefix, partId) as unknown as StoredOutboxRow[];
}

function proveAudioManifest(db: DatabaseSync, paths: Paths, partId: string): AudioManifestProof {
  const part = partFor(db, partId);
  if (part === undefined || part.finalized !== 1 || part.deleted_at !== null) {
    return {
      certain: false,
      reason: 'audio manifest has no finalized undeleted part',
      identities: [],
    };
  }
  const rows = audioManifestRows(db, partId);
  const identities: AudioIdentity[] = [];
  for (const row of rows) {
    const payload = parseRecord(row.payload);
    if (payload === null) {
      return { certain: false, reason: 'audio manifest contains invalid payload JSON', identities };
    }
    const identity = audioIdentity(paths, partId, part, row, payload);
    if (typeof identity === 'string') {
      return { certain: false, reason: identity, identities };
    }
    identities.push(identity);
  }
  const direct = identities.filter((identity) => identity.mode === 'direct');
  const splits = identities
    .filter((identity) => identity.mode === 'split')
    .sort((left, right) => left.ordinal - right.ordinal);
  if (rows.length === 0 || direct.length > 1 || (direct.length === 1 && splits.length > 0)) {
    return { certain: false, reason: 'audio manifest mixes direct and split delivery', identities };
  }
  if (direct.length === 1 && rows.length === 1) {
    return { certain: true, reason: null, identities };
  }
  if (
    splits.length !== rows.length ||
    splits.some((identity, index) => identity.ordinal !== index)
  ) {
    return {
      certain: false,
      reason: 'audio split manifest is not contiguous from split0',
      identities,
    };
  }
  return { certain: true, reason: null, identities };
}

export function proveTemporaryAudioOwnership(
  db: DatabaseSync,
  paths: Paths,
): TemporaryAudioOwnershipProof {
  const candidates = db
    .prepare(
      `SELECT outbox_id, delivery_part_id, session_id, kind, ordinal, payload, state,
              attempts, max_attempts, claim_generation, telegram_message_id, last_error,
              created_at, updated_at
         FROM telegram_outbox
        WHERE state IN ('pending','sending','dead')
          AND (kind = 'audio' OR delivery_part_id LIKE 'audio:%')`,
    )
    .all() as unknown as StoredOutboxRow[];
  const owned = new Set<string>();
  const ambiguous = new Set<string>();
  const manifests = new Map<string, AudioManifestProof>();
  for (const row of candidates) {
    const payload = parseRecord(row.payload);
    const partId = payload?.['partId'];
    if (typeof partId !== 'string' || partId.length === 0) {
      ambiguous.add(row.outbox_id);
      continue;
    }
    const proof = manifests.get(partId) ?? proveAudioManifest(db, paths, partId);
    manifests.set(partId, proof);
    const identity = proof.identities.find((candidate) => candidate.outboxId === row.outbox_id);
    if (!proof.certain || identity === undefined) {
      ambiguous.add(row.outbox_id);
      continue;
    }
    if (identity.mode === 'split') owned.add(resolve(identity.path));
  }
  return {
    certain: ambiguous.size === 0,
    paths: owned,
    ambiguousOutboxIds: [...ambiguous],
  };
}

function inspectAudioDocument(
  db: DatabaseSync,
  paths: Paths,
  row: StoredOutboxRow,
  payload: Record<string, unknown>,
): PayloadInspection {
  const partId = payload['partId'];
  if (typeof partId !== 'string' || partId.length === 0) {
    return blockedDocument('audio document has no canonical part identity');
  }
  const proof = proveAudioManifest(db, paths, partId);
  const identity = proof.identities.find((candidate) => candidate.outboxId === row.outbox_id);
  if (!proof.certain || identity === undefined) {
    return blockedDocument(proof.reason ?? 'audio manifest does not contain the selected row');
  }
  const root = identity.mode === 'direct' ? paths.audioDir : paths.tempDir;
  return {
    ...inspectFile(identity.path, root, identity.mode === 'split'),
    filename: bounded(identity.filename),
  };
}

function inspectPayload(db: DatabaseSync, paths: Paths, row: StoredOutboxRow): PayloadInspection {
  let payload: unknown;
  try {
    payload = JSON.parse(row.payload);
  } catch {
    return invalidPayload('outbox payload is not valid JSON');
  }
  if (!isRecord(payload)) return invalidPayload('outbox payload is not an object');

  if (payload['type'] === 'text') {
    const canonical =
      hasOnly(payload, new Set(['type', 'text', 'parseMode', 'replyMarkup'])) &&
      typeof payload['text'] === 'string' &&
      (payload['parseMode'] === undefined || payload['parseMode'] === 'HTML') &&
      (payload['replyMarkup'] === undefined || isRecord(payload['replyMarkup']));
    if (!canonical) return invalidPayload('outbox text payload is not canonical');
    return {
      type: 'text',
      filename: null,
      artifactStatus: 'not_applicable',
      artifactBytes: null,
      error: row.kind === 'audio' ? 'audio delivery must contain a document payload' : null,
    };
  }

  if (payload['type'] !== 'document')
    return invalidPayload('outbox payload has an unsupported type');
  const filename = payload['filename'];
  if (!canonicalDocumentPayload(payload) || typeof filename !== 'string') {
    return invalidPayload('outbox document payload is not canonical');
  }
  if (row.kind !== 'audio') {
    return {
      ...blockedDocument(
        `${row.kind} document retry is not supported; reconcile or regenerate it explicitly`,
      ),
      filename: bounded(filename),
    };
  }
  return inspectAudioDocument(db, paths, row, payload);
}

function invalidPayload(error: string): PayloadInspection {
  return {
    type: 'invalid',
    filename: null,
    artifactStatus: 'unsafe',
    artifactBytes: null,
    error,
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function inspectRow(db: DatabaseSync, paths: Paths, row: StoredOutboxRow): DeadOutboxDelivery {
  const payload = inspectPayload(db, paths, row);
  const safeId =
    row.delivery_part_id.length > 0 &&
    row.delivery_part_id.length <= 512 &&
    /^[A-Za-z0-9:._-]+$/u.test(row.delivery_part_id) &&
    terminalText(row.delivery_part_id) === row.delivery_part_id;
  const blockedReason =
    row.state !== 'dead'
      ? 'outbox row is no longer dead'
      : row.telegram_message_id !== null
        ? 'dead outbox row already has a Telegram message id'
        : !safeId
          ? 'delivery identity contains unsafe terminal text'
          : payload.error;
  return {
    deliveryPartId: safeId ? row.delivery_part_id : '[unsafe delivery id]',
    kind: row.kind,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    claimGeneration: row.claim_generation,
    lastError:
      row.last_error === null || row.last_error.trim().length === 0
        ? 'cause was not recorded'
        : safeError(row.last_error),
    snapshotSha256: snapshotSha256(row),
    payloadSha256: sha256(row.payload),
    payloadBytes: Buffer.byteLength(row.payload),
    payloadType: payload.type,
    documentFilename: payload.filename,
    artifactStatus: payload.artifactStatus,
    artifactBytes: payload.artifactBytes,
    retryable: blockedReason === null,
    blockedReason,
  };
}

function selectDeadRows(
  db: DatabaseSync,
  deliveryPartId: string | undefined,
  limit: number,
): StoredOutboxRow[] {
  return db
    .prepare(
      `SELECT outbox_id, delivery_part_id, session_id, kind, ordinal, payload, state,
              attempts, max_attempts, claim_generation, telegram_message_id, last_error,
              created_at, updated_at
         FROM telegram_outbox
        WHERE state = 'dead' AND (? IS NULL OR delivery_part_id = ?)
        ORDER BY updated_at DESC, rowid
        LIMIT ?`,
    )
    .all(deliveryPartId ?? null, deliveryPartId ?? null, limit) as unknown as StoredOutboxRow[];
}

export function inspectDeadOutbox(
  db: DatabaseSync,
  paths: Paths,
  options: { readonly deliveryPartId?: string; readonly limit?: number } = {},
): DeadOutboxReport {
  const selector = options.deliveryPartId?.trim() || undefined;
  const limit = options.limit ?? REPORT_LIMIT;
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new DeadOutboxRecoveryError('dead outbox report limit must be a positive integer');
  }
  const rows = selectDeadRows(db, selector, limit + 1);
  return {
    deliveries: rows.slice(0, limit).map((row) => inspectRow(db, paths, row)),
    truncated: rows.length > limit,
  };
}

export function retryDeadOutbox(
  db: DatabaseSync,
  paths: Paths,
  deliveryPartId: string,
  expectedSnapshotSha256: string,
  options: { readonly requireDaemonStopped?: boolean } = {},
): RetryDeadOutboxResult {
  const selector = deliveryPartId.trim();
  if (selector.length === 0)
    throw new DeadOutboxRecoveryError('one exact dead delivery id is required');
  return transaction(db, () => {
    if (
      options.requireDaemonStopped === true &&
      db.prepare('SELECT 1 AS present FROM daemon_ownership WHERE ownership_id = 1').get() !==
        undefined
    ) {
      throw new DeadOutboxRecoveryError(
        'daemon ownership changed before retry; stop the daemon and inspect again',
      );
    }
    const row = selectDeadRows(db, selector, 1)[0];
    if (row === undefined) {
      throw new DeadOutboxRecoveryError('no dead outbox delivery exists for that exact id');
    }
    const inspected = inspectRow(db, paths, row);
    if (inspected.snapshotSha256 !== expectedSnapshotSha256) {
      throw new DeadOutboxRecoveryError(
        'dead outbox delivery changed after inspection; inspect it again before retrying',
      );
    }
    if (!inspected.retryable) {
      throw new DeadOutboxRecoveryError(
        `dead outbox delivery is not safely retryable: ${inspected.blockedReason ?? 'unknown reason'}`,
      );
    }

    const now = new Date().toISOString();
    const updated = db
      .prepare(
        `UPDATE telegram_outbox
            SET state = 'pending', attempts = 0, run_after = ?, updated_at = ?,
                claim_generation = claim_generation + 1
          WHERE outbox_id = ? AND delivery_part_id = ? AND state = 'dead'
            AND claim_generation = ? AND updated_at = ? AND payload = ?
            AND attempts = ? AND last_error IS ? AND telegram_message_id IS NULL`,
      )
      .run(
        now,
        now,
        row.outbox_id,
        row.delivery_part_id,
        row.claim_generation,
        row.updated_at,
        row.payload,
        row.attempts,
        row.last_error,
      );
    if (updated.changes !== 1) {
      throw new DeadOutboxRecoveryError('dead outbox delivery changed while retry was applying');
    }
    return {
      deliveryPartId: row.delivery_part_id,
      payloadSha256: sha256(row.payload),
      claimGeneration: row.claim_generation + 1,
    };
  });
}

export function renderDeadOutboxReport(report: DeadOutboxReport): string {
  if (report.deliveries.length === 0) return 'No failed Telegram outbox deliveries.';
  const lines = [`${report.deliveries.length} failed Telegram delivery row(s):`, ''];
  for (const row of report.deliveries) {
    const payload =
      row.payloadType === 'document'
        ? `document ${row.documentFilename ?? 'missing filename'}`
        : row.payloadType;
    const artifact =
      row.artifactStatus === 'available'
        ? `available (${row.artifactBytes ?? 0} bytes)`
        : row.artifactStatus.replace('_', ' ');
    lines.push(
      `  ${row.deliveryPartId} · ${row.kind} · attempts ${row.attempts}/${row.maxAttempts}`,
      `    cause: ${row.lastError}`,
      `    payload: ${payload} · sha256 ${row.payloadSha256} · ${row.payloadBytes} bytes`,
      `    artifact: ${artifact}`,
      `    retry: ${row.retryable ? 'available' : `blocked — ${row.blockedReason ?? 'unknown reason'}`}`,
    );
  }
  if (report.truncated) lines.push('', 'Report truncated; select one exact --delivery-part.');
  return lines.join('\n');
}
