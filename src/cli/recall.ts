import { open } from 'node:fs/promises';
import type { DatabaseSync } from 'node:sqlite';
import { literalSnippet, unicodeFold, validatedSearchQuery } from '../database/search.ts';

export type SourceAudioAvailability = 'available' | 'partial' | 'deleted' | 'unknown';

export interface SourceAudioFacts {
  readonly expectedParts: number;
  readonly knownParts: number;
  readonly finalizedParts: number;
  readonly availableParts: number;
  readonly deletedParts: number;
  readonly unknownParts: number;
}

export interface RecallMatch {
  readonly revisionId: string;
  readonly sessionId: string;
  /** UTC ISO timestamp, normalized from the durable session timestamp. */
  readonly recordedAt: string;
  /** IANA timezone captured with the session; null means provenance is unavailable. */
  readonly captureTimezone: string | null;
  readonly captureHost: string | null;
  readonly snippet: string;
  readonly audioAvailability: SourceAudioAvailability;
  readonly audioAvailabilityBasis: 'filesystem_snapshot';
  readonly audioCheckedAt: string;
  readonly audioExpectedParts: number;
  readonly audioKnownParts: number;
  readonly audioAvailableParts: number;
  readonly audioDeletedParts: number;
  readonly audioUnknownParts: number;
}

export interface RecallOptions {
  readonly query: string;
  readonly limit?: number | string;
  readonly since?: string | null | undefined;
  readonly until?: string | null | undefined;
}

export interface NormalizedRecallOptions {
  readonly query: string;
  readonly limit: number;
  readonly since: string | null;
  readonly until: string | null;
}

interface RecallRow {
  readonly revision_id: string;
  readonly session_id: string;
  readonly recorded_at: string;
  readonly capture_timezone: string | null;
  readonly capture_host: string | null;
  readonly revision_text: string;
  readonly expected_parts: number;
}

interface AudioPartRow {
  readonly path: string;
  readonly finalized: number;
  readonly deleted_at: string | null;
}

const MAX_RESULTS = 200;
const ISO_TIMESTAMP =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:\d{2})$/;

function parseLimit(value: number | string | undefined): number {
  if (value === undefined) return 20;
  const validString = typeof value === 'string' && /^[1-9]\d*$/.test(value);
  const parsed = validString ? Number(value) : value;
  if (
    typeof parsed !== 'number' ||
    !Number.isSafeInteger(parsed) ||
    parsed < 1 ||
    parsed > MAX_RESULTS
  ) {
    throw new Error(`recall limit must be an integer from 1 to ${MAX_RESULTS}`);
  }
  return parsed;
}

function daysInMonth(year: number, month: number): number {
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ?? 0;
}

function normalizeTimestamp(
  value: string | null | undefined,
  name: 'since' | 'until',
): string | null {
  if (value == null) return null;
  const match = ISO_TIMESTAMP.exec(value);
  if (match === null) {
    throw new Error(`recall --${name} must be an ISO timestamp with a timezone`);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = match[6] === undefined ? 0 : Number(match[6]);
  const offset = match[8] ?? 'Z';
  const offsetHour = offset === 'Z' ? 0 : Number(offset.slice(1, 3));
  const offsetMinute = offset === 'Z' ? 0 : Number(offset.slice(4, 6));
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth(year, month) ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHour > 23 ||
    offsetMinute > 59
  ) {
    throw new Error(`recall --${name} is not a valid calendar timestamp`);
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new Error(`recall --${name} is not a valid calendar timestamp`);
  }
  return new Date(timestamp).toISOString();
}

export function normalizeRecallOptions(options: RecallOptions): NormalizedRecallOptions {
  const since = normalizeTimestamp(options.since, 'since');
  const until = normalizeTimestamp(options.until, 'until');
  if (since !== null && until !== null && since >= until) {
    throw new Error('recall --since must be earlier than --until');
  }
  return {
    query: options.query.trim(),
    limit: parseLimit(options.limit),
    since,
    until,
  };
}

export function sourceAudioAvailability(facts: SourceAudioFacts): SourceAudioAvailability {
  const completeManifest =
    facts.expectedParts > 0 &&
    facts.knownParts === facts.expectedParts &&
    facts.finalizedParts === facts.expectedParts &&
    facts.availableParts + facts.deletedParts + facts.unknownParts === facts.expectedParts;
  if (!completeManifest || facts.unknownParts > 0) return 'unknown';
  if (facts.availableParts === facts.expectedParts) return 'available';
  if (facts.deletedParts === facts.expectedParts) return 'deleted';
  if (facts.availableParts > 0 && facts.deletedParts > 0) return 'partial';
  return 'unknown';
}

function isMissing(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error as Error & { readonly code: string }).code === 'ENOENT'
  );
}

