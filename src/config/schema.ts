/**
 * Configuration schema and validation.
 *
 * Secrets are deliberately absent from this type. The Telegram bot token and
 * the allowed chat ID live in the macOS Keychain (see src/telegram/keychain.ts)
 * and never appear in the config file, argv, env, logs or launchd plists.
 */

export interface SessionizerConfig {
  /** Ring buffer prepended to a session when speech is detected. */
  readonly preRollSeconds: number;
  /** Continuous speech required before IDLE -> ACTIVE. Rejects door slams. */
  readonly speechCandidateMs: number;
  /** Silence required to close a logical session. */
  readonly silenceTimeoutSeconds: number;
  /** Hard cap on one physical audio part before rotation. */
  readonly maxPartSeconds: number;
  /** Sessions with less total speech than this are rejected as noise. */
  readonly minSpeechSeconds: number;
  /** ...unless ASR still produced at least this many words. */
  readonly minTranscriptWords: number;
  /** VAD speech probability above which a frame counts as speech. */
  readonly vadThreshold: number;
  /**
   * Live speech detector.
   *
   * `silero` is the real one and the default. `energy` is a loudness gate: it
   * cannot tell a voice from a fan or a television, so it is only for machines
   * where the Python worker cannot run at all. Choosing it changes what a
   * "speech session" means, so it is never selected automatically.
   */
  readonly vadBackend: 'silero' | 'energy';
}

export interface DiarizationConfig {
  /**
   * Off by default. It separates voices well and counts them badly on
   * far-field room audio, so it is a deliberate choice rather than a surprise:
   * a transcript labelled with the wrong number of people is worse than one
   * with no labels at all.
   *
   * Requires the ONNX models — `./scripts/fetch-diarization-models`, ~44 MB,
   * no account or token.
   */
  readonly enabled: boolean;
  /**
   * Hard cap on distinct voices, not a hint.
   *
   * Allowed to decide for itself, the clustering over-counts badly: a
   * two-minute recording of two people came back with between 4 and 15
   * "speakers" depending on the threshold. Capped at 3 the same recording gave
   * three voices and three speaker changes. Raise it for a meeting, lower it
   * to 2 for a one-to-one.
   */
  readonly maxSpeakers: number;
  /** Turns shorter than this are dropped; fragments are where over-counting lives. */
  readonly minTurnSeconds: number;
}

export interface AudioConfig {
  readonly captureBackend: 'ffmpeg' | 'native';
  readonly sampleRate: number;
  readonly channels: number;
  /** AVFoundation device index, or 'default'. */
  readonly captureDevice: string;
  readonly ffmpegPath: string;
  readonly ffprobePath: string;
  /** FLAC compression level 0-12. 5 is the ffmpeg default. */
  readonly flacCompressionLevel: number;
}

export interface AsrConfig {
  readonly backend: 'mlx' | 'fake';
  readonly model: string;
  readonly quantization: 'fp16' | '8bit' | '4bit';
  /** Empty = automatic detection; one value force-selects that language. */
  readonly languageHints: readonly string[];
  /** Languages for which the Qwen forced aligner produces word timestamps. */
  readonly alignerLanguages: readonly string[];
  /**
   * Terms to bias recognition toward: names, places, jargon, product names —
   * whatever this microphone hears often and the model gets wrong.
   *
   * Qwen3-ASR takes these as background knowledge in its system prompt, which
   * tilts probabilities rather than forcing words.
   *
   * **It cuts both ways.** Seeding a 38-second English recording with terms
   * that were not in it turned "we do not need battery" into "we have to cut
   * me para" — the model reached for the words it had been primed with.
   * Published results put the benefit at its highest around a hundred terms,
   * and irrelevant ones act as distractors, so list only what this microphone
   * actually hears.
   *
   * Empty by default. Nothing is inferred from previous transcripts, because
   * feeding recognition back into itself entrenches its own mistakes.
   */
  readonly context: string;
  readonly pythonWorkerTimeoutMs: number;
}

