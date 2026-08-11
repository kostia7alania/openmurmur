import { languageListLabel, recognitionModeLabel } from '../asr/preferences.ts';
import { speakerLabel } from '../asr/speakers.ts';

/**
 * Telegram message formatting.
 *
 * Transcripts are untrusted text: whatever someone says near the microphone
 * ends up here verbatim. Everything interpolated into an HTML-parse-mode
 * message therefore goes through `escapeHtml` first, or a transcript
 * containing `<b>` would corrupt the message and Telegram would reject it
 * with a 400.
 */

/** Telegram's hard limit for a single text message. */
export const TELEGRAM_MESSAGE_LIMIT = 4096;
/** Telegram's hard limit for a document caption. */
export const TELEGRAM_CAPTION_LIMIT = 1024;
/** Telegram's hard limit for callback-query notification text. */
export const TELEGRAM_CALLBACK_QUERY_TEXT_LIMIT = 200;

export function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/**
 * Splits text into chunks that are safe to send.
 *
 * Splitting happens on Unicode code points, never on UTF-16 code units, so a
 * chunk boundary can never land inside a surrogate pair and produce a lone
 * surrogate (emoji, and much of the CJK/Thai supplementary range). Grapheme
 * clusters are kept together where possible so a combining mark is not
 * separated from its base character.
 */
