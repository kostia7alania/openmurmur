import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { TimestampSource } from '../asr/types.ts';
import { transaction } from './db.ts';

const nowIso = () => new Date().toISOString();

export interface SessionRow {
  session_id: string;
  state: string;
  started_at: string;
  ended_at: string | null;
  duration_ms: number | null;
  speech_ms: number;
  timing_exact: number;
  part_count: number;
  rejection_reason: string | null;
  languages: string | null;
  capture_host: string | null;
  capture_timezone: string | null;
}

export interface SessionCaptureProvenance {
  readonly hostName: string;
  readonly timezone: string;
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
  delivered_at: string | null;
  deleted_at: string | null;
}

export class SessionRepository {
  readonly #db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  create(sessionId: string, startedAtIso: string, provenance?: SessionCaptureProvenance): void {
    const ts = nowIso();
    this.#db
      .prepare(
        `INSERT INTO audio_sessions
           (session_id, state, started_at, capture_host, capture_timezone, created_at, updated_at)
         VALUES (?, 'ACTIVE', ?, ?, ?, ?, ?)`,
      )
      .run(
        sessionId,
        startedAtIso,
        provenance?.hostName ?? null,
        provenance?.timezone ?? null,
        ts,
        ts,
      );
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
                timing_exact = 1, part_count = ?, updated_at = ?
          WHERE session_id = ?`,
      )
      .run(endedAtIso, durationMs, speechMs, partCount, nowIso(), sessionId);
  }

  reject(sessionId: string, reason: string, speechMs: number, partCount: number): void {
    this.#db
      .prepare(
        `UPDATE audio_sessions
            SET state = 'REJECTED', rejection_reason = ?, ended_at = COALESCE(ended_at, ?),
                speech_ms = CASE WHEN timing_exact = 1 THEN speech_ms ELSE ? END,
                part_count = ?, updated_at = ?
          WHERE session_id = ?`,
      )
      .run(reason, nowIso(), speechMs, partCount, nowIso(), sessionId);
  }

  rejectExact(
    sessionId: string,
    reason: string,
    endedAtIso: string,
    durationMs: number,
    speechMs: number,
    partCount: number,
  ): void {
    this.#db
      .prepare(
        `UPDATE audio_sessions
            SET state = 'REJECTED', rejection_reason = ?, ended_at = ?, duration_ms = ?,
                speech_ms = ?, timing_exact = 1, part_count = ?, updated_at = ?
          WHERE session_id = ?`,
      )
      .run(reason, endedAtIso, durationMs, speechMs, partCount, nowIso(), sessionId);
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

  finalizePartFromJournal(partId: string, bytes: number, sha256: string): void {
    transaction(this.#db, () => {
      const journal = new AudioFinalizationJournalRepository(this.#db);
      const exact = journal.forPart(partId);
      if (exact === undefined) {
        throw new Error(`audio part ${partId} has no durable finalization journal`);
      }
      finalizePartWithFacts(this.#db, partId, bytes, sha256, exact);
      if (exact.sessionDurationMs === null) {
        journal.deletePart(partId);
        return;
      }

      const session = this.#db
        .prepare(
          'SELECT state, ended_at, duration_ms, speech_ms, timing_exact FROM audio_sessions WHERE session_id = ?',
        )
        .get(exact.sessionId) as StoredSessionTiming | undefined;
      if (
        session?.timing_exact === 1 &&
        session.state !== 'ACTIVE' &&
        session.state !== 'FINALIZING'
      ) {
        assertStoredSessionTiming(exact, session);
        journal.deletePart(partId);
      }
    });
  }

  markDelivered(partId: string, deliveredAtIso: string): void {
    // A replay may prove a later final acknowledgement, but must never move the
    // retention clock backwards and make a file eligible sooner.
    this.#db
      .prepare(
        `UPDATE audio_parts
            SET delivered = 1,
                delivered_at = CASE
                  WHEN delivered_at IS NULL OR delivered_at < ? THEN ?
                  ELSE delivered_at
                END
          WHERE part_id = ?`,
      )
      .run(deliveredAtIso, deliveredAtIso, partId);
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

export interface FinalSessionTiming {
  readonly endedAtIso: string;
  readonly durationMs: number;
  readonly speechMs: number;
}

export interface AudioFinalizationJournalInput {
  readonly partId: string;
  readonly sessionId: string;
  readonly partEndedAtIso: string;
  readonly partDurationMs: number;
  readonly finalSession?: FinalSessionTiming;
}

export interface AudioFinalizationJournalRow {
  readonly partId: string;
  readonly sessionId: string;
  readonly partEndedAtIso: string;
  readonly partDurationMs: number;
  readonly sessionEndedAtIso: string | null;
  readonly sessionDurationMs: number | null;
  readonly sessionSpeechMs: number | null;
}

interface StoredSessionTiming {
  readonly state: string;
  readonly ended_at: string | null;
  readonly duration_ms: number | null;
  readonly speech_ms: number;
  readonly timing_exact: number;
}

function assertNonNegativeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative safe integer`);
  }
}

