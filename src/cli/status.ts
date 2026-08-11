import type { DatabaseSync } from 'node:sqlite';

export interface LocalStatusCounts {
  readonly sessions: number;
  readonly done: number;
  readonly rejected: number;
  /** Active work retained for JSON compatibility with the original status contract. */
  readonly jobs: number;
  readonly jobsPending: number;
  readonly jobsLeased: number;
  readonly jobsDead: number;
  /** Active sends retained for JSON compatibility with the original status contract. */
  readonly outbox: number;
  readonly outboxPending: number;
  readonly outboxSending: number;
  readonly outboxDead: number;
  readonly parts: number;
}

export interface DaemonHeartbeatInput {
  readonly daemonPid: number;
  readonly daemonStartedAt: string;
  readonly recorderRunning: boolean;
  readonly sessionState: string;
  readonly lastSourceFrameAgeMs: number | null;
  readonly processingLagMs: number | null;
  readonly updatedAt: string;
}

export type HeartbeatStatus =
  | 'fresh'
  | 'stale'
  | 'missing'
  | 'daemon_stopped'
  | 'identity_mismatch';

export interface LocalLiveStatus {
  readonly heartbeatStatus: HeartbeatStatus;
  readonly heartbeatUpdatedAt: string | null;
  readonly heartbeatAgeMs: number | null;
  readonly recorderRunning: boolean | null;
  readonly sessionState: string | null;
  readonly lastSourceFrameAgeMs: number | null;
  readonly processingLagMs: number | null;
}

export interface ReadLocalLiveStatusOptions {
  readonly daemonRunning: boolean;
  readonly daemonPid: number | null;
  readonly daemonStartedAt: string | null;
  readonly nowMs: number;
  readonly freshForMs: number;
}

interface DaemonHeartbeatRow {
  readonly daemon_pid: number;
  readonly daemon_started_at: string;
  readonly recorder_running: number;
  readonly session_state: string;
  readonly last_source_frame_age_ms: number | null;
  readonly processing_lag_ms: number | null;
  readonly updated_at: string;
}

function nullableMilliseconds(value: number | null): number | null {
  return value === null ? null : Math.max(0, Math.round(value));
}

export function writeDaemonHeartbeat(db: DatabaseSync, input: DaemonHeartbeatInput): void {
  db.prepare(
    `INSERT INTO daemon_heartbeat
       (heartbeat_id, daemon_pid, daemon_started_at, recorder_running, session_state,
        last_source_frame_age_ms, processing_lag_ms, updated_at)
     VALUES (1, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (heartbeat_id) DO UPDATE SET
       daemon_pid = excluded.daemon_pid,
       daemon_started_at = excluded.daemon_started_at,
       recorder_running = excluded.recorder_running,
       session_state = excluded.session_state,
       last_source_frame_age_ms = excluded.last_source_frame_age_ms,
       processing_lag_ms = excluded.processing_lag_ms,
       updated_at = excluded.updated_at`,
  ).run(
    input.daemonPid,
    input.daemonStartedAt,
    input.recorderRunning ? 1 : 0,
    input.sessionState,
    nullableMilliseconds(input.lastSourceFrameAgeMs),
    nullableMilliseconds(input.processingLagMs),
    input.updatedAt,
  );
}

function unavailableLiveStatus(
  heartbeatStatus: Exclude<HeartbeatStatus, 'fresh'>,
  row?: DaemonHeartbeatRow,
  heartbeatAgeMs: number | null = null,
): LocalLiveStatus {
  return {
    heartbeatStatus,
    heartbeatUpdatedAt: row?.updated_at ?? null,
    heartbeatAgeMs,
    recorderRunning: null,
    sessionState: null,
    lastSourceFrameAgeMs: null,
    processingLagMs: null,
  };
}

export function readLocalLiveStatus(
  db: DatabaseSync,
  options: ReadLocalLiveStatusOptions,
): LocalLiveStatus {
  const row = db.prepare('SELECT * FROM daemon_heartbeat WHERE heartbeat_id = 1').get() as
    | DaemonHeartbeatRow
    | undefined;
  if (!options.daemonRunning) return unavailableLiveStatus('daemon_stopped', row);
  if (row === undefined) return unavailableLiveStatus('missing');
  if (
    options.daemonPid === null ||
    options.daemonStartedAt === null ||
    row.daemon_pid !== options.daemonPid ||
    row.daemon_started_at !== options.daemonStartedAt
  ) {
    return unavailableLiveStatus('identity_mismatch', row);
  }

  const updatedAtMs = Date.parse(row.updated_at);
  const heartbeatAgeMs = options.nowMs - updatedAtMs;
  if (!Number.isFinite(updatedAtMs) || heartbeatAgeMs < 0 || heartbeatAgeMs > options.freshForMs) {
    return unavailableLiveStatus(
      'stale',
      row,
      Number.isFinite(heartbeatAgeMs) && heartbeatAgeMs >= 0 ? heartbeatAgeMs : null,
    );
  }

  return {
    heartbeatStatus: 'fresh',
    heartbeatUpdatedAt: row.updated_at,
    heartbeatAgeMs,
    recorderRunning: row.recorder_running === 1,
    sessionState: row.session_state,
    lastSourceFrameAgeMs:
      row.last_source_frame_age_ms === null ? null : row.last_source_frame_age_ms + heartbeatAgeMs,
    processingLagMs: row.processing_lag_ms,
  };
}

