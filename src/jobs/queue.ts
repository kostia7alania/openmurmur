import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { transaction } from '../database/db.ts';

export type JobKind = 'asr' | 'summarize' | 'deliver' | 'incoming_audio' | 'digest' | 'retention';

export interface Job {
  readonly jobId: string;
  readonly kind: JobKind;
  readonly payload: Record<string, unknown>;
  readonly attempts: number;
  readonly maxAttempts: number;
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
            ORDER BY run_after
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