function sameJournal(
  left: AudioFinalizationJournalRow,
  right: AudioFinalizationJournalInput,
): boolean {
  return (
    left.partId === right.partId &&
    left.sessionId === right.sessionId &&
    left.partEndedAtIso === right.partEndedAtIso &&
    left.partDurationMs === right.partDurationMs &&
    left.sessionEndedAtIso === (right.finalSession?.endedAtIso ?? null) &&
    left.sessionDurationMs === (right.finalSession?.durationMs ?? null) &&
    left.sessionSpeechMs === (right.finalSession?.speechMs ?? null)
  );
}

function assertJournalMatches(
  exact: AudioFinalizationJournalRow,
  expected: FinalSessionTiming,
): void {
  if (
    exact.sessionEndedAtIso !== expected.endedAtIso ||
    exact.sessionDurationMs !== expected.durationMs ||
    exact.sessionSpeechMs !== expected.speechMs
  ) {
    throw new Error(`session ${exact.sessionId} finalization journal conflicts with exact timing`);
  }
}

export function assertStoredSessionTiming(
  exact: AudioFinalizationJournalRow,
  stored: StoredSessionTiming,
): void {
  if (
    stored.timing_exact !== 1 ||
    stored.ended_at !== exact.sessionEndedAtIso ||
    stored.duration_ms !== exact.sessionDurationMs ||
    stored.speech_ms !== exact.sessionSpeechMs
  ) {
    throw new Error(`session ${exact.sessionId} has conflicting durable timing facts`);
  }
}

export class AudioFinalizationJournalRepository {
  readonly #db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  record(input: AudioFinalizationJournalInput): void {
    assertNonNegativeInteger(input.partDurationMs, 'part duration');
    if (input.finalSession !== undefined) {
      assertNonNegativeInteger(input.finalSession.durationMs, 'session duration');
      assertNonNegativeInteger(input.finalSession.speechMs, 'session speech');
      if (input.finalSession.speechMs > input.finalSession.durationMs) {
        throw new Error('session speech cannot exceed its duration');
      }
    }
    const part = this.#db
      .prepare(
        `SELECT session_id, ended_at, duration_ms, bytes, sha256, finalized
           FROM audio_parts WHERE part_id = ?`,
      )
      .get(input.partId) as
      | {
          session_id: string;
          ended_at: string | null;
          duration_ms: number | null;
          bytes: number | null;
          sha256: string | null;
          finalized: number;
        }
      | undefined;
    if (
      part?.session_id !== input.sessionId ||
      part.finalized !== 0 ||
      part.ended_at !== null ||
      part.duration_ms !== null ||
      part.bytes !== null ||
      part.sha256 !== null
    ) {
      throw new Error(
        `audio part ${input.partId} is not an unfinalized part owned by session ${input.sessionId}`,
      );
    }