export function splitForTelegram(text: string, limit = TELEGRAM_MESSAGE_LIMIT): string[] {
  if (limit <= 0) throw new Error('limit must be positive');
  if (text.length === 0) return [];

  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  const chunks: string[] = [];
  let current = '';

  for (const { segment } of segmenter.segment(text)) {
    if (current.length + segment.length > limit) {
      if (current.length > 0) {
        chunks.push(current);
        current = '';
      }
      // A single grapheme longer than the limit cannot be split without
      // corrupting it; emit it alone and let Telegram reject it loudly.
      if (segment.length > limit) {
        chunks.push(segment);
        continue;
      }
    }
    current += segment;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

/**
 * Splits on paragraph/line boundaries where possible so a transcript reads
 * naturally across messages, falling back to grapheme splitting for a single
 * over-long line.
 */
export function splitOnBoundaries(text: string, limit: number): string[] {
  const chunks: string[] = [];
  let current = '';

  for (const line of text.split('\n')) {
    const candidate = current.length === 0 ? line : `${current}\n${line}`;
    if (candidate.length <= limit) {
      current = candidate;
      continue;
    }
    if (current.length > 0) {
      chunks.push(current);
      current = '';
    }
    if (line.length <= limit) {
      current = line;
    } else {
      chunks.push(...splitForTelegram(line, limit));
    }
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

export interface TranscriptMessage {
  readonly text: string;
  readonly partNumber: number;
  readonly partCount: number;
}

export interface TimedTranscriptSegment {
  readonly startMs: number | null;
  readonly endMs: number | null;
  readonly text: string;
  /** Which voice, when diarization ran. Null means unknown, not "the first". */
  readonly speaker?: number | null;
}

export interface TranscriptLanguageInfo {
  readonly languages: readonly string[];
  readonly forcedLanguage: string | null;
  readonly showSettingsHint?: boolean;
}

/**
 * Renders a transcript as numbered HTML messages, each carrying the session id
 * so that out-of-order delivery in a busy chat is still reassemblable.
 */
export function renderTranscriptMessages(
  sessionId: string,
  transcript: string,
  inlineLimit: number,
  provenanceHtml?: string,
  languageInfo?: TranscriptLanguageInfo,
): TranscriptMessage[] {
  const provenance =
    provenanceHtml === undefined
      ? `<code>${escapeHtml(sessionId)}</code>\n\n`
      : `${provenanceHtml}\n\n`;
  const languageLines =
    languageInfo === undefined
      ? ''
      : `🌐 Языки: ${escapeHtml(languageListLabel(languageInfo.languages))}\n` +
        `🎯 Режим: ${escapeHtml(recognitionModeLabel(languageInfo.forcedLanguage))}\n` +
        (languageInfo.showSettingsHint === true
          ? '⚙️ Кнопки ниже меняют режим следующих расшифровок.\n'
          : '') +
        '\n';
  const header = (n: number, total: number) =>
    total === 1
      ? `📝 <b>Расшифровка</b>\n${provenance}${languageLines}`
      : `📝 <b>Расшифровка ${n}/${total}</b>\n${provenance}${languageLines}`;
  const quote = (body: string) => `<blockquote expandable>${body}</blockquote>`;

  const escaped = escapeHtml(transcript);
  if (quote(escaped).length + header(1, 1).length <= inlineLimit) {
    return [{ text: header(1, 1) + quote(escaped), partNumber: 1, partCount: 1 }];
  }

  // Reserve room for the largest possible header before splitting the body.
  const reserve = header(99, 99).length + quote('').length;
  const bodies = splitOnBoundaries(escaped, Math.max(1, TELEGRAM_MESSAGE_LIMIT - reserve));
  return bodies.map((body, index) => ({
    text: header(index + 1, bodies.length) + quote(body),
    partNumber: index + 1,
    partCount: bodies.length,
  }));
}

export function renderTimedTranscriptMessages(
  sessionId: string,
  segments: readonly TimedTranscriptSegment[],
  fallbackTranscript: string,
  inlineLimit: number,
  provenanceHtml?: string,
  languageInfo?: TranscriptLanguageInfo,
): TranscriptMessage[] {
  const formatted = formatTimedTranscript(segments);
  return renderTranscriptMessages(
    sessionId,
    formatted.length > 0 ? formatted : fallbackTranscript,
    inlineLimit,
    provenanceHtml,
    languageInfo,
  );
}

export function formatTimedTranscript(
  segments: readonly TimedTranscriptSegment[],
  blockMs = 30_000,
): string {
  const timed = segments.filter(
    (segment) => segment.startMs !== null && segment.text.trim() !== '',
  );
  if (timed.length === 0) return '';

  const lines: string[] = [];
  let blockStart = timed[0]?.startMs ?? 0;
  let previousEnd = blockStart;
  let current: TimedTranscriptSegment[] = [];

  const flush = () => {
    const text = normalizeTranscriptLine(current.map((segment) => segment.text).join(''));
    if (text.length > 0) {
      // Only labelled when diarization attributed some part of the block. An
      // unlabelled line is honest; a wrong one is not.
      const speaker = current.find((s) => (s.speaker ?? null) !== null)?.speaker ?? null;
      const label = speaker === null ? '' : `${speakerLabel(speaker)}: `;
      lines.push(`${formatTimestamp(blockStart)}  ${label}${text}`);
    }
    current = [];
  };

  for (const segment of timed) {
    const start = segment.startMs ?? blockStart;
    const candidate = normalizeTranscriptLine([...current, segment].map((s) => s.text).join(''));
    const gapMs = Math.max(0, start - previousEnd);
    // A change of voice ends the block whatever the clock says: running two
    // people's words together is exactly what the labels exist to prevent.
    //
    // Only a change between two *known* voices counts, compared against the
    // last known voice rather than the last segment. Unattributed segments are
    // common — they fall in the gaps between diarization turns — and getting
    // this wrong in either direction was visible on real audio: treating each
    // null as a change shattered one person's sentence into three blocks, and
    // comparing with the immediate predecessor let a null hide the handover
    // and merged two people into one.
    const previousSpeaker = current.findLast((s) => (s.speaker ?? null) !== null)?.speaker ?? null;
    const nextSpeaker = segment.speaker ?? null;
    const voiceChanged =
      previousSpeaker !== null && nextSpeaker !== null && previousSpeaker !== nextSpeaker;
    if (
      current.length > 0 &&
      (voiceChanged || start - blockStart >= blockMs || gapMs >= 5_000 || candidate.length > 700)
    ) {
      flush();
      blockStart = start;
    }

    current.push(segment);
    previousEnd = segment.endMs ?? start;
  }
  flush();

  return lines.join('\n\n');
}

export function formatTimestamp(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const mm = String(minutes).padStart(hours > 0 ? 2 : 1, '0');
  const ss = String(seconds).padStart(2, '0');
  if (hours > 0) return `${hours}:${mm}:${ss}`;
  return `${mm}:${ss}`;
}

function normalizeTranscriptLine(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/([¿¡])\s+/g, '$1')
    .trim();
}

export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours} ч ${minutes} мин`;
  if (minutes > 0) return `${minutes} мин ${seconds} сек`;
  return `${seconds} сек`;
}

export function formatClock(wallMs: number, timeZone?: string): string {
  return new Intl.DateTimeFormat('ru-RU', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    ...(timeZone !== undefined ? { timeZone } : {}),
  }).format(new Date(wallMs));
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}
