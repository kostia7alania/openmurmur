import { createHash } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { lstat, open, opendir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { transaction } from '../database/db.ts';
import { Outbox, type OutboxPayload } from '../telegram/outbox.ts';
import { writeTextAtomically } from '../util/atomic-file.ts';
import {
  type Digest,
  digestDocumentFilename,
  digestSnapshotStillCurrent,
  readStoredDigest,
  renderDigest,
  renderDigestCaption,
  renderDigestMarkdown,
  resolveDigestTimezone,
  storeDigest,
} from './daily.ts';

export interface PreparedDigestDelivery {
  readonly rendered: string;
  readonly payload: OutboxPayload;
}

export type DigestPublication = 'inserted' | 'exists' | 'stale';

interface StoredDigestOutboxRow {
  readonly kind: string;
  readonly session_id: string | null;
  readonly payload: string;
}

function hasOnly(record: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(record).every((key) => allowed.has(key));
}

function sha256(contents: string | Uint8Array): string {
  return createHash('sha256').update(contents).digest('hex');
}

function digestProofError(message: string, cause?: unknown): Error & { readonly errorCode: 409 } {
  return Object.assign(new Error(message, cause === undefined ? {} : { cause }), {
    errorCode: 409 as const,
  });
}

function storedDigestValidationFailed(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith('stored digest ');
}

export function prepareDigestDelivery(
  digest: Digest,
  timezone: string,
  inlineLimit: number,
  transcriptsDir: string,
): PreparedDigestDelivery {
  const digestTimezone = resolveDigestTimezone(timezone);
  const rendered = renderDigest(digest, digestTimezone);
  if (rendered.length <= inlineLimit) {
    return { rendered, payload: { type: 'text', text: rendered, parseMode: 'HTML' } };
  }

  const markdown = renderDigestMarkdown(digest, digestTimezone);
  const contents = Buffer.from(markdown, 'utf8');
  const filename = digestDocumentFilename(digest, markdown);
  return {
    rendered,
    payload: {
      type: 'document',
      path: join(transcriptsDir, filename),
      filename,
      caption: renderDigestCaption(digest),
      contentSha256: sha256(contents),
      contentBytes: contents.byteLength,
      digestTimezone,
    },
  };
}

/**
 * The durable snapshot/outbox pair owns any generated artifact. A losing
 * builder therefore never publishes a file, and a post-commit crash can replay
 * the exact winner payload.
 */
export function publishDigestSnapshot(
  db: DatabaseSync,
  digest: Digest,
  payload: OutboxPayload,
  timezone: string,
): DigestPublication {
  return transaction(db, () => {
    if (readStoredDigest(db, digest.date) !== undefined) return 'exists';
    if (!digestSnapshotStillCurrent(db, digest, timezone)) return 'stale';
    if (!storeDigest(db, digest)) {
      throw new Error(`digest ${digest.date} changed inside its publication transaction`);
    }
    const enqueued = new Outbox(db).enqueue({
      deliveryPartId: `digest:${digest.date}`,
      kind: 'digest',
      ordinal: 30,
      payload,
    });
    if (!enqueued) {
      throw new Error(`digest ${digest.date} has an outbox row without its snapshot`);
    }
    return 'inserted';
  });
}

export function readDigestDeliveryPayload(db: DatabaseSync, date: string): OutboxPayload {
  const row = db
    .prepare(
      `SELECT kind, session_id, payload
         FROM telegram_outbox
        WHERE delivery_part_id = ?`,
    )
    .get(`digest:${date}`) as StoredDigestOutboxRow | undefined;
  if (row === undefined) throw new Error(`stored digest ${date} has no durable delivery`);
  if (row.kind !== 'digest' || row.session_id !== null) {
    throw new Error(`stored digest ${date} has a delivery with the wrong identity`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(row.payload);
  } catch (error) {
    throw new Error(`stored digest ${date} has invalid delivery JSON`, { cause: error });
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`stored digest ${date} has a non-object delivery payload`);
  }
  const payload = parsed as Record<string, unknown>;
  if (
    payload['type'] === 'text' &&
    hasOnly(payload, new Set(['type', 'text', 'parseMode'])) &&
    typeof payload['text'] === 'string' &&
    (payload['parseMode'] === undefined || payload['parseMode'] === 'HTML')
  ) {
    return payload as unknown as OutboxPayload;
  }
  if (
    payload['type'] === 'document' &&
    hasOnly(
      payload,
      new Set([
        'type',
        'path',
        'filename',
        'caption',
        'contentSha256',
        'contentBytes',
        'digestTimezone',
      ]),
    ) &&
    typeof payload['path'] === 'string' &&
    typeof payload['filename'] === 'string' &&
    (payload['caption'] === undefined || typeof payload['caption'] === 'string')
  ) {
    return payload as unknown as OutboxPayload;
  }
  throw new Error(`stored digest ${date} has a noncanonical delivery payload`);
}

async function readRegularFile(
  path: string,
): Promise<{ readonly info: Stats; readonly bytes: Buffer }> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error('artifact is not a regular file');
    return { info, bytes: await handle.readFile() };
  } finally {
    await handle.close();
  }
}

