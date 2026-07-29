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

/**
 * Renders a transcript as numbered HTML messages, each carrying the session id
 * so that out-of-order delivery in a busy chat is still reassemblable.
 */
export function renderTranscriptMessages(
  sessionId: string,
  transcript: string,
  inlineLimit: number,
): TranscriptMessage[] {
  const header = (n: number, total: number) =>
    total === 1
      ? `📝 <b>Transcript</b>\n<code>${escapeHtml(sessionId)}</code>\n\n`
      : `📝 <b>Transcript ${n}/${total}</b>\n<code>${escapeHtml(sessionId)}</code>\n\n`;

  const escaped = escapeHtml(transcript);
  if (escaped.length + header(1, 1).length <= inlineLimit) {
    return [{ text: header(1, 1) + escaped, partNumber: 1, partCount: 1 }];
  }

  // Reserve room for the largest possible header before splitting the body.
  const reserve = header(99, 99).length;
  const bodies = splitOnBoundaries(escaped, Math.max(1, TELEGRAM_MESSAGE_LIMIT - reserve));
  return bodies.map((body, index) => ({
    text: header(index + 1, bodies.length) + body,
    partNumber: index + 1,
    partCount: bodies.length,
  }));
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
