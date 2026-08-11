import type { Stats } from 'node:fs';
import { lstat, opendir, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { Paths } from '../config/paths.ts';
import type { Logger } from '../logging/logger.ts';

const GENERATED_INCOMING_ARTIFACT =
  /^([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})(?:\.16k\.wav|\.(?:ogg|opus|mp3|m4a|aac|wav|flac|bin))$/;
const DEFAULT_MAX_ENTRIES = 10_000;

export interface SupersededIncomingArtifact {
  readonly fileUid: string;
  readonly path: string;
  readonly kind: 'quarantine' | 'normalized';
  readonly bytes: number;
  readonly modifiedAt: string;
}

export interface IncomingRecoveryReport {
  readonly superseded: readonly SupersededIncomingArtifact[];
  readonly removed: number;
  readonly freedBytes: number;
  readonly applied: boolean;
  readonly complete: boolean;
  /** False means ownership or filesystem identity was ambiguous, so files stayed. */
  readonly ownershipCertain: boolean;
  readonly errors: readonly string[];
}

export interface IncomingRecoveryOptions {
  /** Report-only unless the caller explicitly opts into deletion. */
  readonly remove?: boolean;
  /** Bounds one background pass without loading the directory into memory. */
  readonly maxEntries?: number;
}

interface OwnershipProof {
  readonly certain: boolean;
  readonly fileUids: ReadonlySet<string>;
  readonly error?: string;
}

interface IncomingOwnershipRow {
  readonly file_uid: unknown;
  readonly quarantine_path: unknown;
  readonly normalized_path: unknown;
}

interface ArtifactIdentity {
  readonly fileUid: string;
  readonly kind: SupersededIncomingArtifact['kind'];
}

interface Candidate extends SupersededIncomingArtifact {
  readonly device: number;
  readonly inode: number;
}

interface RootIdentity {
  readonly device: number;
  readonly inode: number;
}

type RemovalResult =
  | { readonly status: 'removed'; readonly artifact: SupersededIncomingArtifact }
  | { readonly status: 'owned' | 'missing' }
  | { readonly status: 'ambiguous' | 'failed'; readonly error: string };

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function artifactIdentity(filename: string): ArtifactIdentity | null {
  const match = GENERATED_INCOMING_ARTIFACT.exec(filename);
  const fileUid = match?.[1];
  if (fileUid === undefined) return null;
  return {
    fileUid,
    kind: filename.endsWith('.16k.wav') ? 'normalized' : 'quarantine',
  };
}

function rootIdentity(info: Stats): RootIdentity {
  return { device: info.dev, inode: info.ino };
}

function sameRoot(left: RootIdentity, right: Stats): boolean {
  return (
    right.isDirectory() &&
    !right.isSymbolicLink() &&
    left.device === right.dev &&
    left.inode === right.ino
  );
}

function validateOwnedPath(
  value: unknown,
  fileUid: string,
  expectedKind: ArtifactIdentity['kind'],
  column: 'quarantine_path' | 'normalized_path',
  quarantineRoot: string,
): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || value.length === 0 || !isAbsolute(value)) {
    return `${column} for ${fileUid} is not an absolute path`;
  }
  const canonical = resolve(value);
  const identity = artifactIdentity(basename(canonical));
  if (
    value !== canonical ||
    dirname(canonical) !== quarantineRoot ||
    identity === null ||
    identity.fileUid !== fileUid ||
    identity.kind !== expectedKind
  ) {
    return `${column} for ${fileUid} does not match its canonical UID/kind`;
  }
  return null;
}

function readOwnership(db: DatabaseSync, quarantineRoot: string): OwnershipProof {
  let rows: IncomingOwnershipRow[];
  try {
    rows = db
      .prepare('SELECT file_uid, quarantine_path, normalized_path FROM incoming_telegram_files')
      .all() as unknown as IncomingOwnershipRow[];
  } catch (error) {
    return {
      certain: false,
      fileUids: new Set(),
      error: `could not read incoming artifact ownership: ${messageOf(error)}`,
    };
  }

  const fileUids = new Set<string>();
  for (const row of rows) {
    if (typeof row.file_uid !== 'string' || row.file_uid.length === 0) {
      return {
        certain: false,
        fileUids,
        error: 'incoming artifact ownership contains an invalid file_uid',
      };
    }
    fileUids.add(row.file_uid);
    const pathError =
      validateOwnedPath(
        row.quarantine_path,
        row.file_uid,
        'quarantine',
        'quarantine_path',
        quarantineRoot,
      ) ??
      validateOwnedPath(
        row.normalized_path,
        row.file_uid,
        'normalized',
        'normalized_path',
        quarantineRoot,
      );
    if (pathError !== null) return { certain: false, fileUids, error: pathError };
  }
  return { certain: true, fileUids };
}

