import { rmSync } from 'node:fs';
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

interface RetentionCutoffs {
  readonly sessionAudio: string;
  readonly rejectedSession: string;
  readonly incomingAudio: string;
  readonly quarantine: string;
}

interface RetentionPlanProof {
  readonly db: DatabaseSync;
  readonly config: RetentionConfig;
  readonly now: number;
}

const retentionPlanProofs = new WeakMap<RetentionPlan, RetentionPlanProof>();

function cutoffsFor(config: RetentionConfig, now: number): RetentionCutoffs {
  return {
    sessionAudio: hoursAgoIso(config.sessionAudioHours, now),
    rejectedSession: hoursAgoIso(config.rejectedSessionHours, now),
    incomingAudio: hoursAgoIso(config.incomingAudioHours, now),
    quarantine: hoursAgoIso(config.quarantineHours, now),
  };
}

interface RetentionScope {
  readonly kind: DeletionKind;
  readonly id: string;
}

interface RetentionLanePlan {
  readonly candidates: readonly DeletionCandidate[];
  readonly blocked: RetentionPlan['blocked'];
}

const NO_RECOVERABLE_INCOMING_JOB = `AND NOT EXISTS (
  SELECT 1 FROM jobs j
   WHERE j.state IN ('pending','leased','dead')
     AND j.kind = 'incoming_audio'
     AND CASE
           WHEN json_valid(j.payload) = 0 THEN 1
           WHEN json_type(j.payload, '$') <> 'object' THEN 1
           WHEN COALESCE(json_type(j.payload, '$.fileUid'), 'missing') <> 'text' THEN 1
           WHEN length(trim(json_extract(j.payload, '$.fileUid'))) = 0 THEN 1
           ELSE json_extract(j.payload, '$.fileUid') = incoming_telegram_files.file_uid
         END
)`;

function planSessionAudio(
  db: DatabaseSync,
  config: RetentionConfig,
  cutoff: string,
  partId?: string,
): RetentionLanePlan {
  const exactPart = partId === undefined ? '' : 'AND p.part_id = ?';
  const partArgs = partId === undefined ? [] : [partId];
  const eligible = db
    .prepare(
      `SELECT p.part_id, p.path, COALESCE(p.bytes, 0) AS bytes
         FROM audio_parts p
         JOIN audio_sessions s ON s.session_id = p.session_id
        WHERE p.deleted_at IS NULL
          AND p.finalized = 1
          AND p.sha256 IS NOT NULL
          AND p.delivered = 1
          AND p.delivered_at IS NOT NULL
          AND p.delivered_at <= ?
          AND s.state = 'DONE'
          AND s.ended_at IS NOT NULL
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
              )
          ${exactPart}`,
    )
    .all(cutoff, ...partArgs) as { part_id: string; path: string; bytes: number }[];
  const candidates = eligible.map((row) => ({
    kind: 'session_audio' as const,
    id: row.part_id,
    path: row.path,
    bytes: row.bytes,
    reason: `delivery confirmed more than ${config.sessionAudioHours}h ago`,
  }));

  const held = db
    .prepare(
      `SELECT p.part_id, p.path, s.state, p.finalized, p.delivered, p.delivered_at, p.sha256,
              CASE WHEN p.delivered_at IS NOT NULL AND p.delivered_at <= ? THEN 1 ELSE 0 END
                AS delivery_window_elapsed
         FROM audio_parts p
         JOIN audio_sessions s ON s.session_id = p.session_id
        WHERE p.deleted_at IS NULL
          AND s.ended_at IS NOT NULL
          AND s.ended_at <= ?
          AND s.state != 'REJECTED'
          ${exactPart}`,
    )
    .all(cutoff, cutoff, ...partArgs) as {
    part_id: string;
    path: string;
    state: string;
    finalized: number;
    delivered: number;
    delivered_at: string | null;
    delivery_window_elapsed: number;
    sha256: string | null;
  }[];
  const eligibleIds = new Set(eligible.map((row) => row.part_id));
  const blocked = held
    .filter((row) => !eligibleIds.has(row.part_id))
    .map((row) => ({ id: row.part_id, path: row.path, reason: describeBlock(row) }));
  return { candidates, blocked };
}

