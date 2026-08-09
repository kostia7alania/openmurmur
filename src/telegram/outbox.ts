import { randomUUID } from 'node:crypto';
import { rm, stat } from 'node:fs/promises';
import type { DatabaseSync } from 'node:sqlite';
import { transaction } from '../database/db.ts';
import type { Logger } from '../logging/logger.ts';
import { isRetryable, shouldRetryWithoutAttempt, type TelegramClient } from './client.ts';

/**
 * Transactional outbox for every Telegram send.
 *
 * Delivery is at-least-once at the network layer, so each row carries a stable
 * `delivery_part_id`. Enqueueing the same logical message twice — after a crash
 * between "audio uploaded" and "row marked sent", say — is a primary-key
 * conflict rather than a duplicate message.
 */

export type OutboxKind =
  | 'audio'
  | 'transcript'
  | 'report'
  | 'digest'
  | 'status'
  | 'alert'
  | 'incoming_transcript';

export type OutboxPayload =
  | { readonly type: 'text'; readonly text: string; readonly parseMode?: 'HTML' }
  | {
      readonly type: 'document';
      readonly path: string;
      readonly filename: string;
      readonly caption?: string;
      readonly partId?: string;
      /** Ephemeral delivery artifact, safe to remove only after Telegram accepted it. */
      readonly deleteAfterSend?: boolean;
    };

export interface EnqueueMessage {
  readonly deliveryPartId: string;
  readonly kind: OutboxKind;
  readonly sessionId?: string | undefined;
  /** Breaks ties between rows created together; readiness time is the primary order. */
  readonly ordinal: number;
  readonly payload: OutboxPayload;
}

interface OutboxRow {
  outbox_id: string;
  delivery_part_id: string;
  session_id: string | null;
  kind: OutboxKind;
  payload: string;
  attempts: number;
  max_attempts: number;
}

export type OutboxState = 'pending' | 'sending' | 'sent' | 'failed' | 'dead';

const nowIso = () => new Date().toISOString();
const isoIn = (ms: number) => new Date(Date.now() + ms).toISOString();

export class Outbox {
  readonly #db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  /** Returns false when this exact delivery unit was already enqueued. */
  enqueue(message: EnqueueMessage): boolean {
    const ts = nowIso();
    const result = this.#db
      .prepare(
        `INSERT INTO telegram_outbox
           (outbox_id, delivery_part_id, session_id, kind, ordinal, payload,
            run_after, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (delivery_part_id) DO NOTHING`,
      )
      .run(
        randomUUID(),
        message.deliveryPartId,
        message.sessionId ?? null,
        message.kind,
        message.ordinal,
        JSON.stringify(message.payload),
        ts,
        ts,
        ts,
      );
    return result.changes > 0;
  }

  claimNext(): OutboxRow | null {
    return transaction(this.#db, () => {
      const row = this.#db
        .prepare(
          `SELECT outbox_id, delivery_part_id, session_id, kind, payload, attempts, max_attempts
             FROM telegram_outbox
            WHERE state = 'pending' AND run_after <= ?
            ORDER BY created_at, rowid, ordinal
            LIMIT 1`,
        )
        .get(nowIso()) as OutboxRow | undefined;
      if (row === undefined) return null;

      this.#db
        .prepare(
          `UPDATE telegram_outbox SET state = 'sending', attempts = attempts + 1, updated_at = ?
            WHERE outbox_id = ?`,
        )
        .run(nowIso(), row.outbox_id);
      return { ...row, attempts: row.attempts + 1 };
    });
  }

  markSent(outboxId: string, messageId: number | null, afterMark?: () => void): void {
    transaction(this.#db, () => {
      this.#db
        .prepare(
          `UPDATE telegram_outbox SET state = 'sent', telegram_message_id = ?, updated_at = ?
            WHERE outbox_id = ?`,
        )
        .run(messageId, nowIso(), outboxId);
      afterMark?.();
    });
  }

  markFailed(
    outboxId: string,
    error: string,
    attempts: number,
    maxAttempts: number,
  ): 'retry' | 'dead' {
    const exhausted = attempts >= maxAttempts;
    this.#db
      .prepare(
        `UPDATE telegram_outbox SET state = ?, last_error = ?, run_after = ?, updated_at = ?
          WHERE outbox_id = ?`,
      )
      .run(
        exhausted ? 'dead' : 'pending',
        error.slice(0, 2000),
        isoIn(exhausted ? 0 : Math.min(2 ** attempts * 1000, 10 * 60 * 1000)),
        nowIso(),
        outboxId,
      );
    return exhausted ? 'dead' : 'retry';
  }

  /**
   * Returns a row to `pending` without burning an attempt, deferred by
   * `delayMs`. Used for HTTP 429, where Telegram tells us exactly how long to
   * wait and the send was never our fault.
   */
  defer(outboxId: string, delayMs: number, reason: string): void {
    this.#db
      .prepare(
        `UPDATE telegram_outbox
            SET state = 'pending', attempts = MAX(0, attempts - 1), run_after = ?,
                last_error = ?, updated_at = ?
          WHERE outbox_id = ?`,
      )
      .run(isoIn(delayMs), reason.slice(0, 2000), nowIso(), outboxId);
  }

  /** Re-queues rows left in `sending` by a crash. */
  recoverSending(): number {
    const result = this.#db
      .prepare(
        "UPDATE telegram_outbox SET state = 'pending', updated_at = ? WHERE state = 'sending'",
      )
      .run(nowIso());
    return Number(result.changes);
  }

  pendingCount(): number {
    const row = this.#db
      .prepare("SELECT count(*) AS c FROM telegram_outbox WHERE state IN ('pending','sending')")
      .get() as { c: number };
    return row.c;
  }

  deadCount(): number {
    const row = this.#db
      .prepare("SELECT count(*) AS c FROM telegram_outbox WHERE state = 'dead'")
      .get() as { c: number };
    return row.c;
  }

  stateOf(deliveryPartId: string): OutboxState | null {
    const row = this.#db
      .prepare('SELECT state FROM telegram_outbox WHERE delivery_part_id = ?')
      .get(deliveryPartId) as { state: OutboxState } | undefined;
    return row?.state ?? null;
  }

  oldestPendingAgeMinutes(): number {
    const row = this.#db
      .prepare(
        "SELECT MIN(created_at) AS t FROM telegram_outbox WHERE state IN ('pending','sending')",
      )
      .get() as { t: string | null };
    if (row.t === null) return 0;
    return Math.max(0, (Date.now() - Date.parse(row.t)) / 60_000);
  }

  lastDeliveryAt(): string | null {
    const row = this.#db
      .prepare("SELECT MAX(updated_at) AS t FROM telegram_outbox WHERE state = 'sent'")
      .get() as { t: string | null };
    return row.t;
  }

  /** True once every audio row for a session has been confirmed sent. */
  allDelivered(sessionId: string, kind: OutboxKind): boolean {
    const row = this.#db
      .prepare(
        `SELECT count(*) AS total, SUM(state = 'sent') AS sent
           FROM telegram_outbox WHERE session_id = ? AND kind = ?`,
      )
      .get(sessionId, kind) as { total: number; sent: number | null };
    return row.total > 0 && row.sent === row.total;
  }
}

