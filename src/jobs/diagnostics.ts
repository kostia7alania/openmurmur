import { createHash } from 'node:crypto';
import { openMurmurRecoveryCommand, type RecoveryCommandContext } from '../cli/command-context.ts';
import { isSafeOllamaModel } from '../config/schema.ts';
import { redact } from '../logging/redact.ts';
import { canRetryDeadJob, type DeadJob } from './queue.ts';

const ALERT_JOB_LIMIT = 3;
const ERROR_LIMIT = 240;
const OPTIONAL_TOKENIZER_FAILURE =
  /tokenization requires optional dependency [`'"]?(nagisa|soynlp)/i;

export type FailureCategory =
  | 'asr_dependency'
  | 'llm_dependency'
  | 'telegram_auth'
  | 'telegram_transport'
  | 'source_missing'
  | 'timeout'
  | 'disk'
  | 'internal';

export interface DeadJobAlert {
  readonly active: boolean;
  readonly fingerprint: string;
  readonly detail: string;
}

export {
  openMurmurRecoveryCommand,
  type RecoveryCommandContext,
  TELEGRAM_RECOVERY_COMMAND_CONTEXT,
} from '../cli/command-context.ts';

export function deadJobFingerprint(jobs: readonly DeadJob[]): string {
  if (jobs.length === 0) return '';
  const identity = jobs
    .map((job) => `${job.jobId}\u0000${job.updatedAt}\u0000${job.lastError ?? ''}`)
    .sort()
    .join('\n');
  return createHash('sha256').update(identity).digest('hex');
}

export function compactJobError(error: string | null): string {
  if (error === null || error.trim().length === 0) return 'причина не записана';
  const printable = [...redact(error)]
    .map((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 31 || codePoint === 127 ? ' ' : character;
    })
    .join('');
  const compact = printable.replace(/\s+/g, ' ').trim();
  return compact.length <= ERROR_LIMIT ? compact : `${compact.slice(0, ERROR_LIMIT - 1)}…`;
}

function humanTechnicalJobError(error: string | null): string {
  const compact = compactJobError(error);
  if (error === null || !OPTIONAL_TOKENIZER_FAILURE.test(error)) return compact;
  return compact.replace(/\s+Install with:\s+pip install\b.*$/i, '').trim();
}

function publicAndTechnicalReason(error: string | null): readonly string[] {
  const technical = humanTechnicalJobError(error);
  const publicReason = publicJobFailureReason(error);
  return technical === publicReason
    ? [`Причина: ${publicReason}`]
    : [`Причина: ${publicReason}`, `Технически: ${technical}`];
}

export function failureCategory(error: string | null): FailureCategory {
  if (error === null) return 'internal';
  if (/model_load_failed|could not start the local audio worker|mlx|no module named/i.test(error)) {
    return 'asr_dependency';
  }
  if (/ollama|model.+not (installed|pulled)/i.test(error)) return 'llm_dependency';
  if (/telegram.+(401|403|unauthorized)|invalid bot token/i.test(error)) return 'telegram_auth';
  if (/telegram|network failure|fetch failed|http 5\d\d/i.test(error)) {
    return 'telegram_transport';
  }
  if (/enoent|no finalized audio|source.+(missing|not found)|file.+not found/i.test(error)) {
    return 'source_missing';
  }
  if (/timed? out|timeout/i.test(error)) return 'timeout';
  if (/enospc|sqlite_full|no space|disk full/i.test(error)) return 'disk';
  return 'internal';
}

export function publicJobFailureReason(error: string | null): string {
  const reasons: Record<FailureCategory, string> = {
    asr_dependency: 'Локальная модель распознавания или MLX не готовы.',
    llm_dependency: 'Ollama или настроенная LLM-модель не готовы.',
    telegram_auth: 'Telegram отклонил учётные данные бота.',
    telegram_transport: 'Не удалось связаться с Telegram.',
    source_missing: 'Исходный аудиофайл отсутствует или недоступен.',
    timeout: 'Локальная операция заняла слишком много времени.',
    disk: 'Недостаточно места или произошла ошибка локального хранилища.',
    internal: 'Не удалось определить причину; технические детали остались на этом Mac.',
  };
  return reasons[failureCategory(error)];
}

export function renderDeadJobAlert(
  hostName: string,
  jobs: readonly DeadJob[],
  llmModel: string,
  commandContext: RecoveryCommandContext,
  options: { readonly technicalDetails?: boolean } = {},
): DeadJobAlert {
  if (jobs.length === 0) return { active: false, fingerprint: '', detail: '' };

  const lines = [`Mac: ${hostName}`, `Задач с исчерпанными попытками: ${jobs.length}`, ''];
  for (const [index, job] of jobs.slice(0, ALERT_JOB_LIMIT).entries()) {
    lines.push(
      `${index + 1}. ${job.kind} — ${job.jobId}`,
      ...(options.technicalDetails
        ? publicAndTechnicalReason(job.lastError)
        : [`Причина: ${publicJobFailureReason(job.lastError)}`]),
    );
  }
  if (jobs.length > ALERT_JOB_LIMIT) lines.push(`Ещё задач: ${jobs.length - ALERT_JOB_LIMIT}`);

  const optionalTokenizerJob = jobs.find(
    (job) =>
      (job.kind === 'asr' || job.kind === 'incoming_audio') &&
      job.lastError !== null &&
      OPTIONAL_TOKENIZER_FAILURE.test(job.lastError),
  );
  const categories = new Set(jobs.map((job) => failureCategory(job.lastError)));
  const hasGeneralAsrFailure = jobs.some(
    (job) =>
      failureCategory(job.lastError) === 'asr_dependency' &&
      (job.lastError === null || !OPTIONAL_TOKENIZER_FAILURE.test(job.lastError)),
  );
  lines.push('', 'Что сделать на этом Mac:');
  if (commandContext.instruction !== undefined) lines.push(commandContext.instruction);
  lines.push(`1. ${openMurmurRecoveryCommand(commandContext, 'doctor')}`);
  if (hasGeneralAsrFailure) {
    lines.push(
      '   Если ASR/MLX не установлен: /usr/bin/env -u UV_PROJECT_ENVIRONMENT uv sync --project python/openmurmur_audio --extra mlx',
    );
  }
  if (categories.has('llm_dependency')) {
    lines.push(
      '   Если Ollama не установлен: brew install ollama',
      '   Если Ollama не запущен: brew services start ollama',
      `   ${ollamaPullInstruction(llmModel, commandContext)}`,
    );
  }
  if (optionalTokenizerJob !== undefined) {
    lines.push(
      '2. Auto дошёл до необязательного токенизатора. Повтори задачу с фактическим языком аудио:',
      `   Русский: ${openMurmurRecoveryCommand(commandContext, `jobs retry ${optionalTokenizerJob.jobId} --language ru`)}`,
      `   Тайский: ${openMurmurRecoveryCommand(commandContext, `jobs retry ${optionalTokenizerJob.jobId} --language th`)}`,
      `   English: ${openMurmurRecoveryCommand(commandContext, `jobs retry ${optionalTokenizerJob.jobId} --language en`)}`,
      `   中文: ${openMurmurRecoveryCommand(commandContext, `jobs retry ${optionalTokenizerJob.jobId} --language zh`)}`,
    );
  } else {
    const retryable = jobs.find((job) => canRetryDeadJob(job.kind));
    lines.push(
      retryable === undefined
        ? `2. Эти legacy-задачи не обслуживаются демоном; обнови OpenMurmur и снова запусти ${openMurmurRecoveryCommand(commandContext, 'doctor')}.`
        : `2. После исправления: ${openMurmurRecoveryCommand(commandContext, `jobs retry ${retryable.jobId}`)}`,
    );
  }

  return {
    active: true,
    fingerprint: deadJobFingerprint(jobs),
    detail: lines.join('\n'),
  };
}

export function renderAsrUnavailableDetail(
  hostName: string,
  reason: string,
  commandContext: RecoveryCommandContext,
): string {
  return [
    `Mac: ${hostName}`,
    `Причина: ${publicJobFailureReason(reason)}`,
    `Технически: ${compactJobError(reason)}`,
    '',
    'Что сделать на этом Mac:',
    ...(commandContext.instruction === undefined ? [] : [commandContext.instruction]),
    `1. ${openMurmurRecoveryCommand(commandContext, 'doctor')}`,
    '2. Если ASR/MLX не установлен: /usr/bin/env -u UV_PROJECT_ENVIRONMENT uv sync --project python/openmurmur_audio --extra mlx',
  ].join('\n');
}

export function renderLlmUnavailableDetail(
  hostName: string,
  reason: string,
  llmModel: string,
  commandContext: RecoveryCommandContext,
): string {
  return [
    `Mac: ${hostName}`,
    `Причина: ${publicJobFailureReason(reason)}`,
    `Технически: ${compactJobError(reason)}`,
    'Аудио и расшифровки продолжают работать; недоступен только структурный отчёт.',
    '',
    'Что сделать на этом Mac:',
    ...(commandContext.instruction === undefined ? [] : [commandContext.instruction]),
    `1. ${openMurmurRecoveryCommand(commandContext, 'doctor')}`,
    '2. Если Ollama не установлен: brew install ollama',
    '3. Если Ollama не запущен: brew services start ollama',
    `4. ${ollamaPullInstruction(llmModel, commandContext)}`,
  ].join('\n');
}

function ollamaPullInstruction(model: string, commandContext: RecoveryCommandContext): string {
  return isSafeOllamaModel(model)
    ? `Если модели нет: ollama pull ${model}`
    : `Имя модели в config небезопасно для команды; исправь его и снова запусти ${openMurmurRecoveryCommand(commandContext, 'doctor')}.`;
}
