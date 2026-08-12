import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  type ClaimSourceResolution,
  renderClaimSourceLabel,
  resolveClaimSource,
} from '../llm/claim-source.ts';
import { boundClaimEvidence, EMPTY_SUMMARY, parseSummary } from '../llm/schema.ts';
import { escapeHtml, formatDuration } from '../telegram/format.ts';

/**
 * Daily digest.
 *
 * A roll-up of the day's sessions built purely from stored facts and stored
 * summaries. No model is called here: the per-session summaries already exist,
 * and re-summarizing at midnight would produce a second, possibly conflicting
 * account of the same day.
 */

export interface DigestRow {
  readonly sessionId: string;
  readonly startedAt: string;
  readonly speechMs: number;
  readonly summary: string;
  readonly decisions: readonly string[];
  readonly tasks: readonly string[];
  readonly questions: readonly string[];
  /** Present only in evidence-bearing v2 snapshots. */
  readonly summaryId?: string | null | undefined;
  /** Present only in evidence-bearing v2 snapshots. */
  readonly summaryRevisionId?: string | null | undefined;
  /** Present only in evidence-bearing v2 snapshots. */
  readonly claimSources?: readonly DigestClaimSource[] | undefined;
}

export type DigestClaimField = 'summary' | 'decisions' | 'tasks' | 'questions';

export type DigestClaimSource = ClaimSourceResolution & {
  readonly field: DigestClaimField;
  readonly item: number;
};

export interface Digest {
  readonly sourceKind: 'local_daily_digest';
  readonly processingHost: string;
  readonly date: string;
  readonly sessionCount: number;
  readonly totalSpeechMs: number;
  /** Absent means a legacy snapshot whose model-claim sources were not stored. */
  readonly claimSourceVersion?: 2 | undefined;
  readonly rows: readonly DigestRow[];
}

const DIGEST_CLAIM_FIELDS = ['summary', 'decisions', 'tasks', 'questions'] as const;
const DIGEST_LIST_CLAIM_FIELDS = ['decisions', 'tasks', 'questions'] as const;
const DIGEST_CLAIM_FIELD_SET = new Set<string>(DIGEST_CLAIM_FIELDS);
const MAX_DIGEST_ROWS = 200;
const MAX_DIGEST_CLAIMS = 1_000;

export interface ZonedDateTime {
  readonly date: string;
  readonly hour: number;
  readonly minute: number;
}

export interface DigestSchedule {
  readonly enabled: boolean;
  readonly atLocalTime: string;
  readonly timezone: string;
}

/** Calendar date and clock time at `epochMs` in an IANA timezone. */
export function zonedDateTime(epochMs: number, timezone: string): ZonedDateTime {
  const parts = dateTimeParts(epochMs, resolveDigestTimezone(timezone));
  return {
    date: `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}`,
    hour: parts.hour,
    minute: parts.minute,
  };
}

/** Returns the most recent configured-zone date whose digest time has passed. */
export function scheduledDigestDate(epochMs: number, schedule: DigestSchedule): string | null {
  if (!schedule.enabled) return null;
  const local = zonedDateTime(epochMs, schedule.timezone);
  const [dueHour, dueMinute] = schedule.atLocalTime.split(':').map(Number);
  const dueMinutes = (dueHour ?? 0) * 60 + (dueMinute ?? 0);
  if (local.hour * 60 + local.minute >= dueMinutes) return local.date;

  const [year, month, day] = local.date.split('-').map(Number);
  const previous = new Date(Date.UTC(year ?? 0, (month ?? 1) - 1, (day ?? 1) - 1));
  return `${previous.getUTCFullYear()}-${pad2(previous.getUTCMonth() + 1)}-${pad2(previous.getUTCDate())}`;
}

