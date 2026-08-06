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
  /** VAD frame size. Silero operates on 512 samples at 16 kHz = 32 ms. */
  readonly vadFrameMs: number;
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

export interface AudioConfig {
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
  /** Empty = automatic language detection. */
  readonly languageHints: readonly string[];
  /** Languages for which the Qwen forced aligner produces word timestamps. */
  readonly alignerLanguages: readonly string[];
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
  readonly maxIncomingDurationSeconds: number;
  readonly maxConcurrentIncomingJobs: number;
  readonly summarizeIncoming: boolean;
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
    vadFrameMs: 32,
    vadBackend: 'silero',
  },
  audio: {
    sampleRate: 16_000,
    channels: 1,
    captureDevice: 'default',
    ffmpegPath: 'ffmpeg',
    ffprobePath: 'ffprobe',
    flacCompressionLevel: 5,
  },
  asr: {
    backend: 'mlx',
    model: 'Qwen/Qwen3-ASR-1.7B',
    quantization: '8bit',
    languageHints: [],
    alignerLanguages: ['ru', 'en'],
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
    maxIncomingDurationSeconds: 2 * 60 * 60,
    maxConcurrentIncomingJobs: 2,
    summarizeIncoming: true,
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
      issues.push(`unknown option "${path}"`);
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

  const s = c.sessionizer;
  positive('sessionizer.preRollSeconds', s.preRollSeconds);
  positive('sessionizer.speechCandidateMs', s.speechCandidateMs);
  positive('sessionizer.silenceTimeoutSeconds', s.silenceTimeoutSeconds);
  positive('sessionizer.maxPartSeconds', s.maxPartSeconds);
  positive('sessionizer.vadFrameMs', s.vadFrameMs);
  if (s.vadThreshold <= 0 || s.vadThreshold >= 1) {
    issues.push('sessionizer.vadThreshold must be strictly between 0 and 1');
  }
  if (s.minSpeechSeconds < 0) issues.push('sessionizer.minSpeechSeconds must be >= 0');
  if (s.minTranscriptWords < 0) issues.push('sessionizer.minTranscriptWords must be >= 0');
  if (s.maxPartSeconds <= s.silenceTimeoutSeconds) {
    issues.push('sessionizer.maxPartSeconds must exceed sessionizer.silenceTimeoutSeconds');
  }
  if (s.vadBackend !== 'silero' && s.vadBackend !== 'energy') {
    issues.push('sessionizer.vadBackend must be "silero" or "energy"');
  }

  if (c.audio.sampleRate !== 16_000) {
    issues.push('audio.sampleRate must be 16000: Silero VAD and Qwen3-ASR both require it');
  }
  if (c.audio.channels !== 1) issues.push('audio.channels must be 1');
  if (c.audio.flacCompressionLevel < 0 || c.audio.flacCompressionLevel > 12) {
    issues.push('audio.flacCompressionLevel must be between 0 and 12');
  }

  if (c.asr.backend !== 'mlx' && c.asr.backend !== 'fake') {
    issues.push('asr.backend must be "mlx" or "fake"');
  }
  if (c.llm.backend !== 'ollama' && c.llm.backend !== 'fake') {
    issues.push('llm.backend must be "ollama" or "fake"');
  }
  if (c.llm.temperature < 0 || c.llm.temperature > 2) {
    issues.push('llm.temperature must be between 0 and 2');
  }

  validateTelegram(c.telegram, issues, positive);

  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(c.digest.atLocalTime)) {
    issues.push('digest.atLocalTime must be HH:MM in 24-hour form');
  }

  if (!['debug', 'info', 'warn', 'error'].includes(c.logLevel)) {
    issues.push('logLevel must be one of: debug, info, warn, error');
  }
}

function validateTelegram(
  t: TelegramConfig,
  issues: string[],
  positive: (label: string, n: number) => void,
): void {
  const localBotApi = isLocalBotApiUrl(t.apiBaseUrl);
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
  positive('telegram.maxConcurrentIncomingJobs', t.maxConcurrentIncomingJobs);
  if (!t.apiBaseUrl.startsWith('https://') && !localBotApi) {
    issues.push('telegram.apiBaseUrl must be https, or a local Bot API server on 127.0.0.1');
  }
}

function isLocalBotApiUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' && url.hostname === '127.0.0.1';
  } catch {
    return false;
  }
}
