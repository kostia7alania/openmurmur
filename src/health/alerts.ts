import type { DatabaseSync } from 'node:sqlite';
import { transaction } from '../database/db.ts';

/**
 * Edge-triggered alerting.
 *
 * A health poll runs every few seconds. Sending a Telegram message on every
 * poll where "disk is low" holds true would produce hundreds of messages an
 * hour, so alerts fire only when the *condition changes*, and re-fire only
 * after a cooldown. Fingerprinted conditions instead re-fire only when their
 * underlying failed set changes. Each alert has a stable id so a flapping
 * condition collapses into one row rather than accumulating.
 */

export type AlertId =
  | 'recorder_stale'
  | 'worker_crashed'
  | 'llm_unavailable'
  | 'disk_low'
  | 'asr_backlog'
  | 'dead_jobs'
  | 'telegram_delivery'
  | 'digest_missing';

export interface AlertDecision {
  readonly send: boolean;
  readonly transition: 'raised' | 'cleared' | 'changed' | 'repeated' | 'none';
}

export interface AlertEvaluatorOptions {
  readonly cooldownMinutes: number;
  readonly now?: () => number;
}

interface AlertStateRow {
  readonly active: number;
  readonly last_sent_at: string | null;
  readonly occurrences: number;
  readonly fingerprint: string | null;
}

export class AlertEvaluator {
  readonly #db: DatabaseSync;
  readonly #cooldownMs: number;
  readonly #now: () => number;

  constructor(db: DatabaseSync, options: AlertEvaluatorOptions) {
    this.#db = db;
    this.#cooldownMs = options.cooldownMinutes * 60_000;
    this.#now = options.now ?? Date.now;
  }

  /**
   * Records the current truth of `alertId` and decides whether to notify.
   *
   * - false -> true : send (raised)
   * - true  -> false: send (cleared, i.e. the recovery message)
   * - true  -> true : send once per cooldown, or once per new fingerprint
   * - false -> false: never send
   *
   * `onSend` runs in the same transaction as the state change. A failed
   * durable enqueue therefore cannot consume an alert edge.
   */
  evaluate(
    alertId: AlertId,
    active: boolean,
    fingerprint?: string,
    onSend?: (decision: AlertDecision) => void,
  ): AlertDecision {
    return transaction(this.#db, () => {
      const decision = this.#evaluate(alertId, active, fingerprint);
      if (decision.send) onSend?.(decision);
      return decision;
    });
  }

  #evaluate(alertId: AlertId, active: boolean, fingerprint?: string): AlertDecision {
    const now = this.#now();
    const nowIso = new Date(now).toISOString();

    const row = this.#db
      .prepare(
        'SELECT active, last_sent_at, occurrences, fingerprint FROM alert_state WHERE alert_id = ?',
      )
      .get(alertId) as AlertStateRow | undefined;

    if (row === undefined) {
      this.#db
        .prepare(
          `INSERT INTO alert_state
             (alert_id, active, last_sent_at, last_changed_at, occurrences, fingerprint)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          alertId,
          active ? 1 : 0,
          active ? nowIso : null,
          nowIso,
          active ? 1 : 0,
          active ? (fingerprint ?? null) : null,
        );
      return active ? { send: true, transition: 'raised' } : { send: false, transition: 'none' };
    }

    const wasActive = row.active === 1;

    if (wasActive === active) {
      if (!active) return { send: false, transition: 'none' };
      return this.#evaluateStillActive(alertId, row, now, nowIso, fingerprint);
    }

    this.#db
      .prepare(
        `UPDATE alert_state
            SET active = ?, last_sent_at = ?, last_changed_at = ?, occurrences = occurrences + 1,
                fingerprint = ?
          WHERE alert_id = ?`,
      )
      .run(active ? 1 : 0, nowIso, nowIso, active ? (fingerprint ?? null) : null, alertId);
    return { send: true, transition: active ? 'raised' : 'cleared' };
  }

  #evaluateStillActive(
    alertId: AlertId,
    row: AlertStateRow,
    now: number,
    nowIso: string,
    fingerprint: string | undefined,
  ): AlertDecision {
    if (fingerprint !== undefined) {
      if (row.fingerprint === fingerprint) return { send: false, transition: 'none' };
      this.#db
        .prepare(
          `UPDATE alert_state
              SET last_sent_at = ?, last_changed_at = ?, occurrences = occurrences + 1,
                  fingerprint = ?
            WHERE alert_id = ?`,
        )
        .run(nowIso, nowIso, fingerprint, alertId);
      return { send: true, transition: 'changed' };
    }

    const lastSent = row.last_sent_at === null ? 0 : Date.parse(row.last_sent_at);
    if (now - lastSent < this.#cooldownMs) return { send: false, transition: 'none' };
    this.#db
      .prepare(
        'UPDATE alert_state SET last_sent_at = ?, occurrences = occurrences + 1 WHERE alert_id = ?',
      )
      .run(nowIso, alertId);
    return { send: true, transition: 'repeated' };
  }

  isActive(alertId: AlertId): boolean {
    const row = this.#db
      .prepare('SELECT active FROM alert_state WHERE alert_id = ?')
      .get(alertId) as { active: number } | undefined;
    return row?.active === 1;
  }
}

export interface AlertMessage {
  readonly text: string;
  /** Stable per alert *edge*, so a retry cannot duplicate the message. */
  readonly deliveryPartId: string;
}

export function renderAlert(
  alertId: AlertId,
  transition: 'raised' | 'cleared' | 'changed' | 'repeated',
  detail: string,
  epoch: number,
): AlertMessage {
  const cleared = transition === 'cleared';
  const body: Record<AlertId, { up: string; down: string }> = {
    recorder_stale: {
      up: '🟡 Запись временно недоступна',
      down: '🟢 Запись восстановлена',
    },
    worker_crashed: {
      up: '🟡 Локальный ASR worker остановился',
      down: '🟢 ASR worker восстановлен',
    },
    llm_unavailable: {
      up: '🟡 Структурный отчёт временно недоступен',
      down: '🟢 Структурные отчёты снова доступны',
    },
    disk_low: { up: '🟡 Мало места на диске', down: '🟢 Место на диске восстановлено' },
    asr_backlog: {
      up: '🟡 Очередь распознавания растёт',
      down: '🟢 Очередь распознавания разобрана',
    },
    dead_jobs: {
      up: '🔴 Задача OpenMurmur остановилась после повторных ошибок',
      down: '🟢 Ошибочных задач больше нет',
    },
    telegram_delivery: {
      up: '🟡 Доставка в Telegram не работает',
      down: '🟢 Доставка в Telegram восстановлена',
    },
    digest_missing: { up: '🟡 Дневной дайджест не сформирован', down: '🟢 Дайджест сформирован' },
  };

  const headline = cleared ? body[alertId].down : body[alertId].up;
  return {
    text: detail.length > 0 ? `${headline}\n\n${detail}` : headline,
    deliveryPartId: `alert:${alertId}:${cleared ? 'clear' : 'raise'}:${epoch}`,
  };
}