/** Local-midnight bounds for `date` (YYYY-MM-DD), returned as UTC ISO strings. */
export function localDayBounds(
  date: string,
  timezone: number | string,
): {
  fromIso: string;
  toIso: string;
} {
  // Validate the shape explicitly: "29-07-2026" would otherwise split into
  // three numbers and silently produce a range in the year 29.
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (match === null) {
    throw new Error(`invalid date "${date}", expected YYYY-MM-DD`);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    throw new Error(`invalid date "${date}": calendar day does not exist`);
  }

  if (typeof timezone === 'number') {
    const startUtcMs = Date.UTC(year, month - 1, day) + timezone * 60_000;
    return {
      fromIso: new Date(startUtcMs).toISOString(),
      toIso: new Date(startUtcMs + 86_400_000).toISOString(),
    };
  }

  const zone = resolveDigestTimezone(timezone);
  const nextDate = new Date(Date.UTC(year, month - 1, day + 1));
  const startUtcMs = startOfLocalDate(year, month, day, zone);
  const endUtcMs = startOfLocalDate(
    nextDate.getUTCFullYear(),
    nextDate.getUTCMonth() + 1,
    nextDate.getUTCDate(),
    zone,
  );
  return {
    fromIso: new Date(startUtcMs).toISOString(),
    toIso: new Date(endUtcMs).toISOString(),
  };
}

export function buildDigest(
  db: DatabaseSync,
  date: string,
  timezone: number | string,
  processingHost: string,
): Digest {
  const { fromIso, toIso } = localDayBounds(date, timezone);

  const rows = db
    .prepare(
      `SELECT s.session_id, s.started_at, s.speech_ms,
              r.revision_id, m.summary_id, m.payload
         FROM audio_sessions s
         LEFT JOIN transcript_revisions r
           ON r.session_id = s.session_id AND r.is_current = 1
         LEFT JOIN summaries m
           ON m.session_id = s.session_id AND m.revision_id = r.revision_id
        WHERE s.started_at >= ? AND s.started_at < ?
          AND s.state = 'DONE'
        ORDER BY s.started_at, s.session_id
        LIMIT ?`,
    )
    .all(fromIso, toIso, MAX_DIGEST_ROWS + 1) as {
    session_id: string;
    started_at: string;
    speech_ms: number;
    revision_id: string | null;
    summary_id: string | null;
    payload: string | null;
  }[];
  if (rows.length > MAX_DIGEST_ROWS) {
    throw new Error(`digest ${date} exceeds the ${MAX_DIGEST_ROWS}-session safety bound`);
  }

  let claimCount = 0;
  const digestRows: DigestRow[] = rows.map((row) => {
    if (row.payload !== null && (row.revision_id === null || row.summary_id === null)) {
      throw new Error(`digest ${date} found a summary without an exact current revision identity`);
    }
    const segments =
      row.payload === null || row.revision_id === null
        ? []
        : (db
            .prepare(
              `SELECT text FROM transcript_segments
                WHERE revision_id = ? ORDER BY segment_index`,
            )
            .all(row.revision_id) as { text: string }[]);
    const summary =
      row.payload === null
        ? EMPTY_SUMMARY
        : boundClaimEvidence(parseSummary(JSON.parse(row.payload) as unknown), segments.length);
    const claimSources = digestClaimCoordinates(summary).map(({ field, item }) => ({
      field,
      item,
      ...resolveClaimSource(summary, field, item, segments),
    }));
    claimCount += claimSources.length;
    if (claimCount > MAX_DIGEST_CLAIMS) {
      throw new Error(`digest ${date} exceeds the ${MAX_DIGEST_CLAIMS}-claim safety bound`);
    }
    return {
      sessionId: row.session_id,
      startedAt: row.started_at,
      speechMs: row.speech_ms,
      summary: summary.summary,
      decisions: summary.decisions,
      tasks: summary.tasks,
      questions: summary.questions,
      summaryId: row.summary_id,
      summaryRevisionId: row.payload === null ? null : row.revision_id,
      claimSources,
    };
  });

  return {
    sourceKind: 'local_daily_digest',
    processingHost,
    date,
    sessionCount: digestRows.length,
    totalSpeechMs: digestRows.reduce((sum, r) => sum + r.speechMs, 0),
    claimSourceVersion: 2,
    rows: digestRows,
  };
}

