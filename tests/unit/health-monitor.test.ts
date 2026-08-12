import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { DEFAULT_CONFIG } from '../../src/config/schema.ts';
import {
  diskFreeGb,
  evaluateHealth,
  type HealthCheck,
  recordHealthReport,
  renderHealthLines,
  sqliteWritable,
} from '../../src/health/monitor.ts';
import { renderStatus } from '../../src/telegram/report.ts';

let db: DatabaseSync;

beforeEach(() => {
  db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE health_events (
      event_id INTEGER PRIMARY KEY AUTOINCREMENT,
      component TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('healthy','degraded','failed','recovering')),
      detail TEXT,
      created_at TEXT NOT NULL
    ) STRICT;
  `);
});

afterEach(() => db.close());

const diskFailure: HealthCheck = {
  component: 'disk',
  status: 'failed',
  detail: 'disk space probe failed',
};

const healthyInputs = {
  recorderRunning: true,
  msSinceLastFrame: 10,
  processingLagMs: 0,
  minutesSinceLastClosedPart: null,
  workerReady: true,
  workerDetail: 'ready',
  ollamaReady: true,
  ollamaDetail: 'ready',
  activeSessionMs: null,
  asrBacklogMinutes: 0,
  deadJobs: 0,
  outboxAgeMinutes: 0,
  deadOutbox: 0,
  diskFreeGb: 100,
  sqliteWritable: true,
  hoursSinceLastDigest: 1,
} as const;

function rows(): { status: string; detail: string; created_at: string }[] {
  return db
    .prepare('SELECT status, detail, created_at FROM health_events ORDER BY event_id')
    .all() as unknown as { status: string; detail: string; created_at: string }[];
}

describe('health storage and probe boundaries', () => {
  it('treats a statfs failure as explicit unhealthy state in health and status', async () => {
    assert.equal(
      await diskFreeGb('/unreadable', async () => {
        throw new Error('EACCES /private/secret');
      }),
      null,
    );

    const report = evaluateHealth(
      {
        ...healthyInputs,
        diskFreeGb: null,
        hoursSinceLastDigest: null,
      },
      DEFAULT_CONFIG.health,
    );
    assert.equal(report.overall, 'failed');
    assert.equal(renderHealthLines(report), 'ОШИБКА: диск — не удалось проверить свободное место');

    const status = renderStatus({
      hostName: 'local-mac',
      recordingState: 'recording',
      lastFrameSecondsAgo: 1,
      processingLagSeconds: 0,
      sessionState: 'IDLE',
      sessionElapsedMs: null,
      lastClosedPartMinutesAgo: null,
      asrBacklog: 0,
      failedJobs: 0,
      outboxPending: 0,
      failedOutbox: 0,
      lastDeliveryMinutesAgo: null,
      diskFreeGb: null,
      asrStatus: 'ready',
      llmStatus: 'ready',
      version: 'test',
    });
    assert.match(status, /Свободный диск: не удалось проверить/);
    assert.doesNotMatch(status, /Infinity/);
  });

  it('proves SQLite writability with a rolled-back main-database write', () => {
    assert.equal(sqliteWritable(db), true);
    assert.equal(rows().length, 0, 'the successful probe must leave no row behind');

    db.exec('PRAGMA query_only = ON');
    assert.equal(sqliteWritable(db), false);
    assert.equal(rows().length, 0, 'the failed probe must leave no row behind');
    db.exec('PRAGMA query_only = OFF');
  });

  it('stores status edges and at most one unchanged problem sample per hour', () => {
    const start = new Date('2026-08-11T00:00:00.000Z');
    recordHealthReport(
      db,
      [{ component: 'disk', status: 'healthy', detail: '100 GB free' }],
      start,
    );
    assert.deepEqual(rows(), [], 'a healthy baseline must not grow the table');

    recordHealthReport(db, [diskFailure], start);
    recordHealthReport(db, [diskFailure], new Date(start.getTime() + 59 * 60_000));
    recordHealthReport(db, [diskFailure], new Date(start.getTime() + 60 * 60_000));
    recordHealthReport(
      db,
      [{ component: 'disk', status: 'healthy', detail: '100 GB free' }],
      new Date(start.getTime() + 61 * 60_000),
    );
    recordHealthReport(
      db,
      [{ component: 'disk', status: 'healthy', detail: '99 GB free' }],
      new Date(start.getTime() + 62 * 60_000),
    );

    assert.deepEqual(
      rows().map(({ status, created_at }) => ({ status, created_at })),
      [
        { status: 'failed', created_at: '2026-08-11T00:00:00.000Z' },
        { status: 'failed', created_at: '2026-08-11T01:00:00.000Z' },
        { status: 'healthy', created_at: '2026-08-11T01:01:00.000Z' },
      ],
    );
  });

  it('persists recovery edges for terminal work and a late digest', () => {
    const raisedAt = new Date('2026-08-11T00:00:00.000Z');
    const recoveredAt = new Date('2026-08-11T00:01:00.000Z');
    recordHealthReport(
      db,
      evaluateHealth(
        { ...healthyInputs, deadJobs: 2, deadOutbox: 3, hoursSinceLastDigest: 27 },
        DEFAULT_CONFIG.health,
      ).checks,
      raisedAt,
    );
    recordHealthReport(
      db,
      evaluateHealth(healthyInputs, DEFAULT_CONFIG.health).checks,
      recoveredAt,
    );

    for (const [component, raised] of [
      ['dead_jobs', 'failed'],
      ['dead_outbox', 'degraded'],
      ['digest', 'degraded'],
    ] as const) {
      const events = db
        .prepare(
          `SELECT status, created_at
           FROM health_events
           WHERE component = ?
           ORDER BY event_id`,
        )
        .all(component) as unknown as { status: string; created_at: string }[];
      assert.deepEqual(
        events.map((event) => ({ ...event })),
        [
          { status: raised, created_at: raisedAt.toISOString() },
          { status: 'healthy', created_at: recoveredAt.toISOString() },
        ],
      );
    }
  });

  it('prunes expired events and enforces the hard row cap', () => {
    const insert = db.prepare(
      `INSERT INTO health_events (component, status, detail, created_at)
       VALUES ('disk', 'failed', 'seed', ?)`,
    );
    db.exec('BEGIN');
    for (let index = 0; index < 5_001; index += 1) {
      insert.run(new Date(Date.UTC(2026, 7, 1, 0, index)).toISOString());
    }
    db.exec('COMMIT');

    recordHealthReport(db, [], new Date('2026-08-11T00:00:00.000Z'));
    const count = db.prepare('SELECT COUNT(*) AS count FROM health_events').get() as unknown as {
      count: number;
    };
    assert.equal(count.count, 5_000);

    db.prepare(
      `INSERT INTO health_events (component, status, detail, created_at)
       VALUES ('sqlite', 'failed', 'expired', '2026-06-01T00:00:00.000Z')`,
    ).run();
    recordHealthReport(db, [], new Date('2026-08-11T00:00:00.000Z'));
    assert.equal(
      db.prepare("SELECT COUNT(*) AS count FROM health_events WHERE detail = 'expired'").get()?.[
        'count'
      ],
      0,
    );
  });
});