async function verifyDigestArtifact(
  path: string,
  expectedBytes: number,
  expectedSha256: string,
): Promise<void> {
  const artifact = await readRegularFile(path);
  if (
    artifact.info.size !== expectedBytes ||
    artifact.bytes.byteLength !== expectedBytes ||
    sha256(artifact.bytes) !== expectedSha256
  ) {
    throw digestProofError('durable digest artifact does not match its content-addressed delivery');
  }
}

interface DigestArtifactContract {
  readonly path: string;
  readonly markdown: string;
  readonly bytes: number;
  readonly sha256: string;
}

function digestArtifactContract(
  digest: Digest,
  payload: Extract<OutboxPayload, { type: 'document' }>,
  transcriptsDir: string,
): DigestArtifactContract | null {
  const metadata = [payload.contentSha256, payload.contentBytes, payload.digestTimezone];
  if (metadata.every((value) => value === undefined)) {
    if (digest.claimSourceVersion === 2) {
      throw digestProofError(
        `stored digest ${digest.date} v2 document has no artifact integrity proof`,
      );
    }
    return null;
  }
  if (
    typeof payload.contentSha256 !== 'string' ||
    !/^[0-9a-f]{64}$/u.test(payload.contentSha256) ||
    !Number.isSafeInteger(payload.contentBytes) ||
    (payload.contentBytes ?? -1) < 0 ||
    typeof payload.digestTimezone !== 'string' ||
    payload.digestTimezone.length === 0
  ) {
    throw digestProofError(`stored digest ${digest.date} has incomplete artifact metadata`);
  }

  let markdown: string;
  try {
    markdown = renderDigestMarkdown(digest, payload.digestTimezone);
  } catch (error) {
    throw digestProofError(`stored digest ${digest.date} has an invalid artifact timezone`, error);
  }
  const contents = Buffer.from(markdown, 'utf8');
  const filename = digestDocumentFilename(digest, markdown);
  const path = join(transcriptsDir, filename);
  const contentSha256 = sha256(contents);
  if (
    payload.filename !== filename ||
    payload.path !== path ||
    payload.caption !== renderDigestCaption(digest) ||
    payload.contentBytes !== contents.byteLength ||
    payload.contentSha256 !== contentSha256
  ) {
    throw digestProofError(
      `stored digest ${digest.date} delivery does not match its immutable snapshot`,
    );
  }
  return { path, markdown, bytes: contents.byteLength, sha256: contentSha256 };
}

const DIGEST_TEMP_NAME =
  /^\.(digest-(\d{4}-\d{2}-\d{2})-[0-9a-f]{64}\.md)\.[1-9]\d*\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/u;
const MAX_DIGEST_TEMP_SCAN_ENTRIES = 10_000;

