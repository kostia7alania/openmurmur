import { statfs } from 'node:fs/promises';
import type { DatabaseSync } from 'node:sqlite';
import type { HealthConfig } from '../config/schema.ts';
import { transaction } from '../database/db.ts';

export type HealthStatus = 'healthy' | 'degraded' | 'failed' | 'recovering';

export type HealthComponent =
  | 'recorder'
  | 'capture_pipeline'
  | 'asr_worker'
  | 'dead_jobs'
  | 'llm'
  | 'dead_outbox'
  | 'asr_backlog'
  | 'telegram_outbox'
  | 'disk'
  | 'sqlite'
  | 'digest';

export interface HealthCheck {
  readonly component: HealthComponent;
  readonly status: HealthStatus;
  readonly detail: string;
}

export interface HealthInputs {
  readonly recorderRunning: boolean;
  readonly msSinceLastFrame: number | null;
  readonly processingLagMs: number | null;
  readonly minutesSinceLastClosedPart: number | null;
  readonly workerReady: boolean;
  readonly workerDetail: string;
  readonly ollamaReady: boolean;
  readonly ollamaDetail: string;
  readonly activeSessionMs: number | null;
  readonly asrBacklogMinutes: number;
  readonly deadJobs: number;
  readonly outboxAgeMinutes: number;
  readonly deadOutbox: number;
  readonly diskFreeGb: number | null;
  readonly sqliteWritable: boolean;
  readonly hoursSinceLastDigest: number | null;
}

export interface HealthReport {
  readonly overall: HealthStatus;
  readonly checks: readonly HealthCheck[];
}

const RANK: Record<HealthStatus, number> = { healthy: 0, recovering: 1, degraded: 2, failed: 3 };

const HEALTH_STATUS_LABELS: Readonly<Record<HealthStatus, string | null>> = {
  healthy: null,
  recovering: 'ВНИМАНИЕ',
  degraded: 'ВНИМАНИЕ',
  failed: 'ОШИБКА',
};

export function evaluateHealth(inputs: HealthInputs, config: HealthConfig): HealthReport {
  const checks: HealthCheck[] = [];

  if (!inputs.recorderRunning) {
    checks.push({
      component: 'recorder',
      status: 'failed',
      detail: 'capture process is not running',
    });
  } else if (inputs.msSinceLastFrame === null) {
    checks.push({
      component: 'recorder',
      status: 'recovering',
      detail: 'waiting for the first audio frame',
    });
  } else if (inputs.msSinceLastFrame > config.recorderStaleSeconds * 1000) {
    checks.push({
      component: 'recorder',
      status: 'failed',
      detail: `no audio frames for ${Math.round(inputs.msSinceLastFrame / 1000)}s`,
    });
  } else {
    checks.push({ component: 'recorder', status: 'healthy', detail: 'receiving audio' });
  }

  if (inputs.processingLagMs !== null) {
    const lagging = inputs.processingLagMs > config.recorderStaleSeconds * 1000;
    checks.push({
      component: 'capture_pipeline',
      status: lagging ? 'degraded' : 'healthy',
      detail: lagging
        ? `processing is ${Math.round(inputs.processingLagMs / 1000)}s behind capture`
        : 'keeping up with capture',
    });
  }

  checks.push({
    component: 'asr_worker',
    status: inputs.workerReady ? 'healthy' : 'failed',
    detail: inputs.workerDetail,
  });

  checks.push(deadJobsHealth(inputs.deadJobs));

  // A missing LLM degrades the report to "transcript only"; it never blocks
  // recording or audio delivery, so it is degraded rather than failed.
  checks.push({
    component: 'llm',
    status: inputs.ollamaReady ? 'healthy' : 'degraded',
    detail: inputs.ollamaDetail,
  });

  checks.push(deadOutboxHealth(inputs.deadOutbox));

  checks.push({
    component: 'asr_backlog',
    status: inputs.asrBacklogMinutes > config.asrBacklogMinutes ? 'degraded' : 'healthy',
    detail:
      inputs.asrBacklogMinutes > 0
        ? `oldest job ${Math.round(inputs.asrBacklogMinutes)} min old`
        : 'clear',
  });

  checks.push({
    component: 'telegram_outbox',
    status: inputs.outboxAgeMinutes > config.outboxStaleMinutes ? 'degraded' : 'healthy',
    detail:
      inputs.outboxAgeMinutes > 0
        ? `oldest message ${Math.round(inputs.outboxAgeMinutes)} min old`
        : 'clear',
  });

  checks.push(
    inputs.diskFreeGb === null
      ? {
          component: 'disk',
          status: 'failed',
          detail: 'disk space probe failed',
        }
      : {
          component: 'disk',
          status: inputs.diskFreeGb < config.diskFreeWarnGb ? 'degraded' : 'healthy',
          detail: `${inputs.diskFreeGb.toFixed(0)} GB free`,
        },
  );

  checks.push({
    component: 'sqlite',
    status: inputs.sqliteWritable ? 'healthy' : 'failed',
    detail: inputs.sqliteWritable ? 'writable' : 'database is not writable',
  });

  if (inputs.hoursSinceLastDigest !== null) {
    checks.push(digestHealth(inputs.hoursSinceLastDigest));
  }

  const overall = checks.reduce<HealthStatus>(
    (worst, check) => (RANK[check.status] > RANK[worst] ? check.status : worst),
    'healthy',
  );
  return { overall, checks };
}

