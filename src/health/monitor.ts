import { statfs } from 'node:fs/promises';
import type { DatabaseSync } from 'node:sqlite';
import type { HealthConfig } from '../config/schema.ts';

export type HealthStatus = 'healthy' | 'degraded' | 'failed' | 'recovering';

export interface HealthCheck {
  readonly component: string;
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
  readonly diskFreeGb: number;
  readonly sqliteWritable: boolean;
  readonly hoursSinceLastDigest: number | null;
}

export interface HealthReport {
  readonly overall: HealthStatus;
  readonly checks: readonly HealthCheck[];
}

const RANK: Record<HealthStatus, number> = { healthy: 0, recovering: 1, degraded: 2, failed: 3 };

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

  if (inputs.deadJobs > 0) {
    checks.push({
      component: 'dead_jobs',
      status: 'failed',
      detail: `${inputs.deadJobs} job(s) exhausted retries`,
    });
  }

  // A missing LLM degrades the report to "transcript only"; it never blocks
  // recording or audio delivery, so it is degraded rather than failed.
  checks.push({
    component: 'llm',
    status: inputs.ollamaReady ? 'healthy' : 'degraded',
    detail: inputs.ollamaDetail,
  });

  if (inputs.deadOutbox > 0) {
    checks.push({
      component: 'dead_outbox',
      status: 'degraded',
      detail: `${inputs.deadOutbox} message(s) exhausted retries`,
    });
  }

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

  checks.push({
    component: 'disk',
    status: inputs.diskFreeGb < config.diskFreeWarnGb ? 'degraded' : 'healthy',
    detail: `${inputs.diskFreeGb.toFixed(0)} GB free`,
  });

  checks.push({
    component: 'sqlite',
    status: inputs.sqliteWritable ? 'healthy' : 'failed',
    detail: inputs.sqliteWritable ? 'writable' : 'database is not writable',
  });

  if (inputs.hoursSinceLastDigest !== null && inputs.hoursSinceLastDigest > 26) {
    checks.push({
      component: 'digest',
      status: 'degraded',
      detail: `last digest ${Math.round(inputs.hoursSinceLastDigest)}h ago`,
    });
  }

  const overall = checks.reduce<HealthStatus>(
    (worst, check) => (RANK[check.status] > RANK[worst] ? check.status : worst),
    'healthy',
  );
  return { overall, checks };
}

/** The short `/health` reply: one line per non-healthy component. */
export function renderHealthLines(report: HealthReport): string {
  const problems = report.checks.filter((c) => c.status !== 'healthy');
  if (problems.length === 0) return '✅ Всё в порядке';
  return problems
    .map((c) => {
      const level = c.status === 'failed' ? 'ОШИБКА' : 'ВНИМАНИЕ';
      return `${level}: ${healthComponentLabel(c.component)} — ${healthDetail(c)}`;
    })
    .join('\n');
}

const HEALTH_COMPONENT_LABELS: Readonly<Record<string, string>> = {
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

function healthComponentLabel(component: string): string {
  return HEALTH_COMPONENT_LABELS[component] ?? 'компонент';
}

/**
 * Keeps raw adapter/process errors in health events and logs, never in chat.
 * Only bounded numeric facts from our own health evaluator cross the boundary.
 */
function healthDetail(check: HealthCheck): string {
  const count = firstNumber(check.detail);
  switch (check.component) {
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
        : `${count} ${russianCount(count, 'задача', 'задачи', 'задач')} исчерпали попытки`;
    case 'llm':
      return 'локальные отчёты недоступны; транскрипты продолжат работать';
    case 'dead_outbox':
      return count === null
        ? 'есть сообщения, исчерпавшие попытки'
        : `${count} ${russianCount(count, 'сообщение', 'сообщения', 'сообщений')} не доставлены`;
    case 'asr_backlog':
      return count === null ? 'очередь растёт' : `старейшей задаче ${count} мин`;
    case 'telegram_outbox':
      return count === null ? 'очередь растёт' : `старейшему сообщению ${count} мин`;
    case 'disk':
      return count === null ? 'мало свободного места' : `свободно ${count} ГБ`;
    case 'sqlite':
      return 'база данных недоступна для записи';
    case 'digest':
      return count === null ? 'дайджест не сформирован' : `последний дайджест ${count} ч назад`;
    default:
      return 'требует внимания';
  }
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

export async function diskFreeGb(path: string): Promise<number> {
  try {
    const stats = await statfs(path);
    return (Number(stats.bavail) * Number(stats.bsize)) / 1024 ** 3;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

export function sqliteWritable(db: DatabaseSync): boolean {
  try {
    db.exec('PRAGMA user_version');
    db.prepare('SELECT 1').get();
    return true;
  } catch {
    return false;
  }
}

export function recordHealthEvent(db: DatabaseSync, check: HealthCheck): void {
  db.prepare(
    'INSERT INTO health_events (component, status, detail, created_at) VALUES (?, ?, ?, ?)',
  ).run(check.component, check.status, check.detail, new Date().toISOString());
}