function planRejectedSessionAudio(
  db: DatabaseSync,
  config: RetentionConfig,
  cutoffs: RetentionCutoffs,
  partId?: string,
): RetentionLanePlan {
  const exactPart = partId === undefined ? '' : 'AND p.part_id = ?';
  const partArgs = partId === undefined ? [] : [partId];
  const rows = db
    .prepare(
      `SELECT p.part_id, p.path, COALESCE(p.bytes, 0) AS bytes, s.rejection_reason
         FROM audio_parts p
         JOIN audio_sessions s ON s.session_id = p.session_id
        WHERE p.deleted_at IS NULL
          AND s.state = 'REJECTED'
          AND p.finalized = 1
          AND p.sha256 IS NOT NULL
          AND (
                (
                  s.rejection_reason = 'insufficient_speech'
                  AND s.ended_at IS NOT NULL
                  AND s.ended_at <= ?
                )
                OR (
                     s.rejection_reason IN ('asr_empty','insufficient_words')
                     AND p.delivered = 1
                     AND p.delivered_at IS NOT NULL
                     AND p.delivered_at <= ?
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
              )
          ${exactPart}`,
    )
    .all(cutoffs.rejectedSession, cutoffs.sessionAudio, ...partArgs) as {
    part_id: string;
    path: string;
    bytes: number;
    rejection_reason: string;
  }[];
  return {
    candidates: rows.map((row) => ({
      kind: 'rejected_session_audio',
      id: row.part_id,
      path: row.path,
      bytes: row.bytes,
      reason:
        row.rejection_reason === 'insufficient_speech'
          ? `rejected before delivery and older than ${config.rejectedSessionHours}h`
          : `delivered rejected audio and older than ${config.sessionAudioHours}h after delivery`,
    })),
    blocked: [],
  };
}

function planIncomingAudio(
  db: DatabaseSync,
  config: RetentionConfig,
  cutoff: string,
  fileUid?: string,
): RetentionLanePlan {
  const exactFile = fileUid === undefined ? '' : 'AND file_uid = ?';
  const fileArgs = fileUid === undefined ? [] : [fileUid];
  const rows = db
    .prepare(
      `SELECT file_uid, quarantine_path, normalized_path, COALESCE(actual_bytes, 0) AS bytes
         FROM incoming_telegram_files
        WHERE deleted_at IS NULL
          AND state = 'delivered'
          AND delivered_at IS NOT NULL
          AND delivered_at <= ?
          AND EXISTS (
                SELECT 1 FROM transcript_revisions r WHERE r.incoming_file_id = file_uid
              )
          ${NO_RECOVERABLE_INCOMING_JOB}
          AND NOT EXISTS (
                SELECT 1 FROM telegram_outbox o
                 WHERE o.state IN ('pending','sending')
                   AND o.delivery_part_id LIKE
                         'incoming:' || incoming_telegram_files.file_uid || ':%'
              )
          ${exactFile}`,
    )
    .all(cutoff, ...fileArgs) as {
    file_uid: string;
    quarantine_path: string | null;
    normalized_path: string | null;
    bytes: number;
  }[];
  const candidates: DeletionCandidate[] = [];
  for (const row of rows) {
    for (const path of [row.quarantine_path, row.normalized_path]) {
      if (path === null) continue;
      candidates.push({
        kind: 'incoming_audio',
        id: row.file_uid,
        path,
        bytes: row.bytes,
        reason: `transcript delivered, older than ${config.incomingAudioHours}h after delivery`,
      });
    }
  }
  return { candidates, blocked: [] };
}

function planQuarantine(
  db: DatabaseSync,
  config: RetentionConfig,
  cutoff: string,
  fileUid?: string,
): RetentionLanePlan {
  const exactFile = fileUid === undefined ? '' : 'AND file_uid = ?';
  const fileArgs = fileUid === undefined ? [] : [fileUid];
  const rows = db
    .prepare(
      `SELECT file_uid, quarantine_path, normalized_path, COALESCE(actual_bytes, 0) AS bytes
         FROM incoming_telegram_files
        WHERE deleted_at IS NULL
          AND state IN ('rejected','failed')
          AND quarantine_path IS NOT NULL
          AND updated_at <= ?
          ${NO_RECOVERABLE_INCOMING_JOB}
          ${exactFile}`,
    )
    .all(cutoff, ...fileArgs) as {
    file_uid: string;
    quarantine_path: string;
    normalized_path: string | null;
    bytes: number;
  }[];
  const candidates: DeletionCandidate[] = [];
  for (const row of rows) {
    for (const path of [row.quarantine_path, row.normalized_path]) {
      if (path === null) continue;
      candidates.push({
        kind: 'quarantine',
        id: row.file_uid,
        path,
        bytes: row.bytes,
        reason: `rejected, older than ${config.quarantineHours}h`,
      });
    }
  }
  return {
    candidates,
    blocked: [],
  };
}