function digestClaimCoordinates(
  summary: Pick<DigestRow, 'summary' | 'decisions' | 'tasks' | 'questions'>,
): { readonly field: DigestClaimField; readonly item: number }[] {
  const coordinates: { field: DigestClaimField; item: number }[] = [];
  if (summary.summary.length > 0) coordinates.push({ field: 'summary', item: 0 });
  for (const field of DIGEST_LIST_CLAIM_FIELDS) {
    summary[field].forEach((_, item) => {
      coordinates.push({ field, item });
    });
  }
  return coordinates;
}

/** Re-proves the complete session and current-summary snapshot at publication time. */
export function digestSnapshotStillCurrent(
  db: DatabaseSync,
  digest: Digest,
  timezone: number | string,
): boolean {
  if (digest.claimSourceVersion !== 2) return false;
  const { fromIso, toIso } = localDayBounds(digest.date, timezone);
  const rows = db
    .prepare(
      `SELECT s.session_id, s.state, s.started_at, s.speech_ms,
              r.revision_id, m.summary_id
         FROM audio_sessions s
         LEFT JOIN transcript_revisions r
           ON r.session_id = s.session_id AND r.is_current = 1
         LEFT JOIN summaries m
           ON m.session_id = s.session_id AND m.revision_id = r.revision_id
        WHERE s.started_at >= ? AND s.started_at < ?
        ORDER BY s.started_at, s.session_id`,
    )
    .all(fromIso, toIso) as {
    session_id: string;
    state: string;
    started_at: string;
    speech_ms: number;
    revision_id: string | null;
    summary_id: string | null;
  }[];
  if (
    rows.some((row) => ['ACTIVE', 'FINALIZING', 'PROCESSING', 'DELIVERING'].includes(row.state))
  ) {
    return false;
  }
  const done = rows.filter((row) => row.state === 'DONE');
  if (done.length !== digest.rows.length) return false;
  return done.every((row, index) => {
    const snapshot = digest.rows[index];
    if (snapshot === undefined) return false;
    const summaryRevisionId = row.summary_id === null ? null : row.revision_id;
    return (
      snapshot.sessionId === row.session_id &&
      snapshot.startedAt === row.started_at &&
      snapshot.speechMs === row.speech_ms &&
      snapshot.summaryId === row.summary_id &&
      snapshot.summaryRevisionId === summaryRevisionId
    );
  });
}

/** True while the day's digest can still gain data from an unfinished session. */
export function hasUnfinishedSessionsForDate(
  db: DatabaseSync,
  date: string,
  timezone: number | string,
): boolean {
  const { fromIso, toIso } = localDayBounds(date, timezone);
  return (
    db
      .prepare(
        `SELECT 1 AS present
           FROM audio_sessions
          WHERE started_at >= ? AND started_at < ?
            AND state IN ('ACTIVE','FINALIZING','PROCESSING','DELIVERING')
          LIMIT 1`,
      )
      .get(fromIso, toIso) !== undefined
  );
}

export function resolveDigestTimezone(timezone: string): string {
  return timezone === 'local' ? Intl.DateTimeFormat().resolvedOptions().timeZone : timezone;
}

function dateTimeParts(
  epochMs: number,
  timezone: string,
): { year: number; month: number; day: number; hour: number; minute: number } {
  const formatted = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(epochMs);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    Number(formatted.find((part) => part.type === type)?.value);
  return {
    year: value('year'),
    month: value('month'),
    day: value('day'),
    hour: value('hour'),
    minute: value('minute'),
  };
}

/** Finds the first UTC instant belonging to the requested local calendar date. */
function startOfLocalDate(year: number, month: number, day: number, timezone: string): number {
  const targetDate = year * 10_000 + month * 100 + day;
  const targetWallMs = Date.UTC(year, month - 1, day);
  // IANA offsets fit well inside this window. Searching for the date boundary,
  // rather than an exact 00:00, also handles zones that jump from 23:59 to 01:00.
  let before = targetWallMs - 48 * 60 * 60 * 1000;
  let atOrAfter = targetWallMs + 48 * 60 * 60 * 1000;

  const localDateAt = (epochMs: number) => {
    const parts = dateTimeParts(epochMs, timezone);
    return parts.year * 10_000 + parts.month * 100 + parts.day;
  };
  if (localDateAt(before) >= targetDate || localDateAt(atOrAfter) < targetDate) {
    throw new Error(`could not bracket ${year}-${pad2(month)}-${pad2(day)} in ${timezone}`);
  }

  while (atOrAfter - before > 1) {
    const candidate = Math.floor((before + atOrAfter) / 2);
    if (localDateAt(candidate) < targetDate) before = candidate;
    else atOrAfter = candidate;
  }
  if (localDateAt(atOrAfter) !== targetDate) {
    throw new Error(
      `calendar date ${year}-${pad2(month)}-${pad2(day)} does not exist in ${timezone}`,
    );
  }
  return atOrAfter;
}