function logAmbiguousProof(logger: Logger, error: string): void {
  logger.error('incoming artifact cleanup proof is ambiguous; preserving quarantine files', {
    error,
    action: 'Inspect the quarantine root and incoming_telegram_files facts before cleanup.',
  });
}

async function lstatIfPresent(path: string): Promise<Stats | null> {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function inspectCandidate(
  quarantineRoot: string,
  filename: string,
  identity: ArtifactIdentity,
  logger: Logger,
  errors: string[],
): Promise<Candidate | null> {
  const path = resolve(join(quarantineRoot, filename));
  if (dirname(path) !== quarantineRoot) return null;
  try {
    const info = await lstatIfPresent(path);
    if (info === null) return null;
    if (!info.isFile() || info.isSymbolicLink()) {
      const detail = `generated incoming artifact is not a regular file: ${path}`;
      errors.push(detail);
      logger.error('preserving an unsafe incoming artifact candidate', { path });
      return null;
    }
    return {
      fileUid: identity.fileUid,
      path,
      kind: identity.kind,
      bytes: info.size,
      modifiedAt: new Date(info.mtimeMs).toISOString(),
      device: info.dev,
      inode: info.ino,
    };
  } catch (error) {
    const detail = `could not inspect incoming artifact ${path}: ${messageOf(error)}`;
    errors.push(detail);
    logger.error('preserving an unreadable incoming artifact candidate', { path, error: detail });
    return null;
  }
}

async function scanCandidates(
  paths: Paths,
  quarantineRoot: string,
  ownership: OwnershipProof,
  logger: Logger,
  errors: string[],
  maxEntries: number,
): Promise<{
  readonly candidates: Candidate[];
  readonly inspected: number;
  readonly complete: boolean;
}> {
  const candidates: Candidate[] = [];
  let inspected = 0;
  let complete = true;
  const directory = await opendir(paths.quarantineDir);
  for await (const entry of directory) {
    if (inspected >= maxEntries) {
      complete = false;
      break;
    }
    inspected += 1;
    const identity = artifactIdentity(entry.name);
    if (identity === null || ownership.fileUids.has(identity.fileUid)) continue;
    const candidate = await inspectCandidate(quarantineRoot, entry.name, identity, logger, errors);
    if (candidate !== null) candidates.push(candidate);
  }
  return { candidates, inspected, complete };
}

async function removeCandidate(
  db: DatabaseSync,
  paths: Paths,
  quarantineRoot: string,
  expectedRoot: RootIdentity,
  candidate: Candidate,
): Promise<RemovalResult> {
  const ownership = readOwnership(db, quarantineRoot);
  if (!ownership.certain) {
    return { status: 'ambiguous', error: ownership.error ?? 'unknown ownership error' };
  }
  // UUIDs are generated before their durable row and never reused. Therefore a
  // present UID always wins, while an absent UID remains absent without a DB
  // lock across the following filesystem awaits.
  if (ownership.fileUids.has(candidate.fileUid)) return { status: 'owned' };

  try {
    const current = await lstatIfPresent(candidate.path);
    if (current === null) return { status: 'missing' };
    if (
      !current.isFile() ||
      current.isSymbolicLink() ||
      current.dev !== candidate.device ||
      current.ino !== candidate.inode
    ) {
      return { status: 'failed', error: 'candidate identity changed before cleanup' };
    }
    const currentRoot = await lstat(paths.quarantineDir);
    if (!sameRoot(expectedRoot, currentRoot)) {
      return { status: 'ambiguous', error: 'quarantine root identity changed before cleanup' };
    }
    await unlink(candidate.path);
    return { status: 'removed', artifact: candidate };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'missing' };
    return { status: 'failed', error: messageOf(error) };
  }
}