function durableDigestOwnsFilename(
  db: DatabaseSync,
  date: string,
  filename: string,
  transcriptsDir: string,
): boolean {
  try {
    const digest = readStoredDigest(db, date);
    const payload = readDigestDeliveryPayload(db, date);
    return (
      digest !== undefined &&
      digest.claimSourceVersion === 2 &&
      payload.type === 'document' &&
      digestArtifactContract(digest, payload, transcriptsDir)?.path ===
        join(transcriptsDir, filename)
    );
  } catch {
    // Malformed or ambiguous ownership preserves the file for inspection.
    return false;
  }
}

/** Removes only exact private temps owned by durable v2 snapshots, in one bounded pass. */
export async function cleanupDurableDigestTemps(
  db: DatabaseSync,
  transcriptsDir: string,
): Promise<number> {
  let scanned = 0;
  let removed = 0;
  const ownership = new Map<string, boolean>();
  const directory = await opendir(transcriptsDir);
  for await (const entry of directory) {
    scanned += 1;
    if (scanned > MAX_DIGEST_TEMP_SCAN_ENTRIES) {
      throw new Error(
        `digest temp cleanup stopped after ${MAX_DIGEST_TEMP_SCAN_ENTRIES} directory entries`,
      );
    }
    const match = DIGEST_TEMP_NAME.exec(entry.name);
    if (match === null) continue;
    const filename = match[1] ?? '';
    const date = match[2] ?? '';
    let owned = ownership.get(filename);
    if (owned === undefined) {
      owned = durableDigestOwnsFilename(db, date, filename, transcriptsDir);
      ownership.set(filename, owned);
    }
    if (!owned) continue;

    const temporary = join(transcriptsDir, entry.name);
    let info: Awaited<ReturnType<typeof lstat>>;
    try {
      info = await lstat(temporary);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    if (!info.isFile() || info.isSymbolicLink()) continue;
    await rm(temporary);
    removed += 1;
  }
  return removed;
}

/** Reconstructs and proves the exact digest row selected by the outbox sender. */
export async function prepareDigestDocumentForSend(
  db: DatabaseSync,
  deliveryPartId: string,
  payload: Extract<OutboxPayload, { type: 'document' }>,
  transcriptsDir: string,
): Promise<void> {
  const match = /^digest:(\d{4}-\d{2}-\d{2})$/u.exec(deliveryPartId);
  if (match === null) throw digestProofError('digest delivery has an invalid identity');
  const date = match[1] ?? '';
  let digest: Digest | undefined;
  let storedPayload: OutboxPayload;
  try {
    digest = readStoredDigest(db, date);
    storedPayload = readDigestDeliveryPayload(db, date);
  } catch (error) {
    if (storedDigestValidationFailed(error)) {
      throw digestProofError(`stored digest ${date} failed validation`, error);
    }
    throw error;
  }
  if (digest === undefined) throw digestProofError(`stored digest ${date} has no durable snapshot`);
  if (
    storedPayload.type !== 'document' ||
    JSON.stringify(storedPayload) !== JSON.stringify(payload)
  ) {
    throw digestProofError(`stored digest ${date} changed before delivery`);
  }
  await ensureDigestDeliveryArtifact(digest, storedPayload, transcriptsDir);
}

/** Publishes or verifies the exact artifact named by the durable winner row. */
export async function ensureDigestDeliveryArtifact(
  digest: Digest,
  payload: OutboxPayload,
  transcriptsDir: string,
): Promise<void> {
  if (payload.type !== 'document') return;
  const contract = digestArtifactContract(digest, payload, transcriptsDir);
  if (contract === null) {
    // Legacy documents predate replayable artifact metadata. Never reconstruct
    // them from current configuration or transcript state.
    return;
  }

  try {
    await verifyDigestArtifact(contract.path, contract.bytes, contract.sha256);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  let publicationError: unknown;
  try {
    await writeTextAtomically(contract.path, contract.markdown, { replaceExisting: false });
  } catch (error) {
    publicationError = error;
  }
  try {
    await verifyDigestArtifact(contract.path, contract.bytes, contract.sha256);
  } catch (error) {
    if ((error as { errorCode?: unknown }).errorCode === 409) throw error;
    if (publicationError !== undefined) throw publicationError;
    throw error;
  }
}
