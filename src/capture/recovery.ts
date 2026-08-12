import { readdir, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { Paths } from '../config/paths.ts';
import { transaction } from '../database/db.ts';
import {
  AudioFinalizationJournalRepository,
  assertStoredSessionTiming,
  recoverPublishedPart,
} from '../database/repository.ts';
import { JobQueue } from '../jobs/queue.ts';
import type { Logger } from '../logging/logger.ts';
import { formatBytes } from '../telegram/format.ts';
import { Outbox } from '../telegram/outbox.ts';
import { proveTemporaryAudioOwnership } from '../telegram/outbox-recovery.ts';
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
  /** Terminal provisional rows proven to have no archive or journal owner. */
  readonly settledMissingParts: readonly string[];
  readonly removed: number;
  readonly freedBytes: number;
  /** Sessions found in a live recorder state after the capture process died. */
  readonly stalledSessions: readonly string[];
  /** Whether database reconciliation was applied rather than only reported. */
  readonly repaired: boolean;
}

interface ProvisionalPartRow {
  readonly part_id: string;
  readonly path: string;
}

function isTerminalMissingProvisionalPart(db: DatabaseSync, row: ProvisionalPartRow): boolean {
  return (
    db
      .prepare(
        `SELECT 1
           FROM audio_parts p
           JOIN audio_sessions s ON s.session_id = p.session_id
          WHERE p.part_id = ?
            AND p.path = ?
            AND p.finalized = 0
            AND p.delivered = 0
            AND p.deleted_at IS NULL
            AND p.ended_at IS NULL
            AND p.duration_ms IS NULL
            AND p.bytes IS NULL
            AND p.sha256 IS NULL
            AND s.state = 'FAILED'
            AND s.rejection_reason = 'audio_finalize_failed'
            AND NOT EXISTS (
                  SELECT 1
                    FROM audio_finalization_journal j
                   WHERE j.part_id = p.part_id
                     AND j.session_id = p.session_id
                )`,
      )
      .get(row.part_id, row.path) !== undefined
  );
}

async function settleMissingProvisionalPart(
  db: DatabaseSync,
  row: ProvisionalPartRow,
  repair: boolean,
): Promise<boolean> {
  if (!isTerminalMissingProvisionalPart(db, row)) return false;

  // The first ENOENT was observed by reconcilePublishedParts. Recheck at the
  // mutation boundary; a terminal FAILED session has no live recorder writer,
  // and the transaction below re-proves the exact DB lineage.
  try {
    const info = await stat(row.path);
    if (!info.isFile()) throw new Error(`published audio path is not a regular file: ${row.path}`);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (!repair) return true;

  return transaction(db, () => {
    if (!isTerminalMissingProvisionalPart(db, row)) return false;
    const updated = db
      .prepare(
        `UPDATE audio_parts
            SET deleted_at = ?
          WHERE part_id = ?
            AND path = ?
            AND finalized = 0
            AND delivered = 0
            AND deleted_at IS NULL
            AND ended_at IS NULL
            AND duration_ms IS NULL
            AND bytes IS NULL
            AND sha256 IS NULL
            AND EXISTS (
                  SELECT 1
                    FROM audio_sessions s
                   WHERE s.session_id = audio_parts.session_id
                     AND s.state = 'FAILED'
                     AND s.rejection_reason = 'audio_finalize_failed'
                )
            AND NOT EXISTS (
                  SELECT 1
                    FROM audio_finalization_journal j
                   WHERE j.part_id = audio_parts.part_id
                     AND j.session_id = audio_parts.session_id
                )`,
      )
      .run(new Date().toISOString(), row.part_id, row.path);
    return updated.changes === 1;
  });
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
): Promise<{
  readonly recoveredPublishedParts: readonly string[];
  readonly settledMissingParts: readonly string[];
}> {
  const rows = db
    .prepare('SELECT part_id, path FROM audio_parts WHERE finalized = 0 AND deleted_at IS NULL')
    .all() as unknown as ProvisionalPartRow[];
  const recovered: string[] = [];
  const settledMissingParts: string[] = [];

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
      const result = recoverPublishedPart(db, row.part_id, info.size, sha256);
      recovered.push(row.part_id);
      logger.warn('recovered an atomically published audio part', {
        partId: row.part_id,
        bytes: info.size,
        timingExact: result.timingExact,
      });
    } catch (error) {
      // A genuinely missing path may be a terminal unpublished part or an
      // interrupted live session. Permission, hashing and other I/O failures
      // are not proof that the archive is absent and must stay loud.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        try {
          if (await settleMissingProvisionalPart(db, row, repair)) {
            settledMissingParts.push(row.part_id);
            if (repair) {
              logger.warn('settled an unpublished terminal audio part', { partId: row.part_id });
            }
          }
        } catch (settlementError) {
          throw new Error(`could not settle missing audio part ${row.part_id}`, {
            cause: settlementError,
          });
        }
        continue;
      }
      throw new Error(`could not reconcile published audio part ${row.part_id}`, { cause: error });
    }
  }
  return { recoveredPublishedParts: recovered, settledMissingParts };
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