function emptyReport(
  remove: boolean,
  ownershipCertain: boolean,
  errors: readonly string[],
): IncomingRecoveryReport {
  return {
    superseded: [],
    removed: 0,
    freedBytes: 0,
    applied: remove,
    complete: false,
    ownershipCertain,
    errors,
  };
}

/**
 * Audits app-generated incoming artifacts against their durable UID namespace.
 *
 * The directory is streamed with bounded work. A file is automatically
 * removable only when its generated UID is entirely absent from the ownership
 * table. Existing UIDs, malformed path facts, root swaps and inode changes all
 * preserve data. The ambient archive is never scanned.
 */
export async function reconcileIncomingArtifacts(
  db: DatabaseSync,
  paths: Paths,
  logger: Logger,
  options: IncomingRecoveryOptions = {},
): Promise<IncomingRecoveryReport> {
  const remove = options.remove ?? false;
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0) {
    throw new Error('incoming recovery maxEntries must be a positive integer');
  }
  const quarantineRoot = resolve(paths.quarantineDir);
  const errors: string[] = [];
  const ownership = readOwnership(db, quarantineRoot);
  if (!ownership.certain) {
    const error = ownership.error ?? 'unknown ownership error';
    errors.push(error);
    logAmbiguousProof(logger, error);
    return emptyReport(remove, false, errors);
  }

  let initialRoot: Stats;
  try {
    initialRoot = await lstat(paths.quarantineDir);
    if (!initialRoot.isDirectory() || initialRoot.isSymbolicLink()) {
      throw new Error('quarantine root is not a regular directory');
    }
  } catch (error) {
    const detail = `could not safely inspect quarantine root: ${messageOf(error)}`;
    errors.push(detail);
    logger.error('incoming artifact cleanup could not inspect its managed directory', {
      error: detail,
    });
    return emptyReport(remove, false, errors);
  }
  const expectedRoot = rootIdentity(initialRoot);

  let scan: Awaited<ReturnType<typeof scanCandidates>>;
  try {
    scan = await scanCandidates(paths, quarantineRoot, ownership, logger, errors, maxEntries);
  } catch (error) {
    const detail = `could not stream quarantine artifacts: ${messageOf(error)}`;
    errors.push(detail);
    logger.error('incoming artifact cleanup could not scan its managed directory', {
      error: detail,
    });
    return emptyReport(remove, false, errors);
  }
  if (!scan.complete) {
    const detail = `incoming artifact audit stopped at the ${maxEntries}-entry work limit`;
    errors.push(detail);
    logger.warn('incoming artifact cleanup left a bounded remainder', {
      inspected: scan.inspected,
      maxEntries,
    });
  }
  if (!remove) {
    return {
      superseded: scan.candidates,
      removed: 0,
      freedBytes: 0,
      applied: false,
      complete: scan.complete,
      ownershipCertain: true,
      errors,
    };
  }

  const superseded: SupersededIncomingArtifact[] = [];
  let ownershipCertain = true;
  for (const candidate of scan.candidates) {
    const result = await removeCandidate(db, paths, quarantineRoot, expectedRoot, candidate);
    if (result.status === 'removed') {
      superseded.push(result.artifact);
    } else if (result.status === 'ambiguous') {
      errors.push(result.error);
      logAmbiguousProof(logger, result.error);
      ownershipCertain = false;
      break;
    } else if (result.status === 'failed') {
      const detail = `could not remove superseded incoming artifact ${candidate.path}: ${result.error}`;
      errors.push(detail);
      logger.error('preserving a superseded incoming artifact after cleanup failure', {
        path: candidate.path,
        error: detail,
      });
    }
  }

  const freedBytes = superseded.reduce((total, artifact) => total + artifact.bytes, 0);
  if (superseded.length > 0) {
    logger.warn('cleaned superseded incoming Telegram artifacts', {
      artifacts: superseded.length,
      removed: superseded.length,
      freedBytes,
    });
  }
  return {
    superseded,
    removed: superseded.length,
    freedBytes,
    applied: true,
    complete: scan.complete,
    ownershipCertain,
    errors,
  };
}
