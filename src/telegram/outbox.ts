import { randomUUID } from 'node:crypto';
import { rm, stat } from 'node:fs/promises';
import type { DatabaseSync } from 'node:sqlite';
import { transaction } from '../database/db.ts';
import type { Logger } from '../logging/logger.ts';
import {
  isClientShutdown,
  isRetryable,
  shouldRetryWithoutAttempt,
  type TelegramApiError,
  type TelegramClient,
  type TelegramInlineKeyboardMarkup,
} from './client.ts';

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
  | {
      readonly type: 'text';
      readonly text: string;
      readonly parseMode?: 'HTML';
      readonly replyMarkup?: TelegramInlineKeyboardMarkup;
    }
  | {
      readonly type: 'document';
      readonly path: string;
      readonly filename: string;
      readonly caption?: string;
      readonly partId?: string;
      readonly replyMarkup?: TelegramInlineKeyboardMarkup;
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

export interface ClaimedOutboxRow {
  readonly outbox_id: string;
  readonly delivery_part_id: string;
  readonly session_id: string | null;
  readonly kind: OutboxKind;
  readonly payload: string;
  readonly attempts: number;
  readonly max_attempts: number;
  /** Monotonic token fencing this claim after any recovery and reclaim. */
  readonly claim_generation: number;
}

export type OutboxFailureOutcome = 'retry' | 'dead' | 'lost';
export type OutboxSentOutcome = 'sent' | 'lost';
export type OutboxDeferOutcome = 'deferred' | 'lost';

export type OutboxState = 'pending' | 'sending' | 'sent' | 'failed' | 'dead';

const nowIso = () => new Date().toISOString();
const isoIn = (ms: number) => new Date(Date.now() + ms).toISOString();
const MAX_RETRY_DELAY_MS = 10 * 60 * 1000;

function retryDelayMs(attempts: number, outboxId: string, claimGeneration: number): number {
  const base = Math.min(2 ** attempts * 1000, Math.floor(MAX_RETRY_DELAY_MS / 1.1));
  const maxJitter = Math.floor(base / 10);
  let hash = 2_166_136_261;
  for (const character of `${outboxId}:${claimGeneration}`) {
    hash = Math.imul(hash ^ character.charCodeAt(0), 16_777_619) >>> 0;
  }
  return Math.min(MAX_RETRY_DELAY_MS, base + (hash % (maxJitter + 1)));
}

function isTelegramChannelFailure(error: unknown): boolean {
  const apiError = error as Partial<TelegramApiError>;
  return (
    typeof apiError.method === 'string' &&
    (typeof apiError.errorCode !== 'number' ||
      apiError.errorCode === 429 ||
      apiError.errorCode >= 500)
  );
}

export class Outbox {
  readonly #db: DatabaseSync;
  #channelBlockedUntil = 0;
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

  claimNext(): ClaimedOutboxRow | null {
    if (Date.now() < this.#channelBlockedUntil) return null;
    return transaction(this.#db, () => {
      const row = this.#db
        .prepare(
          `SELECT outbox_id, delivery_part_id, session_id, kind, payload, attempts, max_attempts,
                  claim_generation
             FROM telegram_outbox
            WHERE state = 'pending' AND run_after <= ?
            ORDER BY created_at, rowid, ordinal
            LIMIT 1`,
        )
        .get(nowIso()) as ClaimedOutboxRow | undefined;
      if (row === undefined) return null;

      const updated = this.#db
        .prepare(
          `UPDATE telegram_outbox
              SET state = 'sending', attempts = attempts + 1,
                  claim_generation = claim_generation + 1, updated_at = ?
            WHERE outbox_id = ? AND state = 'pending' AND claim_generation = ?`,
        )
        .run(nowIso(), row.outbox_id, row.claim_generation);
      if (updated.changes !== 1) {
        throw new Error(`outbox row ${row.outbox_id} changed while being claimed`);
      }
      return {
        ...row,
        attempts: row.attempts + 1,
        claim_generation: row.claim_generation + 1,
      };
    });
  }

  markSent(
    claim: Pick<ClaimedOutboxRow, 'outbox_id' | 'claim_generation'>,
    messageId: number | null,
    afterMark?: () => void,
  ): OutboxSentOutcome {
    return transaction(this.#db, () => {
      const updated = this.#db
        .prepare(
          `UPDATE telegram_outbox SET state = 'sent', telegram_message_id = ?, updated_at = ?
            WHERE outbox_id = ? AND state = 'sending' AND claim_generation = ?`,
        )
        .run(messageId, nowIso(), claim.outbox_id, claim.claim_generation);
      if (updated.changes !== 1) return 'lost';
      afterMark?.();
      return 'sent';
    });
  }

  markFailed(
    claim: Pick<ClaimedOutboxRow, 'outbox_id' | 'claim_generation'>,
    error: string,
    attempts: number,
    maxAttempts: number,
  ): OutboxFailureOutcome {
    const exhausted = attempts >= maxAttempts;
    const updated = this.#db
      .prepare(
        `UPDATE telegram_outbox SET state = ?, last_error = ?, run_after = ?, updated_at = ?
          WHERE outbox_id = ? AND state = 'sending' AND claim_generation = ?`,
      )
      .run(
        exhausted ? 'dead' : 'pending',
        error.slice(0, 2000),
        isoIn(exhausted ? 0 : retryDelayMs(attempts, claim.outbox_id, claim.claim_generation)),
        nowIso(),
        claim.outbox_id,
        claim.claim_generation,
      );
    if (updated.changes !== 1) return 'lost';
    return exhausted ? 'dead' : 'retry';
  }

  pauseChannelFor(delayMs: number): void {
    this.#channelBlockedUntil = Math.max(this.#channelBlockedUntil, Date.now() + delayMs);
  }

  /**
   * Returns a row to `pending` without burning an attempt, deferred by
   * `delayMs`. Used for HTTP 429, where Telegram tells us exactly how long to
   * wait and the send was never our fault.
   */
  defer(
    claim: Pick<ClaimedOutboxRow, 'outbox_id' | 'claim_generation'>,
    delayMs: number,
    reason: string,
  ): OutboxDeferOutcome {
    const updated = this.#db
      .prepare(
        `UPDATE telegram_outbox
            SET state = 'pending', attempts = MAX(0, attempts - 1), run_after = ?,
                last_error = ?, updated_at = ?
          WHERE outbox_id = ? AND state = 'sending' AND claim_generation = ?`,
      )
      .run(
        isoIn(delayMs),
        reason.slice(0, 2000),
        nowIso(),
        claim.outbox_id,
        claim.claim_generation,
      );
    return updated.changes === 1 ? 'deferred' : 'lost';
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

type OutboxSendError = Error & { retryAfterSeconds?: number };

function pauseDeferredChannel(outbox: Outbox, outcome: OutboxDeferOutcome, delayMs: number): void {
  if (outcome !== 'lost') outbox.pauseChannelFor(delayMs);
}

function pauseInterruptedChannel(
  outbox: Outbox,
  outcome: OutboxDeferOutcome,
  delayMs: number,
  error: OutboxSendError,
): void {
  if (outcome !== 'lost' && !isClientShutdown(error)) outbox.pauseChannelFor(delayMs);
}

function markPermanentFailure(
  deps: OutboxWorkerDeps,
  row: ClaimedOutboxRow,
  error: OutboxSendError,
): void {
  const outcome = deps.outbox.markFailed(row, error.message, row.max_attempts, row.max_attempts);
  if (outcome === 'lost') {
    deps.logger.warn('ignored permanent failure from a stale outbox sender', {
      kind: row.kind,
      deliveryPartId: row.delivery_part_id,
      claimGeneration: row.claim_generation,
    });
    return;
  }
  deps.logger.error('telegram send reached a terminal outcome', {
    kind: row.kind,
    deliveryPartId: row.delivery_part_id,
    error: error.message,
    outcome,
  });
}

function stopAfterChannelFailure(
  outbox: Outbox,
  row: ClaimedOutboxRow,
  error: OutboxSendError,
  outcome: OutboxFailureOutcome,
): boolean {
  if (!isTelegramChannelFailure(error)) return false;
  if (outcome !== 'lost') {
    outbox.pauseChannelFor(retryDelayMs(row.attempts, row.outbox_id, row.claim_generation));
  }
  return true;
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
      const outcome = deps.outbox.markSent(row, messageId, () => {
        deps.onDelivered?.({
          deliveryPartId: row.delivery_part_id,
          sessionId: row.session_id,
          payload,
        });
      });
      if (outcome === 'lost') {
        deps.logger.warn('ignored Telegram acknowledgement from a stale outbox sender', {
          kind: row.kind,
          deliveryPartId: row.delivery_part_id,
          claimGeneration: row.claim_generation,
        });
        continue;
      }
      await cleanupEphemeralPayload(payload, deps.logger);
      sent += 1;
    } catch (error) {
      const err = error as OutboxSendError;
      if (shouldRetryWithoutAttempt(err)) {
        const delayMs = 1000;
        const outcome = deps.outbox.defer(row, delayMs, err.message);
        deps.logger.info('telegram send interrupted; outbox claim released', {
          kind: row.kind,
          deliveryPartId: row.delivery_part_id,
          outcome,
        });
        pauseInterruptedChannel(deps.outbox, outcome, delayMs, err);
        break;
      }
      if (!isRetryable(err)) {
        markPermanentFailure(deps, row, err);
        continue;
      }
      // Honour Telegram's own backpressure signal rather than guessing, and
      // stop draining: every further send would hit the same limit.
      if (typeof err.retryAfterSeconds === 'number') {
        const delayMs = err.retryAfterSeconds * 1000;
        const outcome = deps.outbox.defer(row, delayMs, err.message);
        deps.logger.warn('telegram rate limited', {
          retryAfterSeconds: err.retryAfterSeconds,
          kind: row.kind,
          outcome,
        });
        pauseDeferredChannel(deps.outbox, outcome, delayMs);
        break;
      }
      const outcome = deps.outbox.markFailed(row, err.message, row.attempts, row.max_attempts);
      deps.logger.warn('telegram send failed', {
        kind: row.kind,
        outcome,
        attempts: row.attempts,
        error: err.message,
      });
      if (stopAfterChannelFailure(deps.outbox, row, err, outcome)) break;
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
      ...(payload.replyMarkup === undefined ? {} : { replyMarkup: payload.replyMarkup }),
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
    ...(payload.replyMarkup === undefined ? {} : { replyMarkup: payload.replyMarkup }),
    ...(payload.caption !== undefined
      ? { caption: payload.caption, parseMode: 'HTML' as const }
      : {}),
  });
  return message.message_id;
}