function planScopedLane(
  db: DatabaseSync,
  config: RetentionConfig,
  cutoffs: RetentionCutoffs,
  scope: RetentionScope,
): RetentionLanePlan {
  switch (scope.kind) {
    case 'session_audio':
      return planSessionAudio(db, config, cutoffs.sessionAudio, scope.id);
    case 'rejected_session_audio':
      return planRejectedSessionAudio(db, config, cutoffs, scope.id);
    case 'incoming_audio':
      return planIncomingAudio(db, config, cutoffs.incomingAudio, scope.id);
    case 'quarantine':
      return planQuarantine(db, config, cutoffs.quarantine, scope.id);
  }
}

function planRetentionScoped(
  db: DatabaseSync,
  config: RetentionConfig,
  now: number,
  scope?: RetentionScope,
): RetentionPlan {
  const cutoffs = cutoffsFor(config, now);
  const lanes =
    scope === undefined
      ? [
          planSessionAudio(db, config, cutoffs.sessionAudio),
          planRejectedSessionAudio(db, config, cutoffs),
          planIncomingAudio(db, config, cutoffs.incomingAudio),
          planQuarantine(db, config, cutoffs.quarantine),
        ]
      : [planScopedLane(db, config, cutoffs, scope)];
  const candidates = lanes.flatMap((lane) => lane.candidates);
  return {
    candidates,
    blocked: lanes.flatMap((lane) => lane.blocked),
    totalBytes: candidates.reduce((sum, candidate) => sum + candidate.bytes, 0),
  };
}

/**
 * Builds the deletion plan. Read-only: `retention apply` treats this preview as
 * an upper bound and reruns the same SQL for each logical candidate under a
 * write lock. The private proof is tied to this object and connection, so a
 * copied or reconstructed plan fails closed.
 */
export function planRetention(
  db: DatabaseSync,
  config: RetentionConfig,
  now = Date.now(),
): RetentionPlan {
  const plan = planRetentionScoped(db, config, now);
  retentionPlanProofs.set(plan, { db, config: { ...config }, now });
  return plan;
}

function describeBlock(row: {
  state: string;
  finalized: number;
  delivered: number;
  delivered_at: string | null;
  delivery_window_elapsed: number;
  sha256: string | null;
}): string {
  if (row.finalized !== 1) return 'audio part was never finalized';
  if (row.sha256 === null) return 'checksum not computed';
  if (row.state === 'PROCESSING') return 'ASR has not finished';
  if (row.state === 'DELIVERING') return 'Telegram delivery not confirmed';
  if (row.delivered !== 1) return 'this audio part was not confirmed delivered';
  if (row.delivered_at === null) return 'exact audio delivery time is not proven';
  if (row.state !== 'DONE') return `session is in state ${row.state}`;
  if (row.delivery_window_elapsed !== 1) {
    return 'retention window after confirmed audio delivery has not elapsed';
  }
  return 'transcript delivery not confirmed';
}

export interface ApplyResult {
  readonly deleted: number;
  readonly freedBytes: number;
  readonly errors: readonly { path: string; error: string }[];
}

function groupCandidates(
  candidates: readonly DeletionCandidate[],
): readonly (readonly DeletionCandidate[])[] {
  const groups = new Map<string, DeletionCandidate[]>();
  for (const candidate of candidates) {
    const key = JSON.stringify([candidate.kind, candidate.id]);
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [candidate]);
    else group.push(candidate);
  }
  return [...groups.values()];
}