const pad2 = (value: number) => String(value).padStart(2, '0');

export function renderDigest(digest: Digest, timezone: number | string): string {
  const provenance = renderDigestProvenanceHtml(digest);
  if (digest.sessionCount === 0) {
    return `📅 <b>Дайджест за ${escapeHtml(digest.date)}</b>\n\n${provenance}\n\nСессий не было.`;
  }

  const lines = [
    `📅 <b>Дайджест за ${escapeHtml(digest.date)}</b>`,
    '',
    provenance,
    '',
    `Сессий: ${digest.sessionCount}`,
    `Всего речи: ${formatDuration(digest.totalSpeechMs)}`,
  ];

  const section = (title: string, field: Exclude<DigestClaimField, 'summary'>) => {
    const claims = digest.rows.flatMap((row) =>
      row[field].map((text, item) => ({ row, text, item })),
    );
    if (claims.length === 0) return;
    lines.push('', `<b>${title}</b>`);
    for (const claim of claims) {
      lines.push(`• ${escapeHtml(displayDigestText(claim.text))}`);
      lines.push(`↳ ${digestClaimContextHtml(digest, claim.row, field, claim.item, timezone)}`);
    }
  };

  section('Черновик модели: решения', 'decisions');
  section('Черновик модели: задачи', 'tasks');
  section('Черновик модели: открытые вопросы', 'questions');

  lines.push('', '<b>Сессии:</b>');
  for (const row of digest.rows) {
    const time = formatClockInZone(row.startedAt, timezone);
    if (row.summary.length === 0) {
      lines.push(`• ${time} — (без резюме)`);
      continue;
    }
    lines.push(`• ${time} — <i>черновик модели</i>: ${escapeHtml(displayDigestText(row.summary))}`);
    lines.push(`↳ ${digestClaimContextHtml(digest, row, 'summary', 0, timezone)}`);
  }

  return lines.join('\n');
}

export function renderDigestMarkdown(digest: Digest, timezone: number | string): string {
  const lines = [
    `# Дайджест OpenMurmur — ${digest.date}`,
    '',
    `- Источник: локальный дневной дайджест OpenMurmur`,
    `- Хост обработки: ${escapeMarkdown(displayDigestText(digest.processingHost))}`,
    `- Сессий: ${digest.sessionCount}`,
    `- Всего речи: ${formatDuration(digest.totalSpeechMs)}`,
  ];

  const section = (title: string, field: Exclude<DigestClaimField, 'summary'>) => {
    const claims = digest.rows.flatMap((row) =>
      row[field].map((text, item) => ({ row, text, item })),
    );
    if (claims.length === 0) return;
    lines.push('', `## ${title}`, '');
    for (const claim of claims) {
      lines.push(
        `- ${escapeMarkdown(displayDigestText(claim.text))}`,
        `  - ${digestClaimContextMarkdown(digest, claim.row, field, claim.item, timezone)}`,
      );
    }
  };
  section('Черновик модели: решения', 'decisions');
  section('Черновик модели: задачи', 'tasks');
  section('Черновик модели: открытые вопросы', 'questions');

  if (digest.rows.length > 0) {
    lines.push('', '## Сессии', '');
    for (const row of digest.rows) {
      const time = formatClockInZone(row.startedAt, timezone);
      if (row.summary.length === 0) {
        lines.push(`- ${time} — (без резюме)`);
        continue;
      }
      lines.push(
        `- ${time} — черновик модели: ${escapeMarkdown(displayDigestText(row.summary))}`,
        `  - ${digestClaimContextMarkdown(digest, row, 'summary', 0, timezone)}`,
      );
    }
  }
  return `${lines.join('\n')}\n`;
}