    this.#db
      .prepare(
        `INSERT INTO audio_finalization_journal
           (part_id, session_id, part_ended_at, part_duration_ms,
            session_ended_at, session_duration_ms, session_speech_ms, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (part_id) DO NOTHING`,
      )
      .run(
        input.partId,
        input.sessionId,
        input.partEndedAtIso,
        input.partDurationMs,
        input.finalSession?.endedAtIso ?? null,
        input.finalSession?.durationMs ?? null,
        input.finalSession?.speechMs ?? null,
        nowIso(),
      );
    const stored = this.forPart(input.partId);
    if (stored === undefined || !sameJournal(stored, input)) {
      throw new Error(`audio part ${input.partId} has a conflicting finalization journal`);
    }
  }

  forPart(partId: string): AudioFinalizationJournalRow | undefined {
    const row = this.#db
      .prepare(
        `SELECT j.part_id, j.session_id, j.part_ended_at, j.part_duration_ms,
                j.session_ended_at, j.session_duration_ms, j.session_speech_ms,
                p.session_id AS owned_session_id
           FROM audio_finalization_journal j
           JOIN audio_parts p ON p.part_id = j.part_id
          WHERE j.part_id = ?`,
      )
      .get(partId) as
      | {
          part_id: string;
          session_id: string;
          part_ended_at: string;
          part_duration_ms: number;
          session_ended_at: string | null;
          session_duration_ms: number | null;
          session_speech_ms: number | null;
          owned_session_id: string;
        }
      | undefined;
    if (row === undefined) return undefined;
    if (row.session_id !== row.owned_session_id) {
      throw new Error(`audio part ${partId} has a finalization journal for another session`);
    }
    return {
      partId: row.part_id,
      sessionId: row.session_id,
      partEndedAtIso: row.part_ended_at,
      partDurationMs: row.part_duration_ms,
      sessionEndedAtIso: row.session_ended_at,
      sessionDurationMs: row.session_duration_ms,
      sessionSpeechMs: row.session_speech_ms,
    };
  }

  forSession(sessionId: string): AudioFinalizationJournalRow | undefined {
    const row = this.#db
      .prepare(
        `SELECT part_id
           FROM audio_finalization_journal
          WHERE session_id = ? AND session_duration_ms IS NOT NULL`,
      )
      .get(sessionId) as { part_id: string } | undefined;
    return row === undefined ? undefined : this.forPart(row.part_id);
  }

  hasUnfinalizedPart(sessionId: string): boolean {
    const row = this.#db
      .prepare(
        `SELECT 1
           FROM audio_finalization_journal j
           JOIN audio_parts p ON p.part_id = j.part_id
          WHERE j.session_id = ? AND p.finalized = 0
          LIMIT 1`,
      )
      .get(sessionId);
    return row !== undefined;
  }

  consumeSessionIfPartFinalized(sessionId: string, expected: FinalSessionTiming): boolean {
    const exact = this.forSession(sessionId);
    if (exact === undefined) return false;
    assertJournalMatches(exact, expected);
    const part = this.#db
      .prepare('SELECT ended_at, duration_ms, finalized FROM audio_parts WHERE part_id = ?')
      .get(exact.partId) as
      | { ended_at: string | null; duration_ms: number | null; finalized: number }
      | undefined;
    if (part?.finalized !== 1) return false;
    if (part.ended_at !== exact.partEndedAtIso || part.duration_ms !== exact.partDurationMs) {
      throw new Error(`audio part ${exact.partId} conflicts with its finalization journal`);
    }
    this.deletePart(exact.partId);
    return true;
  }

  consumeSession(sessionId: string, expected: FinalSessionTiming): void {
    const exact = this.forSession(sessionId);
    if (exact === undefined) {
      throw new Error(`session ${sessionId} has no exact finalization journal`);
    }
    assertJournalMatches(exact, expected);
    const part = this.#db
      .prepare('SELECT ended_at, duration_ms, finalized FROM audio_parts WHERE part_id = ?')
      .get(exact.partId) as
      | { ended_at: string | null; duration_ms: number | null; finalized: number }
      | undefined;
    if (
      part === undefined ||
      (part.finalized === 1 &&
        (part.ended_at !== exact.partEndedAtIso || part.duration_ms !== exact.partDurationMs)) ||
      (part.finalized === 0 && (part.ended_at !== null || part.duration_ms !== null))
    ) {
      throw new Error(`audio part ${exact.partId} conflicts with its finalization journal`);
    }
    this.deletePart(exact.partId);
  }

  deletePart(partId: string): void {
    this.#db.prepare('DELETE FROM audio_finalization_journal WHERE part_id = ?').run(partId);
  }

  deleteSession(sessionId: string): void {
    this.#db.prepare('DELETE FROM audio_finalization_journal WHERE session_id = ?').run(sessionId);
  }
}

