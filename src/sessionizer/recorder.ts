import { mkdir } from 'node:fs/promises';
import type { DatabaseSync } from 'node:sqlite';
import type { CaptureBackend, CaptureFrame } from '../capture/backend.ts';
import { PartWriter, partPaths } from '../capture/writer.ts';
import type { Paths } from '../config/paths.ts';
import type { OpenMurmurConfig } from '../config/schema.ts';
import { PartRepository, SessionRepository } from '../database/repository.ts';
import { JobQueue } from '../jobs/queue.ts';
import type { Logger } from '../logging/logger.ts';
import { Sessionizer } from './machine.ts';
import type { SessionIntent } from './types.ts';
import type { Vad } from './vad.ts';

/**
 * Binds the pure sessionizer to real I/O.
 *
 * Design rule: **capture never blocks on processing.** When a session closes,
 * this class enqueues an ASR job and immediately returns to reading frames. If
 * someone starts talking again two seconds later, a fresh session opens while
 * the previous one is still being transcribed. That is what the job queue is
 * for; the recorder's only obligation is to keep up with the microphone.
 */

export interface RecorderOptions {
  readonly config: OpenMurmurConfig;
  readonly paths: Paths;
  readonly db: DatabaseSync;
  readonly capture: CaptureBackend;
  readonly vad: Vad;
  readonly logger: Logger;
  /** Fired once the first valid audio frame arrives, never before. */
  readonly onFirstFrame?: () => void;
  readonly onSessionFinalized?: (sessionId: string) => void;
}

interface OpenPart {
  readonly partId: string;
  readonly writer: PartWriter;
  readonly startedMonotonicMs: number;
}

export class Recorder {
  readonly #options: RecorderOptions;
  readonly #machine: Sessionizer;
  readonly #sessions: SessionRepository;
  readonly #parts: PartRepository;
  readonly #jobs: JobQueue;

  /** Raw PCM held for pre-roll, aligned with the sessionizer's frame ring. */
  readonly #preRoll: CaptureFrame[] = [];
  #openPart: OpenPart | null = null;
  #sawFirstFrame = false;
  #running = false;
  #lastMonotonicMs = 0;

  constructor(options: RecorderOptions) {
    this.#options = options;
    this.#machine = new Sessionizer({ config: options.config.sessionizer });
    this.#sessions = new SessionRepository(options.db);
    this.#parts = new PartRepository(options.db);
    this.#jobs = new JobQueue(options.db);
  }

  get state(): string {
    return this.#machine.state;
  }

  snapshot() {
    return this.#machine.snapshot();
  }

  get running(): boolean {
    return this.#running;
  }

  async run(): Promise<void> {
    this.#running = true;
    try {
      for await (const frame of this.#options.capture.start()) {
        if (!this.#sawFirstFrame) {
          this.#sawFirstFrame = true;
          this.#options.onFirstFrame?.();
        }
        await this.#handleFrame(frame);
      }
    } finally {
      this.#running = false;
      // A stopped capture must still leave a valid file behind.
      for (const intent of this.#machine.forceFinalize()) {
        await this.#applyIntent(intent, null);
      }
      if (this.#openPart !== null) {
        await this.#closeOpenPart(Date.now(), this.#lastMonotonicMs);
      }
    }
  }

  async stop(): Promise<void> {
    await this.#options.capture.stop();
  }

  /**
   * Closes any open session immediately, as if the silence timeout had fired.
   *
   * Used when the machine wakes from sleep: the audio stream stopped without
   * the sessionizer seeing any silence, so a session left open would appear to
   * span the gap. Returns the session id that was closed, if any.
   */
  async closeOpenSession(reason: string): Promise<string | null> {
    const sessionId = this.#machine.sessionId;
    if (sessionId === null) return null;

    for (const intent of this.#machine.forceFinalize()) {
      await this.#applyIntent(intent, null);
    }
    if (this.#openPart !== null) {
      await this.#closeOpenPart(Date.now(), this.#lastMonotonicMs);
    }
    this.#options.logger.info('closed an open session early', { sessionId, reason });
    return sessionId;
  }

  async #handleFrame(frame: CaptureFrame): Promise<void> {
    this.#lastMonotonicMs = frame.monotonicMs;
    const probability = await this.#options.vad.probability(frame.pcm);

