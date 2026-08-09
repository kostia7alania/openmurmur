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
  readonly logger: Logger;
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
  readonly #worker: WorkerProcess;
  #loaded = false;
  #workerFailed = false;

  constructor(options: MlxAsrOptions) {
    this.#options = options;
    this.#worker = new WorkerProcess({
      command: options.command,
      args: options.args,
      cwd: options.cwd,
      logger: options.logger,
      label: 'ASR',
      onExit: () => {
        this.#loaded = false;
        this.#workerFailed = true;
      },
    });
  }

  health(): { ok: true; detail: string } | { ok: false; reason: string } {
    if (this.#workerFailed && !this.#worker.running) {
      return { ok: false, reason: 'ASR worker exited; the queued job will restart it' };
    }
    if (!this.#worker.running) return { ok: true, detail: 'idle; starts on demand' };
    return { ok: true, detail: this.#loaded ? 'model loaded' : 'worker starting' };
  }

  async ready(): Promise<{ ok: true } | { ok: false; reason: string }> {
    try {
      await this.#worker.ensureStarted();
      const pong = await this.#worker.send({ id: randomUUID(), op: 'ping' }, 30_000);
      if (!pong.ok) return { ok: false, reason: pong.error };
      await this.#ensureLoaded();
      this.#workerFailed = false;
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: (error as Error).message };
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
    await this.#worker.close(randomUUID());
    this.#loaded = false;
  }

  async #ensureLoaded(): Promise<void> {
    if (this.#loaded) return;
    const response = await this.#worker.send(
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
}