function digestClaimSource(
  row: DigestRow,
  field: DigestClaimField,
  item: number,
): DigestClaimSource | undefined {
  return row.claimSources?.find((source) => source.field === field && source.item === item);
}

function digestClaimContextHtml(
  digest: Digest,
  row: DigestRow,
  field: DigestClaimField,
  item: number,
  timezone: number | string,
): string {
  const session = `сессия <code>${escapeHtml(displayDigestText(row.sessionId))}</code>`;
  const time = `время ${escapeHtml(formatClockInZone(row.startedAt, timezone))}`;
  if (digest.claimSourceVersion !== 2) {
    return `${session}; ${time}; legacy snapshot: источник model claim не сохранён`;
  }
  const revision =
    row.summaryRevisionId === null || row.summaryRevisionId === undefined
      ? 'резюме текущей ревизии отсутствует'
      : `ревизия <code>${escapeHtml(displayDigestText(row.summaryRevisionId))}</code>`;
  const source = digestClaimSource(row, field, item);
  const label = source === undefined ? 'ссылка модели: не указана' : renderClaimSourceLabel(source);
  return `${session}; ${time}; ${revision}; ${escapeHtml(displayDigestText(label))}`;
}

function digestClaimContextMarkdown(
  digest: Digest,
  row: DigestRow,
  field: DigestClaimField,
  item: number,
  timezone: number | string,
): string {
  const session = `сессия \`${escapeMarkdown(displayDigestText(row.sessionId))}\``;
  const time = `время ${escapeMarkdown(formatClockInZone(row.startedAt, timezone))}`;
  if (digest.claimSourceVersion !== 2) {
    return `${session}; ${time}; legacy snapshot: источник model claim не сохранён`;
  }
  const revision =
    row.summaryRevisionId === null || row.summaryRevisionId === undefined
      ? 'резюме текущей ревизии отсутствует'
      : `ревизия \`${escapeMarkdown(displayDigestText(row.summaryRevisionId))}\``;
  const source = digestClaimSource(row, field, item);
  const label = source === undefined ? 'ссылка модели: не указана' : renderClaimSourceLabel(source);
  return `${session}; ${time}; ${revision}; ${escapeMarkdown(displayDigestText(label))}`;
}

export function renderDigestCaption(digest: Digest): string {
  return `📅 Дайджест за ${digest.date}\n\n${renderDigestProvenanceHtml(digest)}`;
}

function renderDigestProvenanceHtml(digest: Digest): string {
  return [
    'Источник: локальный дневной дайджест OpenMurmur',
    `Хост обработки: <code>${escapeHtml(displayDigestText(digest.processingHost))}</code>`,
  ].join('\n');
}

function formatClockInZone(iso: string, timezone: number | string): string {
  const epochMs = Date.parse(iso);
  if (typeof timezone === 'number') {
    return new Date(epochMs - timezone * 60_000).toISOString().slice(11, 16);
  }
  const local = zonedDateTime(epochMs, timezone);
  return `${pad2(local.hour)}:${pad2(local.minute)}`;
}

/** Stable artifact identity prevents a losing concurrent builder from replacing the winner. */
export function digestDocumentFilename(digest: Digest, markdown: string): string {
  const hash = createHash('sha256').update(markdown, 'utf8').digest('hex');
  return `digest-${digest.date}-${hash}.md`;
}

/** First writer wins. Returns false without mutating the durable snapshot. */
export function storeDigest(db: DatabaseSync, digest: Digest): boolean {
  const result = db
    .prepare(
      `INSERT INTO digests (digest_id, digest_date, session_count, speech_ms, payload, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (digest_date) DO NOTHING`,
    )
    .run(
      randomUUID(),
      digest.date,
      digest.sessionCount,
      digest.totalSpeechMs,
      JSON.stringify(digest),
      new Date().toISOString(),
    );
  return result.changes === 1;
}

