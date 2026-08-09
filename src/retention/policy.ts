import { rm } from 'node:fs/promises';
import type { DatabaseSync } from 'node:sqlite';
import type { RetentionConfig } from '../config/schema.ts';

/**
 * Retention.
 *
 * The rule this module exists to enforce: **nothing is deleted unless the
 * database can prove it is safe to delete.** Not "probably delivered", not
 * "looks old" — proven, by a query. If a fact is missing, the file stays.
 *
 * The LLM has no involvement here whatsoever. Eligibility is pure SQL over
 * facts the pipeline recorded, so a model that hallucinates cannot cost a user
 * their recording.
 */

export type DeletionKind =
  | 'session_audio'
  | 'rejected_session_audio'
  | 'incoming_audio'
  | 'quarantine';

export interface DeletionCandidate {
  readonly kind: DeletionKind;
  readonly id: string;
  readonly path: string;
  readonly reason: string;
  readonly bytes: number;
}

export interface RetentionPlan {
  readonly candidates: readonly DeletionCandidate[];
  readonly totalBytes: number;
  /** Files that aged out but are still blocked, with the blocking reason. */
  readonly blocked: readonly { id: string; path: string; reason: string }[];
}

const hoursAgoIso = (hours: number, now: number) => new Date(now - hours * 3_600_000).toISOString();

/**
 * Builds the deletion plan. Read-only: this is exactly what `retention dry-run`
 * prints and exactly what `retention apply` executes, so the preview can never
 * disagree with the action.
 */
export function planRetention(
  db: DatabaseSync,
  config: RetentionConfig,
  now = Date.now(),
): RetentionPlan {
  const candidates: DeletionCandidate[] = [];
  const blocked: { id: string; path: string; reason: string }[] = [];

  // --- Delivered session audio -------------------------------------------
  //
  // Every one of these conditions is a separate way to lose a user's recording
  // if we get it wrong, so each is checked explicitly rather than inferred
  // from the session state alone:
  //   - the session finished processing (state = DONE)
  //   - this part was closed, fsynced and renamed (finalized = 1)
  //   - its checksum was computed (sha256 IS NOT NULL)
  //   - Telegram confirmed this exact part (delivered = 1)
  //   - the transcript exists and was itself delivered
  //   - no job still references the session
  const eligible = db
    .prepare(
      `SELECT p.part_id, p.path, COALESCE(p.bytes, 0) AS bytes, p.session_id
         FROM audio_parts p
         JOIN audio_sessions s ON s.session_id = p.session_id
        WHERE p.deleted_at IS NULL
          AND p.finalized = 1
          AND p.sha256 IS NOT NULL
          AND p.delivered = 1
          AND s.state = 'DONE'
          AND s.ended_at IS NOT NULL
          AND s.ended_at <= ?
          AND EXISTS (
                SELECT 1 FROM transcript_revisions r
                 WHERE r.session_id = s.session_id AND r.is_current = 1
              )
          AND EXISTS (
                SELECT 1 FROM telegram_outbox o
                 WHERE o.session_id = s.session_id AND o.kind = 'transcript' AND o.state = 'sent'
              )
          AND NOT EXISTS (
                SELECT 1 FROM telegram_outbox o
                 WHERE o.session_id = s.session_id AND o.state IN ('pending','sending')
              )
          AND NOT EXISTS (
                SELECT 1 FROM jobs j
                 WHERE j.state IN ('pending','leased')
                   AND j.idempotency_key LIKE '%' || s.session_id
              )`,
    )
    .all(hoursAgoIso(config.sessionAudioHours, now)) as {
    part_id: string;
    path: string;
    bytes: number;
    session_id: string;
  }[];

  for (const row of eligible) {
    candidates.push({
      kind: 'session_audio',
      id: row.part_id,
      path: row.path,
      bytes: row.bytes,
      reason: `delivered and older than ${config.sessionAudioHours}h`,
    });
  }

  // Anything old enough but not eligible: report *why* it is being kept, so a
  // user wondering where their disk went gets an answer instead of silence.
  const held = db
    .prepare(
      `SELECT p.part_id, p.path, s.state, p.finalized, p.delivered, p.sha256
         FROM audio_parts p
         JOIN audio_sessions s ON s.session_id = p.session_id
        WHERE p.deleted_at IS NULL
          AND s.ended_at IS NOT NULL
          AND s.ended_at <= ?
          AND s.state != 'REJECTED'`,
    )
    .all(hoursAgoIso(config.sessionAudioHours, now)) as {
    part_id: string;
    path: string;
    state: string;
    finalized: number;
    delivered: number;
    sha256: string | null;
  }[];

  const eligibleIds = new Set(eligible.map((r) => r.part_id));
  for (const row of held) {
    if (eligibleIds.has(row.part_id)) continue;
    blocked.push({ id: row.part_id, path: row.path, reason: describeBlock(row) });
  }

  // --- Rejected sessions --------------------------------------------------
  // The duration gate rejects before delivery is scheduled. ASR rejection is
  // different: audio delivery was promised and must be proven before deletion.
  const rejected = db
    .prepare(
      `SELECT p.part_id, p.path, COALESCE(p.bytes, 0) AS bytes
         FROM audio_parts p
         JOIN audio_sessions s ON s.session_id = p.session_id
        WHERE p.deleted_at IS NULL
          AND s.state = 'REJECTED'
          AND p.finalized = 1
          AND p.sha256 IS NOT NULL
          AND s.ended_at IS NOT NULL
          AND s.ended_at <= ?
          AND (
                s.rejection_reason = 'insufficient_speech'
                OR (
                     s.rejection_reason IN ('asr_empty','insufficient_words')
                     AND p.delivered = 1
                     AND EXISTS (
                           SELECT 1 FROM telegram_outbox sent_audio
                            WHERE sent_audio.session_id = s.session_id
                              AND sent_audio.kind = 'audio'
                              AND sent_audio.state = 'sent'
                              AND (
                                    sent_audio.delivery_part_id = 'audio:' || p.part_id
                                    OR sent_audio.delivery_part_id LIKE
                                         'audio:' || p.part_id || ':split%'
                                  )
                         )
                     AND EXISTS (
                           SELECT 1 FROM jobs audio_job
                            WHERE audio_job.kind = 'deliver_audio'
                              AND audio_job.idempotency_key =
                                    'deliver-audio:' || s.session_id
                              AND audio_job.state = 'done'
                         )
                   )
              )
          AND NOT EXISTS (
                SELECT 1 FROM telegram_outbox o
                 WHERE o.session_id = s.session_id
                   AND o.kind = 'audio' AND o.state <> 'sent'
              )
          AND NOT EXISTS (
                SELECT 1 FROM jobs j
                 WHERE j.state IN ('pending','leased')
                   AND j.idempotency_key LIKE '%' || s.session_id
              )`,
    )
    .all(hoursAgoIso(config.rejectedSessionHours, now)) as {
    part_id: string;
    path: string;
    bytes: number;
  }[];

  for (const row of rejected) {
    candidates.push({
      kind: 'rejected_session_audio',
      id: row.part_id,
      path: row.path,
      bytes: row.bytes,
      reason: `rejected audio, older than ${config.rejectedSessionHours}h`,
    });
  }

  // --- Incoming Telegram audio -------------------------------------------
  const incoming = db
    .prepare(
      `SELECT file_uid, quarantine_path, normalized_path, COALESCE(actual_bytes, 0) AS bytes
         FROM incoming_telegram_files
        WHERE deleted_at IS NULL
          AND state = 'delivered'
          AND updated_at <= ?
          AND EXISTS (
                SELECT 1 FROM transcript_revisions r WHERE r.incoming_file_id = file_uid
              )`,
    )
    .all(hoursAgoIso(config.incomingAudioHours, now)) as {
    file_uid: string;
    quarantine_path: string | null;
    normalized_path: string | null;
    bytes: number;
  }[];

  for (const row of incoming) {
    for (const path of [row.quarantine_path, row.normalized_path]) {
      if (path === null) continue;
      candidates.push({
        kind: 'incoming_audio',
        id: row.file_uid,
        path,
        bytes: row.bytes,
        reason: `transcribed, older than ${config.incomingAudioHours}h`,
      });
    }
  }

  // --- Failed / quarantined files ----------------------------------------
  const failed = db
    .prepare(
      `SELECT file_uid, quarantine_path, COALESCE(actual_bytes, 0) AS bytes
         FROM incoming_telegram_files
        WHERE deleted_at IS NULL
          AND state IN ('rejected','failed')
          AND quarantine_path IS NOT NULL
          AND updated_at <= ?`,
    )
    .all(hoursAgoIso(config.quarantineHours, now)) as {
    file_uid: string;
    quarantine_path: string;
    bytes: number;
  }[];

  for (const row of failed) {
    candidates.push({
      kind: 'quarantine',
      id: row.file_uid,
      path: row.quarantine_path,
      bytes: row.bytes,
      reason: `rejected, older than ${config.quarantineHours}h`,
    });
  }

  return {
    candidates,
    blocked,
    totalBytes: candidates.reduce((sum, c) => sum + c.bytes, 0),
  };
}

