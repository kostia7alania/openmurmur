import type { DatabaseSync } from 'node:sqlite';

/**
 * Full-text search over stored transcripts.
 *
 * The point of keeping transcripts forever is being able to find things in
 * them later.
 *
 * Search stays substring-based because Thai is written without spaces and
 * Russian is heavily inflected, so "встреч" matches
 * "встреча", "встречу" and "встрече" without any stemming. SQLite's trigram
 * tokenizer handles Latin/Cyrillic case, but not canonically equivalent NFC
 * and NFD text. Until normalized text has its own durable index, this command
 * scans every current segment and folds it in JavaScript rather than silently
 * returning false negatives.
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

const MAX_QUERY_CODE_POINTS = 512;
const MAX_RESULTS = 200;

export function validatedSearchQuery(query: string): string {
  const trimmed = query.trim();
  const length = [...trimmed].length;
  if (length === 0) throw new SearchError('search query is empty');
  // Keeping the existing three-character floor bounds an exhaustive scan and
  // preserves the public contract established by the trigram index.
  if (length < 3) {
    throw new SearchError(
      `"${trimmed}" is too short: transcript search needs at least 3 characters`,
    );
  }
  if (length > MAX_QUERY_CODE_POINTS) {
    throw new SearchError(
      `search query is too long: the maximum is ${MAX_QUERY_CODE_POINTS} characters`,
    );
  }
  return trimmed;
}

function boundedLimit(value: number | undefined): number {
  const limit = value ?? 20;
  if (!Number.isFinite(limit) || !Number.isInteger(limit)) {
    throw new SearchError('search limit must be an integer');
  }
  return Math.min(Math.max(limit, 1), MAX_RESULTS);
}

/**
 * FTS5 treats several characters as query syntax. A user typing a phrase with
 * a quote or a hyphen means it literally, so the whole query is quoted and any
 * embedded quote is doubled — the FTS5 escape.
 */
export function escapeFtsQuery(query: string): string {
  const trimmed = validatedSearchQuery(query);
  return `"${trimmed.replaceAll('"', '""')}"`;
}

export function searchTranscripts(db: DatabaseSync, options: SearchOptions): SearchHit[] {
  const query = validatedSearchQuery(options.query);
  const foldedQuery = unicodeFold(query);
  const limit = boundedLimit(options.limit);

  // Only the current revision of each transcript is searched: an older
  // revision is kept for recovery, not for results the user has to
  // disambiguate.
  const rows = db
    .prepare(
      `SELECT
         r.session_id                              AS session_id,
         r.incoming_file_id                        AS incoming_file_id,
         r.revision_id                             AS revision_id,
         r.text                                    AS revision_text,
         s.started_at                              AS started_at,
         seg.language                              AS language,
         seg.start_ms                              AS start_ms,
         seg.text                                  AS segment_text
       FROM transcript_revisions r
       LEFT JOIN transcript_segments seg ON seg.revision_id = r.revision_id
       LEFT JOIN audio_sessions s ON s.session_id = r.session_id
      WHERE r.is_current = 1
        AND (? IS NULL OR s.started_at >= ?)
        AND (? IS NULL OR s.started_at <  ?)
      ORDER BY COALESCE(s.started_at, r.created_at) DESC,
               r.revision_id,
               COALESCE(seg.segment_index, 0)`,
    )
    .all(
      options.since ?? null,
      options.since ?? null,
      options.until ?? null,
      options.until ?? null,
    ) as unknown as {
    session_id: string | null;
    incoming_file_id: string | null;
    revision_id: string;
    revision_text: string;
    started_at: string | null;
    language: string | null;
    start_ms: number | null;
    segment_text: string | null;
  }[];

  const revisions = new Map<
    string,
    {
      readonly sessionId: string | null;
      readonly incomingFileId: string | null;
      readonly startedAt: string | null;
      readonly text: string;
      readonly segments: {
        readonly language: string | null;
        readonly startMs: number | null;
        readonly text: string;
      }[];
    }
  >();
  for (const row of rows) {
    let revision = revisions.get(row.revision_id);
    if (revision === undefined) {
      revision = {
        sessionId: row.session_id,
        incomingFileId: row.incoming_file_id,
        startedAt: row.started_at,
        text: row.revision_text,
        segments: [],
      };
      revisions.set(row.revision_id, revision);
    }
    if (row.segment_text !== null) {
      revision.segments.push({
        language: row.language,
        startMs: row.start_ms,
        text: row.segment_text,
      });
    }
  }

  const hits: SearchHit[] = [];
  for (const revision of revisions.values()) {
    let segmentMatched = false;
    for (const segment of revision.segments) {
      if (!unicodeFold(segment.text).includes(foldedQuery)) continue;
      segmentMatched = true;
      hits.push({
        sessionId: revision.sessionId,
        incomingFileId: revision.incomingFileId,
        startedAt: revision.startedAt,
        language: segment.language,
        startMs: segment.startMs,
        text: segment.text,
        snippet: literalSnippet(segment.text, query),
      });
      if (hits.length === limit) return hits;
    }
    if (segmentMatched || !unicodeFold(revision.text).includes(foldedQuery)) continue;
    hits.push({
      sessionId: revision.sessionId,
      incomingFileId: revision.incomingFileId,
      startedAt: revision.startedAt,
      language: null,
      startMs: null,
      text: revision.text,
      snippet: literalSnippet(revision.text, query),
    });
    if (hits.length === limit) return hits;
  }
  return hits;
}