async function inspectSourceAudio(
  expectedParts: number,
  parts: readonly AudioPartRow[],
): Promise<{ readonly facts: SourceAudioFacts; readonly checkedAt: string }> {
  let availableParts = 0;
  let deletedParts = 0;
  let unknownParts = 0;
  const handles = [];
  try {
    for (const part of parts) {
      try {
        const handle = await open(part.path, 'r');
        handles.push(handle);
        const stat = await handle.stat();
        // A tombstoned path still being readable is inconsistent durable state,
        // not proof that retention will continue to preserve the source.
        if (stat.isFile() && part.deleted_at === null) availableParts += 1;
        else unknownParts += 1;
      } catch (error) {
        if (isMissing(error) && part.deleted_at !== null) deletedParts += 1;
        else unknownParts += 1;
      }
    }
    return {
      facts: {
        expectedParts,
        knownParts: parts.length,
        finalizedParts: parts.filter((part) => part.finalized === 1).length,
        availableParts,
        deletedParts,
        unknownParts,
      },
      // All successfully opened sources are still held at this instant. This
      // makes the result an explicit snapshot rather than a durable live claim.
      checkedAt: new Date().toISOString(),
    };
  } finally {
    await Promise.allSettled(handles.map((handle) => handle.close()));
  }
}

function normalizedStoredTimestamp(value: string): string {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : value;
}

export async function recallTranscripts(
  db: DatabaseSync,
  options: RecallOptions,
): Promise<RecallMatch[]> {
  const normalized = normalizeRecallOptions(options);
  const query = validatedSearchQuery(normalized.query);
  const foldedQuery = unicodeFold(query);
  const rows = (
    db
      .prepare(
        `SELECT r.revision_id,
              s.session_id,
              s.started_at AS recorded_at,
              s.capture_timezone,
              s.capture_host,
              r.text AS revision_text,
              s.part_count AS expected_parts
         FROM transcript_revisions r
         JOIN audio_sessions s ON s.session_id = r.session_id
        WHERE r.is_current = 1
          AND (? IS NULL OR s.started_at >= ?)
          AND (? IS NULL OR s.started_at < ?)
        ORDER BY recorded_at DESC, r.revision_id`,
      )
      .all(
        normalized.since,
        normalized.since,
        normalized.until,
        normalized.until,
      ) as unknown as RecallRow[]
  )
    .filter((row) => unicodeFold(row.revision_text).includes(foldedQuery))
    .slice(0, normalized.limit);

  const readParts = db.prepare(
    `SELECT path, finalized, deleted_at
       FROM audio_parts
      WHERE session_id = ?
      ORDER BY part_index`,
  );
  return Promise.all(
    rows.map(async (row) => {
      const parts = readParts.all(row.session_id) as unknown as AudioPartRow[];
      const audio = await inspectSourceAudio(row.expected_parts, parts);
      return {
        revisionId: row.revision_id,
        sessionId: row.session_id,
        recordedAt: normalizedStoredTimestamp(row.recorded_at),
        captureTimezone: row.capture_timezone,
        captureHost: row.capture_host,
        snippet: literalSnippet(row.revision_text, query),
        audioAvailability: sourceAudioAvailability(audio.facts),
        audioAvailabilityBasis: 'filesystem_snapshot',
        audioCheckedAt: audio.checkedAt,
        audioExpectedParts: audio.facts.expectedParts,
        audioKnownParts: audio.facts.knownParts,
        audioAvailableParts: audio.facts.availableParts,
        audioDeletedParts: audio.facts.deletedParts,
        audioUnknownParts: audio.facts.unknownParts,
      } satisfies RecallMatch;
    }),
  );
}

function terminalText(value: string): string {
  let safe = '';
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    const bidiControl =
      code === 0x061c ||
      code === 0x200e ||
      code === 0x200f ||
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2066 && code <= 0x2069);
    if (bidiControl) continue;
    safe += code <= 31 || (code >= 127 && code <= 159) ? ' ' : character;
  }
  return safe.replace(/\s+/g, ' ').trim();
}

function captureLocalTime(recordedAt: string, timezone: string): string | null {
  const timestamp = new Date(recordedAt);
  if (!Number.isFinite(timestamp.getTime())) return null;
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(timestamp);
    const value = (type: Intl.DateTimeFormatPartTypes): string =>
      parts.find((part) => part.type === type)?.value ?? '??';
    return `${value('year')}-${value('month')}-${value('day')} ${value('hour')}:${value('minute')}:${value('second')}`;
  } catch {
    return null;
  }
}

export function renderRecallResults(matches: readonly RecallMatch[], query: string): string {
  const safeQuery = terminalText(query);
  if (matches.length === 0) return `No grounded session match for "${safeQuery}".`;

  const lines = [
    `${matches.length} grounded session match${matches.length === 1 ? '' : 'es'} for "${safeQuery}":`,
    '',
  ];
  for (const match of matches) {
    const timezone = match.captureTimezone ?? 'unknown timezone';
    const host = match.captureHost ?? 'unknown host';
    const local =
      match.captureTimezone === null
        ? null
        : captureLocalTime(match.recordedAt, match.captureTimezone);
    lines.push(`session ${terminalText(match.sessionId)}`);
    lines.push(`    recorded UTC: ${terminalText(match.recordedAt)}`);
    lines.push(
      `    capture local: ${local === null ? 'unavailable' : terminalText(local)} ` +
        `[${terminalText(timezone)}] · host ${terminalText(host)}`,
    );
    lines.push(
      `    source audio (filesystem snapshot ${terminalText(match.audioCheckedAt)}): ` +
        `${match.audioAvailability} (${match.audioAvailableParts} available, ` +
        `${match.audioDeletedParts} deleted, ${match.audioUnknownParts} unknown, ` +
        `${match.audioExpectedParts} expected)`,
    );
    lines.push(`    ${terminalText(match.snippet)}`);
    lines.push('');
  }
  return lines.join('\n');
}
