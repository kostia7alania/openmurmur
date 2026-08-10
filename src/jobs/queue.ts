import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { transaction } from '../database/db.ts';

export type JobKind =
  | 'deliver_audio'
  | 'asr'
  | 'deliver_transcript'
  | 'summarize'
  | 'deliver_report'
  /** Kept so jobs created by releases before the staged delivery pipeline still drain. */
  | 'deliver'
  | 'incoming_audio'
  | 'digest'
  | 'retention';

const DAEMON_JOB_KINDS: ReadonlySet<JobKind> = new Set([
  'deliver_audio',
  'asr',
  'deliver_transcript',
  'summarize',
  'deliver_report',
  'deliver',
  'incoming_audio',
]);

export function canRetryDeadJob(kind: JobKind): boolean {
  return DAEMON_JOB_KINDS.has(kind);
}

export type RetryDeadOutcome = 'requeued' | 'not_found' | 'unsupported';

export interface Job {
  readonly jobId: string;
  readonly kind: JobKind;
  readonly payload: Record<string, unknown>;
  readonly attempts: number;
  readonly maxAttempts: number;
}

export interface DeadJob {
  readonly jobId: string;
  readonly kind: JobKind;
  readonly idempotencyKey: string;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly updatedAt: string;
  readonly lastError: string | null;
}

export interface EnqueueOptions {
  readonly kind: JobKind;
  /**
   * Natural key for this unit of work, e.g. `asr:<sessionId>`. Enqueueing the
   * same key twice is a no-op, which is what makes the whole pipeline safe to
   * re-drive after a crash.
   */
  readonly idempotencyKey: string;
  readonly payload: Record<string, unknown>;
  readonly maxAttempts?: number;
  readonly runAfterMs?: number;
}

const nowIso = () => new Date().toISOString();
const isoIn = (ms: number) => new Date(Date.now() + ms).toISOString();

/** Exponential backoff with a ceiling, so a broken model does not hot-loop. */
export function backoffMs(attempts: number): number {
  return Math.min(2 ** attempts * 1000, 15 * 60 * 1000);
}

export class JobQueue {
  readonly #db: DatabaseSync;
  readonly #owner: string;
  constructor(db: DatabaseSync, owner: string = `${process.pid}`) {
    this.#db = db;
    this.#owner = owner;
  }

  /** Returns the job id, or null when an identical job already exists. */
  enqueue(options: EnqueueOptions): string | null {
    const jobId = randomUUID();
    const ts = nowIso();
    const result = this.#db
      .prepare(
        `INSERT INTO jobs (job_id, kind, idempotency_key, payload, max_attempts,
                           run_after, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (idempotency_key) DO NOTHING`,
      )
      .run(
        jobId,
        options.kind,
        options.idempotencyKey,
        JSON.stringify(options.payload),
        options.maxAttempts ?? 5,
        isoIn(options.runAfterMs ?? 0),
        ts,
        ts,
      );
    return result.changes > 0 ? jobId : null;
  }

  /**
   * Atomically claims the next runnable job of any of `kinds`, taking a lease.
   * A worker that dies without releasing its lease loses the job back to the
   * pool once `leaseMs` elapses — see `recoverStaleLeases`.
   */
  claim(kinds: readonly JobKind[], leaseMs = 10 * 60 * 1000): Job | null {
    if (kinds.length === 0) return null;
    const placeholders = kinds.map(() => '?').join(',');

    return transaction(this.#db, () => {
      const row = this.#db
        .prepare(
          `SELECT job_id, kind, payload, attempts, max_attempts
             FROM jobs
            WHERE state = 'pending' AND run_after <= ? AND kind IN (${placeholders})
            ORDER BY CASE kind
                       WHEN 'deliver_audio' THEN 0
                       WHEN 'deliver_transcript' THEN 1
                       WHEN 'asr' THEN 2
                       WHEN 'incoming_audio' THEN 2
                       WHEN 'summarize' THEN 3
                       WHEN 'deliver_report' THEN 4
                       ELSE 5
                     END,
                     run_after,
                     created_at
            LIMIT 1`,
        )
        .get(nowIso(), ...kinds) as
        | {
            job_id: string;
            kind: JobKind;
            payload: string;
            attempts: number;
            max_attempts: number;
          }
        | undefined;
      if (row === undefined) return null;

      this.#db
        .prepare(
          `UPDATE jobs
              SET state = 'leased', lease_owner = ?, lease_expires_at = ?,
                  attempts = attempts + 1, updated_at = ?
            WHERE job_id = ?`,
        )
        .run(this.#owner, isoIn(leaseMs), nowIso(), row.job_id);

      return {
        jobId: row.job_id,
        kind: row.kind,
        payload: JSON.parse(row.payload) as Record<string, unknown>,
        attempts: row.attempts + 1,
        maxAttempts: row.max_attempts,
      };
    });
  }

  complete(jobId: string): void {
    this.#db
      .prepare(
        `UPDATE jobs SET state = 'done', lease_owner = NULL, lease_expires_at = NULL,
                         updated_at = ? WHERE job_id = ?`,
      )
      .run(nowIso(), jobId);
  }

