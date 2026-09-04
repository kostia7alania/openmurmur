import { randomUUID } from 'node:crypto';
import type { Logger } from '../logging/logger.ts';
import type {
  AsrBackend,
  AsrRequest,
  AsrResult,
  DiarizationRequest,
  SpeakerTurn,
  VadRequest,
  VadSegment,
} from './types.ts';
import { WorkerProcess } from './worker-process.ts';

export interface MlxAsrOptions {
  /** Usually `uv`, invoked with `run --project python/openmurmur_audio`. */
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly model: string;
  readonly quantization: string;
  readonly alignerLanguages: readonly string[];
  readonly requestTimeoutMs: number;
  readonly workerIdleTimeoutMs: number;
  readonly logger: Logger;
}

type ModelLoadState =
  | { readonly status: 'idle' }
  | { readonly status: 'loading' }
  | { readonly status: 'loaded'; readonly model: string; readonly loadMs: number }
  | { readonly status: 'load_failed'; readonly reason: string };

/**
 * Persistent Python MLX worker.
 *
 * The process is started lazily on first use and retired after bounded idle
 * time so the model returns unified memory to the system. If the worker dies,
 * every in-flight request is rejected and the next call respawns it — a crash
 * costs one session's transcription attempt (which the job queue retries), not
 * the daemon.
 */
export class MlxAsr implements AsrBackend {
  readonly name = 'mlx-qwen3-asr';

  readonly #options: MlxAsrOptions;
  readonly #worker: WorkerProcess;
  #loadState: ModelLoadState = { status: 'idle' };
  #loadPromise: Promise<void> | null = null;
  #workerGeneration = 0;
  #workerFailed = false;
  #readinessFailure: string | null = null;
  #closed = false;

