import { randomUUID } from 'node:crypto';
import { readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { Paths } from '../config/paths.ts';
import type { Logger } from '../logging/logger.ts';
import { formatBytes } from '../telegram/format.ts';

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
  readonly removed: number;
  readonly freedBytes: number;
  /** Sessions left in a live state by a crash, now marked FAILED. */
  readonly stalledSessions: readonly string[];
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
  for (const entry of entries) {
    if (!entry.endsWith('.part')) continue;
    const path = join(paths.tempDir, entry);

    let info: Awaited<ReturnType<typeof stat>>;
    try {
      info = await stat(path);
    } catch {
      continue;
    }
    if (!info.isFile()) continue;

    const sessionId = sessionIdFromPartFilename(entry);
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
 * audio stream it was consuming is gone. If it produced no finalized part it
 * is FAILED; if some parts did land, it is handed to the normal pipeline so
 * the user still gets whatever was captured.
 */
export function reconcileStalledSessions(db: DatabaseSync, logger: Logger): string[] {
  const stalled = db
    .prepare(
      `SELECT s.session_id,
              (SELECT count(*) FROM audio_parts p
                WHERE p.session_id = s.session_id AND p.finalized = 1) AS finalized_parts
         FROM audio_sessions s
        WHERE s.state IN ('ACTIVE','FINALIZING')`,
    )
    .all() as { session_id: string; finalized_parts: number }[];

  const failed: string[] = [];
  const nowIso = new Date().toISOString();

  for (const row of stalled) {
    if (row.finalized_parts > 0) {
      // Some audio survived. Send it down the normal path rather than
      // discarding a recording the user may well want.
      db.prepare(
        `UPDATE audio_sessions
            SET state = 'PROCESSING', ended_at = COALESCE(ended_at, ?), updated_at = ?
          WHERE session_id = ?`,
      ).run(nowIso, nowIso, row.session_id);
      db.prepare(
        `INSERT INTO jobs (job_id, kind, idempotency_key, payload, run_after, created_at, updated_at)
         VALUES (?, 'asr', ?, ?, ?, ?, ?)
         ON CONFLICT (idempotency_key) DO NOTHING`,
      ).run(
        randomUUID(),
        `asr:${row.session_id}`,
        JSON.stringify({ sessionId: row.session_id }),
        nowIso,
        nowIso,
        nowIso,
      );
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
    failed.push(row.session_id);
    logger.warn('session was interrupted before any audio was finalized', {
      sessionId: row.session_id,
    });
  }
  return failed;
}

export interface RecoveryOptions {
  /** When false, report what would be removed without touching anything. */
  readonly remove: boolean;
}

export async function recoverAfterCrash(
  db: DatabaseSync,
  paths: Paths,
  logger: Logger,
  options: RecoveryOptions = { remove: true },
): Promise<RecoveryReport> {
  const orphans = await findOrphanedParts(db, paths);
  const stalledSessions = reconcileStalledSessions(db, logger);

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

  return { orphans, removed, freedBytes, stalledSessions };
}

export function renderRecoveryReport(report: RecoveryReport): string {
  if (report.orphans.length === 0 && report.stalledSessions.length === 0) {
    return 'Nothing to recover: the last shutdown was clean.';
  }

  const lines: string[] = [];
  if (report.orphans.length > 0) {
    lines.push(`${report.orphans.length} interrupted recording(s) found in the temp directory:`);
    for (const orphan of report.orphans) {
      lines.push(`  ${orphan.path}`);
      lines.push(
        `      ${formatBytes(orphan.bytes)}, last written ${orphan.modifiedAt}` +
          (orphan.sessionId === null ? '' : `, session ${orphan.sessionId}`),
      );
    }
    lines.push('');
    lines.push(
      'These are partial FLAC writes from a crash or power loss. They are not',
      'reliably decodable and nothing in the archive refers to them.',
    );
    if (report.removed > 0) {
      lines.push(`Removed ${report.removed}, freeing ${formatBytes(report.freedBytes)}.`);
    }
  }

  if (report.stalledSessions.length > 0) {
    lines.push('');
    lines.push(
      `${report.stalledSessions.length} session(s) were interrupted before any audio was saved:`,
    );
    for (const id of report.stalledSessions) lines.push(`  ${id}`);
  }

  return lines.join('\n');
}
