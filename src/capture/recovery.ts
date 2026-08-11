import { readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
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

export async function findOrphanedParts(
  db: DatabaseSync,
  paths: Paths,
): Promise<readonly OrphanedPart[]> {
  let entries: string[];
  try {
    entries = await readdir(paths.tempDir);
  } catch {
    return [];
  }

  const orphans: OrphanedPart[] = [];
  const ownedSplitPaths = new Set(
    (
      db
        .prepare(
          "SELECT payload FROM telegram_outbox WHERE state IN ('pending','sending') AND kind = 'audio'",
        )
        .all() as { payload: string }[]
    ).flatMap((row) => {
      try {
        const payload = JSON.parse(row.payload) as { path?: unknown; deleteAfterSend?: unknown };
        return payload.deleteAfterSend === true && typeof payload.path === 'string'
          ? [payload.path]
          : [];
      } catch {
        return [];
      }
    }),
  );
  for (const entry of entries) {
    const path = join(paths.tempDir, entry);
    const partialWrite = entry.endsWith('.part');
    const splitArtifact = /\.split\d{3}\.flac$/.test(entry);
    if (!partialWrite && !splitArtifact) continue;
    if (splitArtifact && ownedSplitPaths.has(path)) continue;

    let info: Awaited<ReturnType<typeof stat>>;
    try {
      info = await stat(path);
    } catch {
      continue;
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
  return reconciled;
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
  const orphans = await findOrphanedParts(db, paths);
  const stalledSessions = reconcileStalledSessions(db, logger, repair);

  let removed = 0;
  let freedBytes = 0;

  if (options.remove) {
    for (const orphan of orphans) {
      try {
        await rm(orphan.path, { force: true });
        removed += 1;
        freedBytes += orphan.bytes;
      } catch (error) {
        logger.warn('could not remove an orphaned temp file', {
          path: orphan.path,
          error: (error as Error).message,
        });
      }
    }
  }

  if (orphans.length > 0) {
    logger.warn('cleaned up after an unclean shutdown', {
      orphanedParts: orphans.length,
      removed,
      freedBytes,
    });
  }

  return {
    orphans,
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
