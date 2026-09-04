import {
  ASR_LANGUAGE_CHOICES,
  type AsrLanguageCode,
  asrLanguageCode,
  recognitionModeLabel,
} from '../asr/preferences.ts';
import type { TelegramBotCommand, TelegramInlineKeyboardMarkup } from './client.ts';
import { escapeHtml } from './format.ts';

const CALLBACK_PREFIX = 'asr-mode:v1:';
const RETRY_CALLBACK_PREFIX = 'asr-retry:v1:';

export const OPENMURMUR_BOT_COMMANDS: readonly TelegramBotCommand[] = [
  { command: 'status', description: 'Состояние демона и имя Mac' },
  { command: 'health', description: 'Короткая диагностика' },
  { command: 'settings', description: 'Язык следующих расшифровок' },
  { command: 'help', description: 'Список команд' },
];

export type AsrSettingsOrigin = 'settings' | 'transcript';

const BUTTON_LABELS: Record<AsrLanguageCode, string> = {
  th: '🇹🇭 Тайский',
  ru: '🇷🇺 Русский',
  en: '🇬🇧 English',
  zh: '🇨🇳 中文',
};

export function parseAsrModeCallback(
  data: string | undefined,
): { readonly language: AsrLanguageCode | null; readonly origin: AsrSettingsOrigin } | undefined {
  if (data === undefined || !data.startsWith(CALLBACK_PREFIX)) return undefined;
  const [origin, value, extra] = data.slice(CALLBACK_PREFIX.length).split(':');
  if ((origin !== 'settings' && origin !== 'transcript') || extra !== undefined) return undefined;
  if (value === 'auto') return { language: null, origin };
  return ASR_LANGUAGE_CHOICES.includes(value as AsrLanguageCode)
    ? { language: value as AsrLanguageCode, origin }
    : undefined;
}

export function parseAsrRetryCallback(
  data: string | undefined,
): { readonly language: AsrLanguageCode | null; readonly fileUid: string } | undefined {
  if (data === undefined || !data.startsWith(RETRY_CALLBACK_PREFIX)) return undefined;
  const [value, fileUid, extra] = data.slice(RETRY_CALLBACK_PREFIX.length).split(':');
  if (fileUid === undefined || extra !== undefined || !isUuid(fileUid)) return undefined;
  if (value === 'auto') return { language: null, fileUid };
  return ASR_LANGUAGE_CHOICES.includes(value as AsrLanguageCode)
    ? { language: value as AsrLanguageCode, fileUid }
    : undefined;
}

export function asrRetryKeyboard(
  fileUid: string,
  currentLanguage: string | null,
): TelegramInlineKeyboardMarkup {
  const currentCode = asrLanguageCode(currentLanguage);
  const selected = (value: string | null, label: string) =>
    `${currentCode === asrLanguageCode(value) ? '↻' : '○'} ${label}`;
  return {
    inline_keyboard: [
      [
        {
          text: selected(null, 'Auto / смешанная'),
          callback_data: `${RETRY_CALLBACK_PREFIX}auto:${fileUid}`,
        },
      ],
      [
        {
          text: selected('Russian', 'RU'),
          callback_data: `${RETRY_CALLBACK_PREFIX}ru:${fileUid}`,
        },
        {
          text: selected('English', 'EN'),
          callback_data: `${RETRY_CALLBACK_PREFIX}en:${fileUid}`,
        },
        {
          text: selected('Thai', 'TH'),
          callback_data: `${RETRY_CALLBACK_PREFIX}th:${fileUid}`,
        },
      ],
    ],
  };
}

export function asrSettingsKeyboard(
  currentLanguage: string | null,
  origin: AsrSettingsOrigin = 'settings',
): TelegramInlineKeyboardMarkup {
  const currentCode = asrLanguageCode(currentLanguage);
  const selected = (value: string | null, label: string) =>
    `${currentCode === asrLanguageCode(value) ? '✅' : '○'} ${label}`;
  return {
    inline_keyboard: [
      [
        {
          text: selected(null, 'Авто'),
          callback_data: `${CALLBACK_PREFIX}${origin}:auto`,
        },
        {
          text: selected('Thai', BUTTON_LABELS.th),
          callback_data: `${CALLBACK_PREFIX}${origin}:th`,
        },
      ],
      [
        {
          text: selected('Russian', BUTTON_LABELS.ru),
          callback_data: `${CALLBACK_PREFIX}${origin}:ru`,
        },
        {
          text: selected('English', BUTTON_LABELS.en),
          callback_data: `${CALLBACK_PREFIX}${origin}:en`,
        },
        {
          text: selected('Chinese', BUTTON_LABELS.zh),
          callback_data: `${CALLBACK_PREFIX}${origin}:zh`,
        },
      ],
    ],
  };
}

export function renderAsrSettings(hostName: string, currentLanguage: string | null): string {
  return [
    '⚙️ <b>Настройки распознавания</b>',
    '',
    `Компьютер: <code>${escapeHtml(hostName)}</code>`,
    `Режим: <b>${escapeHtml(recognitionModeLabel(currentLanguage))}</b>`,
    '',
    'Авто рекомендуется для смешанной речи. Фиксированный язык повышает точность, когда вся запись действительно на нём.',
    'Изменение применяется только к следующим расшифровкам на этом компьютере.',
  ].join('\n');
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