function finalizePartWithFacts(
  db: DatabaseSync,
  partId: string,
  bytes: number,
  sha256: string,
  exact: AudioFinalizationJournalRow | undefined,
): boolean {
  const part = db
    .prepare(
      'SELECT ended_at, duration_ms, bytes, sha256, finalized FROM audio_parts WHERE part_id = ?',
    )
    .get(partId) as
    | {
        ended_at: string | null;
        duration_ms: number | null;
        bytes: number | null;
        sha256: string | null;
        finalized: number;
      }
    | undefined;
  if (part === undefined) throw new Error(`unknown audio part ${partId}`);
  const endedAtIso = exact?.partEndedAtIso ?? null;
  const durationMs = exact?.partDurationMs ?? null;
  if (part.finalized === 1) {
    if (
      part.ended_at !== endedAtIso ||
      part.duration_ms !== durationMs ||
      part.bytes !== bytes ||
      part.sha256 !== sha256
    ) {
      throw new Error(`audio part ${partId} has conflicting finalized facts`);
    }
    return false;
  }
  if (
    part.ended_at !== null ||
    part.duration_ms !== null ||
    part.bytes !== null ||
    part.sha256 !== null
  ) {
    throw new Error(`audio part ${partId} has conflicting provisional facts`);
  }
  db.prepare(
    `UPDATE audio_parts
        SET ended_at = ?, duration_ms = ?, bytes = ?, sha256 = ?, finalized = 1
      WHERE part_id = ? AND finalized = 0`,
  ).run(endedAtIso, durationMs, bytes, sha256, partId);
  return true;
}

export function recoverPublishedPart(
  db: DatabaseSync,
  partId: string,
  bytes: number,
  sha256: string,
): { readonly changed: boolean; readonly timingExact: boolean } {
  return transaction(db, () => {
    const journal = new AudioFinalizationJournalRepository(db);
    const exact = journal.forPart(partId);
    const changed = finalizePartWithFacts(db, partId, bytes, sha256, exact);
    if (exact?.sessionDurationMs === null) journal.deletePart(partId);
    if (exact?.sessionDurationMs !== null && exact !== undefined) {
      const session = db
        .prepare(
          'SELECT state, ended_at, duration_ms, speech_ms, timing_exact FROM audio_sessions WHERE session_id = ?',
        )
        .get(exact.sessionId) as StoredSessionTiming | undefined;
      if (
        session?.timing_exact === 1 &&
        session.state !== 'ACTIVE' &&
        session.state !== 'FINALIZING'
      ) {
        assertStoredSessionTiming(exact, session);
        journal.deletePart(partId);
      }
    }
    return { changed, timingExact: exact !== undefined };
  });
}

export type IncomingAttachmentType = 'voice' | 'audio' | 'document' | 'video_note';
export type IncomingTelegramSource = 'direct' | 'forwarded';