export interface LlmConfig {
  readonly backend: 'ollama' | 'fake';
  readonly baseUrl: string;
  readonly model: string;
  readonly contextTokens: number;
  readonly temperature: number;
  /** Qwen3 "thinking" mode. Off for schema extraction, on for reconciliation. */
  readonly think: boolean;
  readonly requestTimeoutMs: number;
  /**
   * How long Ollama keeps the model in memory after a request, e.g. "5m",
   * "30m", "-1" to keep it loaded indefinitely, "0" to unload immediately.
   *
   * Sessions are sporadic, so by default the model is usually cold and the
   * first summarize after an idle period pays a reload. That is acceptable —
   * summarization is not on the recording path — but a machine with memory to
   * spare can trade RAM for latency here. An empty string uses Ollama's own
   * default (5 minutes).
   */
  readonly keepAlive: string;
}

export interface TelegramConfig {
  readonly apiBaseUrl: string;
  /** Cloud Bot API caps sendDocument at 50 MB. */
  readonly maxOutgoingBytes: number;
  /** Cloud Bot API caps getFile at 20 MB; local Bot API mode can be higher. */
  readonly maxIncomingBytes: number;
  /** Longer transcripts are split and also attached as .md. */
  readonly transcriptInlineLimit: number;
  readonly pollIntervalMs: number;
  readonly longPollSeconds: number;
  /** True only on the one explicitly designated getUpdates owner. */
  readonly receiveUpdates: boolean;
  readonly maxIncomingDurationSeconds: number;
  readonly maxConcurrentIncomingJobs: number;
}

export interface RetentionConfig {
  readonly sessionAudioHours: number;
  readonly incomingAudioHours: number;
  readonly quarantineHours: number;
  readonly rejectedSessionHours: number;
}

export interface HealthConfig {
  readonly pollIntervalMs: number;
  readonly recorderStaleSeconds: number;
  readonly asrBacklogMinutes: number;
  readonly outboxStaleMinutes: number;
  readonly diskFreeWarnGb: number;
  readonly alertCooldownMinutes: number;
}

export interface DigestConfig {
  readonly enabled: boolean;
  /** Local time HH:MM at which the daily digest is produced. */
  readonly atLocalTime: string;
  readonly timezone: string;
}

export interface OpenMurmurConfig {
  readonly version: 1;
  readonly sessionizer: SessionizerConfig;
  readonly audio: AudioConfig;
  readonly diarization: DiarizationConfig;
  readonly asr: AsrConfig;
  readonly llm: LlmConfig;
  readonly telegram: TelegramConfig;
  readonly retention: RetentionConfig;
  readonly health: HealthConfig;
  readonly digest: DigestConfig;
  readonly logLevel: 'debug' | 'info' | 'warn' | 'error';
}

export const DEFAULT_CONFIG: OpenMurmurConfig = {
  version: 1,
  sessionizer: {
    preRollSeconds: 5,
    speechCandidateMs: 500,
    silenceTimeoutSeconds: 60,
    maxPartSeconds: 15 * 60,
    minSpeechSeconds: 3,
    minTranscriptWords: 5,
    vadThreshold: 0.5,
    vadBackend: 'silero',
  },
  audio: {
    captureBackend: 'ffmpeg',
    sampleRate: 16_000,
    channels: 1,
    captureDevice: 'default',
    ffmpegPath: 'ffmpeg',
    ffprobePath: 'ffprobe',
    flacCompressionLevel: 5,
  },
  diarization: {
    enabled: false,
    maxSpeakers: 3,
    minTurnSeconds: 1,
  },
  asr: {
    backend: 'mlx',
    model: 'Qwen/Qwen3-ASR-1.7B',
    quantization: '8bit',
    languageHints: [],
    alignerLanguages: ['ru', 'en'],
    context: '',
    pythonWorkerTimeoutMs: 15 * 60 * 1000,
  },
  llm: {
    backend: 'ollama',
    baseUrl: 'http://127.0.0.1:11434',
    model: 'qwen3.6:27b',
    contextTokens: 32_768,
    temperature: 0,
    think: false,
    requestTimeoutMs: 10 * 60 * 1000,
    keepAlive: '',
  },
  telegram: {
    apiBaseUrl: 'https://api.telegram.org',
    maxOutgoingBytes: 50 * 1024 * 1024,
    maxIncomingBytes: 20 * 1024 * 1024,
    transcriptInlineLimit: 3500,
    pollIntervalMs: 1000,
    longPollSeconds: 25,
    receiveUpdates: false,
    maxIncomingDurationSeconds: 2 * 60 * 60,
    maxConcurrentIncomingJobs: 2,
  },
  retention: {
    sessionAudioHours: 48,
    incomingAudioHours: 24,
    quarantineHours: 7 * 24,
    rejectedSessionHours: 6,
  },
  health: {
    pollIntervalMs: 5000,
    recorderStaleSeconds: 15,
    asrBacklogMinutes: 60,
    outboxStaleMinutes: 30,
    diskFreeWarnGb: 20,
    alertCooldownMinutes: 30,
  },
  digest: {
    enabled: true,
    atLocalTime: '23:30',
    timezone: 'local',
  },
  logLevel: 'info',
};

