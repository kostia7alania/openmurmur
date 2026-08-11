import { languageListLabel } from '../asr/preferences.ts';
import type { StructuredSummary, SummaryClaimField } from '../llm/schema.ts';
import {
  escapeHtml,
  formatClock,
  formatDuration,
  formatTimestamp,
  TELEGRAM_MESSAGE_LIMIT,
  type TimedTranscriptSegment,
  timestampSourceLabel,
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
  transcriptSegments: readonly TimedTranscriptSegment[] | undefined,
): string[] {
  if (items.length === 0) return [];
  return [
    '',
    `<b>${title}</b>`,
    ...items.map(
      (item, index) =>
        `• ${escapeHtml(item)}\n↳ ${claimEvidenceHtml(summary, field, index, transcriptSegments)}`,
    ),
  ];
}

function markdownList(
  title: string,
  field: SummaryClaimField,
  items: readonly string[],
  summary: StructuredSummary,
  transcriptSegments: readonly TimedTranscriptSegment[] | undefined,
): string[] {
  if (items.length === 0) return [];
  return [
    '',
    `## ${title}`,
    '',
    ...items.map(
      (item, index) =>
        `- ${escapeMarkdown(item)}\n  ↳ ${claimEvidenceMarkdown(summary, field, index, transcriptSegments)}`,
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
  transcriptSegments: readonly TimedTranscriptSegment[] | undefined,
): string {
  const segments = claimEvidenceSegments(summary, field, item);
  if (segments.length === 0) return 'ссылка модели: не указана';

  const label = `ссылка модели: сегм. ${segments.map((segment) => segment + 1).join(', ')}`;
  const claim = claimText(summary, field, item);
  let best:
    | {
        readonly segment: number;
        readonly excerpt: string;
        readonly wordCount: number;
        readonly characterCount: number;
      }
    | undefined;
  let hasSourceText = false;
  for (const segment of segments) {
    const text = transcriptSegments?.[segment]?.text.replace(/\s+/gu, ' ').trim() ?? '';
    if (text.length === 0) continue;
    hasSourceText = true;
    const match = localizedSourceExcerpt(claim, text);
    if (
      match !== null &&
      (best === undefined ||
        match.wordCount > best.wordCount ||
        (match.wordCount === best.wordCount && match.characterCount > best.characterCount))
    ) {
      best = { segment, ...match };
    }
  }
  if (best !== undefined) {
    const excerptLabel = segments.length === 1 ? 'фрагмент' : `фрагмент сегм. ${best.segment + 1}`;
    return `${label}; ${excerptLabel}: «${best.excerpt}»`;
  }
  if (hasSourceText) return `${label}; фрагмент внутри сегмента не локализован`;
  return label;
}

function claimText(summary: StructuredSummary, field: SummaryClaimField, item: number): string {
  if (field === 'summary') return summary.summary;
  return summary[field][item] ?? '';
}

interface WordToken {
  readonly normalized: string;
  readonly start: number;
  readonly end: number;
}

interface WordMatch {
  readonly start: number;
  readonly end: number;
  readonly wordCount: number;
  readonly characterCount: number;
}

function wordTokens(text: string): WordToken[] {
  return [...new Intl.Segmenter('und', { granularity: 'word' }).segment(text)]
    .filter((part) => part.isWordLike === true)
    .map((part) => ({
      normalized: part.segment.normalize('NFC').toLocaleLowerCase('und'),
      start: part.index,
      end: part.index + part.segment.length,
    }));
}

function bestWordMatch(claim: string, source: string): WordMatch | null {
  const claimTokens = wordTokens(claim);
  const sourceTokens = wordTokens(source);
  if (claimTokens.length === 0 || sourceTokens.length === 0) return null;

  const claimPositions = new Map<string, number[]>();
  for (const [index, token] of claimTokens.entries()) {
    const positions = claimPositions.get(token.normalized) ?? [];
    positions.push(index);
    claimPositions.set(token.normalized, positions);
  }

  let previous = new Map<number, WordMatch>();
  let best: WordMatch | null = null;
  for (const sourceToken of sourceTokens) {
    const current = new Map<number, WordMatch>();
    for (const claimIndex of claimPositions.get(sourceToken.normalized) ?? []) {
      const prefix = previous.get(claimIndex - 1);
      const candidate: WordMatch = {
        start: prefix?.start ?? sourceToken.start,
        end: sourceToken.end,
        wordCount: (prefix?.wordCount ?? 0) + 1,
        characterCount: (prefix?.characterCount ?? 0) + sourceToken.normalized.length,
      };
      current.set(claimIndex, candidate);
      if (
        best === null ||
        candidate.wordCount > best.wordCount ||
        (candidate.wordCount === best.wordCount && candidate.characterCount > best.characterCount)
      ) {
        best = candidate;
      }
    }
    previous = current;
  }

  if (
    best === null ||
    (best.wordCount === 1 && (claimTokens.length > 1 || best.characterCount < 3))
  ) {
    return null;
  }
  return best;
}

function localizedSourceExcerpt(
  claim: string,
  source: string,
): (WordMatch & { readonly excerpt: string }) | null {
  const match = bestWordMatch(claim, source);
  if (match === null) return null;

  const graphemes = [...new Intl.Segmenter('und', { granularity: 'grapheme' }).segment(source)];
  let anchorStart = 0;
  while (
    anchorStart + 1 < graphemes.length &&
    (graphemes[anchorStart + 1]?.index ?? source.length) <= match.start
  ) {
    anchorStart += 1;
  }
  let anchorEnd = anchorStart + 1;
  while (
    anchorEnd < graphemes.length &&
    (graphemes[anchorEnd]?.index ?? source.length) < match.end
  ) {
    anchorEnd += 1;
  }

  const maxGraphemes = 120;
  const midpoint = Math.floor((anchorStart + anchorEnd) / 2);
  let left = Math.max(
    0,
    Math.min(graphemes.length - maxGraphemes, midpoint - Math.floor(maxGraphemes / 2)),
  );
  let right = Math.min(graphemes.length, left + maxGraphemes);
  const render = () =>
    `${left > 0 ? '…' : ''}${graphemes
      .slice(left, right)
      .map((part) => part.segment)
      .join('')}${right < graphemes.length ? '…' : ''}`;

  while (escapeHtml(render()).length > 320) {
    const leftContext = anchorStart - left;
    const rightContext = right - anchorEnd;
    if (leftContext <= 0 && rightContext <= 0) return null;
    if (rightContext > leftContext && right > anchorEnd) right -= 1;
    else if (left < anchorStart) left += 1;
    else right -= 1;
  }
  return { ...match, excerpt: render() };
}

function claimEvidenceHtml(
  summary: StructuredSummary,
  field: SummaryClaimField,
  item: number,
  transcriptSegments: readonly TimedTranscriptSegment[] | undefined,
): string {
  return `<i>[${escapeHtml(claimEvidenceLabel(summary, field, item, transcriptSegments))}]</i>`;
}

function claimEvidenceMarkdown(
  summary: StructuredSummary,
  field: SummaryClaimField,
  item: number,
  transcriptSegments: readonly TimedTranscriptSegment[] | undefined,
): string {
  return `_[${escapeMarkdown(claimEvidenceLabel(summary, field, item, transcriptSegments))}]_`;
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
  details.push(...bulletList('Решения:', 'decisions', s.decisions, s, input.transcriptSegments));
  details.push(...bulletList('Задачи:', 'tasks', s.tasks, s, input.transcriptSegments));
  details.push(
    ...bulletList('Обязательства:', 'commitments', s.commitments, s, input.transcriptSegments),
  );
  details.push(...bulletList('Расходы:', 'expenses', s.expenses, s, input.transcriptSegments));
  details.push(...bulletList('Идеи:', 'ideas', s.ideas, s, input.transcriptSegments));
  details.push(...bulletList('Вопросы:', 'questions', s.questions, s, input.transcriptSegments));
  details.push(
    ...bulletList('Неуверенность:', 'uncertainties', s.uncertainties, s, input.transcriptSegments),
  );
  details.push(...bulletList('Люди:', 'people', s.people, s, input.transcriptSegments));
  details.push(...bulletList('Места:', 'places', s.places, s, input.transcriptSegments));

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
      `<blockquote expandable>${escapeHtml(s.summary)}\n↳ ${claimEvidenceHtml(s, 'summary', 0, input.transcriptSegments)}</blockquote>`,
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
  const evidence = claimEvidenceHtml(input.summary, 'summary', 0, input.transcriptSegments);
  const evidenceLine = `\n↳ ${evidence}`;
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
      evidenceLine.length -
      revision.length -
      provenance.length,
  );
  return `${prefix}${escapeHtml(summary)}${evidenceLine}${suffix}${revision}${provenance}`;
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
      escapeMarkdown(s.summary),
      '',
      `↳ ${claimEvidenceMarkdown(s, 'summary', 0, input.transcriptSegments)}`,
    );
  }
  lines.push(...markdownList('Решения', 'decisions', s.decisions, s, input.transcriptSegments));
  lines.push(...markdownList('Задачи', 'tasks', s.tasks, s, input.transcriptSegments));
  lines.push(
    ...markdownList('Обязательства', 'commitments', s.commitments, s, input.transcriptSegments),
  );
  lines.push(...markdownList('Расходы', 'expenses', s.expenses, s, input.transcriptSegments));
  lines.push(...markdownList('Идеи', 'ideas', s.ideas, s, input.transcriptSegments));
  lines.push(...markdownList('Вопросы', 'questions', s.questions, s, input.transcriptSegments));
  lines.push(
    ...markdownList('Неуверенность', 'uncertainties', s.uncertainties, s, input.transcriptSegments),
  );
  lines.push(...markdownList('Люди', 'people', s.people, s, input.transcriptSegments));
  lines.push(...markdownList('Места', 'places', s.places, s, input.transcriptSegments));
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
          const hasTimestamp = segment.startMs !== null && segment.timestampSource !== 'none';
          const time =
            segment.timestampSource === undefined
              ? segment.startMs === null
                ? 'без времени'
                : formatTimestamp(segment.startMs)
              : hasTimestamp
                ? `${formatTimestamp(segment.startMs ?? 0)} · ${timestampSourceLabel(segment.timestampSource, true)}`
                : timestampSourceLabel(segment.timestampSource, false);
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
  readonly diskFreeGb: number | null;
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
    `Свободный диск: ${input.diskFreeGb === null ? 'не удалось проверить' : `${input.diskFreeGb.toFixed(0)} ГБ`}`,
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
