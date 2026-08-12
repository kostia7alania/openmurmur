import type { IncomingFileRow, SessionRow } from '../database/repository.ts';
import { escapeHtml } from './format.ts';

export interface LiveCaptureProvenance {
  readonly kind: 'live_capture';
  readonly hostName: string | null;
  readonly timezone: string | null;
  readonly originalAt: string;
  readonly sessionId: string;
}

export interface IncomingTelegramProvenance {
  readonly kind: 'telegram_audio';
  readonly hostName: string | null;
  readonly telegramSource: 'direct' | 'forwarded' | null;
  readonly attachmentType: 'voice' | 'audio' | 'document' | 'video_note' | null;
  readonly telegramMessageAt: string | null;
  readonly originalSentAt: string | null;
  readonly claimedFilename: string | null;
  readonly updateId: number | null;
  readonly messageId: number;
  readonly fileUid: string;
}

export type OutputProvenance = LiveCaptureProvenance | IncomingTelegramProvenance;

const UNKNOWN = 'неизвестно';
const FORMAT_CONTROL = /\p{Cf}/u;
// Captions share Telegram's 1024 UTF-16 limit with their surrounding label.
// Bounding every variable independently keeps the complete provenance block
// below that budget even when one grapheme is many code units or HTML expands.
const MAX_DISPLAY_VALUE_UTF16 = 96;

export function liveCaptureProvenance(session: SessionRow): LiveCaptureProvenance {
  return {
    kind: 'live_capture',
    hostName: session.capture_host,
    timezone: session.capture_timezone,
    originalAt: session.started_at,
    sessionId: session.session_id,
  };
}

export function incomingTelegramProvenance(incoming: IncomingFileRow): IncomingTelegramProvenance {
  return {
    kind: 'telegram_audio',
    hostName: incoming.daemonHost,
    telegramSource: incoming.telegramSource,
    attachmentType: incoming.attachmentType,
    telegramMessageAt: incoming.telegramMessageAt,
    originalSentAt: incoming.originalSentAt,
    claimedFilename: incoming.claimedFilename,
    updateId: incoming.updateId,
    messageId: incoming.messageId,
    fileUid: incoming.fileUid,
  };
}

/**
 * Provenance is display metadata only. In particular, claimedFilename is
 * untrusted Telegram input: it is bounded, control characters are made visible
 * and it never leaves this renderer for a path or a decision.
 */
export function renderProvenanceHtml(provenance: OutputProvenance): string {
  return provenanceLines(
    provenance,
    (value) => `<code>${escapeHtml(displayUntrusted(value))}</code>`,
  ).join('\n');
}

export function renderProvenancePlain(provenance: OutputProvenance): string {
  return provenanceLines(provenance, displayUntrusted).join('\n');
}

export function renderProvenanceMarkdown(provenance: OutputProvenance): string {
  return provenanceLines(provenance, (value) => `\`${escapeMarkdown(value)}\``)
    .map((line) => `- ${line}`)
    .join('\n');
}

function provenanceLines(provenance: OutputProvenance, code: (value: string) => string): string[] {
  if (provenance.kind === 'live_capture') {
    return [
      'Источник: фоновая запись OpenMurmur',
      `Демон: ${code(displayValue(provenance.hostName))}`,
      `Исходные дата/время: ${code(formatWallTime(provenance.originalAt, provenance.timezone))}`,
      `Часовой пояс записи: ${code(displayValue(provenance.timezone))}`,
      `UID сессии: ${code(provenance.sessionId)}`,
    ];
  }

  const source =
    provenance.telegramSource === 'forwarded'
      ? 'пересланное аудио из Telegram'
      : provenance.telegramSource === 'direct'
        ? 'загруженное аудио из Telegram'
        : 'аудио из Telegram';
  const lines = [
    `Источник: ${source}${attachmentLabel(provenance.attachmentType)}`,
    `Демон: ${code(displayValue(provenance.hostName))}`,
  ];
  if (provenance.originalSentAt !== null) {
    lines.push(`Исходные дата/время: ${code(formatWallTime(provenance.originalSentAt, 'UTC'))}`);
  } else {
    lines.push(`Исходные дата/время: ${code(formatWallTime(provenance.telegramMessageAt, 'UTC'))}`);
  }
  lines.push(
    `Сообщение боту: ${code(formatWallTime(provenance.telegramMessageAt, 'UTC'))}`,
    `ID обновления/сообщения Telegram: ${code(`${displayNumber(provenance.updateId)}/${provenance.messageId}`)}`,
  );
  if (provenance.claimedFilename !== null) {
    lines.push(`Исходное имя: ${code(displayUntrusted(provenance.claimedFilename))}`);
  }
  lines.push(`UID файла: ${code(provenance.fileUid)}`);
  return lines;
}

function attachmentLabel(attachmentType: IncomingTelegramProvenance['attachmentType']): string {
  if (attachmentType === null) return '';
  const labels = {
    voice: 'голосовое сообщение',
    audio: 'аудио',
    document: 'документ',
    video_note: 'видеосообщение',
  } as const;
  return ` (${labels[attachmentType]})`;
}

function displayNumber(value: number | null): string {
  return value === null ? UNKNOWN : String(value);
}

function displayValue(value: string | null): string {
  return value === null || value.trim() === '' ? UNKNOWN : displayUntrusted(value);
}

function formatWallTime(value: string | null, timezone: string | null): string {
  if (value === null) return UNKNOWN;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return displayUntrusted(value);
  if (timezone === null) return `${date.toISOString()} (часовой пояс ${UNKNOWN})`;
  try {
    const formatted = new Intl.DateTimeFormat('ru-RU', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
      timeZone: timezone,
      timeZoneName: 'short',
    }).format(date);
    return `${formatted} (${timezone})`;
  } catch {
    return `${date.toISOString()} (${displayUntrusted(timezone)})`;
  }
}

function displayUntrusted(value: string): string {
  const visible = [...value]
    .map((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      if (FORMAT_CONTROL.test(character)) return '';
      return codePoint <= 31 || (codePoint >= 127 && codePoint <= 159) ? '�' : character;
    })
    .join('');
  if (visible.trim().length === 0) return UNKNOWN;
  let bounded = '';
  let escapedLength = 0;
  for (const { segment } of new Intl.Segmenter(undefined, {
    granularity: 'grapheme',
  }).segment(visible)) {
    const escapedSegmentLength = escapeHtml(segment).length;
    if (
      bounded.length + segment.length > MAX_DISPLAY_VALUE_UTF16 ||
      escapedLength + escapedSegmentLength > MAX_DISPLAY_VALUE_UTF16
    ) {
      return `${bounded}…`;
    }
    bounded += segment;
    escapedLength += escapedSegmentLength;
  }
  return bounded;
}

function escapeMarkdown(value: string): string {
  return displayUntrusted(value).replaceAll('\\', '\\\\').replaceAll('`', '\\`');
}
