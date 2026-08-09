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
  /**
   * Terms to bias recognition toward — names, jargon, the English words that
   * recur inside Thai speech. Placed in the model's system prompt, so it tilts
   * probabilities rather than forcing output, and a long list of irrelevant
   * terms hurts more than it helps.
   */
  readonly context?: string;
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

/** One stretch of a single voice. `speaker` is an index within one recording. */
export interface SpeakerTurn {
  readonly startMs: number;
  readonly endMs: number;
  readonly speaker: number;
}

export interface DiarizationRequest {
  readonly audioPath: string;
  /**
   * Hard cap on distinct voices.
   *
   * Not a hint. Allowed to decide for itself, the clustering over-counts badly
   * on real room audio — a two-minute two-person recording came back with
   * anywhere from 4 to 15 "speakers". Capping fixes it; the segmentation was
   * never the problem.
   */
  readonly maxSpeakers: number;
  /** Turns shorter than this are dropped: fragments are where over-counting lives. */
  readonly minTurnSeconds: number;
}

export interface AsrBackend {
  readonly name: string;
  /** Non-intrusive snapshot: must not start/load/ping a worker. */
  health():
    | { readonly ok: true; readonly detail: string }
    | { readonly ok: false; readonly reason: string };
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
  /**
   * Splits a finished recording into stretches by voice.
   *
   * Separates voices; it does not identify people. Speaker 0 in one session has
   * nothing to do with speaker 0 in the next, and nothing here knows a name.
   *
   * Independent of the ASR model on purpose: a recording is worth labelling by
   * voice even when transcription failed, and the caller attaches speakers to
   * transcript segments afterwards, by overlap.
   */
  diarize(request: DiarizationRequest): Promise<readonly SpeakerTurn[]>;
  close(): Promise<void>;
}
