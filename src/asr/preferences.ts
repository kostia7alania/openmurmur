import type { DatabaseSync } from 'node:sqlite';

export type AsrLanguageCode = 'th' | 'ru' | 'en' | 'zh';

export const ASR_LANGUAGE_CHOICES: readonly AsrLanguageCode[] = ['th', 'ru', 'en', 'zh'];

const MODEL_LANGUAGE_NAMES: Record<AsrLanguageCode, string> = {
  th: 'Thai',
  ru: 'Russian',
  en: 'English',
  zh: 'Chinese',
};

const LANGUAGE_LABELS: Record<string, string> = {
  th: 'тайский',
  thai: 'тайский',
  ru: 'русский',
  russian: 'русский',
  en: 'английский',
  english: 'английский',
  zh: 'китайский',
  chinese: 'китайский',
  mandarin: 'китайский',
  de: 'немецкий',
  german: 'немецкий',
  fr: 'французский',
  french: 'французский',
  es: 'испанский',
  spanish: 'испанский',
};

const LANGUAGE_CODES: Record<string, AsrLanguageCode> = {
  th: 'th',
  thai: 'th',
  ru: 'ru',
  russian: 'ru',
  en: 'en',
  english: 'en',
  zh: 'zh',
  chinese: 'zh',
  mandarin: 'zh',
};

export function isAsrLanguageCode(value: unknown): value is AsrLanguageCode {
  return typeof value === 'string' && ASR_LANGUAGE_CHOICES.includes(value as AsrLanguageCode);
}

export function modelLanguageName(code: AsrLanguageCode): string {
  return MODEL_LANGUAGE_NAMES[code];
}

export function asrLanguageCode(value: string | null): AsrLanguageCode | null | undefined {
  if (value === null) return null;
  return LANGUAGE_CODES[value.toLowerCase()];
}

export function languageLabel(value: string): string {
  return LANGUAGE_LABELS[value.toLowerCase()] ?? value;
}

export function languageListLabel(values: readonly string[]): string {
  if (values.length === 0) return 'не определены';
  return values.map(languageLabel).join(', ');
}

export function recognitionModeLabel(language: string | null): string {
  return language === null ? 'автоматически' : `только ${languageLabel(language)}`;
}

export class AsrPreferenceRepository {
  readonly #db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  /** Undefined means no Telegram override; null explicitly selects auto detection. */
  stored(): AsrLanguageCode | null | undefined {
    const row = this.#db
      .prepare('SELECT forced_language FROM asr_preferences WHERE preference_id = 1')
      .get() as { forced_language: AsrLanguageCode | null } | undefined;
    return row?.forced_language;
  }

  set(language: AsrLanguageCode | null): void {
    this.#db
      .prepare(
        `INSERT INTO asr_preferences (preference_id, forced_language, updated_at)
         VALUES (1, ?, ?)
         ON CONFLICT (preference_id) DO UPDATE SET
           forced_language = excluded.forced_language,
           updated_at = excluded.updated_at`,
      )
      .run(language, new Date().toISOString());
  }
}

/** Telegram override wins; otherwise the optional legacy config value remains effective. */
export function effectiveAsrLanguage(
  db: DatabaseSync,
  configuredHints: readonly string[],
): string | null {
  const stored = new AsrPreferenceRepository(db).stored();
  if (stored !== undefined) return stored === null ? null : modelLanguageName(stored);
  return configuredHints[0] ?? null;
}
