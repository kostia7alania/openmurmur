import type { StructuredSummary } from '../llm/schema.ts';
import {
  escapeHtml,
  formatClock,
  formatDuration,
  formatTimedTranscript,
  TELEGRAM_MESSAGE_LIMIT,
  type TimedTranscriptSegment,
} from './format.ts';
import {
  type OutputProvenance,
  renderProvenanceHtml,
  renderProvenanceMarkdown,
} from './provenance.ts';

export interface SessionReportInput {
  readonly sessionId: string;
  readonly startedWallMs: number;
  readonly endedWallMs: number;
  readonly durationMs: number;
  readonly speechMs: number;
  readonly languages: readonly string[];
  readonly partCount: number;
  readonly summary: StructuredSummary;
  readonly timezone?: string | undefined;
  readonly transcript?: string | undefined;
  readonly transcriptSegments?: readonly TimedTranscriptSegment[] | undefined;
  readonly provenance?: OutputProvenance | undefined;
}

const LANGUAGE_NAMES: Record<string, string> = {
  ru: 'русский',
  en: 'английский',
  th: 'тайский',
  de: 'немецкий',
  fr: 'французский',
  es: 'испанский',
  zh: 'китайский',
};

function languageLabel(codes: readonly string[]): string {
  if (codes.length === 0) return 'не определены';
  return codes.map((code) => LANGUAGE_NAMES[code] ?? code).join(', ');
}

function bulletList(title: string, items: readonly string[]): string[] {
  if (items.length === 0) return [];
  return ['', `<b>${title}</b>`, ...items.map((item) => `• ${escapeHtml(item)}`)];
}

function markdownList(title: string, items: readonly string[]): string[] {
  if (items.length === 0) return [];
  return ['', `## ${title}`, '', ...items.map((item) => `- ${escapeMarkdown(item)}`)];
}

function escapeMarkdown(text: string): string {
  return escapeHtml(text)
    .replaceAll('\\', '\\\\')
    .replace(/([`*_{}[\]()#+.!|>-])/g, '\\$1');
}

/**
 * Renders the structured Telegram report.
 *
 * Every interpolated value that can originate from speech — the summary, every
 * list item, the language names — is HTML-escaped. Only the tags this function
 * writes itself are live markup.
 */
export function renderSessionReport(input: SessionReportInput): string {
  const details: string[] = [
    `Время: ${formatClock(input.startedWallMs, input.timezone)}–${formatClock(input.endedWallMs, input.timezone)}`,
    `Продолжительность: ${formatDuration(input.durationMs)}`,
    `Речь: ${formatDuration(input.speechMs)}`,
    `Языки: ${escapeHtml(languageLabel(input.languages))}`,
    `Частей аудио: ${input.partCount}`,
  ];

  const s = input.summary;
  details.push(...bulletList('Решения:', s.decisions));
  details.push(...bulletList('Задачи:', s.tasks));
  details.push(...bulletList('Обязательства:', s.commitments));
  details.push(...bulletList('Расходы:', s.expenses));
  details.push(...bulletList('Идеи:', s.ideas));
  details.push(...bulletList('Вопросы:', s.questions));
  details.push(...bulletList('Неуверенность:', s.uncertainties));

  if (s.people.length > 0) {
    details.push('', `Люди: ${escapeHtml(s.people.join(', '))}`);
  }
  if (s.places.length > 0) {
    details.push(`Места: ${escapeHtml(s.places.join(', '))}`);
  }

  const transcript = reportTranscript(input);
  if (transcript !== null) {
    details.push('', `<b>${transcript.title}:</b>`, escapeHtml(transcript.text));
  }

  if (input.provenance === undefined) {
    details.push('', `Session UID: <code>${escapeHtml(input.sessionId)}</code>`);
  } else {
    details.push('', '<b>Происхождение:</b>', renderProvenanceHtml(input.provenance));
  }

  const lines: string[] = ['🎙 <b>Сессия завершена</b>'];
  if (s.summary.length > 0) {
    lines.push(
      '',
      '🧠 <b>Кратко</b>',
      `<blockquote expandable>${escapeHtml(s.summary)}</blockquote>`,
    );
  }
  lines.push('', '📋 <b>Отчёт</b>', `<blockquote expandable>${details.join('\n')}</blockquote>`);
  return lines.join('\n');
}

/** Compact companion message sent before a long Markdown report attachment. */
export function renderSessionSummaryPreview(input: SessionReportInput): string {
  if (input.summary.summary.length === 0) return '';
  const prefix = '🧠 <b>Кратко</b>\n<blockquote expandable>';
  const suffix = '</blockquote>';
  const provenance =
    input.provenance === undefined ? '' : `\n\n${renderProvenanceHtml(input.provenance)}`;
  const summary = compactPreview(
    input.summary.summary,
    500,
    TELEGRAM_MESSAGE_LIMIT - prefix.length - suffix.length - provenance.length,
  );
  return `${prefix}${escapeHtml(summary)}${suffix}${provenance}`;
}

/** Full report artifact used when the Telegram-sized HTML rendering is too long. */
export function renderSessionReportMarkdown(input: SessionReportInput): string {
  const lines: string[] = [
    '# OpenMurmur session report',
    '',
    ...(input.provenance === undefined
      ? [`- Session UID: \`${input.sessionId}\``]
      : [renderProvenanceMarkdown(input.provenance)]),
    `- Time: ${formatClock(input.startedWallMs, input.timezone)}–${formatClock(input.endedWallMs, input.timezone)}`,
    `- Duration: ${formatDuration(input.durationMs)}`,
    `- Speech: ${formatDuration(input.speechMs)}`,
    `- Languages: ${languageLabel(input.languages)}`,
    `- Audio parts: ${input.partCount}`,
  ];

  const s = input.summary;
  if (s.summary.length > 0) lines.push('', '## Summary', '', escapeMarkdown(s.summary));
  lines.push(...markdownList('Decisions', s.decisions));
  lines.push(...markdownList('Tasks', s.tasks));
  lines.push(...markdownList('Commitments', s.commitments));
  lines.push(...markdownList('Expenses', s.expenses));
  lines.push(...markdownList('Ideas', s.ideas));
  lines.push(...markdownList('Questions', s.questions));
  lines.push(...markdownList('Uncertainties', s.uncertainties));
  if (s.people.length > 0) {
    lines.push('', `**People:** ${s.people.map(escapeMarkdown).join(', ')}`);
  }
  if (s.places.length > 0) {
    lines.push('', `**Places:** ${s.places.map(escapeMarkdown).join(', ')}`);
  }
  const transcript = reportTranscript(input);
  if (transcript !== null) {
    lines.push('', `## ${transcript.title}`, '', escapeMarkdown(transcript.text));
  }
  return `${lines.join('\n')}\n`;
}

