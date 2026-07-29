export interface AsrSegment {
  readonly startMs: number | null;
  readonly endMs: number | null;
  /**
   * 'aligner' when the Qwen forced aligner produced real word timings (RU/EN),
   * 'vad' when timings come from session/VAD boundaries instead. Thai gets
   * 'vad': no official aligner supports it, and inventing word timestamps
   * would be a fabricated confidence signal.
   */
  readonly timestampSource: 'aligner' | 'vad' | 'none';
  readonly language: string | null;
  readonly text: string;
}

export interface AsrResult {
  readonly text: string;
  readonly languages: readonly string[];
  readonly segments: readonly AsrSegment[];
  readonly engine: string;
  readonly model: string;
  readonly durationMs: number;
}

export interface AsrRequest {
  /** Absolute path to 16 kHz mono WAV or FLAC. */
  readonly audioPath: string;
  readonly languageHints?: readonly string[];
  readonly requestId: string;
}

export interface AsrBackend {
  readonly name: string;
  ready(): Promise<{ ok: true } | { ok: false; reason: string }>;
  transcribe(request: AsrRequest): Promise<AsrResult>;
  close(): Promise<void>;
}
