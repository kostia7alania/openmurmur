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

/** One stretch of detected speech, in milliseconds from the start of the file. */
export interface VadSegment {
  readonly startMs: number;
  readonly endMs: number;
  readonly meanProbability: number;
}

export interface VadRequest {
  readonly audioPath: string;
  readonly threshold: number;
}

export interface AsrBackend {
  readonly name: string;
  ready(): Promise<{ ok: true } | { ok: false; reason: string }>;
  transcribe(request: AsrRequest): Promise<AsrResult>;
  /**
   * Final VAD pass over a finalized part.
   *
   * Run after the file is closed rather than reusing the streaming decisions:
   * the streaming pass sees 32 ms at a time and cannot look ahead, so its
   * segment boundaries are provisional. This pass sees the whole part and
   * produces the boundaries stored in `vad_segments` and used for Thai
   * timings, where no word aligner exists.
   *
   * It never decides what to delete. Retention reads the database, not VAD.
   */
  vadSegments(request: VadRequest): Promise<readonly VadSegment[]>;
  close(): Promise<void>;
}