    const intents = this.#machine.push({
      monotonicMs: frame.monotonicMs,
      wallMs: frame.wallMs,
      durationMs: frame.durationMs,
      speechProbability: probability,
    });

    // Keep raw PCM for the pre-roll while no part is open. The sessionizer
    // tracks the same window in frame counts; this holds the actual bytes.
    if (this.#openPart === null) {
      this.#preRoll.push(frame);
      const capacityMs = this.#options.config.sessionizer.preRollSeconds * 1000;
      let held = this.#preRoll.reduce((sum, f) => sum + f.durationMs, 0);
      while (this.#preRoll.length > 1 && held > capacityMs) {
        held -= this.#preRoll.shift()?.durationMs ?? 0;
      }
    }

    for (const intent of intents) {
      await this.#applyIntent(intent, frame);
    }

    // Written after the intents so that a freshly opened part receives the
    // pre-roll first and this frame second, in the right order.
    if (this.#openPart !== null) {
      await this.#openPart.writer.write(frame.pcm);
    }
  }

  async #applyIntent(intent: SessionIntent, frame: CaptureFrame | null): Promise<void> {
    switch (intent.kind) {
      case 'session_started':
        this.#sessions.create(intent.sessionId, new Date(intent.startedWallMs).toISOString());
        this.#options.logger.info('session started', { sessionId: intent.sessionId });
        break;

      case 'open_part':
        await this.#openNewPart(intent);
        break;

      case 'close_part':
        await this.#closeOpenPart(intent.endedWallMs, intent.endedMonotonicMs);
        break;

      case 'session_finalized': {
        this.#sessions.finalize(
          intent.sessionId,
          new Date(intent.endedWallMs).toISOString(),
          intent.durationMs,
          intent.speechMs,
          intent.partCount,
        );
        // Enqueue and return to the microphone immediately.
        this.#jobs.enqueue({
          kind: 'asr',
          idempotencyKey: `asr:${intent.sessionId}`,
          payload: { sessionId: intent.sessionId },
        });
        this.#options.logger.info('session finalized', {
          sessionId: intent.sessionId,
          speechMs: intent.speechMs,
          parts: intent.partCount,
        });
        this.#options.onSessionFinalized?.(intent.sessionId);
        break;
      }

      case 'session_rejected':
        this.#sessions.reject(intent.sessionId, intent.reason, intent.speechMs, intent.partCount);
        this.#options.logger.info('session rejected', {
          sessionId: intent.sessionId,
          reason: intent.reason,
          speechMs: intent.speechMs,
        });
        break;
    }
    void frame;
  }

  async #openNewPart(intent: Extract<SessionIntent, { kind: 'open_part' }>): Promise<void> {
    const { dateDir, finalPath, tempPath } = partPaths(
      this.#options.paths.audioDir,
      this.#options.paths.tempDir,
      intent.sessionId,
      intent.partIndex,
      intent.startedWallMs,
    );
    await mkdir(dateDir, { recursive: true, mode: 0o700 });

    const writer = new PartWriter({
      ffmpegPath: this.#options.config.audio.ffmpegPath,
      sampleRate: this.#options.config.audio.sampleRate,
      channels: this.#options.config.audio.channels,
      compressionLevel: this.#options.config.audio.flacCompressionLevel,
      tempPath,
      finalPath,
    });
    writer.open();

    const partId = this.#parts.open(
      intent.sessionId,
      intent.partIndex,
      finalPath,
      new Date(intent.startedWallMs).toISOString(),
    );

    this.#openPart = {
      partId,
      writer,
      startedMonotonicMs: intent.startedMonotonicMs,
    };

    // Replay the pre-roll so the session begins a few seconds before the words
    // that opened it — the user hears the whole sentence, not its second half.
    if (intent.preRollFrames > 0) {
      for (const buffered of this.#preRoll.slice(-intent.preRollFrames)) {
        await writer.write(buffered.pcm);
      }
    }
    this.#preRoll.length = 0;
  }

  async #closeOpenPart(endedWallMs: number, endedMonotonicMs: number): Promise<void> {
    const open = this.#openPart;
    if (open === null) return;
    this.#openPart = null;

    // Duration comes from the monotonic span of the part, so an NTP step
    // mid-recording cannot report a negative or wildly long part.
    const durationMs = Math.max(0, Math.round(endedMonotonicMs - open.startedMonotonicMs));

    try {
      const finalized = await open.writer.close();
      this.#parts.finalizePart(
        open.partId,
        new Date(endedWallMs).toISOString(),
        durationMs,
        finalized.bytes,
        finalized.sha256,
      );
      this.#options.logger.info('audio part closed', {
        partId: open.partId,
        bytes: finalized.bytes,
        sha256: finalized.sha256,
      });
    } catch (error) {
      this.#options.logger.error('failed to finalize audio part', {
        partId: open.partId,
        error: (error as Error).message,
      });
      await open.writer.abort();
    }
  }
}