function describeBlock(row: {
  state: string;
  finalized: number;
  delivered: number;
  sha256: string | null;
}): string {
  if (row.finalized !== 1) return 'audio part was never finalized';
  if (row.sha256 === null) return 'checksum not computed';
  if (row.state === 'PROCESSING') return 'ASR has not finished';
  if (row.state === 'DELIVERING') return 'Telegram delivery not confirmed';
  if (row.delivered !== 1) return 'this audio part was not confirmed delivered';
  if (row.state !== 'DONE') return `session is in state ${row.state}`;
  return 'transcript delivery not confirmed';
}

export interface ApplyResult {
  readonly deleted: number;
  readonly freedBytes: number;
  readonly errors: readonly { path: string; error: string }[];
}

/**
 * Executes a plan. The database row is marked deleted only after the unlink
 * succeeds, so a failure leaves the file eligible next run rather than
 * orphaning a record that claims the file is gone.
 */
export async function applyRetention(db: DatabaseSync, plan: RetentionPlan): Promise<ApplyResult> {
  const errors: { path: string; error: string }[] = [];
  let deleted = 0;
  let freedBytes = 0;

  for (const candidate of plan.candidates) {
    try {
      await rm(candidate.path, { force: true });
    } catch (error) {
      errors.push({ path: candidate.path, error: (error as Error).message });
      continue;
    }
    markDeleted(db, candidate);
    deleted += 1;
    freedBytes += candidate.bytes;
  }

  return { deleted, freedBytes, errors };
}

function markDeleted(db: DatabaseSync, candidate: DeletionCandidate): void {
  const nowIso = new Date().toISOString();
  if (candidate.kind === 'session_audio' || candidate.kind === 'rejected_session_audio') {
    db.prepare('UPDATE audio_parts SET deleted_at = ? WHERE part_id = ?').run(nowIso, candidate.id);
    return;
  }
  db.prepare(
    'UPDATE incoming_telegram_files SET deleted_at = ?, updated_at = ? WHERE file_uid = ?',
  ).run(nowIso, nowIso, candidate.id);
}