export class ConfigError extends Error {
  readonly issues: readonly string[];
  constructor(issues: readonly string[]) {
    super(`Invalid configuration:\n  - ${issues.join('\n  - ')}`);
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

type Json = Record<string, unknown>;

const REMOVED_OPTIONS: Readonly<Record<string, string>> = {
  'sessionizer.vadFrameMs':
    '"sessionizer.vadFrameMs" was removed because capture and Silero require fixed 32 ms frames; remove it from the config',
  'telegram.summarizeIncoming':
    '"telegram.summarizeIncoming" was removed because incoming summaries are not implemented; remove it from the config',
};

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Deep-merges user overrides onto defaults, then validates. Unknown keys are
 * rejected rather than silently ignored: a typo in `silence_timeout_seconds`
 * would otherwise leave the user believing they changed a threshold.
 */
export function parseConfig(raw: unknown): OpenMurmurConfig {
  const issues: string[] = [];
  if (!isObject(raw)) throw new ConfigError(['config root must be a JSON object']);

  const merged = mergeInto(DEFAULT_CONFIG as unknown as Json, raw, '', issues);
  if (issues.length > 0) throw new ConfigError(issues);

  const config = merged as unknown as OpenMurmurConfig;
  validate(config, issues);
  if (issues.length > 0) throw new ConfigError(issues);
  return config;
}

function mergeInto(defaults: Json, overrides: Json, prefix: string, issues: string[]): Json {
  const out: Json = { ...defaults };
  for (const [key, value] of Object.entries(overrides)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (!(key in defaults)) {
      issues.push(REMOVED_OPTIONS[path] ?? `unknown option "${path}"`);
      continue;
    }
    const fallback = defaults[key];
    if (isObject(fallback)) {
      if (!isObject(value)) {
        issues.push(`"${path}" must be an object`);
        continue;
      }
      out[key] = mergeInto(fallback, value, path, issues);
    } else if (Array.isArray(fallback)) {
      if (!Array.isArray(value)) {
        issues.push(`"${path}" must be an array`);
        continue;
      }
      out[key] = value;
    } else {
      if (typeof value !== typeof fallback) {
        issues.push(`"${path}" must be a ${typeof fallback}, got ${typeof value}`);
        continue;
      }
      out[key] = value;
    }
  }
  return out;
}

function validate(c: OpenMurmurConfig, issues: string[]): void {
  const positive = (label: string, n: number) => {
    if (!Number.isFinite(n) || n <= 0) issues.push(`${label} must be a positive number`);
  };
  const nonNegative = (label: string, n: number) => {
    if (!Number.isFinite(n) || n < 0) issues.push(`${label} must be a non-negative number`);
  };

  const s = c.sessionizer;
  positive('sessionizer.preRollSeconds', s.preRollSeconds);
  positive('sessionizer.speechCandidateMs', s.speechCandidateMs);
  positive('sessionizer.silenceTimeoutSeconds', s.silenceTimeoutSeconds);
  positive('sessionizer.maxPartSeconds', s.maxPartSeconds);
  if (!Number.isFinite(s.vadThreshold) || s.vadThreshold <= 0 || s.vadThreshold >= 1) {
    issues.push('sessionizer.vadThreshold must be strictly between 0 and 1');
  }
  nonNegative('sessionizer.minSpeechSeconds', s.minSpeechSeconds);
  nonNegative('sessionizer.minTranscriptWords', s.minTranscriptWords);
  if (s.maxPartSeconds <= s.silenceTimeoutSeconds) {
    issues.push('sessionizer.maxPartSeconds must exceed sessionizer.silenceTimeoutSeconds');
  }
  if (s.vadBackend !== 'silero' && s.vadBackend !== 'energy') {
    issues.push('sessionizer.vadBackend must be "silero" or "energy"');
  }

  validateAudio(c.audio, issues);

  const d = c.diarization;
  if (d.maxSpeakers < 1 || d.maxSpeakers > 20) {
    issues.push('diarization.maxSpeakers must be between 1 and 20');
  }
  nonNegative('diarization.minTurnSeconds', d.minTurnSeconds);

  validateAsr(c.asr, issues);
  positive('asr.pythonWorkerTimeoutMs', c.asr.pythonWorkerTimeoutMs);
  if (c.llm.backend !== 'ollama' && c.llm.backend !== 'fake') {
    issues.push('llm.backend must be "ollama" or "fake"');
  }
  if (c.llm.backend === 'ollama' && !isLocalOllamaUrl(c.llm.baseUrl)) {
    issues.push(
      'llm.baseUrl must be an unauthenticated http URL on 127.0.0.1 with no path, query or fragment',
    );
  }
  if (!isSafeOllamaModel(c.llm.model)) {
    issues.push('llm.model must be a command-safe Ollama model identifier');
  }
  positive('llm.contextTokens', c.llm.contextTokens);
  positive('llm.requestTimeoutMs', c.llm.requestTimeoutMs);
  if (!Number.isFinite(c.llm.temperature) || c.llm.temperature < 0 || c.llm.temperature > 2) {
    issues.push('llm.temperature must be between 0 and 2');
  }

  validateTelegram(c.telegram, issues, positive, nonNegative);

  const retention = c.retention;
  nonNegative('retention.sessionAudioHours', retention.sessionAudioHours);
  nonNegative('retention.incomingAudioHours', retention.incomingAudioHours);
  nonNegative('retention.quarantineHours', retention.quarantineHours);
  nonNegative('retention.rejectedSessionHours', retention.rejectedSessionHours);

  const health = c.health;
  positive('health.pollIntervalMs', health.pollIntervalMs);
  positive('health.recorderStaleSeconds', health.recorderStaleSeconds);
  nonNegative('health.asrBacklogMinutes', health.asrBacklogMinutes);
  nonNegative('health.outboxStaleMinutes', health.outboxStaleMinutes);
  nonNegative('health.diskFreeWarnGb', health.diskFreeWarnGb);
  positive('health.alertCooldownMinutes', health.alertCooldownMinutes);

  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(c.digest.atLocalTime)) {
    issues.push('digest.atLocalTime must be HH:MM in 24-hour form');
  }
  if (c.digest.timezone !== 'local') {
    try {
      new Intl.DateTimeFormat('en', { timeZone: c.digest.timezone });
    } catch {
      issues.push('digest.timezone must be "local" or a valid IANA timezone');
    }
  }

  if (!['debug', 'info', 'warn', 'error'].includes(c.logLevel)) {
    issues.push('logLevel must be one of: debug, info, warn, error');
  }
}

function validateAudio(audio: AudioConfig, issues: string[]): void {
  if (audio.sampleRate !== 16_000) {
    issues.push('audio.sampleRate must be 16000: Silero VAD and Qwen3-ASR both require it');
  }
  if (audio.channels !== 1) issues.push('audio.channels must be 1');
  if (audio.captureBackend !== 'ffmpeg' && audio.captureBackend !== 'native') {
    issues.push('audio.captureBackend must be "ffmpeg" or "native"');
  }
  if (audio.flacCompressionLevel < 0 || audio.flacCompressionLevel > 12) {
    issues.push('audio.flacCompressionLevel must be between 0 and 12');
  }
}

function validateAsr(asr: AsrConfig, issues: string[]): void {
  if (asr.backend !== 'mlx' && asr.backend !== 'fake') {
    issues.push('asr.backend must be "mlx" or "fake"');
  }
  if (asr.languageHints.some((value) => typeof value !== 'string' || value.trim().length === 0)) {
    issues.push('asr.languageHints must contain only non-empty strings');
  }
  if (asr.languageHints.length > 1) {
    issues.push(
      'asr.languageHints accepts at most one forced language; Qwen does not support a priority list',
    );
  }
}

function validateTelegram(
  t: TelegramConfig,
  issues: string[],
  positive: (label: string, n: number) => void,
  nonNegative: (label: string, n: number) => void,
): void {
  const localBotApi = isLocalBotApiUrl(t.apiBaseUrl);
  const officialBotApi = isOfficialBotApiUrl(t.apiBaseUrl);
  if (t.maxOutgoingBytes > 50 * 1024 * 1024) {
    issues.push('telegram.maxOutgoingBytes cannot exceed the 50 MB Bot API sendDocument limit');
  }
  positive('telegram.maxIncomingBytes', t.maxIncomingBytes);
  positive('telegram.maxOutgoingBytes', t.maxOutgoingBytes);
  if (!localBotApi && t.maxIncomingBytes > 20 * 1024 * 1024) {
    issues.push('telegram.maxIncomingBytes cannot exceed the 20 MB Bot API getFile limit');
  }
  if (localBotApi && t.maxIncomingBytes > 2 * 1024 * 1024 * 1024) {
    issues.push('telegram.maxIncomingBytes cannot exceed 2 GB in local Bot API mode');
  }
  if (t.transcriptInlineLimit > 4096) {
    issues.push('telegram.transcriptInlineLimit must be <= 4096 (Telegram message length limit)');
  }
  positive('telegram.transcriptInlineLimit', t.transcriptInlineLimit);
  positive('telegram.pollIntervalMs', t.pollIntervalMs);
  nonNegative('telegram.longPollSeconds', t.longPollSeconds);
  positive('telegram.maxIncomingDurationSeconds', t.maxIncomingDurationSeconds);
  positive('telegram.maxConcurrentIncomingJobs', t.maxConcurrentIncomingJobs);
  if (!officialBotApi && !localBotApi) {
    issues.push(
      'telegram.apiBaseUrl must be https://api.telegram.org or an unauthenticated root URL on http://127.0.0.1',
    );
  }
}

function isLocalOllamaUrl(value: string): boolean {
  if (!/^http:\/\/127\.0\.0\.1(?::\d+)?\/?$/.test(value)) return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === 'http:' &&
      url.hostname === '127.0.0.1' &&
      url.username === '' &&
      url.password === '' &&
      url.pathname === '/' &&
      url.search === '' &&
      url.hash === ''
    );
  } catch {
    return false;
  }
}

export function isSafeOllamaModel(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._/-]*(?::[A-Za-z0-9][A-Za-z0-9._-]*)?$/.test(value);
}

function isLocalBotApiUrl(value: string): boolean {
  if (!/^http:\/\/127\.0\.0\.1(?::\d+)?\/?$/.test(value)) return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === 'http:' &&
      url.hostname === '127.0.0.1' &&
      url.username === '' &&
      url.password === '' &&
      url.pathname === '/' &&
      url.search === '' &&
      url.hash === ''
    );
  } catch {
    return false;
  }
}

function isOfficialBotApiUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      url.hostname === 'api.telegram.org' &&
      url.port === '' &&
      url.username === '' &&
      url.password === '' &&
      url.pathname === '/' &&
      url.search === '' &&
      url.hash === ''
    );
  } catch {
    return false;
  }
}