function ownedTemporaryAudioPaths(
  db: DatabaseSync,
  paths: Paths,
  logger: Logger,
): TemporaryAudioOwnershipProof {
  let proof: ReturnType<typeof proveTemporaryAudioOwnership>;
  try {
    proof = proveTemporaryAudioOwnership(db, paths);
  } catch (error) {
    logger.error('audio outbox ownership is unreadable; preserving every split artifact', {
      error: (error as Error).message,
      action: 'Repair the outbox database error before rerunning split recovery.',
    });
    return { certain: false, paths: new Set() };
  }
  if (!proof.certain) {
    logger.error('audio outbox ownership is ambiguous; preserving every split artifact', {
      outboxIds: proof.ambiguousOutboxIds,
      action: 'Repair or retire the listed outbox rows before rerunning split recovery.',
    });
    return { certain: false, paths: proof.paths };
  }
  return { certain: true, paths: proof.paths };
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
    ? ownedTemporaryAudioPaths(db, paths, logger)
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

interface StalledSessionRow {
  readonly session_id: string;
  readonly state: string;
  readonly ended_at: string | null;
  readonly duration_ms: number | null;
  readonly speech_ms: number;
  readonly timing_exact: number;
  readonly finalized_parts: number;
}

function stalledSessionRows(db: DatabaseSync): StalledSessionRow[] {
  return db
    .prepare(
      `SELECT s.session_id, s.state, s.ended_at, s.duration_ms, s.speech_ms, s.timing_exact,
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
    .all() as unknown as StalledSessionRow[];
}

/**
 * Durable facts that crash recovery can still turn into jobs or Telegram outbox rows.
 * Credential replacement uses this exact recovery assessment rather than a parallel
 * approximation, so old recordings cannot wake up under a new bot or chat.
 */
export function hasRecoverableTelegramWork(db: DatabaseSync): boolean {
  if (stalledSessionRows(db).some((session) => session.finalized_parts > 0)) return true;

  // FAILED provisional rows remain blocked until recovery either publishes
  // their existing archive or durably tombstones an exact terminal ENOENT.
  const pendingPublication = db
    .prepare(
      `SELECT 1
         FROM audio_parts p
         JOIN audio_sessions s ON s.session_id = p.session_id
        WHERE p.finalized = 0
          AND p.deleted_at IS NULL
          AND (
                s.state IN ('ACTIVE','FINALIZING','PROCESSING')
                OR (s.state = 'FAILED' AND s.rejection_reason = 'audio_finalize_failed')
              )
        LIMIT 1`,
    )
    .get();
  if (pendingPublication !== undefined) return true;

  const processing = db
    .prepare("SELECT session_id FROM audio_sessions WHERE state = 'PROCESSING'")
    .all() as { session_id: string }[];
  return processing.some(
    (session) => assessProcessingRepair(db, session.session_id).status === 'repair',
  );
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
  const stalled = stalledSessionRows(db);

  const reconciled: string[] = [];
  const nowIso = new Date().toISOString();
  const finalizations = new AudioFinalizationJournalRepository(db);

  for (const row of stalled) {
    const exact = finalizations.forSession(row.session_id);
    if (exact !== undefined && row.timing_exact === 1) {
      assertStoredSessionTiming(exact, row);
    }
    reconciled.push(row.session_id);
    if (!repair) continue;
    if (row.finalized_parts > 0) {
      // Some audio survived. Send it down the normal path rather than
      // discarding a recording the user may well want.
      transaction(db, () => {
        if (exact === undefined) {
          db.prepare(
            `UPDATE audio_sessions
                SET state = 'PROCESSING', part_count = ?, rejection_reason = NULL, updated_at = ?
              WHERE session_id = ?`,
          ).run(row.finalized_parts, nowIso, row.session_id);
        } else {
          db.prepare(
            `UPDATE audio_sessions
                SET state = 'PROCESSING', ended_at = ?, duration_ms = ?, speech_ms = ?,
                    timing_exact = 1, part_count = ?, rejection_reason = NULL, updated_at = ?
              WHERE session_id = ?`,
          ).run(
            exact.sessionEndedAtIso,
            exact.sessionDurationMs,
            exact.sessionSpeechMs,
            row.finalized_parts,
            nowIso,
            row.session_id,
          );
        }
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
        if (exact !== undefined) {
          finalizations.consumeSession(row.session_id, {
            endedAtIso: exact.sessionEndedAtIso as string,
            durationMs: exact.sessionDurationMs as number,
            speechMs: exact.sessionSpeechMs as number,
          });
        }
        finalizations.deleteSession(row.session_id);
      });
      logger.warn('recovered a session interrupted by a crash', {
        sessionId: row.session_id,
        finalizedParts: row.finalized_parts,
      });
      continue;
    }

    transaction(db, () => {
      if (exact === undefined) {
        db.prepare(
          `UPDATE audio_sessions
              SET state = 'FAILED', rejection_reason = 'interrupted', updated_at = ?
            WHERE session_id = ?`,
        ).run(nowIso, row.session_id);
      } else {
        db.prepare(
          `UPDATE audio_sessions
              SET state = 'FAILED', rejection_reason = 'interrupted', ended_at = ?,
                  duration_ms = ?, speech_ms = ?, timing_exact = 1, updated_at = ?
            WHERE session_id = ?`,
        ).run(
          exact.sessionEndedAtIso,
          exact.sessionDurationMs,
          exact.sessionSpeechMs,
          nowIso,
          row.session_id,
        );
      }
      if (exact !== undefined) {
        finalizations.consumeSession(row.session_id, {
          endedAtIso: exact.sessionEndedAtIso as string,
          durationMs: exact.sessionDurationMs as number,
          speechMs: exact.sessionSpeechMs as number,
        });
      }
      finalizations.deleteSession(row.session_id);
    });
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
  const { recoveredPublishedParts, settledMissingParts } = await reconcilePublishedParts(
    db,
    logger,
    repair,
  );
  const orphans = await findOrphanedParts(db, paths, logger);
  const stalledSessions = reconcileStalledSessions(db, logger, repair);

  let removed = 0;
  let freedBytes = 0;
  const preservedPaths = new Set<string>();

  if (options.remove) {
    for (const orphan of orphans) {
      if (SPLIT_ARTIFACT_PATTERN.test(orphan.path)) {
        const ownership = ownedTemporaryAudioPaths(db, paths, logger);
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
    settledMissingParts,
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
    report.settledMissingParts.length === 0 &&
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
  if (report.settledMissingParts.length > 0) {
    lines.push(
      `${report.settledMissingParts.length} unpublished terminal audio part(s) ${report.repaired ? 'were marked unavailable' : 'need database reconciliation'}.`,
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