  constructor(options: MlxAsrOptions) {
    this.#options = options;
    this.#worker = new WorkerProcess({
      command: options.command,
      args: options.args,
      cwd: options.cwd,
      logger: options.logger,
      label: 'ASR',
      idleTimeoutMs: options.workerIdleTimeoutMs,
      onExit: (reason) => {
        this.#workerGeneration += 1;
        this.#loadState = { status: 'idle' };
        this.#loadPromise = null;
        if (reason !== 'unexpected') {
          this.#workerFailed = false;
          this.#readinessFailure = null;
          return;
        }
        this.#workerFailed = true;
        this.#readinessFailure = 'ASR worker exited; the queued job will restart it';
      },
    });
  }

  health(): { ok: true; detail: string } | { ok: false; reason: string; recovering?: true } {
    if (this.#closed) return { ok: false, reason: 'ASR worker is closed' };
    if (this.#readinessFailure !== null) {
      return { ok: false, reason: this.#readinessFailure };
    }
    if (this.#workerFailed && !this.#worker.running) {
      return { ok: false, reason: 'ASR worker exited; the queued job will restart it' };
    }
    if (!this.#worker.running) {
      return { ok: true, detail: 'model idle; starts on queued audio' };
    }
    switch (this.#loadState.status) {
      case 'idle':
        return {
          ok: false,
          reason: 'ASR worker is running; model not loaded',
          recovering: true,
        };
      case 'loading':
        return { ok: false, reason: 'ASR model is loading', recovering: true };
      case 'loaded':
        return {
          ok: true,
          detail: `model loaded: ${this.#loadState.model} (${this.#loadState.loadMs} ms)`,
        };
      case 'load_failed':
        return { ok: false, reason: this.#loadState.reason };
    }
  }

  async ready(): Promise<{ ok: true } | { ok: false; reason: string }> {
    try {
      await this.#worker.ensureStarted();
      const pong = await this.#worker.send(
        { id: randomUUID(), op: 'ping' },
        Math.max(30_000, this.#options.requestTimeoutMs),
      );
      if (!pong.ok) {
        const reason = `ASR worker readiness failed: ${pong.error}`;
        this.#readinessFailure = reason;
        this.#loadState = { status: 'load_failed', reason };
        return { ok: false, reason };
      }
      await this.#ensureLoaded();
      this.#workerFailed = false;
      this.#readinessFailure = null;
      return { ok: true };
    } catch (error) {
      const reason = (error as Error).message;
      this.#readinessFailure = reason;
      if (this.#worker.running) this.#loadState = { status: 'load_failed', reason };
      return { ok: false, reason };
    }
  }

  async transcribe(request: AsrRequest): Promise<AsrResult> {
    await this.#worker.ensureStarted();
    await this.#ensureLoaded();
    this.#workerFailed = false;

    const response = await this.#worker.send(
      {
        id: request.requestId,
        op: 'transcribe',
        path: request.audioPath,
        language_hints: request.languageHints ?? [],
        aligner_languages: this.#options.alignerLanguages,
        context: request.context ?? '',
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
    await this.#worker.ensureStarted();

    // Deliberately does not require the ASR model: a VAD pass must still work
    // when the transcription model failed to load.
    const response = await this.#worker.send(
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

  async diarize(request: DiarizationRequest): Promise<readonly SpeakerTurn[]> {
    await this.#worker.ensureStarted();

    // Like the VAD pass, deliberately independent of the ASR model.
    const response = await this.#worker.send(
      {
        id: randomUUID(),
        op: 'diarize',
        path: request.audioPath,
        max_speakers: request.maxSpeakers,
        min_turn_seconds: request.minTurnSeconds,
      },
      this.#options.requestTimeoutMs,
    );

    if (!response.ok) throw new Error(`diarization failed: ${response.error}`);
    if (response.op !== 'diarize') throw new Error('worker replied to the wrong operation');

    return response.turns.map((turn) => ({
      startMs: turn.start_ms,
      endMs: turn.end_ms,
      speaker: turn.speaker,
    }));
  }

  async close(): Promise<void> {
    this.#closed = true;
    await this.#worker.close(randomUUID());
    this.#loadState = { status: 'idle' };
    this.#loadPromise = null;
  }

  async #ensureLoaded(): Promise<void> {
    if (this.#loadState.status === 'loaded') return;
    if (this.#loadPromise !== null) return this.#loadPromise;

    const generation = this.#workerGeneration;
    const load = this.#loadModel(generation);
    this.#loadPromise = load;
    try {
      await load;
    } finally {
      if (this.#loadPromise === load) this.#loadPromise = null;
    }
  }

  async #loadModel(generation: number): Promise<void> {
    this.#loadState = { status: 'loading' };
    try {
      const response = await this.#worker.send(
        {
          id: randomUUID(),
          op: 'load',
          model: this.#options.model,
          quantization: this.#options.quantization,
        },
        // Loading a provisioned snapshot can still be slow on the first local use.
        Math.max(this.#options.requestTimeoutMs, 30 * 60 * 1000),
      );
      if (!response.ok) {
        throw new Error(`could not load ${this.#options.model}: ${response.error}`);
      }
      if (response.op !== 'load') {
        throw new Error(`ASR worker replied to "load" with "${response.op}"`);
      }
      if (response.model !== this.#options.model) {
        throw new Error(
          `ASR worker loaded "${response.model}" instead of "${this.#options.model}"`,
        );
      }
      if (!Number.isFinite(response.load_ms) || response.load_ms < 0) {
        throw new Error('ASR worker returned an invalid model load duration');
      }
      if (generation !== this.#workerGeneration || !this.#worker.running) {
        throw new Error('ASR worker generation changed while the model was loading');
      }

      this.#loadState = {
        status: 'loaded',
        model: response.model,
        loadMs: response.load_ms,
      };
      this.#workerFailed = false;
      this.#readinessFailure = null;
    } catch (error) {
      if (generation === this.#workerGeneration && this.#worker.running) {
        const reason = (error as Error).message;
        this.#loadState = { status: 'load_failed', reason };
        this.#readinessFailure = reason;
      }
      throw error;
    }
  }
}