function reportTranscript(
  input: SessionReportInput,
): { readonly title: string; readonly text: string } | null {
  const segments = input.transcriptSegments ?? [];
  const timed = formatTimedTranscript(segments);
  if (timed.length > 0) {
    const hasSpeakers = segments.some((segment) => (segment.speaker ?? null) !== null);
    return { title: hasSpeakers ? 'Таймлайн и голоса' : 'Таймлайн', text: timed };
  }
  const fallback = input.transcript?.trim() ?? '';
  return fallback.length > 0 ? { title: 'Транскрипт', text: fallback } : null;
}

function compactPreview(text: string, maxGraphemes: number, maxEscapedLength: number): string {
  const segments = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)];
  let raw = '';
  let escapedLength = 0;
  let count = 0;

  for (const { segment } of segments) {
    const segmentLength = escapeHtml(segment).length;
    if (count >= maxGraphemes || escapedLength + segmentLength + 1 > maxEscapedLength) {
      return `${raw}…`;
    }
    raw += segment;
    escapedLength += segmentLength;
    count += 1;
  }
  return raw;
}

export interface StatusReportInput {
  readonly hostName: string;
  readonly recording: boolean;
  readonly lastFrameSecondsAgo: number | null;
  readonly sessionState: string;
  readonly sessionElapsedMs: number | null;
  readonly lastClosedPartMinutesAgo: number | null;
  readonly asrBacklog: number;
  readonly outboxPending: number;
  readonly lastDeliveryMinutesAgo: number | null;
  readonly diskFreeGb: number;
  readonly asrStatus: string;
  readonly llmStatus: string;
  readonly version: string;
}

export function renderStatus(input: StatusReportInput): string {
  const ago = (value: number | null, unit: string) =>
    value === null ? 'нет данных' : `${Math.round(value)} ${unit} назад`;

  const session =
    input.sessionElapsedMs === null
      ? input.sessionState
      : `${input.sessionState}, ${formatDuration(input.sessionElapsedMs)}`;
  const heading = input.recording ? 'OpenMurmur работает' : 'OpenMurmur не записывает';

  return [
    `${input.recording ? '🟢' : '🔴'} <b>${heading}</b> — <code>${escapeHtml(input.hostName)}</code>`,
    '',
    `Запись: ${input.recording ? 'включена' : 'остановлена'}`,
    `Последний audio frame: ${ago(input.lastFrameSecondsAgo, 'сек')}`,
    `Текущая сессия: ${escapeHtml(session)}`,
    `Последний закрытый файл: ${ago(input.lastClosedPartMinutesAgo, 'мин')}`,
    `ASR backlog: ${input.asrBacklog}`,
    `Telegram outbox: ${input.outboxPending}`,
    `Последняя доставка: ${ago(input.lastDeliveryMinutesAgo, 'мин')}`,
    `Свободный диск: ${input.diskFreeGb.toFixed(0)} GB`,
    `ASR: ${escapeHtml(input.asrStatus)}`,
    `LLM: ${escapeHtml(input.llmStatus)}`,
    `Версия: ${escapeHtml(input.version)}`,
  ].join('\n');
}

export const HELP_TEXT = [
  '<b>OpenMurmur</b>',
  '',
  'Команды:',
  '/status — подробное состояние демона',
  '/health — короткая сводка OK / WARN / ERROR',
  '/help — этот текст',
  '',
  'Пришлите голосовое сообщение или аудиофайл — бот распознает его локально.',
  'Поддерживаются: .ogg .opus .mp3 .m4a .aac .wav .flac (до 20 MB — ограничение Telegram).',
  '',
  'Записью управляет демон на вашем Mac. Удалённых команд остановки нет.',
].join('\n');