export function readStoredDigest(db: DatabaseSync, date: string): Digest | undefined {
  const row = db.prepare('SELECT payload FROM digests WHERE digest_date = ?').get(date) as
    | { payload: string }
    | undefined;
  if (row === undefined) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(row.payload);
  } catch (error) {
    throw new Error(`stored digest ${date} has invalid payload JSON`, { cause: error });
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return invalidStoredDigest(date, 'payload', 'an object');
  }
  const record = parsed as Record<string, unknown>;
  if (record['sourceKind'] !== 'local_daily_digest') {
    return invalidStoredDigest(date, 'sourceKind', 'local_daily_digest');
  }
  if (typeof record['processingHost'] !== 'string' || record['processingHost'].trim() === '') {
    return invalidStoredDigest(date, 'processingHost', 'a non-empty string');
  }
  if (record['date'] !== date) {
    return invalidStoredDigest(date, 'date', `the requested date ${date}`);
  }
  const rawClaimSourceVersion = record['claimSourceVersion'];
  if (rawClaimSourceVersion !== undefined && rawClaimSourceVersion !== 2) {
    return invalidStoredDigest(date, 'claimSourceVersion', '2 or absent for a legacy snapshot');
  }
  const claimSourceVersion = rawClaimSourceVersion === 2 ? 2 : undefined;
  const sessionCount = record['sessionCount'];
  if (!Number.isInteger(sessionCount) || (sessionCount as number) < 0) {
    return invalidStoredDigest(date, 'sessionCount', 'a non-negative integer');
  }
  const totalSpeechMs = record['totalSpeechMs'];
  if (typeof totalSpeechMs !== 'number' || !Number.isFinite(totalSpeechMs) || totalSpeechMs < 0) {
    return invalidStoredDigest(date, 'totalSpeechMs', 'a finite non-negative number');
  }
  const rawRows = record['rows'];
  if (!Array.isArray(rawRows)) {
    return invalidStoredDigest(date, 'rows', 'an array');
  }
  if (claimSourceVersion === 2 && rawRows.length > MAX_DIGEST_ROWS) {
    return invalidStoredDigest(date, 'rows', `at most ${MAX_DIGEST_ROWS} sessions`);
  }
  if (sessionCount !== rawRows.length) {
    return invalidStoredDigest(date, 'sessionCount', `rows.length (${rawRows.length})`);
  }
  const rows = rawRows.map((row, index) =>
    validateStoredDigestRow(date, row, index, claimSourceVersion),
  );
  const claimCount = rows.reduce((sum, row) => sum + digestClaimCoordinates(row).length, 0);
  if (claimSourceVersion === 2 && claimCount > MAX_DIGEST_CLAIMS) {
    return invalidStoredDigest(date, 'rows', `at most ${MAX_DIGEST_CLAIMS} model claims`);
  }
  const rowSpeechMs = rows.reduce((sum, row) => sum + row.speechMs, 0);
  if (!Number.isFinite(rowSpeechMs) || totalSpeechMs !== rowSpeechMs) {
    return invalidStoredDigest(date, 'totalSpeechMs', `the row speech sum (${rowSpeechMs})`);
  }
  return {
    sourceKind: 'local_daily_digest',
    processingHost: record['processingHost'],
    date,
    sessionCount,
    totalSpeechMs,
    ...(claimSourceVersion === 2 ? { claimSourceVersion } : {}),
    rows,
  };
}

