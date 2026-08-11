import { readdir, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { Paths } from '../config/paths.ts';
import { transaction } from '../database/db.ts';
import { JobQueue } from '../jobs/queue.ts';
import type { Logger } from '../logging/logger.ts';
import { formatBytes } from '../telegram/format.ts';
import { Outbox } from '../telegram/outbox.ts';
import { sha256File } from './writer.ts';

/**
 * Startup reconciliation of the temp directory against the database.
 *
 * A crash or a hard power loss leaves a `.flac.part` behind: bytes ffmpeg was
 * still writing when the process died. They are not recoverable audio — a FLAC
 * that never received its final metadata block is not reliably decodable, and
 * the session it belonged to was never finalized, so nothing downstream refers
 * to it.
 *
 * What matters is that this is *reported* rather than silently swept up. A user
 * whose Mac lost power mid-session should be told that a recording was
 * interrupted, not left to wonder why an hour is missing.
 *
 * The archive itself is never touched here: anything under `audio/` was
 * fsynced and atomically renamed, so by construction it is complete.
 */

export interface OrphanedPart {
  readonly path: string;
  readonly bytes: number;
  readonly modifiedAt: string;
  /** The session it belonged to, if the filename still identifies one. */
  readonly sessionId: string | null;
  /** True when the database also has an unfinalized row for it. */
  readonly hasDatabaseRow: boolean;
}

export interface RecoveryReport {
  readonly orphans: readonly OrphanedPart[];
  /** Complete archive files recovered after a crash before their DB update. */
  readonly recoveredPublishedParts: readonly string[];
  readonly removed: number;
  readonly freedBytes: number;
  /** Sessions found in a live recorder state after the capture process died. */
  readonly stalledSessions: readonly string[];
  /** Whether database reconciliation was applied rather than only reported. */
  readonly repaired: boolean;
}

/**
 * Completes the database half of an atomic publication interrupted after rename.
 * A path under audio/ exists only after ffmpeg closed cleanly and the file and
 * directory were fsynced, so hashing that file is sufficient recovery proof.
 */
export async function reconcilePublishedParts(
  db: DatabaseSync,
  logger: Logger,
  repair = true,
): Promise<readonly string[]> {
  const rows = db.prepare('SELECT part_id, path FROM audio_parts WHERE finalized = 0').all() as {
    part_id: string;
    path: string;
  }[];
  const recovered: string[] = [];

  for (const row of rows) {
    try {
      const info = await stat(row.path);
      if (!info.isFile()) {
        throw new Error(`published audio path is not a regular file: ${row.path}`);
      }
      if (!repair) {
        recovered.push(row.part_id);
        continue;
      }
      const sha256 = await sha256File(row.path);
      db.prepare(
        `UPDATE audio_parts
            SET ended_at = COALESCE(ended_at, ?), bytes = ?, sha256 = ?, finalized = 1
          WHERE part_id = ? AND finalized = 0`,
      ).run(new Date(info.mtimeMs).toISOString(), info.size, sha256, row.part_id);
      recovered.push(row.part_id);
      logger.warn('recovered an atomically published audio part', {
        partId: row.part_id,
        bytes: info.size,
      });
    } catch (error) {
      // A genuinely missing path is an interrupted temp write and is handled by
      // stalled-session reconciliation. Permission, hashing and other I/O
      // failures are not proof that the archive is absent and must stay loud.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw new Error(`could not reconcile published audio part ${row.part_id}`, { cause: error });
    }
  }
  return recovered;
}

/** `<sessionId>.p000.flac.part` -> `<sessionId>` */
export function sessionIdFromPartFilename(filename: string): string | null {
  const match = /^(.+)\.p\d{3}\.flac\.part$/.exec(filename);
  return match?.[1] ?? null;
}

const SPLIT_ARTIFACT_PATTERN = /\.split\d{3,}\.flac$/;

interface TemporaryAudioOwnershipProof {
  readonly certain: boolean;
  readonly paths: ReadonlySet<string>;
}

function ownedTemporaryAudioPaths(db: DatabaseSync, logger: Logger): TemporaryAudioOwnershipProof {
  let rows: { outbox_id: string; payload: string }[];
  try {
    rows = db
      .prepare(
        "SELECT outbox_id, payload FROM telegram_outbox WHERE state IN ('pending','sending') AND kind = 'audio'",
      )
      .all() as { outbox_id: string; payload: string }[];
  } catch (error) {
    logger.error('active audio outbox ownership is unreadable; preserving every split artifact', {
      error: (error as Error).message,
      action: 'Repair the outbox database error before rerunning split recovery.',
    });
    return { certain: false, paths: new Set() };
  }

  const owned = new Set<string>();
  const ambiguousOutboxIds: string[] = [];

  for (const row of rows) {
    let payload: unknown;
    try {
      payload = JSON.parse(row.payload);
    } catch {
      ambiguousOutboxIds.push(row.outbox_id);
      continue;
    }
    if (typeof payload !== 'object' || payload === null) {
      ambiguousOutboxIds.push(row.outbox_id);
      continue;
    }
    const record = payload as Record<string, unknown>;
    if (
      record['type'] !== 'document' ||
      typeof record['path'] !== 'string' ||
      record['path'].length === 0
    ) {
      ambiguousOutboxIds.push(row.outbox_id);
      continue;
    }

    // deleteAfterSend controls terminal cleanup, not whether an in-flight
    // delivery still needs the file it names.
    owned.add(resolve(record['path']));
  }

  if (ambiguousOutboxIds.length > 0) {
    logger.error('active audio outbox ownership is ambiguous; preserving every split artifact', {
      outboxIds: ambiguousOutboxIds,
      action: 'Repair or retire the listed outbox rows before rerunning split recovery.',
    });
    return { certain: false, paths: owned };
  }
  return { certain: true, paths: owned };
}

export async function findOrphanedParts(
  db: DatabaseSync,
  paths: Paths,
  logger: Logger,
): Promise<readonly OrphanedPart[]> {
  let entries: string[];
  try {
    entries = await readdir(paths.tempDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new Error(`could not inspect recovery temp directory ${paths.tempDir}`, { cause: error });
  }

  const orphans: OrphanedPart[] = [];
  const hasSplitArtifacts = entries.some((entry) => SPLIT_ARTIFACT_PATTERN.test(entry));
  const ownedSplitPaths = hasSplitArtifacts
    ? ownedTemporaryAudioPaths(db, logger)
    : { certain: true, paths: new Set<string>() };
  for (const entry of entries) {
    const path = join(paths.tempDir, entry);
    const partialWrite = entry.endsWith('.part');
    const splitArtifact = SPLIT_ARTIFACT_PATTERN.test(entry);
    if (!partialWrite && !splitArtifact) continue;
    if (splitArtifact && (!ownedSplitPaths.certain || ownedSplitPaths.paths.has(resolve(path)))) {
      continue;
    }

    let info: Awaited<ReturnType<typeof stat>>;
    try {
      info = await stat(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw new Error(`could not inspect recovery artifact ${path}`, { cause: error });
    }
    if (!info.isFile()) continue;

    const sessionId = partialWrite ? sessionIdFromPartFilename(entry) : null;
    const hasDatabaseRow =
      sessionId !== null &&
      (
        db
          .prepare('SELECT count(*) AS c FROM audio_parts WHERE session_id = ? AND finalized = 0')
          .get(sessionId) as { c: number }
      ).c > 0;

    orphans.push({
      path,
      bytes: info.size,
      modifiedAt: new Date(info.mtimeMs).toISOString(),
      sessionId,
      hasDatabaseRow,
    });
  }
  return orphans;
}

type InitialSessionJobKind = 'deliver_audio' | 'asr';

interface StoredInitialJob {
  readonly kind: string;
  readonly idempotency_key: string;
  readonly payload: string;
  readonly state: string;
}

interface ProcessingRepairPlan {
  readonly status: 'repair';
  readonly sessionId: string;
  readonly finalizedParts: number;
  readonly missingJobs: readonly InitialSessionJobKind[];
  readonly statusExists: boolean;
}

type ProcessingRepairAssessment =
  | ProcessingRepairPlan
  | { readonly status: 'complete' }
  | { readonly status: 'blocked'; readonly reason: string };

function initialJobKey(kind: InitialSessionJobKind, sessionId: string): string {
  return kind === 'deliver_audio' ? `deliver-audio:${sessionId}` : `asr:${sessionId}`;
}

function payloadSessionId(payload: string): string | null {
  try {
    const parsed: unknown = JSON.parse(payload);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    const sessionId = (parsed as Record<string, unknown>)['sessionId'];
    return typeof sessionId === 'string' ? sessionId : null;
  } catch {
    return null;
  }
}

function hasDownstreamProof(
  db: DatabaseSync,
  sessionId: string,
  missingJobs: readonly InitialSessionJobKind[],
): boolean {
  const transcript = db
    .prepare('SELECT 1 AS present FROM transcript_revisions WHERE session_id = ? LIMIT 1')
    .get(sessionId);
  if (transcript !== undefined) return true;
  const downstreamJob = db
    .prepare(
      `SELECT 1 AS present
         FROM jobs
        WHERE kind IN ('deliver_transcript','summarize','deliver_report','deliver')
          AND json_valid(payload) = 1
          AND json_extract(payload, '$.sessionId') = ?
        LIMIT 1`,
    )
    .get(sessionId);
  if (downstreamJob !== undefined) return true;

  if (missingJobs.includes('deliver_audio')) {
    const audioProgress = db
      .prepare(
        `SELECT 1 AS present
           FROM audio_parts p
          WHERE p.session_id = ? AND p.delivered = 1
          UNION ALL
         SELECT 1 AS present
           FROM telegram_outbox o
          WHERE o.session_id = ? AND o.kind = 'audio'
          LIMIT 1`,
      )
      .get(sessionId, sessionId);
    if (audioProgress !== undefined) return true;
  }
  return false;
}

/**
 * This repair fills absent initial facts; it never rewrites contradictory ones.
 * With no owned finalized part, a dead/conflicting initial job or later-stage
 * progress, another enqueue could duplicate work or invent recoverable audio,
 * so those sessions remain operator-owned and are logged as blocked.
 */
function assessProcessingRepair(db: DatabaseSync, sessionId: string): ProcessingRepairAssessment {
  const session = db
    .prepare(
      `SELECT state,
              (SELECT count(*)
                 FROM audio_parts p
                WHERE p.session_id = s.session_id
                  AND p.finalized = 1
                  AND p.deleted_at IS NULL) AS finalized_parts
         FROM audio_sessions s
        WHERE s.session_id = ?`,
    )
    .get(sessionId) as { state: string; finalized_parts: number } | undefined;
  if (session === undefined || session.state !== 'PROCESSING') return { status: 'complete' };
  if (session.finalized_parts === 0) {
    return {
      status: 'blocked',
      reason: 'the PROCESSING session has no finalized, undeleted owned audio part',
    };
  }

  const requiredKinds = ['deliver_audio', 'asr'] as const;
  const expectedKeys = new Map(
    requiredKinds.map((kind) => [initialJobKey(kind, sessionId), kind] as const),
  );
  const rows = db
    .prepare(
      `SELECT kind, idempotency_key, payload, state
         FROM jobs
        WHERE idempotency_key IN (?, ?)
           OR (
                kind IN ('deliver_audio','asr')
                AND json_valid(payload) = 1
                AND json_extract(payload, '$.sessionId') = ?
              )`,
    )
    .all(
      initialJobKey('deliver_audio', sessionId),
      initialJobKey('asr', sessionId),
      sessionId,
    ) as unknown as StoredInitialJob[];
  const present = new Set<InitialSessionJobKind>();
  for (const row of rows) {
    const expectedKind = expectedKeys.get(row.idempotency_key);
    if (expectedKind !== undefined) {
      if (
        row.kind !== expectedKind ||
        payloadSessionId(row.payload) !== sessionId ||
        row.state === 'failed' ||
        row.state === 'dead'
      ) {
        return {
          status: 'blocked',
          reason: `required job ${row.idempotency_key} is conflicting, failed or dead`,
        };
      }
      present.add(expectedKind);
    }
  }
  const missingJobs = requiredKinds.filter((kind) => !present.has(kind));
  if (missingJobs.length === 0) return { status: 'complete' };

  for (const row of rows) {
    if (
      (row.kind === 'deliver_audio' || row.kind === 'asr') &&
      payloadSessionId(row.payload) === sessionId &&
      row.idempotency_key !== initialJobKey(row.kind, sessionId)
    ) {
      return {
        status: 'blocked',
        reason: `initial ${row.kind} work exists under conflicting key ${row.idempotency_key}`,
      };
    }
  }
  if (hasDownstreamProof(db, sessionId, missingJobs)) {
    return {
      status: 'blocked',
      reason: 'durable downstream facts already exist for a missing initial job',
    };
  }

  const statusId = `session-status:finalized:${sessionId}`;
  const lifecycleStatus = db
    .prepare(
      `SELECT kind, session_id, payload
         FROM telegram_outbox
        WHERE delivery_part_id = ?`,
    )
    .get(statusId) as { kind: string; session_id: string | null; payload: string } | undefined;
  if (lifecycleStatus !== undefined) {
    let canonicalText = false;
    try {
      const payload = JSON.parse(lifecycleStatus.payload) as Record<string, unknown>;
      canonicalText = payload['type'] === 'text' && typeof payload['text'] === 'string';
    } catch {
      // A conflicting durable status must be repaired by an operator, not overwritten here.
    }
    if (
      lifecycleStatus.kind !== 'status' ||
      lifecycleStatus.session_id !== sessionId ||
      !canonicalText
    ) {
      return { status: 'blocked', reason: `lifecycle status ${statusId} is conflicting` };
    }
  }

  return {
    status: 'repair',
    sessionId,
    finalizedParts: session.finalized_parts,
    missingJobs,
    statusExists: lifecycleStatus !== undefined,
  };
}

function insertMissingProcessingFacts(db: DatabaseSync, plan: ProcessingRepairPlan): void {
  const nowIso = new Date().toISOString();
  const updated = db
    .prepare(
      `UPDATE audio_sessions
          SET part_count = ?, updated_at = ?
        WHERE session_id = ? AND state = 'PROCESSING'`,
    )
    .run(plan.finalizedParts, nowIso, plan.sessionId);
  if (updated.changes !== 1) throw new Error(`PROCESSING session ${plan.sessionId} changed`);

  const jobs = new JobQueue(db);
  for (const kind of plan.missingJobs) {
    const inserted = jobs.enqueue({
      kind,
      idempotencyKey: initialJobKey(kind, plan.sessionId),
      payload: { sessionId: plan.sessionId },
    });
    if (inserted === null) throw new Error(`initial ${kind} job appeared during recovery`);
  }
  if (!plan.statusExists) {
    const inserted = new Outbox(db).enqueue({
      deliveryPartId: `session-status:finalized:${plan.sessionId}`,
      kind: 'status',
      sessionId: plan.sessionId,
      ordinal: -10,
      payload: {
        type: 'text',
        text: '⚠️ Восстановлена локальная очередь завершённой записи — загружаю аудио и расшифровываю локально…',
      },
    });
    if (!inserted) throw new Error('lifecycle status appeared during recovery');
  }
}

function reconcileMissingProcessingJobs(
  db: DatabaseSync,
  logger: Logger,
  repair: boolean,
): string[] {
  const sessions = db
    .prepare("SELECT session_id FROM audio_sessions WHERE state = 'PROCESSING' ORDER BY session_id")
    .all() as { session_id: string }[];
  const candidates: string[] = [];
  for (const session of sessions) {
    const assessment = assessProcessingRepair(db, session.session_id);
    if (assessment.status === 'complete') continue;
    if (assessment.status === 'blocked') {
      logger.error('PROCESSING session initial job recovery is blocked', {
        sessionId: session.session_id,
        reason: assessment.reason,
        action: 'Inspect the durable jobs and session audio before retrying recovery.',
      });
      continue;
    }
    if (!repair) {
      candidates.push(session.session_id);
      continue;
    }

    const repaired = transaction(db, () => {
      const current = assessProcessingRepair(db, session.session_id);
      if (current.status !== 'repair') return current;
      insertMissingProcessingFacts(db, current);
      return current;
    });
    if (repaired.status === 'blocked') {
      logger.error('PROCESSING session changed before initial job recovery', {
        sessionId: session.session_id,
        reason: repaired.reason,
      });
      continue;
    }
    if (repaired.status === 'repair') {
      candidates.push(session.session_id);
      logger.warn('restored missing initial processing jobs', {
        sessionId: session.session_id,
        jobs: repaired.missingJobs,
        finalizedParts: repaired.finalizedParts,
      });
    }
  }
  return candidates;
}

/**
 * Marks sessions a crash left mid-flight.
 *
 * A session still in ACTIVE or FINALIZING at startup cannot be resumed: the
 * audio stream it was consuming is gone. A session provisionally marked
 * audio_finalize_failed is also recoverable when archive reconciliation has
 * since proved that a published part survived. If no part landed the session
 * is FAILED; otherwise it is handed to the normal pipeline so the user still
 * gets whatever was captured.
 */
export function reconcileStalledSessions(
  db: DatabaseSync,
  logger: Logger,
  repair = true,
): string[] {
  const stalled = db
    .prepare(
      `SELECT s.session_id,
              (SELECT count(*) FROM audio_parts p
                WHERE p.session_id = s.session_id AND p.finalized = 1) AS finalized_parts
         FROM audio_sessions s
        WHERE s.state IN ('ACTIVE','FINALIZING')
           OR (
                s.state = 'FAILED'
                AND s.rejection_reason = 'audio_finalize_failed'
                AND EXISTS (
                      SELECT 1 FROM audio_parts recovered
                       WHERE recovered.session_id = s.session_id
                         AND recovered.finalized = 1
                    )
              )`,
    )
    .all() as { session_id: string; finalized_parts: number }[];

  const reconciled: string[] = [];
  const nowIso = new Date().toISOString();

  for (const row of stalled) {
    reconciled.push(row.session_id);
    if (!repair) continue;
    if (row.finalized_parts > 0) {
      // Some audio survived. Send it down the normal path rather than
      // discarding a recording the user may well want.
      transaction(db, () => {
        db.prepare(
          `UPDATE audio_sessions
              SET state = 'PROCESSING', ended_at = COALESCE(ended_at, ?),
                  part_count = ?, rejection_reason = NULL, updated_at = ?
            WHERE session_id = ?`,
        ).run(nowIso, row.finalized_parts, nowIso, row.session_id);
        const jobs = new JobQueue(db);
        jobs.enqueue({
          kind: 'deliver_audio',
          idempotencyKey: `deliver-audio:${row.session_id}`,
          payload: { sessionId: row.session_id },
        });
        jobs.enqueue({
          kind: 'asr',
          idempotencyKey: `asr:${row.session_id}`,
          payload: { sessionId: row.session_id },
        });
        new Outbox(db).enqueue({
          deliveryPartId: `session-status:finalized:${row.session_id}`,
          kind: 'status',
          sessionId: row.session_id,
          ordinal: -10,
          payload: {
            type: 'text',
            text: '⚠️ Запись прервалась, но сохранившиеся части готовы — загружаю аудио и расшифровываю локально…',
          },
        });
      });
      logger.warn('recovered a session interrupted by a crash', {
        sessionId: row.session_id,
        finalizedParts: row.finalized_parts,
      });
      continue;
    }

    db.prepare(
      `UPDATE audio_sessions
          SET state = 'FAILED', rejection_reason = 'interrupted',
              ended_at = COALESCE(ended_at, ?), updated_at = ?
        WHERE session_id = ?`,
    ).run(nowIso, nowIso, row.session_id);
    logger.warn('session was interrupted before any audio was finalized', {
      sessionId: row.session_id,
    });
  }
  return [...reconciled, ...reconcileMissingProcessingJobs(db, logger, repair)];
}

export interface RecoveryOptions {
  /** When false, report what would be removed without touching anything. */
  readonly remove: boolean;
  /** When false, report database reconciliation without changing state or jobs. */
  readonly repair?: boolean;
}

export async function recoverAfterCrash(
  db: DatabaseSync,
  paths: Paths,
  logger: Logger,
  options: RecoveryOptions = { remove: true, repair: true },
): Promise<RecoveryReport> {
  const repair = options.repair ?? true;
  const recoveredPublishedParts = await reconcilePublishedParts(db, logger, repair);
  const orphans = await findOrphanedParts(db, paths, logger);
  const stalledSessions = reconcileStalledSessions(db, logger, repair);

  let removed = 0;
  let freedBytes = 0;
  const preservedPaths = new Set<string>();

  if (options.remove) {
    for (const orphan of orphans) {
      if (SPLIT_ARTIFACT_PATTERN.test(orphan.path)) {
        const ownership = ownedTemporaryAudioPaths(db, logger);
        if (!ownership.certain || ownership.paths.has(resolve(orphan.path))) {
          preservedPaths.add(orphan.path);
          continue;
        }
      }
      try {
        await rm(orphan.path);
        removed += 1;
        freedBytes += orphan.bytes;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw new Error(`could not remove orphaned temp file ${orphan.path}`, { cause: error });
      }
    }
  }

  const confirmedOrphans = orphans.filter((orphan) => !preservedPaths.has(orphan.path));
  if (confirmedOrphans.length > 0) {
    logger.warn('cleaned up after an unclean shutdown', {
      orphanedParts: confirmedOrphans.length,
      removed,
      freedBytes,
    });
  }

  return {
    orphans: confirmedOrphans,
    recoveredPublishedParts,
    removed,
    freedBytes,
    stalledSessions,
    repaired: repair,
  };
}

export function renderRecoveryReport(report: RecoveryReport): string {
  if (
    report.orphans.length === 0 &&
    report.recoveredPublishedParts.length === 0 &&
    report.stalledSessions.length === 0
  ) {
    return 'Nothing to recover: the last shutdown was clean.';
  }

  const lines: string[] = [];
  if (report.recoveredPublishedParts.length > 0) {
    lines.push(
      `${report.recoveredPublishedParts.length} complete archive part(s) ${report.repaired ? 'were restored' : 'need restoration'} in the database.`,
    );
  }
  if (report.orphans.length > 0) {
    lines.push(`${report.orphans.length} unowned temporary artifact(s) found:`);
    for (const orphan of report.orphans) {
      lines.push(`  ${orphan.path}`);
      lines.push(
        `      ${formatBytes(orphan.bytes)}, last written ${orphan.modifiedAt}` +
          (orphan.sessionId === null ? '' : `, session ${orphan.sessionId}`),
      );
    }
    lines.push('');
    lines.push(
      'These are interrupted encoder writes or delivery splits with no live outbox owner.',
      'The source archive is separate and is never removed by this cleanup.',
    );
    if (report.removed > 0) {
      lines.push(`Removed ${report.removed}, freeing ${formatBytes(report.freedBytes)}.`);
    }
  }

  if (report.stalledSessions.length > 0) {
    lines.push('');
    lines.push(
      `${report.stalledSessions.length} session(s) ${report.repaired ? 'were reconciled after interruption' : 'need database reconciliation'}:`,
    );
    for (const id of report.stalledSessions) lines.push(`  ${id}`);
  }

  return lines.join('\n');
}
