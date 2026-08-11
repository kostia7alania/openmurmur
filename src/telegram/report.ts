import { languageListLabel } from '../asr/preferences.ts';
import type { StructuredSummary, SummaryClaimField } from '../llm/schema.ts';
import {
  escapeHtml,
  formatClock,
  formatDuration,
  formatTimestamp,
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
  /** False means crash recovery could not prove exact monotonic timing. */
  readonly timingExact?: boolean | undefined;
  readonly languages: readonly string[];
  readonly partCount: number;
  readonly summary: StructuredSummary;
  readonly transcriptRevisionId?: string | undefined;
  readonly timezone?: string | undefined;
  readonly transcript?: string | undefined;
  readonly transcriptSegments?: readonly TimedTranscriptSegment[] | undefined;
  readonly provenance?: OutputProvenance | undefined;
}

function bulletList(
  title: string,
  field: SummaryClaimField,
  items: readonly string[],
  summary: StructuredSummary,
): string[] {
  if (items.length === 0) return [];
  return [
    '',
    `<b>${title}</b>`,
    ...items.map(
      (item, index) => `• ${escapeHtml(item)}${claimEvidenceHtml(summary, field, index)}`,
    ),
  ];
}

function markdownList(
  title: string,
  field: SummaryClaimField,
  items: readonly string[],
  summary: StructuredSummary,
): string[] {
  if (items.length === 0) return [];
  return [
    '',
    `## ${title}`,
    '',
    ...items.map(
      (item, index) => `- ${escapeMarkdown(item)}${claimEvidenceMarkdown(summary, field, index)}`,
    ),
  ];
}

function claimEvidenceSegments(
  summary: StructuredSummary,
  field: SummaryClaimField,
  item: number,
): readonly number[] {
  return (
    summary.claimEvidence.find((claim) => claim.field === field && claim.item === item)?.segments ??
    []
  );
}

function claimEvidenceLabel(
  summary: StructuredSummary,
  field: SummaryClaimField,
  item: number,
): string {
  const segments = claimEvidenceSegments(summary, field, item);
  return segments.length === 0
    ? 'ссылка модели: не указана'
    : `ссылка модели: сегм. ${segments.map((segment) => segment + 1).join(', ')}`;
}

function claimEvidenceHtml(
  summary: StructuredSummary,
  field: SummaryClaimField,
  item: number,
): string {
  return ` <i>[${escapeHtml(claimEvidenceLabel(summary, field, item))}]</i>`;
}

