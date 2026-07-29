import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { transaction } from './db.ts';

const nowIso = () => new Date().toISOString();

export interface SessionRow {
  session_id: string;
  state: string;
  started_at: string;
  ended_at: string | null;
  duration_ms: number | null;
  speech_ms: number;
  part_count: number;
  rejection_reason: string | null;
  languages: string | null;
}

export interface PartRow {
  part_id: string;
  session_id: string;
  part_index: number;
  path: string;
  started_at: string;
  ended_at: string | null;
  duration_ms: number | null;
  bytes: number | null;
  sha256: string | null;
  finalized: number;
  delivered: number;
  deleted_at: string | null;
}

export class SessionRepository {
  readonly #db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  create(sessionId: string, startedAtIso: string): void {
    const ts = nowIso();
    this.#db
      .prepare(
        `INSERT INTO audio_sessions (session_id, state, started_at, created_at, updated_at)
         VALUES (?, 'ACTIVE', ?, ?, ?)`,
      )
      .run(sessionId, startedAtIso, ts, ts);
  }

  setState(sessionId: string, state: string): void {
    this.#db
      .prepare('UPDATE audio_sessions SET state = ?, updated_at = ? WHERE session_id = ?')
      .run(state, nowIso(), sessionId);
  }

  finalize(
    sessionId: string,
    endedAtIso: string,
    durationMs: number,
    speechMs: number,
    partCount: number,
  ): void {
    this.#db
      .prepare(
        `UPDATE audio_sessions
            SET state = 'PROCESSING', ended_at = ?, duration_ms = ?, speech_ms = ?,
                part_count = ?, updated_at = ?
          WHERE session_id = ?`,
      )
      .run(endedAtIso, durationMs, speechMs, partCount, nowIso(), sessionId);
  }

  reject(sessionId: string, reason: string, speechMs: number, partCount: number): void {
    this.#db
      .prepare(
        `UPDATE audio_sessions
            SET state = 'REJECTED', rejection_reason = ?, ended_at = ?, speech_ms = ?,
                part_count = ?, updated_at = ?
          WHERE session_id = ?`,
      )
      .run(reason, nowIso(), speechMs, partCount, nowIso(), sessionId);
  }

  setLanguages(sessionId: string, languages: readonly string[]): void {
    this.#db
      .prepare('UPDATE audio_sessions SET languages = ?, updated_at = ? WHERE session_id = ?')
      .run(JSON.stringify(languages), nowIso(), sessionId);
  }

  get(sessionId: string): SessionRow | undefined {
    return this.#db
      .prepare('SELECT * FROM audio_sessions WHERE session_id = ?')
      .get(sessionId) as unknown as SessionRow | undefined;
  }

  listBetween(fromIso: string, toIso: string): SessionRow[] {
    return this.#db
      .prepare(
        `SELECT * FROM audio_sessions
          WHERE started_at >= ? AND started_at < ? AND state = 'DONE'
          ORDER BY started_at`,
      )
      .all(fromIso, toIso) as unknown as SessionRow[];
  }

  countByState(state: string): number {
    const row = this.#db
      .prepare('SELECT count(*) AS c FROM audio_sessions WHERE state = ?')
      .get(state) as { c: number };
    return row.c;
  }
}