function deadJobsHealth(count: number): HealthCheck {
  return {
    component: 'dead_jobs',
    status: count > 0 ? 'failed' : 'healthy',
    detail: count > 0 ? `${count} job(s) exhausted retries` : 'clear',
  };
}

function deadOutboxHealth(count: number): HealthCheck {
  return {
    component: 'dead_outbox',
    status: count > 0 ? 'degraded' : 'healthy',
    detail: count > 0 ? `${count} message(s) exhausted retries` : 'clear',
  };
}

function digestHealth(hoursSinceLastDigest: number): HealthCheck {
  return {
    component: 'digest',
    status: hoursSinceLastDigest > 26 ? 'degraded' : 'healthy',
    detail:
      hoursSinceLastDigest > 26
        ? `last digest ${Math.round(hoursSinceLastDigest)}h ago`
        : 'on schedule',
  };
}

/** The short `/health` reply: one line per non-healthy component. */
export function renderHealthLines(report: HealthReport): string {
  const problems = report.checks.filter((c) => c.status !== 'healthy');
  if (problems.length === 0) return '✅ Всё в порядке';
  return problems
    .map((c) => {
      const level = HEALTH_STATUS_LABELS[c.status];
      if (level === null) throw new Error('healthy check reached the unhealthy renderer');
      return `${level}: ${healthComponentLabel(c.component)} — ${healthDetail(c)}`;
    })
    .join('\n');
}

const HEALTH_COMPONENT_LABELS: Readonly<Record<HealthComponent, string>> = {
  recorder: 'запись',
  capture_pipeline: 'обработка аудио',
  asr_worker: 'распознавание',
  dead_jobs: 'очередь задач',
  llm: 'отчёты',
  dead_outbox: 'доставка Telegram',
  asr_backlog: 'очередь распознавания',
  telegram_outbox: 'очередь Telegram',
  disk: 'диск',
  sqlite: 'база данных',
  digest: 'дайджест',
};

function healthComponentLabel(component: HealthComponent): string {
  return HEALTH_COMPONENT_LABELS[component];
}

/**
 * Keeps raw adapter/process errors in health events and logs, never in chat.
 * Only bounded numeric facts from our own health evaluator cross the boundary.
 */
function healthDetail(check: HealthCheck): string {
  const count = firstNumber(check.detail);
  const component = check.component;
  switch (component) {
    case 'recorder':
      if (check.status === 'recovering') return 'ожидаю первый аудиокадр';
      return count === null ? 'процесс записи не работает' : `нет аудиокадров ${count} сек`;
    case 'capture_pipeline':
      return count === null
        ? 'обработка не успевает за записью'
        : `обработка отстаёт на ${count} сек`;
    case 'asr_worker':
      return 'локальный ASR недоступен';
    case 'dead_jobs':
      return count === null
        ? 'есть задачи, исчерпавшие попытки'
        : `${count} ${russianCount(count, 'задача', 'задачи', 'задач')} ${russianCount(
            count,
            'исчерпала',
            'исчерпали',
            'исчерпали',
          )} попытки`;
    case 'llm':
      return 'локальные отчёты недоступны; транскрипты продолжат работать';
    case 'dead_outbox':
      return count === null
        ? 'есть сообщения, исчерпавшие попытки'
        : `${count} ${russianCount(count, 'сообщение', 'сообщения', 'сообщений')} ${russianCount(
            count,
            'не доставлено',
            'не доставлены',
            'не доставлены',
          )}`;
    case 'asr_backlog':
      return count === null ? 'очередь растёт' : `старейшей задаче ${count} мин`;
    case 'telegram_outbox':
      return count === null ? 'очередь растёт' : `старейшему сообщению ${count} мин`;
    case 'disk':
      return count === null ? 'не удалось проверить свободное место' : `свободно ${count} ГБ`;
    case 'sqlite':
      return 'база данных недоступна для записи';
    case 'digest':
      return count === null ? 'дайджест не сформирован' : `последний дайджест ${count} ч назад`;
  }
  return unreachableComponent(component);
}