function claimEvidenceMarkdown(
  summary: StructuredSummary,
  field: SummaryClaimField,
  item: number,
): string {
  return ` _[${escapeMarkdown(claimEvidenceLabel(summary, field, item))}]_`;
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
  const timingExact = input.timingExact ?? true;
  const details: string[] = [
    `Время: ${formatClock(input.startedWallMs, input.timezone)}–${timingExact ? formatClock(input.endedWallMs, input.timezone) : 'неизвестно'}`,
    `Продолжительность: ${timingExact ? formatDuration(input.durationMs) : 'неизвестно'}`,
    `Речь: ${timingExact ? formatDuration(input.speechMs) : 'неизвестно'}`,
    `Языки: ${escapeHtml(languageListLabel(input.languages))}`,
    `Частей аудио: ${input.partCount}`,
  ];
  if (input.transcriptRevisionId !== undefined) {
    details.push(`Ревизия транскрипта: <code>${escapeHtml(input.transcriptRevisionId)}</code>`);
  }

  const s = input.summary;
  details.push(...bulletList('Решения:', 'decisions', s.decisions, s));
  details.push(...bulletList('Задачи:', 'tasks', s.tasks, s));
  details.push(...bulletList('Обязательства:', 'commitments', s.commitments, s));
  details.push(...bulletList('Расходы:', 'expenses', s.expenses, s));
  details.push(...bulletList('Идеи:', 'ideas', s.ideas, s));
  details.push(...bulletList('Вопросы:', 'questions', s.questions, s));
  details.push(...bulletList('Неуверенность:', 'uncertainties', s.uncertainties, s));

  if (s.people.length > 0) {
    details.push(
      '',
      `Люди: ${s.people
        .map((person, index) => `${escapeHtml(person)}${claimEvidenceHtml(s, 'people', index)}`)
        .join(', ')}`,
    );
  }
  if (s.places.length > 0) {
    details.push(
      `Места: ${s.places
        .map((place, index) => `${escapeHtml(place)}${claimEvidenceHtml(s, 'places', index)}`)
        .join(', ')}`,
    );
  }

  const transcript = reportTranscript(input);
  if (transcript !== null) {
    details.push('', `<b>${transcript.title}:</b>`, escapeHtml(transcript.text));
  }

  if (input.provenance === undefined) {
    details.push('', `UID сессии: <code>${escapeHtml(input.sessionId)}</code>`);
  } else {
    details.push('', '<b>Происхождение:</b>', renderProvenanceHtml(input.provenance));
  }

  const lines: string[] = ['🎙 <b>Сессия завершена</b>'];
  if (s.summary.length > 0) {
    lines.push(
      '',
      '🧠 <b>Кратко</b>',
      `<blockquote expandable>${escapeHtml(s.summary)}${claimEvidenceHtml(s, 'summary', 0)}</blockquote>`,
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
  const evidence = claimEvidenceHtml(input.summary, 'summary', 0);
  const revision =
    input.transcriptRevisionId === undefined
      ? ''
      : `\n\nРевизия транскрипта: <code>${escapeHtml(input.transcriptRevisionId)}</code>`;
  const provenance =
    input.provenance === undefined ? '' : `\n\n${renderProvenanceHtml(input.provenance)}`;
  const summary = compactPreview(
    input.summary.summary,
    500,
    TELEGRAM_MESSAGE_LIMIT -
      prefix.length -
      suffix.length -
      evidence.length -
      revision.length -
      provenance.length,
  );
  return `${prefix}${escapeHtml(summary)}${evidence}${suffix}${revision}${provenance}`;
}

/** Full report artifact used when the Telegram-sized HTML rendering is too long. */
export function renderSessionReportMarkdown(input: SessionReportInput): string {
  const timingExact = input.timingExact ?? true;
  const lines: string[] = [
    '# Отчёт OpenMurmur',
    '',
    ...(input.provenance === undefined
      ? [`- UID сессии: \`${input.sessionId}\``]
      : [renderProvenanceMarkdown(input.provenance)]),
    `- Время: ${formatClock(input.startedWallMs, input.timezone)}–${timingExact ? formatClock(input.endedWallMs, input.timezone) : 'неизвестно'}`,
    `- Продолжительность: ${timingExact ? formatDuration(input.durationMs) : 'неизвестно'}`,
    `- Речь: ${timingExact ? formatDuration(input.speechMs) : 'неизвестно'}`,
    `- Языки: ${languageListLabel(input.languages)}`,
    `- Частей аудио: ${input.partCount}`,
    ...(input.transcriptRevisionId === undefined
      ? []
      : [`- Ревизия транскрипта: \`${escapeMarkdown(input.transcriptRevisionId)}\``]),
  ];

  const s = input.summary;
  if (s.summary.length > 0) {
    lines.push(
      '',
      '## Кратко',
      '',
      `${escapeMarkdown(s.summary)}${claimEvidenceMarkdown(s, 'summary', 0)}`,
    );
  }
  lines.push(...markdownList('Решения', 'decisions', s.decisions, s));
  lines.push(...markdownList('Задачи', 'tasks', s.tasks, s));
  lines.push(...markdownList('Обязательства', 'commitments', s.commitments, s));
  lines.push(...markdownList('Расходы', 'expenses', s.expenses, s));
  lines.push(...markdownList('Идеи', 'ideas', s.ideas, s));
  lines.push(...markdownList('Вопросы', 'questions', s.questions, s));
  lines.push(...markdownList('Неуверенность', 'uncertainties', s.uncertainties, s));
  if (s.people.length > 0) {
    lines.push(
      '',
      `**Люди:** ${s.people
        .map(
          (person, index) =>
            `${escapeMarkdown(person)}${claimEvidenceMarkdown(s, 'people', index)}`,
        )
        .join(', ')}`,
    );
  }
  if (s.places.length > 0) {
    lines.push(
      '',
      `**Места:** ${s.places
        .map(
          (place, index) => `${escapeMarkdown(place)}${claimEvidenceMarkdown(s, 'places', index)}`,
        )
        .join(', ')}`,
    );
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
  if (segments.length > 0) {
    return {
      title: 'Сегменты-источники транскрипта',
      text: segments
        .map((segment, index) => {
          const time = segment.startMs === null ? 'без времени' : formatTimestamp(segment.startMs);
          const speaker =
            (segment.speaker ?? null) === null ? '' : ` · Голос ${(segment.speaker ?? 0) + 1}`;
          const text = segment.text.replace(/\s+/gu, ' ').trim() || '(пустой сегмент)';
          return `[сегм. ${index + 1}] ${time}${speaker}: ${text}`;
        })
        .join('\n\n'),
    };
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
  readonly processingLagSeconds: number | null;
  readonly sessionState: string;
  readonly sessionElapsedMs: number | null;
  readonly lastClosedPartMinutesAgo: number | null;
  readonly asrBacklog: number;
  readonly failedJobs: number;
  readonly outboxPending: number;
  readonly failedOutbox: number;
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
    `Последний аудиокадр: ${ago(input.lastFrameSecondsAgo, 'сек')}`,
    `Отставание обработки: ${
      input.processingLagSeconds === null
        ? 'нет данных'
        : `${Math.round(input.processingLagSeconds)} сек`
    }`,
    `Текущая сессия: ${escapeHtml(session)}`,
    `Последний закрытый файл: ${ago(input.lastClosedPartMinutesAgo, 'мин')}`,
    `Очередь ASR: ${input.asrBacklog}`,
    `Ошибочные задачи: ${input.failedJobs}`,
    `Очередь Telegram: ${input.outboxPending}`,
    `Недоставленные сообщения: ${input.failedOutbox}`,
    `Последняя доставка: ${ago(input.lastDeliveryMinutesAgo, 'мин')}`,
    `Свободный диск: ${input.diskFreeGb.toFixed(0)} ГБ`,
    `ASR: ${escapeHtml(input.asrStatus)}`,
    `LLM: ${escapeHtml(input.llmStatus)}`,
    `Версия: ${escapeHtml(input.version)}`,
  ].join('\n');
}

/** Stable chat copy; the capture exception itself remains in the local log. */
export function renderCaptureFailure(recordingWasAnnounced: boolean): string {
  const heading = recordingWasAnnounced ? '🔴 Запись остановлена' : '🔴 Запись не запустилась';
  return [
    heading,
    '',
    'Не удалось получать аудио с микрофона.',
    'Проверьте доступ к микрофону и запустите `pnpm openmurmur doctor` в корне репозитория.',
    'Технические подробности сохранены в локальном журнале.',
  ].join('\n');
}

export const HELP_TEXT = [
  '<b>OpenMurmur</b>',
  '',
  'Команды:',
  '/status — подробное состояние демона',
  '/health — короткая сводка на русском',
  '/settings — режим языка для следующих расшифровок',
  '/help — этот текст',
  '',
  'Пришлите голосовое сообщение или аудиофайл — бот распознает его локально.',
  'Поддерживаются: .ogg .opus .mp3 .m4a .aac .wav .flac (до 20 MB — ограничение Telegram).',
  '',
  'Записью управляет демон на вашем Mac. Удалённых команд остановки нет.',
].join('\n');