export interface IncomingFileRow {
  readonly fileUid: string;
  readonly telegramFileId: string;
  readonly telegramUniqueId: string;
  readonly chatId: number;
  readonly messageId: number;
  readonly botScope: string;
  readonly updateId: number | null;
  readonly telegramSource: IncomingTelegramSource | null;
  readonly attachmentType: IncomingAttachmentType | null;
  readonly claimedFilename: string | null;
  readonly telegramMessageAt: string | null;
  readonly originalSentAt: string | null;
  readonly daemonHost: string | null;
  readonly state: string;
  readonly quarantinePath: string | null;
  readonly normalizedPath: string | null;
  readonly deliveredAt: string | null;
}

export interface ClaimIncomingFileInput {
  readonly telegramFileId: string;
  readonly telegramUniqueId: string;
  readonly chatId: number;
  readonly messageId: number;
  readonly botScope?: string;
  readonly updateId: number;
  readonly telegramSource: IncomingTelegramSource;
  readonly attachmentType: IncomingAttachmentType;
  readonly claimedFilename: string | null;
  readonly telegramMessageAt: string;
  readonly originalSentAt: string | null;
  readonly daemonHost: string;
  readonly declaredBytes: number | null;
  readonly declaredMime: string | null;
}

/** Durable identity and display-only provenance for Telegram-supplied audio. */
export class IncomingFileRepository {
  readonly #db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  claim(input: ClaimIncomingFileInput): IncomingFileRow {
    const ts = nowIso();
    const botScope = input.botScope ?? 'legacy';
    const telegramFileKey =
      botScope === 'legacy' ? input.telegramUniqueId : `${botScope}:${input.telegramUniqueId}`;
    this.#db
      .prepare(
        `INSERT INTO incoming_telegram_files
           (file_uid, telegram_file_id, telegram_unique_id, chat_id, message_id, bot_scope, update_id,
            telegram_source, attachment_type, claimed_filename, telegram_message_at,
            original_sent_at, daemon_host, declared_bytes, declared_mime, state,
            created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'received', ?, ?)
         ON CONFLICT (telegram_unique_id) DO NOTHING`,
      )
      .run(
        randomUUID(),
        input.telegramFileId,
        telegramFileKey,
        input.chatId,
        input.messageId,
        botScope,
        input.updateId,
        input.telegramSource,
        input.attachmentType,
        input.claimedFilename,
        input.telegramMessageAt,
        input.originalSentAt,
        input.daemonHost,
        input.declaredBytes,
        input.declaredMime,
        ts,
        ts,
      );
    const row = this.#find('telegram_unique_id', telegramFileKey);
    if (row === undefined) throw new Error('could not claim incoming Telegram file');
    return row;
  }

  findByTelegramUniqueId(
    telegramUniqueId: string,
    botScope = 'legacy',
  ): IncomingFileRow | undefined {
    const telegramFileKey =
      botScope === 'legacy' ? telegramUniqueId : `${botScope}:${telegramUniqueId}`;
    return this.#find('telegram_unique_id', telegramFileKey);
  }

  get(fileUid: string): IncomingFileRow | undefined {
    return this.#find('file_uid', fileUid);
  }

  markDownloaded(fileUid: string, path: string, actualBytes: number): void {
    this.#db
      .prepare(
        `UPDATE incoming_telegram_files
            SET state = 'downloaded', quarantine_path = ?, actual_bytes = ?, updated_at = ?
          WHERE file_uid = ?`,
      )
      .run(path, actualBytes, nowIso(), fileUid);
  }

  reserveNormalizedPath(fileUid: string, path: string): void {
    this.#db
      .prepare(
        `UPDATE incoming_telegram_files
            SET normalized_path = COALESCE(normalized_path, ?), updated_at = ?
          WHERE file_uid = ?`,
      )
      .run(path, nowIso(), fileUid);
  }

  markNormalized(fileUid: string, path: string, probedFormat: string, durationMs: number): void {
    this.#db
      .prepare(
        `UPDATE incoming_telegram_files
            SET state = 'validated', normalized_path = ?, probed_format = ?, duration_ms = ?,
                updated_at = ?
          WHERE file_uid = ?`,
      )
      .run(path, probedFormat, durationMs, nowIso(), fileUid);
  }

  markTranscribed(fileUid: string): void {
    this.#db
      .prepare(
        `UPDATE incoming_telegram_files
            SET state = 'transcribed', updated_at = ?
          WHERE file_uid = ? AND state <> 'delivered'`,
      )
      .run(nowIso(), fileUid);
  }

  markFailedIfUntranscribed(fileUid: string): void {
    this.#db
      .prepare(
        `UPDATE incoming_telegram_files
            SET state = 'failed', updated_at = ?
          WHERE file_uid = ?
            AND state NOT IN ('transcribed', 'delivered', 'rejected')
            AND NOT EXISTS (
                  SELECT 1 FROM transcript_revisions WHERE incoming_file_id = ?
                )`,
      )
      .run(nowIso(), fileUid, fileUid);
  }

  #find(column: 'file_uid' | 'telegram_unique_id', value: string): IncomingFileRow | undefined {
    const row = this.#db
      .prepare(
        `SELECT file_uid, telegram_file_id, telegram_unique_id, chat_id, message_id, bot_scope, update_id,
                telegram_source, attachment_type, claimed_filename, telegram_message_at,
                original_sent_at, daemon_host, state, quarantine_path, normalized_path, delivered_at
           FROM incoming_telegram_files WHERE ${column} = ?`,
      )
      .get(value) as
      | {
          file_uid: string;
          telegram_file_id: string;
          telegram_unique_id: string;
          chat_id: number;
          message_id: number;
          bot_scope: string;
          update_id: number | null;
          telegram_source: IncomingTelegramSource | null;
          attachment_type: IncomingAttachmentType | null;
          claimed_filename: string | null;
          telegram_message_at: string | null;
          original_sent_at: string | null;
          daemon_host: string | null;
          state: string;
          quarantine_path: string | null;
          normalized_path: string | null;
          delivered_at: string | null;
        }
      | undefined;
    if (row === undefined) return undefined;
    return {
      fileUid: row.file_uid,
      telegramFileId: row.telegram_file_id,
      telegramUniqueId: row.telegram_unique_id,
      chatId: row.chat_id,
      messageId: row.message_id,
      botScope: row.bot_scope,
      updateId: row.update_id,
      telegramSource: row.telegram_source,
      attachmentType: row.attachment_type,
      claimedFilename: row.claimed_filename,
      telegramMessageAt: row.telegram_message_at,
      originalSentAt: row.original_sent_at,
      daemonHost: row.daemon_host,
      state: row.state,
      quarantinePath: row.quarantine_path,
      normalizedPath: row.normalized_path,
      deliveredAt: row.delivered_at,
    };
  }
}

