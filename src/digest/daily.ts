import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
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
}

export interface Digest {
  readonly date: string;
  readonly sessionCount: number;
  readonly totalSpeechMs: number;
  readonly rows: readonly DigestRow[];
}

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
  const parts = dateTimeParts(epochMs, resolveTimezone(timezone));
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

  const zone = resolveTimezone(timezone);
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

export function buildDigest(db: DatabaseSync, date: string, timezone: number | string): Digest {
  const { fromIso, toIso } = localDayBounds(date, timezone);

  const rows = db
    .prepare(
      `SELECT s.session_id, s.started_at, s.speech_ms, m.payload
         FROM audio_sessions s
         LEFT JOIN summaries m ON m.summary_id = (
           SELECT m2.summary_id FROM summaries m2
            WHERE m2.session_id = s.session_id
            ORDER BY m2.created_at DESC, m2.rowid DESC
            LIMIT 1
         )
        WHERE s.started_at >= ? AND s.started_at < ?
          AND s.state = 'DONE'
        ORDER BY s.started_at`,
    )
    .all(fromIso, toIso) as {
    session_id: string;
    started_at: string;
    speech_ms: number;
    payload: string | null;
  }[];

  const digestRows: DigestRow[] = rows.map((row) => {
    const parsed =
      row.payload === null
        ? null
        : (JSON.parse(row.payload) as {
            summary?: string;
            decisions?: string[];
            tasks?: string[];
            questions?: string[];
          });
    return {
      sessionId: row.session_id,
      startedAt: row.started_at,
      speechMs: row.speech_ms,
      summary: parsed?.summary ?? '',
      decisions: parsed?.decisions ?? [],
      tasks: parsed?.tasks ?? [],
      questions: parsed?.questions ?? [],
    };
  });

  return {
    date,
    sessionCount: digestRows.length,
    totalSpeechMs: digestRows.reduce((sum, r) => sum + r.speechMs, 0),
    rows: digestRows,
  };
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

function resolveTimezone(timezone: string): string {
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
  if (digest.sessionCount === 0) {
    return `📅 <b>Дайджест за ${escapeHtml(digest.date)}</b>\n\nСессий не было.`;
  }

  const allTasks = digest.rows.flatMap((r) => r.tasks);
  const allDecisions = digest.rows.flatMap((r) => r.decisions);
  const allQuestions = digest.rows.flatMap((r) => r.questions);

  const lines = [
    `📅 <b>Дайджест за ${escapeHtml(digest.date)}</b>`,
    '',
    `Сессий: ${digest.sessionCount}`,
    `Всего речи: ${formatDuration(digest.totalSpeechMs)}`,
  ];

  const section = (title: string, items: readonly string[]) => {
    if (items.length === 0) return;
    lines.push('', `<b>${title}</b>`);
    // Same fact said twice in a day is one line, not two.
    for (const item of [...new Set(items)].slice(0, 20)) {
      lines.push(`• ${escapeHtml(item)}`);
    }
  };

  section('Решения за день:', allDecisions);
  section('Задачи за день:', allTasks);
  section('Открытые вопросы:', allQuestions);

  lines.push('', '<b>Сессии:</b>');
  for (const row of digest.rows) {
    const time = formatClockInZone(row.startedAt, timezone);
    const preview = row.summary.length > 0 ? row.summary.slice(0, 120) : '(без резюме)';
    lines.push(`• ${time} — ${escapeHtml(preview)}`);
  }

  return lines.join('\n');
}

export function renderDigestMarkdown(digest: Digest, timezone: number | string): string {
  const lines = [
    `# OpenMurmur digest — ${digest.date}`,
    '',
    `- Sessions: ${digest.sessionCount}`,
    `- Total speech: ${formatDuration(digest.totalSpeechMs)}`,
  ];

  const section = (title: string, items: readonly string[]) => {
    if (items.length === 0) return;
    lines.push('', `## ${title}`, '');
    for (const item of [...new Set(items)]) lines.push(`- ${escapeMarkdown(item)}`);
  };
  section(
    'Decisions',
    digest.rows.flatMap((row) => row.decisions),
  );
  section(
    'Tasks',
    digest.rows.flatMap((row) => row.tasks),
  );
  section(
    'Open questions',
    digest.rows.flatMap((row) => row.questions),
  );

  if (digest.rows.length > 0) {
    lines.push('', '## Sessions', '');
    for (const row of digest.rows) {
      const preview = row.summary.length > 0 ? row.summary : '(no summary)';
      lines.push(`- ${formatClockInZone(row.startedAt, timezone)} — ${escapeMarkdown(preview)}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

function formatClockInZone(iso: string, timezone: number | string): string {
  const epochMs = Date.parse(iso);
  if (typeof timezone === 'number') {
    return new Date(epochMs - timezone * 60_000).toISOString().slice(11, 16);
  }
  const local = zonedDateTime(epochMs, timezone);
  return `${pad2(local.hour)}:${pad2(local.minute)}`;
}

export function storeDigest(db: DatabaseSync, digest: Digest): void {
  db.prepare(
    `INSERT INTO digests (digest_id, digest_date, session_count, speech_ms, payload, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (digest_date) DO UPDATE SET
       session_count = excluded.session_count,
       speech_ms = excluded.speech_ms,
       payload = excluded.payload`,
  ).run(
    randomUUID(),
    digest.date,
    digest.sessionCount,
    digest.totalSpeechMs,
    JSON.stringify(digest),
    new Date().toISOString(),
  );
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
