import type { StructuredSummary } from '../llm/schema.ts';
import { escapeHtml, formatClock, formatDuration } from './format.ts';

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

/**
 * Renders the structured Telegram report.
 *
 * Every interpolated value that can originate from speech — the summary, every
 * list item, the language names — is HTML-escaped. Only the tags this function
 * writes itself are live markup.
 */
export function renderSessionReport(input: SessionReportInput): string {
  const lines: string[] = [
    '🎙 <b>Сессия завершена</b>',
    '',
    `Время: ${formatClock(input.startedWallMs, input.timezone)}–${formatClock(input.endedWallMs, input.timezone)}`,
    `Продолжительность: ${formatDuration(input.durationMs)}`,
    `Речь: ${formatDuration(input.speechMs)}`,
    `Языки: ${escapeHtml(languageLabel(input.languages))}`,
    `Частей аудио: ${input.partCount}`,
  ];

  const s = input.summary;
  if (s.summary.length > 0) {
    lines.push('', '<b>Кратко:</b>', escapeHtml(s.summary));
  }

  lines.push(...bulletList('Решения:', s.decisions));
  lines.push(...bulletList('Задачи:', s.tasks));
  lines.push(...bulletList('Обязательства:', s.commitments));
  lines.push(...bulletList('Расходы:', s.expenses));
  lines.push(...bulletList('Идеи:', s.ideas));
  lines.push(...bulletList('Вопросы:', s.questions));
  lines.push(...bulletList('Неуверенность:', s.uncertainties));

  if (s.people.length > 0) {
    lines.push('', `Люди: ${escapeHtml(s.people.join(', '))}`);
  }
  if (s.places.length > 0) {
    lines.push(`Места: ${escapeHtml(s.places.join(', '))}`);
  }

  lines.push('', `Session ID: <code>${escapeHtml(input.sessionId)}</code>`);
  return lines.join('\n');
}

export interface StatusReportInput {
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

  return [
    input.recording ? '🟢 <b>OpenMurmur работает</b>' : '🔴 <b>OpenMurmur не записывает</b>',
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