export interface OutboxWorkerDeps {
  readonly outbox: Outbox;
  readonly client: TelegramClient;
  readonly chatId: number;
  readonly logger: Logger;
  readonly maxOutgoingBytes: number;
  readonly onDelivered?: (row: {
    deliveryPartId: string;
    sessionId: string | null;
    payload: OutboxPayload;
  }) => void;
}

/**
 * Drains the outbox once. Returns the number of rows successfully sent.
 *
 * Sends are strictly sequential: Telegram rate-limits per chat, and the report
 * only makes sense after the audio it describes.
 */
export async function drainOutbox(deps: OutboxWorkerDeps, budget = 25): Promise<number> {
  let sent = 0;
  for (let i = 0; i < budget; i += 1) {
    const row = deps.outbox.claimNext();
    if (row === null) break;

    const payload = JSON.parse(row.payload) as OutboxPayload;
    try {
      const messageId = await sendPayload(deps, payload);
      deps.outbox.markSent(row.outbox_id, messageId, () => {
        deps.onDelivered?.({
          deliveryPartId: row.delivery_part_id,
          sessionId: row.session_id,
          payload,
        });
      });
      await cleanupEphemeralPayload(payload, deps.logger);
      sent += 1;
    } catch (error) {
      const err = error as Error & { retryAfterSeconds?: number };
      if (shouldRetryWithoutAttempt(err)) {
        deps.outbox.defer(row.outbox_id, 1000, err.message);
        deps.logger.info('telegram send interrupted; returned to the outbox', {
          kind: row.kind,
          deliveryPartId: row.delivery_part_id,
        });
        break;
      }
      if (!isRetryable(err)) {
        deps.outbox.markFailed(row.outbox_id, err.message, row.max_attempts, row.max_attempts);
        await cleanupEphemeralPayload(payload, deps.logger);
        deps.logger.error('telegram send permanently failed', {
          kind: row.kind,
          deliveryPartId: row.delivery_part_id,
          error: err.message,
        });
        continue;
      }
      // Honour Telegram's own backpressure signal rather than guessing, and
      // stop draining: every further send would hit the same limit.
      if (typeof err.retryAfterSeconds === 'number') {
        deps.outbox.defer(row.outbox_id, err.retryAfterSeconds * 1000, err.message);
        deps.logger.warn('telegram rate limited', {
          retryAfterSeconds: err.retryAfterSeconds,
          kind: row.kind,
        });
        break;
      }
      const outcome = deps.outbox.markFailed(
        row.outbox_id,
        err.message,
        row.attempts,
        row.max_attempts,
      );
      if (outcome === 'dead') await cleanupEphemeralPayload(payload, deps.logger);
      deps.logger.warn('telegram send failed', {
        kind: row.kind,
        outcome,
        attempts: row.attempts,
        error: err.message,
      });
    }
  }
  return sent;
}

async function cleanupEphemeralPayload(payload: OutboxPayload, logger: Logger): Promise<void> {
  if (payload.type !== 'document' || payload.deleteAfterSend !== true) return;
  try {
    await rm(payload.path, { force: true });
  } catch (error) {
    logger.warn('could not remove a finished temporary delivery file', {
      path: payload.path,
      error: (error as Error).message,
    });
  }
}

async function sendPayload(deps: OutboxWorkerDeps, payload: OutboxPayload): Promise<number | null> {
  if (payload.type === 'text') {
    const message = await deps.client.sendMessage(deps.chatId, payload.text, {
      parseMode: payload.parseMode,
    });
    return message.message_id;
  }

  // Size is re-checked against the live file immediately before upload: the
  // recorder may have rotated, and a stale row must not blow the 50 MB limit.
  const info = await stat(payload.path);
  if (info.size > deps.maxOutgoingBytes) {
    throw Object.assign(
      new Error(
        `${payload.filename} is ${info.size} bytes, over the ${deps.maxOutgoingBytes} byte Telegram limit`,
      ),
      { errorCode: 413 },
    );
  }
  const message = await deps.client.sendDocument(deps.chatId, payload.path, {
    filename: payload.filename,
    ...(payload.caption !== undefined
      ? { caption: payload.caption, parseMode: 'HTML' as const }
      : {}),
  });
  return message.message_id;
}
