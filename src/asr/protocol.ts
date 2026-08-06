/**
 * NDJSON protocol between the TypeScript daemon and the Python MLX worker.
 *
 * One JSON object per line on stdin/stdout. The worker keeps the ASR model
 * resident across requests — loading Qwen3-ASR-1.7B per file would add tens of
 * seconds to every session — so the protocol is request/response over a long
 * lived process, correlated by `id`.
 *
 * stderr is reserved for human-readable logs and is never parsed.
 */

export interface WorkerRequestBase {
  readonly id: string;
}

export type WorkerRequest =
  | (WorkerRequestBase & { readonly op: 'ping' })
  | (WorkerRequestBase & {
      readonly op: 'load';
      readonly model: string;
      readonly quantization: string;
    })
  | (WorkerRequestBase & {
      readonly op: 'transcribe';
      readonly path: string;
      readonly language_hints: readonly string[];
      readonly aligner_languages: readonly string[];
    })
  | (WorkerRequestBase & {
      readonly op: 'vad';
      readonly path: string;
      readonly threshold: number;
    })
  | (WorkerRequestBase & {
      readonly op: 'vad_stream';
      /** base64 of signed 16-bit LE PCM: a whole number of 512-sample frames. */
      readonly pcm: string;
      /** Start a new stream, discarding the state left by the previous audio. */
      readonly reset?: boolean;
    })
  | (WorkerRequestBase & {
      readonly op: 'diarize';
      readonly path: string;
      /** Hard cap on distinct voices. Left free, clustering over-counts badly. */
      readonly max_speakers: number;
      readonly min_turn_seconds: number;
    })
  | (WorkerRequestBase & { readonly op: 'shutdown' });

export interface WorkerSegment {
  readonly start_ms: number | null;
  readonly end_ms: number | null;
  readonly timestamp_source: 'aligner' | 'vad' | 'none';
  readonly language: string | null;
  readonly text: string;
}

export type WorkerResponse =
  | { readonly id: string; readonly ok: true; readonly op: 'ping'; readonly worker_version: string }
  | {
      readonly id: string;
      readonly ok: true;
      readonly op: 'load';
      readonly model: string;
      readonly load_ms: number;
    }
  | {
      readonly id: string;
      readonly ok: true;
      readonly op: 'transcribe';
      readonly text: string;
      readonly languages: readonly string[];
      readonly segments: readonly WorkerSegment[];
      readonly model: string;
      readonly duration_ms: number;
    }
  | {
      readonly id: string;
      readonly ok: true;
      readonly op: 'vad';
      readonly segments: readonly { start_ms: number; end_ms: number; mean_probability: number }[];
      readonly speech_ms: number;
    }
  | {
      readonly id: string;
      readonly ok: true;
      readonly op: 'vad_stream';
      /** One probability per submitted frame, in order. */
      readonly probabilities: readonly number[];
    }
  | {
      readonly id: string;
      readonly ok: true;
      readonly op: 'diarize';
      readonly turns: readonly { start_ms: number; end_ms: number; speaker: number }[];
      readonly speakers: number;
    }
  | { readonly id: string; readonly ok: true; readonly op: 'shutdown' }
  | { readonly id: string; readonly ok: false; readonly error: string; readonly code: string };

export function encodeRequest(request: WorkerRequest): string {
  return `${JSON.stringify(request)}\n`;
}

export class ProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProtocolError';
  }
}

export function decodeResponse(line: string): WorkerResponse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new ProtocolError(`worker emitted non-JSON on stdout: ${line.slice(0, 200)}`);
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new ProtocolError('worker response must be a JSON object');
  }
  const record = parsed as Record<string, unknown>;
  if (typeof record['id'] !== 'string' || typeof record['ok'] !== 'boolean') {
    throw new ProtocolError('worker response must carry string "id" and boolean "ok"');
  }
  return parsed as WorkerResponse;
}

/** Splits a byte stream into complete NDJSON lines, buffering partial tails. */
export class LineSplitter {
  #buffer = '';

  push(chunk: string): string[] {
    this.#buffer += chunk;
    const lines = this.#buffer.split('\n');
    this.#buffer = lines.pop() ?? '';
    return lines.filter((line) => line.trim().length > 0);
  }
}