export interface TranscriptSegmentInput {
  readonly startMs: number | null;
  readonly endMs: number | null;
  readonly timestampSource: TimestampSource;
  readonly language: string | null;
  readonly text: string;
  /**
   * Which voice, as an index within this recording. Null means unknown, not
   * "the first speaker" — see migration 002.
   */
  readonly speaker?: number | null;
}

export interface TranscriptInput {
  readonly sessionId?: string | undefined;
  readonly incomingFileId?: string | undefined;
  readonly engine: string;
  readonly model: string;
  readonly languages: readonly string[];
  /** Null means automatic language identification; a value was forced by config/user. */
  readonly forcedLanguage?: string | null;
  readonly text: string;
  readonly segments: readonly TranscriptSegmentInput[];
}

export interface TranscriptRevisionRow {
  readonly revision_id: string;
  readonly text: string;
  readonly word_count: number;
  readonly languages: string;
  readonly forced_language: string | null;
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
  append(input: TranscriptInput, afterStored?: (revisionId: string) => void): string {
    return transaction(this.#db, () => {
      const owner = input.sessionId ?? input.incomingFileId;
      if (owner === undefined) {
        throw new Error('transcript must belong to a session or an incoming file');
      }
      const column = input.sessionId !== undefined ? 'session_id' : 'incoming_file_id';

      if (input.incomingFileId !== undefined) {
        const incoming = this.#db
          .prepare('SELECT state FROM incoming_telegram_files WHERE file_uid = ?')
          .get(input.incomingFileId) as { readonly state: string } | undefined;
        if (incoming?.state === 'delivered') {
          throw new Error('cannot supersede a delivered incoming transcript revision');
        }
        const prefix = `incoming:${input.incomingFileId}:`;
        const manifest = this.#db
          .prepare(
            `SELECT 1
               FROM telegram_outbox
              WHERE kind = 'incoming_transcript'
                AND substr(delivery_part_id, 1, ?) = ?
              LIMIT 1`,
          )
          .get(prefix.length, prefix);
        if (manifest !== undefined) {
          throw new Error('cannot supersede an incoming transcript revision after delivery starts');
        }
      }

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
              languages, forced_language, text, word_count, is_current, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
        )
        .run(
          revisionId,
          input.sessionId ?? null,
          input.incomingFileId ?? null,
          revisionNumber,
          input.engine,
          input.model,
          JSON.stringify(input.languages),
          input.forcedLanguage ?? null,
          input.text,
          wordCount,
          nowIso(),
        );

      const insertSegment = this.#db.prepare(
        `INSERT INTO transcript_segments
           (revision_id, segment_index, start_ms, end_ms, timestamp_source, language, text,
            speaker)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
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
          segment.speaker ?? null,
        );
      });

      // Some pipeline facts (for example the session language and downstream
      // jobs) must become durable with the revision, not in a later crash
      // window. The callback deliberately runs inside this transaction.
      afterStored?.(revisionId);

      return revisionId;
    });
  }

  current(sessionId: string): TranscriptRevisionRow | undefined {
    return this.#db
      .prepare(
        `SELECT revision_id, text, word_count, languages, forced_language
           FROM transcript_revisions
          WHERE session_id = ? AND is_current = 1`,
      )
      .get(sessionId) as TranscriptRevisionRow | undefined;
  }

  /** Loads one immutable revision and proves that it belongs to this session. */
  revision(sessionId: string, revisionId: string): TranscriptRevisionRow | undefined {
    return this.#db
      .prepare(
        `SELECT revision_id, text, word_count, languages, forced_language
           FROM transcript_revisions
          WHERE session_id = ? AND revision_id = ?`,
      )
      .get(sessionId, revisionId) as TranscriptRevisionRow | undefined;
  }

  segments(revisionId: string): TranscriptSegmentInput[] {
    const rows = this.#db
      .prepare(
        `SELECT start_ms, end_ms, timestamp_source, language, text, speaker
           FROM transcript_segments WHERE revision_id = ? ORDER BY segment_index`,
      )
      .all(revisionId) as {
      start_ms: number | null;
      end_ms: number | null;
      timestamp_source: TimestampSource;
      language: string | null;
      text: string;
      speaker: number | null;
    }[];
    return rows.map((r) => ({
      startMs: r.start_ms,
      endMs: r.end_ms,
      timestampSource: r.timestamp_source,
      language: r.language,
      text: r.text,
      speaker: r.speaker,
    }));
  }
}

export function appendIncomingTranscript(
  db: DatabaseSync,
  input: TranscriptInput & { readonly incomingFileId: string },
  afterStored?: () => void,
): string {
  if (input.sessionId !== undefined) {
    throw new Error('incoming transcript cannot also belong to a recorded session');
  }
  return new TranscriptRepository(db).append(input, () => {
    // State and revision are one recovery boundary: a restart must either run
    // ASR again or observe both durable facts, never a transcript by itself.
    new IncomingFileRepository(db).markTranscribed(input.incomingFileId);
    afterStored?.();
  });
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

export interface VadSegmentRow {
  readonly startMs: number;
  readonly endMs: number;
  readonly meanProbability: number;
}

/**
 * Speech segments from the final VAD pass over a finalized session.
 *
 * These are the authoritative boundaries. The streaming pass that drives the
 * sessionizer sees 32 ms at a time and cannot look ahead, so its decisions are
 * provisional; this pass sees the whole recording. They remain independent of
 * transcript timing unless an explicit mapping records VAD provenance.
 */
export class VadSegmentRepository {
  readonly #db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  /**
   * Replaces the stored segments for a session. Idempotent, so a retried ASR
   * job cannot accumulate duplicates.
   */
  replaceForSession(sessionId: string, segments: readonly VadSegmentRow[]): void {
    transaction(this.#db, () => {
      this.#db.prepare('DELETE FROM vad_segments WHERE session_id = ?').run(sessionId);
      const insert = this.#db.prepare(
        `INSERT INTO vad_segments (session_id, start_ms, end_ms, mean_probability)
         VALUES (?, ?, ?, ?)`,
      );
      for (const segment of segments) {
        insert.run(sessionId, segment.startMs, segment.endMs, segment.meanProbability);
      }
    });
  }

  listForSession(sessionId: string): VadSegmentRow[] {
    const rows = this.#db
      .prepare(
        `SELECT start_ms, end_ms, mean_probability FROM vad_segments
          WHERE session_id = ? ORDER BY start_ms`,
      )
      .all(sessionId) as unknown as {
      start_ms: number;
      end_ms: number;
      mean_probability: number;
    }[];
    return rows.map((r) => ({
      startMs: r.start_ms,
      endMs: r.end_ms,
      meanProbability: r.mean_probability,
    }));
  }

  /** Total detected speech across a session, in milliseconds. */
  totalSpeechMs(sessionId: string): number {
    const row = this.#db
      .prepare(
        'SELECT COALESCE(SUM(end_ms - start_ms), 0) AS total FROM vad_segments WHERE session_id = ?',
      )
      .get(sessionId) as { total: number };
    return row.total;
  }
}

/**
 * The diarization turns as produced, before they are matched to transcript
 * segments.
 *
 * Stored separately because the aligner and the diarizer segment the same
 * audio independently, so when a report attributes a line to the wrong voice
 * this is the only way to tell which of the two was wrong.
 */
export interface SpeakerTurnRow {
  readonly startMs: number;
  readonly endMs: number;
  readonly speaker: number;
}

export class SpeakerTurnRepository {
  readonly #db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  /** Replaces the turns for a session. Idempotent, so a retried job cannot duplicate. */
  replaceForSession(sessionId: string, turns: readonly SpeakerTurnRow[]): void {
    const now = new Date().toISOString();
    transaction(this.#db, () => {
      this.#db.prepare('DELETE FROM speaker_turns WHERE session_id = ?').run(sessionId);
      const insert = this.#db.prepare(
        `INSERT INTO speaker_turns (session_id, turn_index, start_ms, end_ms, speaker, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      );
      turns.forEach((turn, index) => {
        insert.run(sessionId, index, turn.startMs, turn.endMs, turn.speaker, now);
      });
    });
  }

  listForSession(sessionId: string): SpeakerTurnRow[] {
    const rows = this.#db
      .prepare(
        `SELECT start_ms, end_ms, speaker FROM speaker_turns
          WHERE session_id = ? ORDER BY start_ms`,
      )
      .all(sessionId) as unknown as { start_ms: number; end_ms: number; speaker: number }[];
    return rows.map((r) => ({ startMs: r.start_ms, endMs: r.end_ms, speaker: r.speaker }));
  }

  speakerCount(sessionId: string): number {
    const row = this.#db
      .prepare('SELECT COUNT(DISTINCT speaker) AS n FROM speaker_turns WHERE session_id = ?')
      .get(sessionId) as { n: number };
    return row.n;
  }
}