function unreachableComponent(component: never): never {
  throw new Error(`unsupported health component: ${component}`);
}

function firstNumber(detail: string): number | null {
  const match = /\d+/.exec(detail);
  return match === null ? null : Number(match[0]);
}

function russianCount(count: number, one: string, few: string, many: string): string {
  const lastTwo = count % 100;
  if (lastTwo >= 11 && lastTwo <= 14) return many;
  const last = count % 10;
  if (last === 1) return one;
  return last >= 2 && last <= 4 ? few : many;
}

type StatfsProbe = (path: string) => ReturnType<typeof statfs>;

export async function diskFreeGb(
  path: string,
  probe: StatfsProbe = statfs,
): Promise<number | null> {
  try {
    const stats = await probe(path);
    return (Number(stats.bavail) * Number(stats.bsize)) / 1024 ** 3;
  } catch {
    return null;
  }
}

export function sqliteWritable(db: DatabaseSync): boolean {
  const savepoint = 'openmurmur_health_write_probe';
  try {
    db.exec(`SAVEPOINT ${savepoint}`);
    db.prepare(
      `INSERT INTO health_events (component, status, detail, created_at)
       VALUES ('sqlite', 'healthy', 'rollback-only write probe', ?)`,
    ).run(new Date().toISOString());
    db.exec(`ROLLBACK TO ${savepoint}`);
    db.exec(`RELEASE ${savepoint}`);
    return true;
  } catch {
    try {
      db.exec(`ROLLBACK TO ${savepoint}`);
      db.exec(`RELEASE ${savepoint}`);
    } catch {
      // The probe may have failed before the savepoint was established.
    }
    return false;
  }
}

const HEALTH_SAMPLE_INTERVAL_MS = 60 * 60 * 1000;
const HEALTH_EVENT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_HEALTH_EVENTS = 5_000;

interface StoredHealthEvent {
  readonly status: HealthStatus;
  readonly created_at: string;
}

/** Persist state edges and one hourly problem sample, then enforce hard bounds. */
export function recordHealthReport(
  db: DatabaseSync,
  checks: readonly HealthCheck[],
  now = new Date(),
): void {
  const nowIso = now.toISOString();
  const sampleBefore = now.getTime() - HEALTH_SAMPLE_INTERVAL_MS;

  transaction(db, () => {
    const latest = db.prepare(
      `SELECT status, created_at
       FROM health_events
       WHERE component = ?
       ORDER BY event_id DESC
       LIMIT 1`,
    );
    const insert = db.prepare(
      'INSERT INTO health_events (component, status, detail, created_at) VALUES (?, ?, ?, ?)',
    );

    for (const check of checks) {
      const previous = latest.get(check.component) as unknown as StoredHealthEvent | undefined;
      const isEdge = previous !== undefined && previous.status !== check.status;
      const isProblemSample =
        check.status !== 'healthy' &&
        (previous === undefined || Date.parse(previous.created_at) <= sampleBefore);
      if ((previous === undefined && check.status !== 'healthy') || isEdge || isProblemSample) {
        insert.run(check.component, check.status, check.detail, nowIso);
      }
    }

    db.prepare('DELETE FROM health_events WHERE created_at < ?').run(
      new Date(now.getTime() - HEALTH_EVENT_RETENTION_MS).toISOString(),
    );
    const boundary = db
      .prepare(
        `SELECT event_id
         FROM health_events
         ORDER BY event_id DESC
         LIMIT 1 OFFSET ?`,
      )
      .get(MAX_HEALTH_EVENTS - 1) as unknown as { event_id: number } | undefined;
    if (boundary !== undefined) {
      db.prepare('DELETE FROM health_events WHERE event_id < ?').run(boundary.event_id);
    }
  });
}
