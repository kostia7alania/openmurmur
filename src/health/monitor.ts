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
  if (problems.length === 0) return 'OK';
  return problems
    .map((c) => {
      const level = c.status === 'failed' ? 'ERROR' : 'WARN';
      return `${level}: ${c.component} — ${c.detail}`;
    })
    .join('\n');
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
