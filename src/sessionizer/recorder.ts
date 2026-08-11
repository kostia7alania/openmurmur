import { mkdir } from 'node:fs/promises';
import { hostname } from 'node:os';
import type { DatabaseSync } from 'node:sqlite';
import type { CaptureBackend, CaptureFrame } from '../capture/backend.ts';
import { PartWriter, partPaths } from '../capture/writer.ts';
import type { Paths } from '../config/paths.ts';
import type { OpenMurmurConfig } from '../config/schema.ts';
import { transaction } from '../database/db.ts';
import {
  AudioFinalizationJournalRepository,
  PartRepository,
  SessionRepository,
} from '../database/repository.ts';
import { JobQueue } from '../jobs/queue.ts';
import type { Logger } from '../logging/logger.ts';
import { Outbox } from '../telegram/outbox.ts';
import { type LiveCaptureProvenance, renderProvenancePlain } from '../telegram/provenance.ts';
import { Sessionizer } from './machine.ts';
import type { SessionIntent } from './types.ts';
import type { Vad } from './vad.ts';

const STORAGE_FINALIZER_CAPACITY = 2;

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
  readonly sessionId: string;
  readonly writer: PartWriter;
  readonly startedMonotonicMs: number;
}

type SessionOutcomeIntent = Extract<
  SessionIntent,
  { kind: 'session_finalized' | 'session_rejected' }
>;

interface PendingSessionOutcome {
  readonly intent: SessionOutcomeIntent;
  readonly storageDiscarded: boolean;
}

interface SessionStorageProof {
  readonly finalizedPartCount: number;
  readonly publishedPartPendingDatabase: boolean;
  readonly hasFinalizationBoundary: boolean;
  readonly storageDiscarded: boolean;
  readonly proven: boolean;
}

export class Recorder {
  readonly #options: RecorderOptions;
  readonly #machine: Sessionizer;
  readonly #sessions: SessionRepository;
  readonly #parts: PartRepository;
  readonly #finalizations: AudioFinalizationJournalRepository;
  readonly #jobs: JobQueue;
  readonly #outbox: Outbox;
  readonly #captureHost: string;
  readonly #captureTimezone: string;

  /** Raw PCM held for pre-roll, aligned with the sessionizer's frame ring. */
  readonly #preRoll: CaptureFrame[] = [];
  #openPart: OpenPart | null = null;
  #discardingSessionId: string | null = null;
  #reservedFinalizers = 0;
  readonly #storageFinalizers = new Set<Promise<void>>();
  readonly #storageFinalizersBySession = new Map<string, Set<Promise<void>>>();
  readonly #pendingSessionOutcomes = new Map<string, PendingSessionOutcome>();
  #sawFirstFrame = false;
  #running = false;
  #lastMonotonicMs = 0;
  #mutationTail: Promise<void> = Promise.resolve();