  /**
   * Records a failure. The job returns to `pending` with backoff until it has
   * burned its attempts, then becomes `dead` so an operator can see it rather
   * than it silently vanishing.
   */
  fail(jobId: string, error: string): 'retry' | 'dead' {
    return transaction(this.#db, () => {
      const row = this.#db
        .prepare('SELECT attempts, max_attempts FROM jobs WHERE job_id = ?')
        .get(jobId) as { attempts: number; max_attempts: number } | undefined;
      if (row === undefined) return 'dead';

      const exhausted = row.attempts >= row.max_attempts;
      this.#db
        .prepare(
          `UPDATE jobs
              SET state = ?, last_error = ?, run_after = ?, lease_owner = NULL,
                  lease_expires_at = NULL, updated_at = ?
            WHERE job_id = ?`,
        )
        .run(
          exhausted ? 'dead' : 'pending',
          error.slice(0, 2000),
          isoIn(exhausted ? 0 : backoffMs(row.attempts)),
          nowIso(),
          jobId,
        );
      return exhausted ? 'dead' : 'retry';
    });
  }

  /** Returns leases to the pool after a crash. Called at daemon start and periodically. */
  recoverStaleLeases(): number {
    const result = this.#db
      .prepare(
        `UPDATE jobs
            SET state = 'pending', lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
          WHERE state = 'leased' AND lease_expires_at <= ?`,
      )
      .run(nowIso(), nowIso());
    return Number(result.changes);
  }

  pendingCount(kind?: JobKind): number {
    const row =
      kind === undefined
        ? (this.#db
            .prepare("SELECT count(*) AS c FROM jobs WHERE state IN ('pending','leased')")
            .get() as { c: number })
        : (this.#db
            .prepare(
              "SELECT count(*) AS c FROM jobs WHERE state IN ('pending','leased') AND kind = ?",
            )
            .get(kind) as { c: number });
    return row.c;
  }

  deadCount(): number {
    const row = this.#db.prepare("SELECT count(*) AS c FROM jobs WHERE state = 'dead'").get() as {
      c: number;
    };
    return row.c;
  }

  deadJobs(): readonly DeadJob[] {
    const rows = this.#db
      .prepare(
        `SELECT job_id, kind, idempotency_key, attempts, max_attempts, updated_at, last_error
           FROM jobs
          WHERE state = 'dead'
          ORDER BY updated_at DESC, job_id`,
      )
      .all() as unknown as {
      job_id: string;
      kind: JobKind;
      idempotency_key: string;
      attempts: number;
      max_attempts: number;
      updated_at: string;
      last_error: string | null;
    }[];
    return rows.map((row) => ({
      jobId: row.job_id,
      kind: row.kind,
      idempotencyKey: row.idempotency_key,
      attempts: row.attempts,
      maxAttempts: row.max_attempts,
      updatedAt: row.updated_at,
      lastError: row.last_error,
    }));
  }

  /** Re-drives one explicitly selected exhausted job after its cause was fixed. */
  retryDead(jobId: string): RetryDeadOutcome {
    return transaction(this.#db, () => {
      const row = this.#db
        .prepare("SELECT kind, payload FROM jobs WHERE job_id = ? AND state = 'dead'")
        .get(jobId) as { kind: JobKind; payload: string } | undefined;
      if (row === undefined) return 'not_found';
      if (!canRetryDeadJob(row.kind)) return 'unsupported';

      if (row.kind === 'asr') {
        const payload = JSON.parse(row.payload) as Record<string, unknown>;
        const sessionId = payload['sessionId'];
        if (typeof sessionId === 'string') {
          this.#db
            .prepare(
              `UPDATE audio_sessions
                  SET state = 'PROCESSING', rejection_reason = NULL, updated_at = ?
                WHERE session_id = ? AND state = 'FAILED' AND rejection_reason = 'asr_failed'`,
            )
            .run(nowIso(), sessionId);
          this.#db
            .prepare(
              `UPDATE telegram_outbox
                  SET state = 'failed', last_error = ?, updated_at = ?
                WHERE delivery_part_id = ? AND state = 'pending'`,
            )
            .run(
              'superseded by a manual ASR retry',
              nowIso(),
              `session-status:asr-failed:${sessionId}`,
            );
        }
      }

      const result = this.#db
        .prepare(
          `UPDATE jobs
              SET state = 'pending', attempts = 0, run_after = ?, lease_owner = NULL,
                  lease_expires_at = NULL, updated_at = ?
            WHERE job_id = ? AND state = 'dead'`,
        )
        .run(nowIso(), nowIso(), jobId);
      return result.changes > 0 ? 'requeued' : 'not_found';
    });
  }

  /** Age in minutes of the oldest unfinished job, or 0 when the queue is clear. */
  oldestPendingAgeMinutes(kind?: JobKind): number {
    const sql =
      kind === undefined
        ? "SELECT MIN(created_at) AS t FROM jobs WHERE state IN ('pending','leased')"
        : "SELECT MIN(created_at) AS t FROM jobs WHERE state IN ('pending','leased') AND kind = ?";
    const row = (
      kind === undefined ? this.#db.prepare(sql).get() : this.#db.prepare(sql).get(kind)
    ) as { t: string | null };
    if (row.t === null) return 0;
    return Math.max(0, (Date.now() - Date.parse(row.t)) / 60_000);
  }
}