function validateStoredDigestRow(
  date: string,
  value: unknown,
  index: number,
  claimSourceVersion: 2 | undefined,
): DigestRow {
  const field = (name: string) => `rows[${index}].${name}`;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return invalidStoredDigest(date, `rows[${index}]`, 'an object');
  }
  const row = value as Record<string, unknown>;
  if (typeof row['sessionId'] !== 'string' || row['sessionId'].trim() === '') {
    return invalidStoredDigest(date, field('sessionId'), 'a non-empty string');
  }
  if (!isCanonicalIsoTimestamp(row['startedAt'])) {
    return invalidStoredDigest(date, field('startedAt'), 'a canonical UTC ISO timestamp');
  }
  if (
    typeof row['speechMs'] !== 'number' ||
    !Number.isFinite(row['speechMs']) ||
    row['speechMs'] < 0
  ) {
    return invalidStoredDigest(date, field('speechMs'), 'a finite non-negative number');
  }
  if (typeof row['summary'] !== 'string') {
    return invalidStoredDigest(date, field('summary'), 'a string');
  }
  for (const name of ['decisions', 'tasks', 'questions'] as const) {
    const list = row[name];
    if (!Array.isArray(list) || !list.every((item) => typeof item === 'string')) {
      return invalidStoredDigest(date, field(name), 'an array of strings');
    }
  }
  const base: DigestRow = {
    sessionId: row['sessionId'],
    startedAt: row['startedAt'],
    speechMs: row['speechMs'],
    summary: row['summary'],
    decisions: row['decisions'] as string[],
    tasks: row['tasks'] as string[],
    questions: row['questions'] as string[],
  };
  if (claimSourceVersion === undefined) {
    if (
      Object.hasOwn(row, 'summaryId') ||
      Object.hasOwn(row, 'summaryRevisionId') ||
      Object.hasOwn(row, 'claimSources')
    ) {
      return invalidStoredDigest(
        date,
        `rows[${index}]`,
        'legacy fields only when claimSourceVersion is absent',
      );
    }
    return base;
  }

  const summaryId = nullableIdentity(date, row['summaryId'], field('summaryId'));
  const summaryRevisionId = nullableIdentity(
    date,
    row['summaryRevisionId'],
    field('summaryRevisionId'),
  );
  if ((summaryId === null) !== (summaryRevisionId === null)) {
    return invalidStoredDigest(
      date,
      `rows[${index}]`,
      'summaryId and summaryRevisionId to both be null or both be identities',
    );
  }
  const expected = digestClaimCoordinates(base);
  if (summaryRevisionId === null && expected.length > 0) {
    return invalidStoredDigest(
      date,
      field('summaryRevisionId'),
      'an identity when model claims are present',
    );
  }
  const rawSources = row['claimSources'];
  if (!Array.isArray(rawSources)) {
    return invalidStoredDigest(date, field('claimSources'), 'an array');
  }
  const claimSources = rawSources.map((source, sourceIndex) =>
    validateDigestClaimSource(date, source, index, sourceIndex),
  );
  const keys = claimSources.map((source) => `${source.field}:${source.item}`);
  const expectedKeys = expected.map(({ field: expectedField, item }) => `${expectedField}:${item}`);
  if (
    keys.length !== expectedKeys.length ||
    new Set(keys).size !== keys.length ||
    keys.some((key, sourceIndex) => key !== expectedKeys[sourceIndex])
  ) {
    return invalidStoredDigest(
      date,
      field('claimSources'),
      'exactly one source entry for every visible model claim in field/item order',
    );
  }
  return { ...base, summaryId, summaryRevisionId, claimSources };
}

function nullableIdentity(date: string, value: unknown, field: string): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || value.trim() === '' || value.length > 200) {
    return invalidStoredDigest(date, field, 'null or a non-empty identity up to 200 characters');
  }
  return value;
}

