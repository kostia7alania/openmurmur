import { mkdir } from 'node:fs/promises';
import { hostname } from 'node:os';
import type { DatabaseSync } from 'node:sqlite';
import type { CaptureBackend, CaptureFrame } from '../capture/backend.ts';
import { PartWriter, partPaths } from '../capture/writer.ts';
import type { Paths } from '../config/paths.ts';
import type { OpenMurmurConfig } from '../config/schema.ts';
import { transaction } from '../database/db.ts';
import { PartRepository, SessionRepository } from '../database/repository.ts';
import { JobQueue } from '../jobs/queue.ts';
import type { Logger } from '../logging/logger.ts';
import { Outbox } from '../telegram/outbox.ts';
import { type LiveCaptureProvenance, renderProvenancePlain } from '../telegram/provenance.ts';
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
  /** Persisted provenance; injectable so tests never depend on the test runner host. */
  readonly captureHost?: string;
  readonly captureTimezone?: string;
  /** Fired once the first valid audio frame arrives, never before. */
  readonly onFirstFrame?: () => void;
  readonly onSessionStarted?: (sessionId: string) => void;
  readonly onSessionFinalized?: (sessionId: string) => void;
  readonly onSessionRejected?: (sessionId: string, reason: string) => void;
  /** Snapshotted into each ASR job so later settings changes cannot alter a retry. */
  readonly resolveAsrLanguage?: () => string | null;
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
  readonly #outbox: Outbox;
  readonly #captureHost: string;
  readonly #captureTimezone: string;

  /** Raw PCM held for pre-roll, aligned with the sessionizer's frame ring. */
  readonly #preRoll: CaptureFrame[] = [];
  #openPart: OpenPart | null = null;
  #sawFirstFrame = false;
  #running = false;
  #lastMonotonicMs = 0;
  #mutationTail: Promise<void> = Promise.resolve();

  constructor(options: RecorderOptions) {
    this.#options = options;
    this.#machine = new Sessionizer({ config: options.config.sessionizer });
    this.#sessions = new SessionRepository(options.db);
    this.#parts = new PartRepository(options.db);
    this.#jobs = new JobQueue(options.db);
    this.#outbox = new Outbox(options.db);
    this.#captureHost = options.captureHost ?? hostname();
    this.#captureTimezone =
      options.captureTimezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
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
        await this.#withMutation(() => this.#handleFrame(frame));
      }
    } finally {
      this.#running = false;
      await this.#withMutation(async () => {
        // A stopped capture must still leave a valid file behind.
        for (const intent of this.#machine.forceFinalize()) {
          await this.#applyIntent(intent, null);
        }
        if (this.#openPart !== null) {
          await this.#closeOpenPart(Date.now(), this.#lastMonotonicMs);
        }
      });
    }
  }

  async stop(): Promise<void> {
    // Stop ingress immediately. Waiting behind VAD/writer mutation here would
    // keep the microphone open precisely when processing is wedged.
    let discarded = this.#options.capture.discardBufferedFrames?.() ?? 0;
    await this.#options.capture.stop();
    discarded += this.#options.capture.discardBufferedFrames?.() ?? 0;
    if (discarded > 0) {
      this.#options.logger.warn('discarded buffered capture frames during recorder stop', {
        frames: discarded,
      });
    }
  }

  /**
   * Closes any open session immediately, as if the silence timeout had fired.
   *
   * Used when the machine wakes from sleep: the audio stream stopped without
   * the sessionizer seeing any silence, so a session left open would appear to
   * span the gap. Returns the session id that was closed, if any.
   */
  async closeOpenSession(reason: string): Promise<string | null> {
    return this.#withMutation(() => this.#closeOpenSession(reason, true));
  }

  async #closeOpenSession(reason: string, discardBuffered: boolean): Promise<string | null> {
    if (discardBuffered) {
      const discarded = this.#options.capture.discardBufferedFrames?.() ?? 0;
      if (discarded > 0) {
        this.#options.logger.warn('discarded buffered frames across a recorder boundary', {
          frames: discarded,
          reason,
        });
      }
    }
    const sessionId = this.#machine.sessionId;
    if (sessionId === null) {
      // A sleep gap can happen while speech is still only a candidate. Clear
      // both timing and PCM pre-roll so audio from before sleep cannot open or
      // prefix a session after wake.
      this.#machine.forceFinalize();
      this.#preRoll.length = 0;
      this.#options.vad.reset();
      return null;
    }

    for (const intent of this.#machine.forceFinalize()) {
      await this.#applyIntent(intent, null);
    }
    if (this.#openPart !== null) {
      await this.#closeOpenPart(Date.now(), this.#lastMonotonicMs);
    }
    this.#preRoll.length = 0;
    this.#options.vad.reset();
    this.#options.logger.info('closed an open session early', { sessionId, reason });
    return sessionId;
  }

  async #handleFrame(frame: CaptureFrame): Promise<void> {
    const currentEpoch = this.#options.capture.currentStreamEpoch?.();
    if (
      frame.streamEpoch !== undefined &&
      currentEpoch !== undefined &&
      frame.streamEpoch !== currentEpoch
    ) {
      this.#options.logger.warn('discarded a stale frame from an earlier capture epoch', {
        frameEpoch: frame.streamEpoch,
        currentEpoch,
      });
      return;
    }
    if ((frame.discontinuityBeforeMs ?? 0) > 0) {
      await this.#closeOpenSession('capture stream discontinuity', false);
      this.#options.logger.warn('capture stream resumed after a source gap', {
        gapMs: frame.discontinuityBeforeMs,
      });
    }
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
    const bufferedCurrentFrame = this.#openPart === null;
    if (bufferedCurrentFrame) {
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

    // Written after the intents so rotations place this frame in the new part.
    // A frame that opened a session was already replayed as the tail of pre-roll
    // and must not be duplicated here.
    const currentFrameWasReplayed =
      bufferedCurrentFrame && intents.some((intent) => intent.kind === 'open_part');
    if (this.#openPart !== null && !currentFrameWasReplayed) {
      await this.#openPart.writer.write(frame.pcm);
    }
  }

  async #applyIntent(intent: SessionIntent, frame: CaptureFrame | null): Promise<void> {
    switch (intent.kind) {
      case 'session_started':
        transaction(this.#options.db, () => {
          this.#sessions.create(intent.sessionId, new Date(intent.startedWallMs).toISOString(), {
            hostName: this.#captureHost,
            timezone: this.#captureTimezone,
          });
          this.#enqueueLifecycleStatus(
            intent.sessionId,
            'started',
            '🎙 Услышал речь — запись сессии началась.',
          );
        });
        this.#options.logger.info('session started', { sessionId: intent.sessionId });
        this.#notify(() => this.#options.onSessionStarted?.(intent.sessionId));
        break;

      case 'open_part':
        await this.#openNewPart(intent);
        break;

      case 'close_part':
        await this.#closeOpenPart(intent.endedWallMs, intent.endedMonotonicMs);
        break;

      case 'session_finalized': {
        const finalizedParts = this.#parts
          .listForSession(intent.sessionId)
          .filter((part) => part.finalized === 1);
        if (finalizedParts.length === 0) {
          transaction(this.#options.db, () => {
            this.#options.db
              .prepare(
                `UPDATE audio_sessions
                    SET state = 'FAILED', rejection_reason = 'audio_finalize_failed',
                        ended_at = ?, duration_ms = ?, speech_ms = ?, part_count = 0,
                        updated_at = ?
                  WHERE session_id = ?`,
              )
              .run(
                new Date(intent.endedWallMs).toISOString(),
                intent.durationMs,
                intent.speechMs,
                new Date().toISOString(),
                intent.sessionId,
              );
            this.#enqueueLifecycleStatus(
              intent.sessionId,
              'failed',
              '🔴 Сессию не удалось сохранить: финализация аудио завершилась ошибкой. Аудио не загружаю.',
            );
          });
          this.#options.logger.error('session failed because no audio part was finalized', {
            sessionId: intent.sessionId,
            attemptedParts: intent.partCount,
          });
          break;
        }

        const partial = finalizedParts.length < intent.partCount;
        transaction(this.#options.db, () => {
          this.#sessions.finalize(
            intent.sessionId,
            new Date(intent.endedWallMs).toISOString(),
            intent.durationMs,
            intent.speechMs,
            finalizedParts.length,
          );
          // Audio delivery is a separate job so Telegram can upload while ASR
          // works, without putting filesystem or network I/O on this hot path.
          this.#jobs.enqueue({
            kind: 'deliver_audio',
            idempotencyKey: `deliver-audio:${intent.sessionId}`,
            payload: { sessionId: intent.sessionId },
          });
          this.#jobs.enqueue({
            kind: 'asr',
            idempotencyKey: `asr:${intent.sessionId}`,
            payload: {
              sessionId: intent.sessionId,
              forcedLanguage: this.#options.resolveAsrLanguage?.() ?? null,
            },
          });
          this.#enqueueLifecycleStatus(
            intent.sessionId,
            'finalized',
            partial
              ? '⚠️ Сессия завершена не полностью — загружаю сохранившиеся части аудио и расшифровываю локально…'
              : '⏳ Сессия завершена — загружаю аудио и параллельно расшифровываю локально…',
          );
        });
        this.#options.logger.info('session finalized', {
          sessionId: intent.sessionId,
          speechMs: intent.speechMs,
          parts: finalizedParts.length,
          partial,
        });
        this.#notify(() => this.#options.onSessionFinalized?.(intent.sessionId));
        break;
      }

      case 'session_rejected':
        transaction(this.#options.db, () => {
          this.#sessions.reject(intent.sessionId, intent.reason, intent.speechMs, intent.partCount);
          this.#enqueueLifecycleStatus(
            intent.sessionId,
            'rejected',
            'ℹ️ Сессия завершена, но фрагмент слишком короткий — аудио не отправляю.',
          );
        });
        this.#options.logger.info('session rejected', {
          sessionId: intent.sessionId,
          reason: intent.reason,
          speechMs: intent.speechMs,
        });
        this.#notify(() => this.#options.onSessionRejected?.(intent.sessionId, intent.reason));
        break;
    }
    void frame;
  }

  #enqueueLifecycleStatus(
    sessionId: string,
    stage: 'started' | 'finalized' | 'rejected' | 'failed',
    text: string,
  ): void {
    const session = this.#sessions.get(sessionId);
    const provenance: LiveCaptureProvenance = {
      kind: 'live_capture',
      hostName: session?.capture_host ?? null,
      timezone: session?.capture_timezone ?? null,
      originalAt: session?.started_at ?? new Date(0).toISOString(),
      sessionId,
    };
    this.#outbox.enqueue({
      deliveryPartId: `session-status:${stage}:${sessionId}`,
      kind: 'status',
      sessionId,
      ordinal: -10,
      payload: { type: 'text', text: `${text}\n\n${renderProvenancePlain(provenance)}` },
    });
  }

  #notify(callback: () => void): void {
    try {
      callback();
    } catch (error) {
      this.#options.logger.warn('recorder observer failed', { error: (error as Error).message });
    }
  }

  #withMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#mutationTail.then(operation);
    this.#mutationTail = result.then(
      () => {},
      () => {},
    );
    return result;
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