export function heartbeatFreshForMs(healthPollIntervalMs: number): number {
  return healthPollIntervalMs * 3;
}

export function readLocalStatusCounts(db: DatabaseSync): LocalStatusCounts {
  const row = db
    .prepare(
      `SELECT
         (SELECT count(*) FROM audio_sessions)                                      AS sessions,
         (SELECT count(*) FROM audio_sessions WHERE state = 'DONE')                 AS done,
         (SELECT count(*) FROM audio_sessions WHERE state = 'REJECTED')             AS rejected,
         (SELECT count(*) FROM jobs WHERE state IN ('pending','leased'))            AS jobs,
         (SELECT count(*) FROM jobs WHERE state = 'pending')                        AS jobsPending,
         (SELECT count(*) FROM jobs WHERE state = 'leased')                         AS jobsLeased,
         (SELECT count(*) FROM jobs WHERE state = 'dead')                           AS jobsDead,
         (SELECT count(*) FROM telegram_outbox WHERE state IN ('pending','sending')) AS outbox,
         (SELECT count(*) FROM telegram_outbox WHERE state = 'pending')             AS outboxPending,
         (SELECT count(*) FROM telegram_outbox WHERE state = 'sending')             AS outboxSending,
         (SELECT count(*) FROM telegram_outbox WHERE state = 'dead')                AS outboxDead,
         (SELECT count(*) FROM audio_parts WHERE deleted_at IS NULL)                AS parts`,
    )
    .get() as unknown as LocalStatusCounts | undefined;
  if (row === undefined) throw new Error('could not read local status counts');
  return { ...row };
}

export function renderQueueStatus(counts: LocalStatusCounts, logFile: string): readonly string[] {
  const lines = [
    `Jobs:              ${counts.jobsPending} pending, ${counts.jobsLeased} leased, ${counts.jobsDead} dead`,
    `Telegram outbox:   ${counts.outboxPending} pending, ${counts.outboxSending} sending, ${counts.outboxDead} dead`,
  ];
  if (counts.jobsDead > 0 || counts.outboxDead > 0) {
    lines.push(
      `Terminal failures: ${counts.jobsDead} job(s), ${counts.outboxDead} Telegram message(s)`,
      `Inspect logs:       ${logFile}`,
    );
  }
  return lines;
}

function formatMilliseconds(value: number): string {
  if (value < 1000) return `${Math.round(value)} ms`;
  if (value < 10_000) return `${(value / 1000).toFixed(1)}s`;
  return `${Math.round(value / 1000)}s`;
}

export function renderLiveStatus(status: LocalLiveStatus): readonly string[] {
  if (status.heartbeatStatus === 'fresh') {
    return [
      `Heartbeat:         fresh (${formatMilliseconds(status.heartbeatAgeMs ?? 0)} old)`,
      `Recorder:          ${status.recorderRunning === true ? 'running' : 'stopped'}`,
      `Current session:   ${status.sessionState ?? 'unknown'}`,
      `Last source frame: ${status.lastSourceFrameAgeMs === null ? 'not observed' : `${formatMilliseconds(status.lastSourceFrameAgeMs)} ago`}`,
      `Processing lag:    ${status.processingLagMs === null ? 'not available' : formatMilliseconds(status.processingLagMs)}`,
    ];
  }

  const reason =
    status.heartbeatStatus === 'daemon_stopped'
      ? 'daemon stopped'
      : status.heartbeatStatus === 'missing'
        ? 'waiting for the first health tick'
        : status.heartbeatStatus === 'identity_mismatch'
          ? 'heartbeat belongs to another daemon run'
          : status.heartbeatAgeMs === null
            ? 'heartbeat timestamp is invalid'
            : `heartbeat is stale (${formatMilliseconds(status.heartbeatAgeMs)} old)`;
  return [
    `Heartbeat:         ${status.heartbeatStatus}`,
    `Recorder:          unknown (${reason})`,
    `Current session:   unknown (${reason})`,
    `Last source frame: unknown (${reason})`,
    `Processing lag:    unknown (${reason})`,
  ];
}