export class PartRepository {
  readonly #db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  open(sessionId: string, partIndex: number, path: string, startedAtIso: string): string {
    const partId = randomUUID();
    this.#db
      .prepare(
        `INSERT INTO audio_parts (part_id, session_id, part_index, path, started_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(partId, sessionId, partIndex, path, startedAtIso, nowIso());
    return partId;
  }

  finalizePart(
    partId: string,
    endedAtIso: string,
    durationMs: number,
    bytes: number,
    sha256: string,
  ): void {
    this.#db
      .prepare(
        `UPDATE audio_parts
            SET ended_at = ?, duration_ms = ?, bytes = ?, sha256 = ?, finalized = 1
          WHERE part_id = ?`,
      )
      .run(endedAtIso, durationMs, bytes, sha256, partId);
  }

  markDelivered(partId: string): void {
    this.#db.prepare('UPDATE audio_parts SET delivered = 1 WHERE part_id = ?').run(partId);
  }

  markDeleted(partId: string): void {
    this.#db
      .prepare('UPDATE audio_parts SET deleted_at = ? WHERE part_id = ?')
      .run(nowIso(), partId);
  }

  listForSession(sessionId: string): PartRow[] {
    return this.#db
      .prepare('SELECT * FROM audio_parts WHERE session_id = ? ORDER BY part_index')
      .all(sessionId) as unknown as PartRow[];
  }

  lastFinalized(): PartRow | undefined {
    return this.#db
      .prepare('SELECT * FROM audio_parts WHERE finalized = 1 ORDER BY ended_at DESC LIMIT 1')
      .get() as unknown as PartRow | undefined;
  }
}

export interface TranscriptSegmentInput {
  readonly startMs: number | null;
  readonly endMs: number | null;
  readonly timestampSource: 'aligner' | 'vad' | 'none';
  readonly language: string | null;
  readonly text: string;
}

export interface TranscriptInput {
  readonly sessionId?: string | undefined;
  readonly incomingFileId?: string | undefined;
  readonly engine: string;
  readonly model: string;
  readonly languages: readonly string[];
  readonly text: string;
  readonly segments: readonly TranscriptSegmentInput[];
}

export class TranscriptRepository {
  readonly #db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  /**
   * Appends a new immutable revision. The previous current revision is demoted
   * rather than deleted, so a bad model upgrade is always recoverable.
   */
  append(input: TranscriptInput): string {
    return transaction(this.#db, () => {
      const owner = input.sessionId ?? input.incomingFileId;
      if (owner === undefined) {
        throw new Error('transcript must belong to a session or an incoming file');
      }
      const column = input.sessionId !== undefined ? 'session_id' : 'incoming_file_id';

      const prev = this.#db
        .prepare(
          `SELECT COALESCE(MAX(revision_number), 0) AS n
             FROM transcript_revisions WHERE ${column} = ?`,
        )
        .get(owner) as { n: number };
      const revisionNumber = prev.n + 1;

      this.#db
        .prepare(`UPDATE transcript_revisions SET is_current = 0 WHERE ${column} = ?`)
        .run(owner);

      const revisionId = randomUUID();
      const wordCount = countWords(input.text);
      this.#db
        .prepare(
          `INSERT INTO transcript_revisions
             (revision_id, session_id, incoming_file_id, revision_number, engine, model,
              languages, text, word_count, is_current, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
        )
        .run(
          revisionId,
          input.sessionId ?? null,
          input.incomingFileId ?? null,
          revisionNumber,
          input.engine,
          input.model,
          JSON.stringify(input.languages),
          input.text,
          wordCount,
          nowIso(),
        );

      const insertSegment = this.#db.prepare(
        `INSERT INTO transcript_segments
           (revision_id, segment_index, start_ms, end_ms, timestamp_source, language, text)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      input.segments.forEach((segment, index) => {
        insertSegment.run(
          revisionId,
          index,
          segment.startMs,
          segment.endMs,
          segment.timestampSource,
          segment.language,
          segment.text,
        );
      });

      return revisionId;
    });
  }

  current(
    sessionId: string,
  ): { revision_id: string; text: string; word_count: number } | undefined {
    return this.#db
      .prepare(
        `SELECT revision_id, text, word_count FROM transcript_revisions
          WHERE session_id = ? AND is_current = 1`,
      )
      .get(sessionId) as { revision_id: string; text: string; word_count: number } | undefined;
  }

  segments(revisionId: string): TranscriptSegmentInput[] {
    const rows = this.#db
      .prepare(
        `SELECT start_ms, end_ms, timestamp_source, language, text
           FROM transcript_segments WHERE revision_id = ? ORDER BY segment_index`,
      )
      .all(revisionId) as {
      start_ms: number | null;
      end_ms: number | null;
      timestamp_source: 'aligner' | 'vad' | 'none';
      language: string | null;
      text: string;
    }[];
    return rows.map((r) => ({
      startMs: r.start_ms,
      endMs: r.end_ms,
      timestampSource: r.timestamp_source,
      language: r.language,
      text: r.text,
    }));
  }
}

/**
 * Word count that works for space-separated scripts and for Thai, which is
 * written without spaces. For scripts with no word delimiters we approximate
 * with a character count so that the "at least 5 meaningful words" gate does
 * not reject every Thai session.
 */
export function countWords(text: string): number {
  const spaced = text.trim().split(/\s+/).filter(Boolean).length;
  const thaiChars = (text.match(/[฀-๿]/g) ?? []).length;
  // Thai averages roughly 4 characters per word.
  const thaiWords = Math.floor(thaiChars / 4);
  const hasSpacedContent = /[^\s฀-๿]/.test(text);
  return Math.max(hasSpacedContent ? spaced : 0, thaiWords);
}