// Generated from Unicode 17 CaseFolding.txt (default full mappings: C + F,
// excluding Turkic T). Only mappings that differ from Node 26's ICU lowercase
// are kept here. This also includes identity-by-omission where ICU lowercase
// differs from the default fold. The complete 297-entry overlay was verified
// against every Unicode scalar value.
const FULL_CASE_FOLD_EXCEPTIONS: ReadonlyMap<number, string> = new Map([
  [0x00b5, 'μ'],
  [0x00df, 'ss'],
  [0x0149, 'ʼn'],
  [0x017f, 's'],
  [0x01f0, 'ǰ'],
  [0x0345, 'ι'],
  [0x0390, 'ΐ'],
  [0x03b0, 'ΰ'],
  [0x03c2, 'σ'],
  [0x03d0, 'β'],
  [0x03d1, 'θ'],
  [0x03d5, 'φ'],
  [0x03d6, 'π'],
  [0x03f0, 'κ'],
  [0x03f1, 'ρ'],
  [0x03f5, 'ε'],
  [0x0587, 'եւ'],
  [0x13a0, 'Ꭰ'],
  [0x13a1, 'Ꭱ'],
  [0x13a2, 'Ꭲ'],
  [0x13a3, 'Ꭳ'],
  [0x13a4, 'Ꭴ'],
  [0x13a5, 'Ꭵ'],
  [0x13a6, 'Ꭶ'],
  [0x13a7, 'Ꭷ'],
  [0x13a8, 'Ꭸ'],
  [0x13a9, 'Ꭹ'],
  [0x13aa, 'Ꭺ'],
  [0x13ab, 'Ꭻ'],
  [0x13ac, 'Ꭼ'],
  [0x13ad, 'Ꭽ'],
  [0x13ae, 'Ꭾ'],
  [0x13af, 'Ꭿ'],
  [0x13b0, 'Ꮀ'],
  [0x13b1, 'Ꮁ'],
  [0x13b2, 'Ꮂ'],
  [0x13b3, 'Ꮃ'],
  [0x13b4, 'Ꮄ'],
  [0x13b5, 'Ꮅ'],
  [0x13b6, 'Ꮆ'],
  [0x13b7, 'Ꮇ'],
  [0x13b8, 'Ꮈ'],
  [0x13b9, 'Ꮉ'],
  [0x13ba, 'Ꮊ'],
  [0x13bb, 'Ꮋ'],
  [0x13bc, 'Ꮌ'],
  [0x13bd, 'Ꮍ'],
  [0x13be, 'Ꮎ'],
  [0x13bf, 'Ꮏ'],
  [0x13c0, 'Ꮐ'],
  [0x13c1, 'Ꮑ'],
  [0x13c2, 'Ꮒ'],
  [0x13c3, 'Ꮓ'],
  [0x13c4, 'Ꮔ'],
  [0x13c5, 'Ꮕ'],
  [0x13c6, 'Ꮖ'],
  [0x13c7, 'Ꮗ'],
  [0x13c8, 'Ꮘ'],
  [0x13c9, 'Ꮙ'],
  [0x13ca, 'Ꮚ'],
  [0x13cb, 'Ꮛ'],
  [0x13cc, 'Ꮜ'],
  [0x13cd, 'Ꮝ'],
  [0x13ce, 'Ꮞ'],
  [0x13cf, 'Ꮟ'],
  [0x13d0, 'Ꮠ'],
  [0x13d1, 'Ꮡ'],
  [0x13d2, 'Ꮢ'],
  [0x13d3, 'Ꮣ'],
  [0x13d4, 'Ꮤ'],
  [0x13d5, 'Ꮥ'],
  [0x13d6, 'Ꮦ'],
  [0x13d7, 'Ꮧ'],
  [0x13d8, 'Ꮨ'],
  [0x13d9, 'Ꮩ'],
  [0x13da, 'Ꮪ'],
  [0x13db, 'Ꮫ'],
  [0x13dc, 'Ꮬ'],
  [0x13dd, 'Ꮭ'],
  [0x13de, 'Ꮮ'],
  [0x13df, 'Ꮯ'],
  [0x13e0, 'Ꮰ'],
  [0x13e1, 'Ꮱ'],
  [0x13e2, 'Ꮲ'],
  [0x13e3, 'Ꮳ'],
  [0x13e4, 'Ꮴ'],
  [0x13e5, 'Ꮵ'],
  [0x13e6, 'Ꮶ'],
  [0x13e7, 'Ꮷ'],
  [0x13e8, 'Ꮸ'],
  [0x13e9, 'Ꮹ'],
  [0x13ea, 'Ꮺ'],
  [0x13eb, 'Ꮻ'],
  [0x13ec, 'Ꮼ'],
  [0x13ed, 'Ꮽ'],
  [0x13ee, 'Ꮾ'],
  [0x13ef, 'Ꮿ'],
  [0x13f0, 'Ᏸ'],
  [0x13f1, 'Ᏹ'],
  [0x13f2, 'Ᏺ'],
  [0x13f3, 'Ᏻ'],
  [0x13f4, 'Ᏼ'],
  [0x13f5, 'Ᏽ'],
  [0x13f8, 'Ᏸ'],
  [0x13f9, 'Ᏹ'],
  [0x13fa, 'Ᏺ'],
  [0x13fb, 'Ᏻ'],
  [0x13fc, 'Ᏼ'],
  [0x13fd, 'Ᏽ'],
  [0x1c80, 'в'],
  [0x1c81, 'д'],
  [0x1c82, 'о'],
  [0x1c83, 'с'],
  [0x1c84, 'т'],
  [0x1c85, 'т'],
  [0x1c86, 'ъ'],
  [0x1c87, 'ѣ'],
  [0x1c88, 'ꙋ'],
  [0x1e96, 'ẖ'],
  [0x1e97, 'ẗ'],
  [0x1e98, 'ẘ'],
  [0x1e99, 'ẙ'],
  [0x1e9a, 'aʾ'],
  [0x1e9b, 'ṡ'],
  [0x1e9e, 'ss'],
  [0x1f50, 'ὐ'],
  [0x1f52, 'ὒ'],
  [0x1f54, 'ὔ'],
  [0x1f56, 'ὖ'],
  [0x1f80, 'ἀι'],
  [0x1f81, 'ἁι'],
  [0x1f82, 'ἂι'],
  [0x1f83, 'ἃι'],
  [0x1f84, 'ἄι'],
  [0x1f85, 'ἅι'],
  [0x1f86, 'ἆι'],
  [0x1f87, 'ἇι'],
  [0x1f88, 'ἀι'],
  [0x1f89, 'ἁι'],
  [0x1f8a, 'ἂι'],
  [0x1f8b, 'ἃι'],
  [0x1f8c, 'ἄι'],
  [0x1f8d, 'ἅι'],
  [0x1f8e, 'ἆι'],
  [0x1f8f, 'ἇι'],
  [0x1f90, 'ἠι'],
  [0x1f91, 'ἡι'],
  [0x1f92, 'ἢι'],
  [0x1f93, 'ἣι'],
  [0x1f94, 'ἤι'],
  [0x1f95, 'ἥι'],
  [0x1f96, 'ἦι'],
  [0x1f97, 'ἧι'],
  [0x1f98, 'ἠι'],
  [0x1f99, 'ἡι'],
  [0x1f9a, 'ἢι'],
  [0x1f9b, 'ἣι'],
  [0x1f9c, 'ἤι'],
  [0x1f9d, 'ἥι'],
  [0x1f9e, 'ἦι'],
  [0x1f9f, 'ἧι'],
  [0x1fa0, 'ὠι'],
  [0x1fa1, 'ὡι'],
  [0x1fa2, 'ὢι'],
  [0x1fa3, 'ὣι'],
  [0x1fa4, 'ὤι'],
  [0x1fa5, 'ὥι'],
  [0x1fa6, 'ὦι'],
  [0x1fa7, 'ὧι'],
  [0x1fa8, 'ὠι'],
  [0x1fa9, 'ὡι'],
  [0x1faa, 'ὢι'],
  [0x1fab, 'ὣι'],
  [0x1fac, 'ὤι'],
  [0x1fad, 'ὥι'],
  [0x1fae, 'ὦι'],
  [0x1faf, 'ὧι'],
  [0x1fb2, 'ὰι'],
  [0x1fb3, 'αι'],
  [0x1fb4, 'άι'],
  [0x1fb6, 'ᾶ'],
  [0x1fb7, 'ᾶι'],
  [0x1fbc, 'αι'],
  [0x1fbe, 'ι'],
  [0x1fc2, 'ὴι'],
  [0x1fc3, 'ηι'],
  [0x1fc4, 'ήι'],
  [0x1fc6, 'ῆ'],
  [0x1fc7, 'ῆι'],
  [0x1fcc, 'ηι'],
  [0x1fd2, 'ῒ'],
  [0x1fd3, 'ΐ'],
  [0x1fd6, 'ῖ'],
  [0x1fd7, 'ῗ'],
  [0x1fe2, 'ῢ'],
  [0x1fe3, 'ΰ'],
  [0x1fe4, 'ῤ'],
  [0x1fe6, 'ῦ'],
  [0x1fe7, 'ῧ'],
  [0x1ff2, 'ὼι'],
  [0x1ff3, 'ωι'],
  [0x1ff4, 'ώι'],
  [0x1ff6, 'ῶ'],
  [0x1ff7, 'ῶι'],
  [0x1ffc, 'ωι'],
  [0xab70, 'Ꭰ'],
  [0xab71, 'Ꭱ'],
  [0xab72, 'Ꭲ'],
  [0xab73, 'Ꭳ'],
  [0xab74, 'Ꭴ'],
  [0xab75, 'Ꭵ'],
  [0xab76, 'Ꭶ'],
  [0xab77, 'Ꭷ'],
  [0xab78, 'Ꭸ'],
  [0xab79, 'Ꭹ'],
  [0xab7a, 'Ꭺ'],
  [0xab7b, 'Ꭻ'],
  [0xab7c, 'Ꭼ'],
  [0xab7d, 'Ꭽ'],
  [0xab7e, 'Ꭾ'],
  [0xab7f, 'Ꭿ'],
  [0xab80, 'Ꮀ'],
  [0xab81, 'Ꮁ'],
  [0xab82, 'Ꮂ'],
  [0xab83, 'Ꮃ'],
  [0xab84, 'Ꮄ'],
  [0xab85, 'Ꮅ'],
  [0xab86, 'Ꮆ'],
  [0xab87, 'Ꮇ'],
  [0xab88, 'Ꮈ'],
  [0xab89, 'Ꮉ'],
  [0xab8a, 'Ꮊ'],
  [0xab8b, 'Ꮋ'],
  [0xab8c, 'Ꮌ'],
  [0xab8d, 'Ꮍ'],
  [0xab8e, 'Ꮎ'],
  [0xab8f, 'Ꮏ'],
  [0xab90, 'Ꮐ'],
  [0xab91, 'Ꮑ'],
  [0xab92, 'Ꮒ'],
  [0xab93, 'Ꮓ'],
  [0xab94, 'Ꮔ'],
  [0xab95, 'Ꮕ'],
  [0xab96, 'Ꮖ'],
  [0xab97, 'Ꮗ'],
  [0xab98, 'Ꮘ'],
  [0xab99, 'Ꮙ'],
  [0xab9a, 'Ꮚ'],
  [0xab9b, 'Ꮛ'],
  [0xab9c, 'Ꮜ'],
  [0xab9d, 'Ꮝ'],
  [0xab9e, 'Ꮞ'],
  [0xab9f, 'Ꮟ'],
  [0xaba0, 'Ꮠ'],
  [0xaba1, 'Ꮡ'],
  [0xaba2, 'Ꮢ'],
  [0xaba3, 'Ꮣ'],
  [0xaba4, 'Ꮤ'],
  [0xaba5, 'Ꮥ'],
  [0xaba6, 'Ꮦ'],
  [0xaba7, 'Ꮧ'],
  [0xaba8, 'Ꮨ'],
  [0xaba9, 'Ꮩ'],
  [0xabaa, 'Ꮪ'],
  [0xabab, 'Ꮫ'],
  [0xabac, 'Ꮬ'],
  [0xabad, 'Ꮭ'],
  [0xabae, 'Ꮮ'],
  [0xabaf, 'Ꮯ'],
  [0xabb0, 'Ꮰ'],
  [0xabb1, 'Ꮱ'],
  [0xabb2, 'Ꮲ'],
  [0xabb3, 'Ꮳ'],
  [0xabb4, 'Ꮴ'],
  [0xabb5, 'Ꮵ'],
  [0xabb6, 'Ꮶ'],
  [0xabb7, 'Ꮷ'],
  [0xabb8, 'Ꮸ'],
  [0xabb9, 'Ꮹ'],
  [0xabba, 'Ꮺ'],
  [0xabbb, 'Ꮻ'],
  [0xabbc, 'Ꮼ'],
  [0xabbd, 'Ꮽ'],
  [0xabbe, 'Ꮾ'],
  [0xabbf, 'Ꮿ'],
  [0xfb00, 'ff'],
  [0xfb01, 'fi'],
  [0xfb02, 'fl'],
  [0xfb03, 'ffi'],
  [0xfb04, 'ffl'],
  [0xfb05, 'st'],
  [0xfb06, 'st'],
  [0xfb13, 'մն'],
  [0xfb14, 'մե'],
  [0xfb15, 'մի'],
  [0xfb16, 'վն'],
  [0xfb17, 'մխ'],
]);

