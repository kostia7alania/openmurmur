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

/** Local-midnight bounds for `date` (YYYY-MM-DD), returned as UTC ISO strings. */
export function localDayBounds(
  date: string,
  timezoneOffsetMinutes: number,
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
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    throw new Error(`invalid date "${date}": month and day are out of range`);
  }
  const startUtcMs = Date.UTC(year, month - 1, day) + timezoneOffsetMinutes * 60_000;
  return {
    fromIso: new Date(startUtcMs).toISOString(),
    toIso: new Date(startUtcMs + 86_400_000).toISOString(),
  };
}

export function buildDigest(db: DatabaseSync, date: string, timezoneOffsetMinutes: number): Digest {
  const { fromIso, toIso } = localDayBounds(date, timezoneOffsetMinutes);

  const rows = db
    .prepare(
      `SELECT s.session_id, s.started_at, s.speech_ms, m.payload
         FROM audio_sessions s
         LEFT JOIN summaries m ON m.session_id = s.session_id
        WHERE s.started_at >= ? AND s.started_at < ?
          AND s.state IN ('DONE','DELIVERING')
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

export function renderDigest(digest: Digest): string {
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
    const time = row.startedAt.slice(11, 16);
    const preview = row.summary.length > 0 ? row.summary.slice(0, 120) : '(без резюме)';
    lines.push(`• ${time} — ${escapeHtml(preview)}`);
  }

  return lines.join('\n');
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

export function hoursSinceLastDigest(db: DatabaseSync): number | null {
  const row = db.prepare('SELECT MAX(created_at) AS t FROM digests').get() as { t: string | null };
  if (row.t === null) return null;
  return (Date.now() - Date.parse(row.t)) / 3_600_000;
}