function sameCandidateGroup(
  planned: readonly DeletionCandidate[],
  current: readonly DeletionCandidate[],
): boolean {
  if (planned.length !== current.length) return false;
  const byPath = (a: DeletionCandidate, b: DeletionCandidate) => a.path.localeCompare(b.path);
  const plannedSorted = [...planned].sort(byPath);
  const currentSorted = [...current].sort(byPath);
  return plannedSorted.every((candidate, index) => {
    const other = currentSorted[index];
    return (
      other !== undefined &&
      candidate.kind === other.kind &&
      candidate.id === other.id &&
      candidate.path === other.path &&
      candidate.bytes === other.bytes &&
      candidate.reason === other.reason
    );
  });
}

function groupStillEligible(
  db: DatabaseSync,
  group: readonly DeletionCandidate[],
  proof: RetentionPlanProof,
): boolean {
  const first = group[0];
  if (
    first === undefined ||
    group.some((candidate) => candidate.kind !== first.kind || candidate.id !== first.id)
  ) {
    return false;
  }
  const current = planRetentionScoped(db, proof.config, proof.now, {
    kind: first.kind,
    id: first.id,
  });
  return sameCandidateGroup(group, current.candidates);
}

const STALE_PLAN_ERROR =
  'retention plan became stale after database facts changed; rerun retention dry-run';

type GroupApplyOutcome =
  | { readonly kind: 'deleted'; readonly bytes: number }
  | { readonly kind: 'group_stale' }
  | { readonly kind: 'error'; readonly path: string; readonly error: string };

function rollback(db: DatabaseSync): void {
  try {
    db.exec('ROLLBACK');
  } catch {}
}

function applyCandidateGroup(
  db: DatabaseSync,
  group: readonly DeletionCandidate[],
  proof: RetentionPlanProof,
): GroupApplyOutcome {
  let transactionOpen = false;
  let activePath = group[0]?.path ?? '';
  try {
    db.exec('BEGIN IMMEDIATE');
    transactionOpen = true;

    if (!groupStillEligible(db, group, proof)) {
      rollback(db);
      return { kind: 'group_stale' };
    }

    // DatabaseSync is shared by the daemon. Do not yield while its transaction
    // is open or an unrelated callback could accidentally join this COMMIT.
    // The synchronous section is bounded to this group's one or two paths.
    for (const candidate of group) {
      activePath = candidate.path;
      rmSync(candidate.path, { force: true });
    }
    const first = group[0];
    if (first === undefined) throw new Error('empty retention candidate group');
    markDeleted(db, first);
    db.exec('COMMIT');
    transactionOpen = false;
    return {
      kind: 'deleted',
      bytes: group.reduce((sum, candidate) => sum + candidate.bytes, 0),
    };
  } catch (error) {
    if (transactionOpen) rollback(db);
    return { kind: 'error', path: activePath, error: (error as Error).message };
  }
}

function staleErrors(candidates: readonly DeletionCandidate[]) {
  return candidates.map((candidate) => ({ path: candidate.path, error: STALE_PLAN_ERROR }));
}

/**
 * Executes a plan. Every logical candidate is revalidated under BEGIN
 * IMMEDIATE, then at most two explicit incoming paths are unlinked while that
 * write lock is held. There are no directory scans or hashes in the lock.
 * The row is marked deleted only after every path in its group is gone, so an
 * unlink failure leaves the database eligible for a safe retry.
 */
export async function applyRetention(db: DatabaseSync, plan: RetentionPlan): Promise<ApplyResult> {
  const errors: { path: string; error: string }[] = [];
  let deleted = 0;
  let freedBytes = 0;
  const groups = groupCandidates(plan.candidates);
  const proof = retentionPlanProofs.get(plan);
  if (proof === undefined || proof.db !== db) {
    return { deleted, freedBytes, errors: staleErrors(plan.candidates) };
  }

  for (let index = 0; index < groups.length; index += 1) {
    const group = groups[index] ?? [];
    const outcome = applyCandidateGroup(db, group, proof);
    if (outcome.kind === 'deleted') {
      deleted += group.length;
      freedBytes += outcome.bytes;
    } else if (outcome.kind === 'group_stale') {
      errors.push(...staleErrors(group));
    } else {
      errors.push({ path: outcome.path, error: outcome.error });
    }
    if (index + 1 < groups.length) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
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