  constructor(options: RecorderOptions) {
    this.#options = options;
    this.#machine = new Sessionizer({ config: options.config.sessionizer });
    this.#sessions = new SessionRepository(options.db);
    this.#parts = new PartRepository(options.db);
    this.#finalizations = new AudioFinalizationJournalRepository(options.db);
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
      try {
        await this.#withMutation(async () => {
          // A stopped capture must still leave a valid file behind.
          for (const intent of this.#machine.forceFinalize()) {
            await this.#applyIntent(intent, null);
          }
          if (this.#openPart !== null) {
            await this.#closeOpenPart(Date.now(), this.#lastMonotonicMs);
          }
        });
      } finally {
        await this.#drainStorageFinalizers();
      }
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
    const bufferedCurrentFrame = this.#openPart === null && this.#discardingSessionId === null;
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
        await this.#closeOpenPart(intent.endedWallMs, intent.endedMonotonicMs, intent.finalSession);
        break;

      case 'session_finalized': {
        this.#deferOrSettleSessionOutcome(intent);
        break;
      }

      case 'session_rejected':
        this.#deferOrSettleSessionOutcome(intent);
        break;
    }
    void frame;
  }

  #deferOrSettleSessionOutcome(intent: SessionOutcomeIntent): void {
    const storageDiscarded = this.#discardingSessionId === intent.sessionId;
    if (storageDiscarded) {
      this.#discardingSessionId = null;
    }
    if ((this.#storageFinalizersBySession.get(intent.sessionId)?.size ?? 0) > 0) {
      this.#pendingSessionOutcomes.set(intent.sessionId, { intent, storageDiscarded });
      return;
    }
    this.#settleSessionOutcome(intent, storageDiscarded);
  }

  #settleDeferredSessionOutcome(sessionId: string): void {
    if ((this.#storageFinalizersBySession.get(sessionId)?.size ?? 0) > 0) return;
    const pending = this.#pendingSessionOutcomes.get(sessionId);
    if (pending === undefined) return;
    this.#settleSessionOutcome(pending.intent, pending.storageDiscarded);
    this.#pendingSessionOutcomes.delete(sessionId);
  }

  #settleSessionOutcome(intent: SessionOutcomeIntent, storageDiscarded: boolean): void {
    if (intent.kind === 'session_finalized') {
      this.#settleFinalizedSession(intent, storageDiscarded);
      return;
    }
    this.#settleRejectedSession(intent, storageDiscarded);
  }

  #settleFinalizedSession(
    intent: Extract<SessionIntent, { kind: 'session_finalized' }>,
    storageDiscarded: boolean,
  ): void {
    const storage = this.#proveSessionStorage(intent.sessionId, storageDiscarded);
    if (!storage.proven) {
      this.#failSessionStorage(
        {
          sessionId: intent.sessionId,
          endedWallMs: intent.endedWallMs,
          durationMs: intent.durationMs,
          speechMs: intent.speechMs,
          partCount: intent.partCount,
        },
        storage,
      );
      return;
    }

    const partial = storage.finalizedPartCount < intent.partCount;
    transaction(this.#options.db, () => {
      this.#sessions.finalizeFromFinalizing(
        intent.sessionId,
        new Date(intent.endedWallMs).toISOString(),
        intent.durationMs,
        intent.speechMs,
        storage.finalizedPartCount,
      );
      this.#finalizations.consumeSessionIfPartFinalized(intent.sessionId, {
        endedAtIso: new Date(intent.endedWallMs).toISOString(),
        durationMs: intent.durationMs,
        speechMs: intent.speechMs,
      });
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
      parts: storage.finalizedPartCount,
      partial,
    });
    this.#notify(() => this.#options.onSessionFinalized?.(intent.sessionId));
  }

  #settleRejectedSession(
    intent: Extract<SessionIntent, { kind: 'session_rejected' }>,
    storageDiscarded: boolean,
  ): void {
    const storage = this.#proveSessionStorage(intent.sessionId, storageDiscarded);
    if (!storage.proven) {
      if (intent.endedWallMs === undefined || intent.durationMs === undefined) {
        throw new Error(`rejected session ${intent.sessionId} lacks exact finalization timing`);
      }
      this.#failSessionStorage(
        {
          sessionId: intent.sessionId,
          endedWallMs: intent.endedWallMs,
          durationMs: intent.durationMs,
          speechMs: intent.speechMs,
          partCount: intent.partCount,
        },
        storage,
      );
      return;
    }

    transaction(this.#options.db, () => {
      if (intent.endedWallMs !== undefined && intent.durationMs !== undefined) {
        const exact = {
          endedAtIso: new Date(intent.endedWallMs).toISOString(),
          durationMs: intent.durationMs,
          speechMs: intent.speechMs,
        };
        this.#sessions.rejectExact(
          intent.sessionId,
          intent.reason,
          exact.endedAtIso,
          exact.durationMs,
          exact.speechMs,
          storage.finalizedPartCount,
        );
        this.#finalizations.consumeSessionIfPartFinalized(intent.sessionId, exact);
      } else {
        this.#sessions.reject(
          intent.sessionId,
          intent.reason,
          intent.speechMs,
          storage.finalizedPartCount,
        );
      }
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
  }

  #proveSessionStorage(sessionId: string, storageDiscarded: boolean): SessionStorageProof {
    const finalizedPartCount = this.#parts
      .listForSession(sessionId)
      .filter((part) => part.finalized === 1).length;
    const publishedPartPendingDatabase = this.#finalizations.hasUnfinalizedPart(sessionId);
    const hasFinalizationBoundary = this.#sessions.get(sessionId)?.state === 'FINALIZING';
    return {
      finalizedPartCount,
      publishedPartPendingDatabase,
      hasFinalizationBoundary,
      storageDiscarded,
      proven:
        !storageDiscarded &&
        finalizedPartCount > 0 &&
        !publishedPartPendingDatabase &&
        hasFinalizationBoundary,
    };
  }

  #failSessionStorage(
    intent: {
      readonly sessionId: string;
      readonly endedWallMs: number;
      readonly durationMs: number;
      readonly speechMs: number;
      readonly partCount: number;
    },
    storage: SessionStorageProof,
  ): void {
    transaction(this.#options.db, () => {
      this.#options.db
        .prepare(
          `UPDATE audio_sessions
              SET state = 'FAILED', rejection_reason = 'audio_finalize_failed',
                  ended_at = ?, duration_ms = ?, speech_ms = ?, part_count = ?,
                  timing_exact = 1, updated_at = ?
            WHERE session_id = ?`,
        )
        .run(
          new Date(intent.endedWallMs).toISOString(),
          intent.durationMs,
          intent.speechMs,
          storage.finalizedPartCount,
          new Date().toISOString(),
          intent.sessionId,
        );
      this.#finalizations.consumeSessionIfPartFinalized(intent.sessionId, {
        endedAtIso: new Date(intent.endedWallMs).toISOString(),
        durationMs: intent.durationMs,
        speechMs: intent.speechMs,
      });
      this.#enqueueLifecycleStatus(
        intent.sessionId,
        'failed',
        '🔴 Сессию не удалось сохранить: финализация аудио завершилась ошибкой. Аудио не загружаю.',
      );
    });
    this.#options.logger.error('session held because audio finalization is incomplete', {
      sessionId: intent.sessionId,
      attemptedParts: intent.partCount,
      finalizedParts: storage.finalizedPartCount,
      publishedPartPendingDatabase: storage.publishedPartPendingDatabase,
      hasFinalizationBoundary: storage.hasFinalizationBoundary,
      storageDiscarded: storage.storageDiscarded,
    });
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
    if (this.#discardingSessionId === intent.sessionId) return;
    if (this.#reservedFinalizers >= STORAGE_FINALIZER_CAPACITY) {
      this.#discardingSessionId = intent.sessionId;
      this.#preRoll.length = 0;
      this.#options.logger.error('audio storage finalizer capacity exhausted', {
        sessionId: intent.sessionId,
        partIndex: intent.partIndex,
        capacity: STORAGE_FINALIZER_CAPACITY,
      });
      return;
    }

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
    this.#reservedFinalizers += 1;

    let partId: string;
    try {
      partId = this.#parts.open(
        intent.sessionId,
        intent.partIndex,
        finalPath,
        new Date(intent.startedWallMs).toISOString(),
      );
    } catch (error) {
      // The encoder exists but no durable row owns it. Its reserved finalizer
      // reaps it off the capture lane, and the rest of this session is dropped
      // so a later part cannot create a gapped archive manifest.
      this.#discardingSessionId = intent.sessionId;
      this.#preRoll.length = 0;
      this.#options.logger.error('failed to register audio part', {
        sessionId: intent.sessionId,
        partIndex: intent.partIndex,
        error: (error as Error).message,
      });
      this.#trackStorageFinalizer(intent.sessionId, async () => {
        try {
          await writer.abort();
        } catch (cleanupError) {
          this.#options.logger.error('failed to clean up unregistered audio part', {
            sessionId: intent.sessionId,
            partIndex: intent.partIndex,
            error: (cleanupError as Error).message,
          });
        }
      });
      return;
    }

    if (this.#discardingSessionId === intent.sessionId) {
      this.#discardingSessionId = null;
    }

    this.#openPart = {
      partId,
      sessionId: intent.sessionId,
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

  async #closeOpenPart(
    endedWallMs: number,
    endedMonotonicMs: number,
    finalSession?: {
      readonly endedWallMs: number;
      readonly durationMs: number;
      readonly speechMs: number;
    },
  ): Promise<void> {
    const open = this.#openPart;
    if (open === null) return;

    // Duration comes from the monotonic span of the part, so an NTP step
    // mid-recording cannot report a negative or wildly long part.
    const durationMs = Math.max(0, Math.round(endedMonotonicMs - open.startedMonotonicMs));
    const partEndedAtIso = new Date(endedWallMs).toISOString();

    try {
      transaction(this.#options.db, () => {
        this.#finalizations.record({
          partId: open.partId,
          sessionId: open.sessionId,
          partEndedAtIso,
          partDurationMs: durationMs,
          ...(finalSession === undefined
            ? {}
            : {
                finalSession: {
                  endedAtIso: new Date(finalSession.endedWallMs).toISOString(),
                  durationMs: finalSession.durationMs,
                  speechMs: finalSession.speechMs,
                },
              }),
        });
        if (finalSession !== undefined) this.#sessions.advanceToFinalizing(open.sessionId);
      });
    } catch (error) {
      this.#options.logger.error('failed to journal exact audio timing', {
        partId: open.partId,
        error: (error as Error).message,
      });
      this.#openPart = null;
      this.#trackStorageFinalizer(open.sessionId, async () => {
        try {
          await open.writer.abort();
        } catch (cleanupError) {
          this.#options.logger.error('failed to clean up unjournaled audio part', {
            partId: open.partId,
            error: (cleanupError as Error).message,
          });
        }
      });
      return;
    }

    // The exact journal, and FINALIZING for the last part, are durable before
    // ownership leaves the capture lane. The reserved slot then bounds all
    // encoder-close/fsync/hash work while the next frame can be consumed.
    this.#openPart = null;
    this.#trackStorageFinalizer(open.sessionId, () => this.#finalizeDetachedPart(open));
  }

  async #finalizeDetachedPart(open: OpenPart): Promise<void> {
    let finalized: Awaited<ReturnType<PartWriter['close']>>;
    try {
      finalized = await open.writer.close();
    } catch (error) {
      // PartWriter computes its checksum before rename, so a thrown close did
      // not publish an archive and this journal no longer owns future work.
      this.#finalizations.deletePart(open.partId);
      this.#options.logger.error('failed to publish audio part', {
        partId: open.partId,
        error: (error as Error).message,
      });
      try {
        await open.writer.abort();
      } catch (cleanupError) {
        this.#options.logger.error('failed to clean up unpublished audio part', {
          partId: open.partId,
          error: (cleanupError as Error).message,
        });
      }
      return;
    }

    try {
      this.#parts.finalizePartFromJournal(open.partId, finalized.bytes, finalized.sha256);
      this.#options.logger.info('audio part closed', {
        partId: open.partId,
        bytes: finalized.bytes,
        sha256: finalized.sha256,
      });
    } catch (error) {
      // The archive and exact journal are both durable. Startup recovery owns
      // the missing database finalization; abort only removes a temp if present.
      this.#options.logger.error('failed to commit published audio part', {
        partId: open.partId,
        error: (error as Error).message,
      });
      try {
        await open.writer.abort();
      } catch (cleanupError) {
        this.#options.logger.error('failed to clean up published audio temp file', {
          partId: open.partId,
          error: (cleanupError as Error).message,
        });
      }
    }
  }

  #trackStorageFinalizer(sessionId: string, operation: () => Promise<void>): void {
    if (this.#storageFinalizers.size >= STORAGE_FINALIZER_CAPACITY) {
      throw new Error('storage finalizer reservation invariant violated');
    }
    const task = operation().catch((error) => {
      this.#options.logger.error('storage finalizer failed unexpectedly', {
        sessionId,
        error: (error as Error).message,
      });
    });
    this.#storageFinalizers.add(task);
    let sessionTasks = this.#storageFinalizersBySession.get(sessionId);
    if (sessionTasks === undefined) {
      sessionTasks = new Set();
      this.#storageFinalizersBySession.set(sessionId, sessionTasks);
    }
    sessionTasks.add(task);
    void task.then(() => this.#storageFinalizerFinished(sessionId, task));
  }

  #storageFinalizerFinished(sessionId: string, task: Promise<void>): void {
    this.#storageFinalizers.delete(task);
    const sessionTasks = this.#storageFinalizersBySession.get(sessionId);
    sessionTasks?.delete(task);
    if (sessionTasks?.size === 0) this.#storageFinalizersBySession.delete(sessionId);
    this.#reservedFinalizers -= 1;

    void this.#withMutation(async () => {
      this.#settleDeferredSessionOutcome(sessionId);
    }).catch((error) => {
      this.#options.logger.error('failed to settle finalized session', {
        sessionId,
        error: (error as Error).message,
      });
    });
  }

  async #drainStorageFinalizers(): Promise<void> {
    while (this.#storageFinalizers.size > 0) {
      await Promise.all(this.#storageFinalizers);
    }
    await this.#mutationTail;
    await this.#withMutation(async () => {
      for (const sessionId of this.#pendingSessionOutcomes.keys()) {
        this.#settleDeferredSessionOutcome(sessionId);
      }
    });
  }
}