export function unicodeFold(value: string): string {
  let folded = '';
  for (const character of value.normalize('NFC')) {
    const codePoint = character.codePointAt(0);
    folded +=
      codePoint === undefined
        ? character
        : (FULL_CASE_FOLD_EXCEPTIONS.get(codePoint) ?? character.toLocaleLowerCase('und'));
  }
  return folded.normalize('NFC');
}

export function literalSnippet(text: string, query: string): string {
  const foldedQuery = unicodeFold(query);
  const segments = [...new Intl.Segmenter('und', { granularity: 'grapheme' }).segment(text)];
  let foldedText = '';
  const sourceOffsets: { readonly start: number; readonly end: number }[] = [];
  for (const segment of segments) {
    const foldedSegment = unicodeFold(segment.segment);
    foldedText += foldedSegment;
    for (let index = 0; index < foldedSegment.length; index += 1) {
      sourceOffsets.push({
        start: segment.index,
        end: segment.index + segment.segment.length,
      });
    }
  }
  const foldedIndex = foldedText.indexOf(foldedQuery);
  const foldedEnd = foldedIndex + foldedQuery.length - 1;
  const sourceStart = sourceOffsets[foldedIndex]?.start;
  const sourceEnd = sourceOffsets[foldedEnd]?.end;
  if (foldedIndex < 0 || sourceStart === undefined || sourceEnd === undefined) {
    return safeSlice(text, 0, Math.min(text.length, 180));
  }

  const contextStart = Math.max(0, sourceStart - 72);
  const contextEnd = Math.min(text.length, sourceEnd + 72);
  const prefix = contextStart === 0 ? '' : '…';
  const suffix = contextEnd === text.length ? '' : '…';
  return (
    prefix +
    safeSlice(text, contextStart, sourceStart) +
    `[${safeSlice(text, sourceStart, sourceEnd)}]` +
    safeSlice(text, sourceEnd, contextEnd) +
    suffix
  );
}