function validateDigestClaimSource(
  date: string,
  value: unknown,
  rowIndex: number,
  sourceIndex: number,
): DigestClaimSource {
  const root = `rows[${rowIndex}].claimSources[${sourceIndex}]`;
  const field = (name: string) => `${root}.${name}`;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return invalidStoredDigest(date, root, 'an object');
  }
  const source = value as Record<string, unknown>;
  const sourceField = source['field'];
  if (typeof sourceField !== 'string' || !DIGEST_CLAIM_FIELD_SET.has(sourceField)) {
    return invalidStoredDigest(date, field('field'), DIGEST_CLAIM_FIELDS.join(', '));
  }
  const item = source['item'];
  if (!Number.isInteger(item) || (item as number) < 0 || (item as number) >= 20) {
    return invalidStoredDigest(date, field('item'), 'an integer from 0 through 19');
  }
  const segments = source['segments'];
  if (!isDigestSegmentIndexes(segments)) {
    return invalidStoredDigest(
      date,
      field('segments'),
      'up to 20 unique segment indexes below 1000000',
    );
  }
  const kind = source['kind'];
  if (!['missing', 'referenced', 'unlocalized', 'localized'].includes(String(kind))) {
    return invalidStoredDigest(date, field('kind'), 'a supported source status');
  }
  const allowedKeys = new Set([
    'field',
    'item',
    'kind',
    'segments',
    ...(kind === 'localized' ? ['localizedSegment', 'excerpt'] : []),
  ]);
  if (Object.keys(source).some((key) => !allowedKeys.has(key))) {
    return invalidStoredDigest(date, root, 'only bounded claim-source fields');
  }
  const normalizedSegments = segments;
  const base = {
    field: sourceField as DigestClaimField,
    item: item as number,
    segments: normalizedSegments,
  };
  if (kind === 'missing') {
    if (
      normalizedSegments.length !== 0 ||
      Object.hasOwn(source, 'localizedSegment') ||
      Object.hasOwn(source, 'excerpt')
    ) {
      return invalidStoredDigest(date, field('segments'), 'empty when kind is missing');
    }
    return { ...base, kind, segments: [] };
  }
  if (normalizedSegments.length === 0) {
    return invalidStoredDigest(date, field('segments'), `non-empty when kind is ${String(kind)}`);
  }
  if (kind === 'referenced' || kind === 'unlocalized') {
    if (Object.hasOwn(source, 'localizedSegment') || Object.hasOwn(source, 'excerpt')) {
      return invalidStoredDigest(date, root, `${kind} fields without localized excerpt data`);
    }
    return { ...base, kind };
  }

  const localizedSegment = source['localizedSegment'];
  if (
    typeof localizedSegment !== 'number' ||
    !Number.isInteger(localizedSegment) ||
    !normalizedSegments.includes(localizedSegment)
  ) {
    return invalidStoredDigest(
      date,
      field('localizedSegment'),
      'one of the referenced segment indexes',
    );
  }
  const excerpt = source['excerpt'];
  if (
    typeof excerpt !== 'string' ||
    excerpt.length === 0 ||
    [...new Intl.Segmenter('und', { granularity: 'grapheme' }).segment(excerpt)].length > 122 ||
    escapeHtml(excerpt).length > 320
  ) {
    return invalidStoredDigest(date, field('excerpt'), 'a bounded non-empty source excerpt');
  }
  return { ...base, kind: 'localized', localizedSegment, excerpt };
}

function isDigestSegmentIndexes(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    value.length <= 20 &&
    value.every(
      (segment) =>
        typeof segment === 'number' &&
        Number.isInteger(segment) &&
        segment >= 0 &&
        segment < 1_000_000,
    ) &&
    new Set(value).size === value.length
  );
}

function isCanonicalIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const epochMs = Date.parse(value);
  return Number.isFinite(epochMs) && new Date(epochMs).toISOString() === value;
}

function invalidStoredDigest(date: string, field: string, expected: string): never {
  throw new Error(
    `stored digest ${date} has invalid ${field}; expected ${expected}. The durable snapshot was left unchanged.`,
  );
}

function displayDigestText(value: string): string {
  let safe = '';
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    const bidiControl =
      code === 0x061c ||
      code === 0x200e ||
      code === 0x200f ||
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2066 && code <= 0x2069);
    if (bidiControl) {
      safe += '�';
    } else if (code === 9 || code === 10 || code === 13) {
      safe += ' ';
    } else {
      safe += code <= 31 || (code >= 127 && code <= 159) ? '�' : character;
    }
  }
  return safe.replace(/\s+/gu, ' ').trim();
}

function escapeMarkdown(text: string): string {
  const punctuation = new Set('\\`*_{}[]()#+.!|><&-');
  return [...text]
    .map((character) => (punctuation.has(character) ? `\\${character}` : character))
    .join('');
}

export function hoursSinceLastDigest(db: DatabaseSync): number | null {
  const row = db.prepare('SELECT MAX(created_at) AS t FROM digests').get() as { t: string | null };
  if (row.t === null) return null;
  return (Date.now() - Date.parse(row.t)) / 3_600_000;
}
