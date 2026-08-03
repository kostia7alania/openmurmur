import type { DatabaseSync } from 'node:sqlite';

/**
 * Full-text search over stored transcripts.
 *
 * The point of keeping transcripts forever is being able to find things in
 * them later. The FTS5 index was built and populated from the start; this is
 * what finally reads it.
 *
 * The trigram tokenizer matters here: Thai is written without spaces and
 * Russian is heavily inflected, so a whitespace tokenizer would miss most of
 * what a user actually types. Trigram finds substrings, so "встреч" matches
 * "встреча", "встречу" and "встрече" without any stemming.
 */

export interface SearchHit {
  readonly sessionId: string | null;
  readonly incomingFileId: string | null;
  readonly startedAt: string | null;
  readonly language: string | null;
  /** The matching segment, with the query highlighted by markers. */
  readonly snippet: string;
  readonly text: string;
  readonly startMs: number | null;
}

export interface SearchOptions {
  readonly query: string;
  readonly limit?: number;
  /** Restrict to sessions started on or after this UTC ISO timestamp. */
  readonly since?: string | undefined;
  readonly until?: string | undefined;
}

export class SearchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SearchError';
  }
}

/**
 * FTS5 treats several characters as query syntax. A user typing a phrase with
 * a quote or a hyphen means it literally, so the whole query is quoted and any
 * embedded quote is doubled — the FTS5 escape.
 */
export function escapeFtsQuery(query: string): string {
  const trimmed = query.trim();
  if (trimmed.length === 0) throw new SearchError('search query is empty');
  // The trigram tokenizer needs at least three characters to match anything.
  if ([...trimmed].length < 3) {
    throw new SearchError(
      `"${trimmed}" is too short: the trigram index needs at least 3 characters`,
    );
  }
  return `"${trimmed.replaceAll('"', '""')}"`;
}

export function searchTranscripts(db: DatabaseSync, options: SearchOptions): SearchHit[] {
  const match = escapeFtsQuery(options.query);
  const limit = Math.min(Math.max(options.limit ?? 20, 1), 200);

  // Only the current revision of each transcript is searched: an older
  // revision is kept for recovery, not for results the user has to
  // disambiguate.
  const rows = db
    .prepare(
      `SELECT
         r.session_id                              AS session_id,
         r.incoming_file_id                        AS incoming_file_id,
         s.started_at                              AS started_at,
         seg.language                              AS language,
         seg.start_ms                              AS start_ms,
         seg.text                                  AS text,
         snippet(transcript_fts, 0, '[', ']', '…', 12) AS snippet
       FROM transcript_fts f
       JOIN transcript_revisions r ON r.revision_id = f.revision_id
       LEFT JOIN transcript_segments seg
              ON seg.revision_id = r.revision_id AND seg.text = f.text
       LEFT JOIN audio_sessions s ON s.session_id = r.session_id
      WHERE transcript_fts MATCH ?
        AND r.is_current = 1
        AND (? IS NULL OR s.started_at >= ?)
        AND (? IS NULL OR s.started_at <  ?)
      ORDER BY COALESCE(s.started_at, r.created_at) DESC
      LIMIT ?`,
    )
    .all(
      match,
      options.since ?? null,
      options.since ?? null,
      options.until ?? null,
      options.until ?? null,
      limit,
    ) as unknown as {
    session_id: string | null;
    incoming_file_id: string | null;
    started_at: string | null;
    language: string | null;
    start_ms: number | null;
    text: string;
    snippet: string;
  }[];

  return rows.map((row) => ({
    sessionId: row.session_id,
    incomingFileId: row.incoming_file_id,
    startedAt: row.started_at,
    language: row.language,
    startMs: row.start_ms,
    text: row.text,
    snippet: row.snippet,
  }));
}

function formatOffset(startMs: number | null): string {
  if (startMs === null) return '';
  const total = Math.floor(startMs / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return ` +${minutes}:${String(seconds).padStart(2, '0')}`;
}

export function renderSearchResults(hits: readonly SearchHit[], query: string): string {
  if (hits.length === 0) {
    return `No transcript contains "${query}".`;
  }

  const lines = [`${hits.length} match${hits.length === 1 ? '' : 'es'} for "${query}":`, ''];
  for (const hit of hits) {
    const when =
      hit.startedAt === null ? 'incoming file' : hit.startedAt.slice(0, 16).replace('T', ' ');
    const id = hit.sessionId ?? hit.incomingFileId ?? 'unknown';
    lines.push(`${when}${formatOffset(hit.startMs)}  ${id}`);
    lines.push(`    ${hit.snippet.replaceAll('\n', ' ')}`);
    lines.push('');
  }
  return lines.join('\n');
}