function safeSlice(value: string, requestedStart: number, requestedEnd: number): string {
  let start = requestedStart;
  let end = requestedEnd;
  const startCode = value.charCodeAt(start);
  if (start > 0 && startCode >= 0xdc00 && startCode <= 0xdfff) start -= 1;
  const endCode = value.charCodeAt(end - 1);
  if (end < value.length && endCode >= 0xd800 && endCode <= 0xdbff) end += 1;
  return value.slice(start, end);
}

function formatOffset(startMs: number | null): string {
  if (startMs === null) return '';
  const total = Math.floor(startMs / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return ` +${minutes}:${String(seconds).padStart(2, '0')}`;
}

export function renderSearchResults(hits: readonly SearchHit[], query: string): string {
  const safeQuery = terminalText(query);
  if (hits.length === 0) {
    return `No transcript contains "${safeQuery}".`;
  }

  const lines = [`${hits.length} match${hits.length === 1 ? '' : 'es'} for "${safeQuery}":`, ''];
  for (const hit of hits) {
    const when =
      hit.startedAt === null ? 'incoming file' : hit.startedAt.slice(0, 16).replace('T', ' ');
    const id = hit.sessionId ?? hit.incomingFileId ?? 'unknown';
    lines.push(`${terminalText(when)}${formatOffset(hit.startMs)}  ${terminalText(id)}`);
    lines.push(`    ${terminalText(hit.snippet)}`);
    lines.push('');
  }
  return lines.join('\n');
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
