import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { Logger } from '../logging/logger.ts';
import {
  decodeResponse,
  encodeRequest,
  LineSplitter,
  type WorkerRequest,
  type WorkerResponse,
} from './protocol.ts';
import type { AsrBackend, AsrRequest, AsrResult, VadRequest, VadSegment } from './types.ts';

export interface MlxAsrOptions {
  /** Usually `uv`, invoked with `run --project python/openmurmur_audio`. */
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly model: string;
  readonly quantization: string;
  readonly alignerLanguages: readonly string[];
  readonly requestTimeoutMs: number;
  readonly logger: Logger;
}

interface Pending {
  resolve: (response: WorkerResponse) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * Persistent Python MLX worker.
 *
 * The process is started lazily on first use and kept alive; the model stays
 * resident in unified memory. If the worker dies, every in-flight request is
 * rejected and the next call respawns it — a crash costs one session's
 * transcription attempt (which the job queue retries), not the daemon.
 */
export class MlxAsr implements AsrBackend {
  readonly name = 'mlx-qwen3-asr';

  readonly #options: MlxAsrOptions;
  readonly #pending = new Map<string, Pending>();
  #child: ChildProcessWithoutNullStreams | null = null;
  #loaded = false;
  #startPromise: Promise<void> | null = null;

  constructor(options: MlxAsrOptions) {
    this.#options = options;
  }

  async ready(): Promise<{ ok: true } | { ok: false; reason: string }> {
    try {
      await this.#ensureStarted();
      const pong = await this.#send({ id: randomUUID(), op: 'ping' }, 30_000);
      if (!pong.ok) return { ok: false, reason: pong.error };
      await this.#ensureLoaded();
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: (error as Error).message };
    }
  }

  async transcribe(request: AsrRequest): Promise<AsrResult> {
    await this.#ensureStarted();
    await this.#ensureLoaded();

    const response = await this.#send(
      {
        id: request.requestId,
        op: 'transcribe',
        path: request.audioPath,
        language_hints: request.languageHints ?? [],
        aligner_languages: this.#options.alignerLanguages,
      },
      this.#options.requestTimeoutMs,
    );

    if (!response.ok) throw new Error(`ASR failed: ${response.error}`);
    if (response.op !== 'transcribe') throw new Error('worker replied to the wrong operation');

    return {
      text: response.text,
      languages: response.languages,
      segments: response.segments.map((s) => ({
        startMs: s.start_ms,
        endMs: s.end_ms,
        timestampSource: s.timestamp_source,
        language: s.language,
        text: s.text,
      })),
      engine: this.name,
      model: response.model,
      durationMs: response.duration_ms,
    };
  }

  async vadSegments(request: VadRequest): Promise<readonly VadSegment[]> {
    await this.#ensureStarted();

    // Deliberately does not require the ASR model: a VAD pass must still work
    // when the transcription model failed to load.
    const response = await this.#send(
      { id: randomUUID(), op: 'vad', path: request.audioPath, threshold: request.threshold },
      this.#options.requestTimeoutMs,
    );

    if (!response.ok) throw new Error(`VAD failed: ${response.error}`);
    if (response.op !== 'vad') throw new Error('worker replied to the wrong operation');

    return response.segments.map((s) => ({
      startMs: s.start_ms,
      endMs: s.end_ms,
      meanProbability: s.mean_probability,
    }));
  }

  async close(): Promise<void> {
    const child = this.#child;
    if (child === null) return;
    try {
      await this.#send({ id: randomUUID(), op: 'shutdown' }, 5000);
    } catch {
      // Worker already gone or wedged; SIGTERM below is the fallback.
    }
    child.kill('SIGTERM');
    this.#child = null;
    this.#loaded = false;
  }

  #ensureStarted(): Promise<void> {
    if (this.#child !== null) return Promise.resolve();
    if (this.#startPromise !== null) return this.#startPromise;

    this.#startPromise = new Promise<void>((resolve, reject) => {
      let child: ChildProcessWithoutNullStreams;
      try {
        child = spawn(this.#options.command, [...this.#options.args], {
          cwd: this.#options.cwd,
          stdio: ['pipe', 'pipe', 'pipe'],
          // The worker gets no secrets. It only ever sees audio file paths.
          env: { PATH: process.env['PATH'] ?? '', HOME: process.env['HOME'] ?? '' },
        });
      } catch (error) {
        reject(new Error(`could not start the ASR worker: ${(error as Error).message}`));
        return;
      }

      const splitter = new LineSplitter();
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        for (const line of splitter.push(chunk)) this.#dispatch(line);
      });

      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => {
        this.#options.logger.debug('asr worker stderr', { text: chunk.trimEnd().slice(0, 2000) });
      });

      child.on('error', (error) => {
        this.#failAll(new Error(`ASR worker failed to start: ${error.message}`));
        reject(new Error(missingWorkerHint(this.#options.command, error.message)));
      });

      child.on('close', (code) => {
        this.#child = null;
        this.#loaded = false;
        this.#startPromise = null;
        this.#failAll(new Error(`ASR worker exited with code ${code}`));
      });

      this.#child = child;
      resolve();
    }).finally(() => {
      this.#startPromise = null;
    });

    return this.#startPromise;
  }

  async #ensureLoaded(): Promise<void> {
    if (this.#loaded) return;
    const response = await this.#send(
      {
        id: randomUUID(),
        op: 'load',
        model: this.#options.model,
        quantization: this.#options.quantization,
      },
      // First load may download several GB of weights.
      Math.max(this.#options.requestTimeoutMs, 30 * 60 * 1000),
    );
    if (!response.ok) throw new Error(`could not load ${this.#options.model}: ${response.error}`);
    this.#loaded = true;
  }

  #dispatch(line: string): void {
    let response: WorkerResponse;
    try {
      response = decodeResponse(line);
    } catch (error) {
      this.#options.logger.warn('discarding malformed worker line', {
        error: (error as Error).message,
      });
      return;
    }
    const pending = this.#pending.get(response.id);
    if (pending === undefined) return;
    this.#pending.delete(response.id);
    clearTimeout(pending.timer);
    pending.resolve(response);
  }

  #send(request: WorkerRequest, timeoutMs: number): Promise<WorkerResponse> {
    const child = this.#child;
    if (child === null) return Promise.reject(new Error('ASR worker is not running'));

    return new Promise<WorkerResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(request.id);
        reject(new Error(`ASR worker did not answer "${request.op}" within ${timeoutMs} ms`));
      }, timeoutMs);
      this.#pending.set(request.id, { resolve, reject, timer });
      child.stdin.write(encodeRequest(request), (error) => {
        if (!error) return;
        this.#pending.delete(request.id);
        clearTimeout(timer);
        reject(new Error(`could not write to the ASR worker: ${error.message}`));
      });
    });
  }

  #failAll(error: Error): void {
    for (const [, pending] of this.#pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }
}

function missingWorkerHint(command: string, detail: string): string {
  return (
    `Could not start the local ASR worker ("${command}"): ${detail}\n\n` +
    'OpenMurmur transcribes on-device and does not fall back to any cloud service.\n' +
    'Fix it with:\n' +
    '  ./scripts/bootstrap          # installs uv and the Python environment\n' +
    '  openmurmur doctor            # re-checks every dependency\n\n' +
    'To run without models (delivery pipeline only), set asr.backend to "fake" in the config.'
  );
}
