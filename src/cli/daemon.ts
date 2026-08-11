import { execFile } from 'node:child_process';
import { access, readFile, rm, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { reconcileLanguages } from '../asr/languages.ts';
import {
  AsrPreferenceRepository,
  effectiveAsrLanguage,
  modelLanguageName,
} from '../asr/preferences.ts';
import type { AsrBackend, AsrSegment } from '../asr/types.ts';
import { FfmpegCapture } from '../capture/ffmpeg.ts';
import { normalizeToWav, probeAudio } from '../capture/probe.ts';
import { recoverAfterCrash } from '../capture/recovery.ts';
import type { LoadedConfig } from '../config/load.ts';
import { type Database, openDatabase, transaction } from '../database/db.ts';
import {
  appendIncomingTranscript,
  IncomingFileRepository,
  type IncomingFileRow,
  PartRepository,
  SessionRepository,
  TranscriptRepository,
} from '../database/repository.ts';
import {
  buildDigest,
  hasUnfinishedSessionsForDate,
  hoursSinceLastDigest,
  renderDigest,
  renderDigestMarkdown,
  scheduledDigestDate,
  storeDigest,
  zonedDateTime,
} from '../digest/daily.ts';
import { AlertEvaluator, type AlertId, renderAlert } from '../health/alerts.ts';
import {
  diskFreeGb,
  evaluateHealth,
  recordHealthEvent,
  renderHealthLines,
  sqliteWritable,
} from '../health/monitor.ts';
import { renderSleepMessage, SleepDetector } from '../health/sleep.ts';
import {
  failureCategory,
  renderAsrUnavailableDetail,
  renderDeadJobAlert,
  renderLlmUnavailableDetail,
} from '../jobs/diagnostics.ts';
import { handleJob, markAudioDelivered, reconcileSessionDelivery } from '../jobs/pipeline.ts';
import { type JobKind, JobQueue } from '../jobs/queue.ts';
import type { LlmBackend } from '../llm/ollama.ts';
import type { Logger } from '../logging/logger.ts';
import { applyRetention, planRetention } from '../retention/policy.ts';
import { Recorder } from '../sessionizer/recorder.ts';
import { SileroStreamVad } from '../sessionizer/silero.ts';
import type { Vad } from '../sessionizer/vad.ts';
import {
  isClientShutdown,
  isRetryable,
  type TelegramCallbackQuery,
  TelegramClient,
  type TelegramInlineKeyboardMarkup,
  type TelegramMessage,
} from '../telegram/client.ts';
import { renderTimedTranscriptMessages } from '../telegram/format.ts';
import {
  downloadToQuarantine,
  extractAttachment,
  IncomingRejected,
  rejectionMessage,
  validateProbe,
} from '../telegram/incoming.ts';
import { reconcileIncomingArtifacts } from '../telegram/incoming-recovery.ts';
import { keychainProvider, type SecretsProvider, telegramBotScope } from '../telegram/keychain.ts';
import { drainOutbox, Outbox, type OutboxPayload } from '../telegram/outbox.ts';
import {
  incomingTelegramProvenance,
  renderProvenanceHtml,
  renderProvenancePlain,
} from '../telegram/provenance.ts';
import { HELP_TEXT, renderCaptureFailure, renderStatus } from '../telegram/report.ts';
import {
  markUpdateHandled,
  nextOffsetFor,
  readOffset,
  recordUpdate,
  routeUpdate,
  writeOffset,
} from '../telegram/router.ts';
import {
  asrSettingsKeyboard,
  OPENMURMUR_BOT_COMMANDS,
  parseAsrModeCallback,
  renderAsrSettings,
} from '../telegram/settings.ts';
import { writeTextAtomically } from '../util/atomic-file.ts';
import { createAsrBackend, createLlmBackend, createVadBackend } from './backends.ts';
import { writeDaemonHeartbeat } from './status.ts';
import { VERSION } from './version.ts';

const DIGEST_TICK_INTERVAL_MS = 5 * 60 * 1000;

/** Calls the recorder synchronously before making cleanup runnable. */
export function startRecorderBeforeBackgroundRecovery(
  startRecorder: () => Promise<void>,
  scheduleRecovery: () => void,
): Promise<void> {
  const recorderDone = startRecorder();
  scheduleRecovery();
  return recorderDone;
}

/**
 * The long-running daemon.
 *
 * Independent recorder, job, Telegram and maintenance loops share one SQLite
 * database. Job work is split by stage so delivery, ASR and summarization do
 * not block one another.
 *
 * They are independent on purpose. A wedged model, an offline Telegram or a
 * full outbox slows its own loop and nothing else; the microphone keeps
 * recording.
 */

export interface DaemonOptions {
  readonly loaded: LoadedConfig;
  readonly logger: Logger;
  readonly secrets?: SecretsProvider;
}

export class Daemon {
  readonly #options: DaemonOptions;
  readonly #db: Database;
  readonly #jobs: JobQueue;
  readonly #outbox: Outbox;
  readonly #alerts: AlertEvaluator;
  readonly #recorder: Recorder;
  readonly #capture: FfmpegCapture;
  readonly #vad: Vad;
  readonly #asr: AsrBackend;
  readonly #llm: LlmBackend;

  #client: TelegramClient | null = null;
  #chatId: number | null = null;
  #botScope: string | null = null;
  #asrLanguage: string | null;
  #stopping = false;
  #recorderFailure: string | null = null;
  /** Resolves once `run()` has finalized whatever was open. */
  #recorderDone: Promise<void> | null = null;
  #recorderSettled = true;
  readonly #sleepDetector: SleepDetector;
  #announcedRecording = false;
  readonly #timers: NodeJS.Timeout[] = [];
  readonly #activeTicks = new Set<Promise<void>>();
  readonly #activeOutboxDrains = new Set<Promise<void>>();
  #outboxDrainTail: Promise<void> = Promise.resolve();
  #startupPhaseDone: Promise<void> = Promise.resolve();
  #workersClosePromise: Promise<void> | null = null;
  #storageClosePromise: Promise<void> | null = null;
  #pidClaimed = false;
  #daemonStartedAt: string | null = null;
  #stopPromise: Promise<void> | null = null;
  #nextSecretsRetryAt = 0;
  #telegramUnavailable = false;
  #nextReadinessProbeAt = 0;
  #llmReadiness: { ready: boolean; detail: string } = {
    ready: false,
    detail: 'not probed yet',
  };

  constructor(options: DaemonOptions) {
    this.#options = options;
    const { config, paths } = options.loaded;

    this.#db = openDatabase({
      file: paths.databaseFile,
      onVersionWarning: (message) => options.logger.warn(message),
    });
    this.#asrLanguage = effectiveAsrLanguage(this.#db.handle, config.asr.languageHints);
    this.#jobs = new JobQueue(this.#db.handle);
    this.#outbox = new Outbox(this.#db.handle);
    this.#alerts = new AlertEvaluator(this.#db.handle, {
      cooldownMinutes: config.health.alertCooldownMinutes,
    });
    this.#asr = createAsrBackend(options.loaded, options.logger);
    this.#llm = createLlmBackend(config);

    this.#capture = new FfmpegCapture({
      sampleRate: config.audio.sampleRate,
      channels: config.audio.channels,
      device: config.audio.captureDevice,
      // 512 samples at 16 kHz = 32 ms, the frame size Silero VAD requires.
      frameSamples: 512,
      ffmpegPath: config.audio.ffmpegPath,
      clock: { monotonicMs: () => Number(process.hrtime.bigint() / 1_000_000n), wallMs: Date.now },
    });

    this.#sleepDetector = new SleepDetector({
      clock: {
        monotonicMs: () => Number(process.hrtime.bigint() / 1_000_000n),
        wallMs: Date.now,
      },
    });

    this.#vad = createVadBackend(options.loaded, options.logger, {
      onDegraded: (reason) => {
        void this.#sendNow(
          '🟡 Распознавание речи работает в упрощённом режиме\n\n' +
            'Silero VAD недоступен, сессии временно определяются по громкости: ' +
            'шум может быть принят за речь, а тихая речь — пропущена.\n' +
            `Причина: ${reason.slice(0, 300)}`,
        );
      },
      onRecovered: () => {
        void this.#sendNow('🟢 Определение речи снова работает нормально (Silero VAD)');
      },
    });

    this.#recorder = new Recorder({
      config,
      paths,
      db: this.#db.handle,
      capture: this.#capture,
      vad: this.#vad,
      logger: options.logger.child('recorder'),
      captureHost: hostname(),
      captureTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      onFirstFrame: () => this.#announceRecordingStarted(),
      resolveAsrLanguage: () => this.#asrLanguage,
    });
  }

  async start(): Promise<void> {
    if (this.#stopping) return;
    const { config, paths } = this.#options.loaded;
    const logger = this.#options.logger;

    let finishStartupPhase = () => {};
    this.#startupPhaseDone = new Promise<void>((resolve) => {
      finishStartupPhase = resolve;
    });
    try {
      const identity = await claimDaemonPid(paths.pidFile, paths.root);
      this.#pidClaimed = true;
      this.#daemonStartedAt = identity.startedAt;
      if (this.#stopping) return;
      const staleNoticeCutoff = new Date().toISOString();

      // Reclaim anything a previous crash left half-done before new work starts.
      const recovery = await recoverAfterCrash(this.#db.handle, paths, logger);
      if (
        recovery.orphans.length > 0 ||
        recovery.recoveredPublishedParts.length > 0 ||
        recovery.stalledSessions.length > 0
      ) {
        await this.#sendNow(
          `🟡 Предыдущий запуск завершился некорректно\n\n` +
            `Прерванных записей: ${recovery.orphans.length}\n` +
            `Восстановленных частей: ${recovery.recoveredPublishedParts.length}\n` +
            `Незавершённых сессий: ${recovery.stalledSessions.length}`,
        );
      }
      if (this.#stopping) return;

      const reclaimedJobs = this.#jobs.recoverStaleLeases();
      const reclaimedSends = this.#outbox.recoverSending();
      const retiredStaleNotices = retireStaleNotices(
        this.#db.handle,
        staleNoticeCutoff,
        'superseded by the next daemon startup',
      );
      this.#reconcileDeadAsrSessions();
      this.#reconcileDeadIncomingFiles();
      if (reclaimedJobs > 0 || reclaimedSends > 0 || retiredStaleNotices > 0) {
        logger.info('recovered work from a previous run', {
          reclaimedJobs,
          reclaimedSends,
          retiredStaleNotices,
        });
      }

      // A locked Keychain must not stop the recorder. The independent config
      // loop retries this bounded lookup even in send-only mode, so delivery
      // catches up without restarting once the user unlocks the Mac.
      this.#trackTask('initial Telegram configuration', () =>
        this.#ensureTelegramConfigured(true).then(() => {}),
      );

      this.#loop(
        'delivery-jobs',
        () => this.#tickJobs(['deliver_audio', 'deliver_transcript', 'deliver_report', 'deliver']),
        500,
      );
      this.#loop('asr-jobs', () => this.#tickJobs(['asr', 'incoming_audio']), 1000);
      this.#loop('summary-jobs', () => this.#tickJobs(['summarize']), 1000);
      this.#loop(
        'telegram-config',
        () => this.#ensureTelegramConfigured(false).then(() => {}),
        5000,
      );
      this.#loop('outbox', () => this.#tickOutbox(), 1500);
      if (config.telegram.receiveUpdates) {
        this.#loop('telegram', () => this.#tickTelegram(), config.telegram.pollIntervalMs);
      } else {
        logger.info('Telegram update polling disabled; outbound delivery remains enabled');
      }
      this.#loop('health', () => this.#tickHealth(), config.health.pollIntervalMs);
      this.#loop('sleep', () => this.#tickSleep(), 2000);
      this.#loop('digest', () => this.#tickDigest(), DIGEST_TICK_INTERVAL_MS);
      this.#loop('retention', () => this.#tickRetention(), 60 * 60 * 1000);

      // Creating the ONNX session takes about a second. Paying that on the first
      // frame would queue a second of audio behind it at start-up.
      if (this.#vad instanceof SileroStreamVad) {
        try {
          await this.#vad.warmUp();
          logger.info('speech detection ready', { vad: this.#vad.name });
        } catch (error) {
          logger.warn('could not preload the speech detector', {
            error: (error as Error).message,
          });
        }
      }
    } finally {
      finishStartupPhase();
    }
    if (this.#stopping) return;

    logger.info('daemon started', { pid: process.pid, version: VERSION });

    try {
      this.#recorderSettled = false;
      this.#recorderDone = startRecorderBeforeBackgroundRecovery(
        () => this.#recorder.run(),
        () => {
          this.#trackTask('incoming artifact startup cleanup', () =>
            reconcileIncomingArtifacts(this.#db.handle, paths, logger, { remove: true }).then(
              () => {},
            ),
          );
        },
      ).finally(() => {
        this.#recorderSettled = true;
      });
      await this.#recorderDone;
      // A clean end to the capture stream still means recording stopped.
      if (!this.#stopping) throw new Error('capture stream ended unexpectedly');
    } catch (error) {
      this.#recorderFailure = (error as Error).message;
      logger.error('capture failed', { error: this.#recorderFailure });
      await this.#sendNow(renderCaptureFailure(this.#announcedRecording));
      throw new Error(`capture failed: ${this.#recorderFailure}`, { cause: error });
    }
  }

  async stop(): Promise<void> {
    this.#stopPromise ??= this.#stop();
    return this.#stopPromise;
  }

  async #stop(): Promise<void> {
    this.#stopping = true;
    this.#closeTelegramClient();
    for (const timer of this.#timers) clearInterval(timer);
    await this.#startupPhaseDone;
    // A signal may have arrived before startup installed its intervals.
    for (const timer of this.#timers) clearInterval(timer);

    // `recorder.stop()` only closes the capture device. The recorder then
    // finalizes whatever was open — flushes the encoder, renames the part into
    // the archive, marks the session PROCESSING, queues transcription — and
    // that work must finish before the database closes underneath it.
    // Skipping the wait threw away the recording in progress every time
    // someone stopped the daemon.
    let recorderStopError: unknown;
    try {
      await this.#recorder.stop();
      await this.#awaitRecorderFinalization();
      if (this.#announcedRecording && this.#recorderFailure === null) {
        this.#options.logger.info('recording stopped during daemon shutdown');
      }
    } catch (error) {
      recorderStopError = error;
    }

    await this.#closeWorkers();
    const drained = await this.#waitForInFlight(15_000);
    if (drained) {
      await this.#closeStorage();
    } else {
      this.#options.logger.warn('shutdown deadline reached; deferring database close', {
        activeTicks: this.#activeTicks.size,
        activeOutboxDrains: this.#activeOutboxDrains.size,
        recorderFinalizing: !this.#recorderSettled,
      });
      void this.#finishDeferredCleanup().catch((error: unknown) => {
        this.#options.logger.error('deferred shutdown cleanup failed', {
          error: (error as Error).message,
        });
      });
    }

    if (recorderStopError !== undefined) throw recorderStopError;
  }

  #closeWorkers(): Promise<void> {
    this.#workersClosePromise ??= this.#closeWorkersOnce();
    return this.#workersClosePromise;
  }

  async #closeWorkersOnce(): Promise<void> {
    try {
      await this.#vad.close?.();
    } catch (error) {
      this.#options.logger.warn('could not close the VAD worker cleanly', {
        error: (error as Error).message,
      });
    }
    try {
      await this.#asr.close();
    } catch (error) {
      this.#options.logger.warn('could not close the ASR worker cleanly', {
        error: (error as Error).message,
      });
    }
  }

  #closeStorage(): Promise<void> {
    this.#storageClosePromise ??= this.#closeStorageOnce();
    return this.#storageClosePromise;
  }

  async #closeStorageOnce(): Promise<void> {
    // The ASR close latch prevents new work from restarting the worker. Repeat
    // the close after every tick settles only to keep cleanup idempotent.
    try {
      await this.#asr.close();
    } catch (error) {
      this.#options.logger.warn('could not close the ASR worker cleanly', {
        error: (error as Error).message,
      });
    }
    try {
      if (this.#pidClaimed) {
        await releaseDaemonPid(this.#options.loaded.paths.pidFile, process.pid);
        this.#pidClaimed = false;
        this.#daemonStartedAt = null;
      }
    } finally {
      this.#db.close();
    }
  }

  async #finishDeferredCleanup(): Promise<void> {
    await this.#awaitActiveTicks();
    await this.#closeStorage();
  }

  async #waitForInFlight(timeoutMs: number): Promise<boolean> {
    if (
      this.#activeTicks.size === 0 &&
      this.#activeOutboxDrains.size === 0 &&
      this.#recorderSettled
    ) {
      return true;
    }

    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    });
    const settled = await Promise.race([
      this.#awaitActiveTicks().then(() => true as const),
      timeout,
    ]);
    if (timer !== undefined) clearTimeout(timer);
    return settled;
  }

  /**
   * Waits for the recorder to finish finalizing, but not forever.
   *
   * A wedged encoder must not leave the daemon unkillable: launchd sends
   * SIGKILL if SIGTERM is not honoured, and being killed mid-write is worse
   * than giving up on the last part. Crash recovery handles what is left.
   */
  async #awaitRecorderFinalization(timeoutMs = 30_000): Promise<void> {
    const done = this.#recorderDone;
    if (done === null) return;

    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), timeoutMs);
    });

    const outcome = await Promise.race([
      done.then(() => 'done' as const).catch(() => 'done'),
      deadline,
    ]);
    if (timer !== undefined) clearTimeout(timer);
    if (outcome === 'timeout') {
      this.#options.logger.warn('gave up waiting for the recorder to finalize', { timeoutMs });
    }
  }

  /**
   * Announces recording only once the microphone has actually produced audio.
   * Sending this at process start would claim a working recorder before macOS
   * had even granted the TCC permission.
   */
  #announceRecordingStarted(): void {
    if (this.#announcedRecording) return;
    this.#announcedRecording = true;
    this.#options.logger.info('first audio frame received');
    void this.#sendNow('🟢 Запись включена');
  }

  #loop(name: string, tick: () => Promise<void>, intervalMs: number): void {
    let running = false;
    const timer = setInterval(() => {
      if (running || this.#stopping) return;
      running = true;
      this.#trackTask(name, tick, () => {
        running = false;
      });
    }, intervalMs);
    timer.unref();
    this.#timers.push(timer);
  }

  #trackTask(name: string, task: () => Promise<void>, onSettled?: () => void): void {
    const tracked = Promise.resolve()
      .then(task)
      .catch((error: unknown) => {
        this.#options.logger.error(`${name} loop failed`, { error: (error as Error).message });
      })
      .finally(() => {
        this.#activeTicks.delete(tracked);
        onSettled?.();
      });
    this.#activeTicks.add(tracked);
  }

  async #awaitActiveTicks(): Promise<void> {
    while (
      this.#activeTicks.size > 0 ||
      this.#activeOutboxDrains.size > 0 ||
      !this.#recorderSettled
    ) {
      const recorderDone = this.#recorderDone;
      await Promise.allSettled([
        ...this.#activeTicks,
        ...this.#activeOutboxDrains,
        ...(recorderDone === null || this.#recorderSettled ? [] : [recorderDone]),
      ]);
    }
  }

  async #tickJobs(kinds: readonly JobKind[]): Promise<void> {
    this.#jobs.recoverStaleLeases();
    const job = this.#jobs.claim(kinds);
    if (job === null) return;

    try {
      if (job.kind === 'incoming_audio') await this.#handleIncomingJob(job.payload);
      else {
        await handleJob(
          {
            db: this.#db.handle,
            config: this.#options.loaded.config,
            paths: this.#options.loaded.paths,
            asr: this.#asr,
            llm: this.#llm,
            jobs: this.#jobs,
            logger: this.#options.logger,
          },
          job,
        );
      }
      this.#jobs.complete(job.jobId);
    } catch (error) {
      if (this.#stopping) {
        this.#releaseInterruptedJob(job.jobId, error);
        return;
      }
      const outcome = this.#jobs.fail(job.jobId, (error as Error).message);
      if (job.kind === 'asr' && outcome === 'dead') {
        markExhaustedAsrSession(this.#db.handle, job.payload);
      }
      if (job.kind === 'incoming_audio' && outcome === 'dead') {
        markExhaustedIncomingFile(this.#db.handle, job.payload);
      }
      this.#options.logger.warn('job failed', {
        kind: job.kind,
        outcome,
        attempts: job.attempts,
        error: (error as Error).message,
      });
    }
  }

  #releaseInterruptedJob(jobId: string, error: unknown): void {
    releaseInterruptedJob(this.#db.handle, jobId, error);
    this.#options.logger.info('released a job interrupted by daemon shutdown', { jobId });
  }

  async #tickOutbox(): Promise<void> {
    const drain = this.#outboxDrainTail.then(() => this.#drainOutbox());
    this.#activeOutboxDrains.add(drain);
    this.#outboxDrainTail = drain
      .catch(() => {})
      .finally(() => this.#activeOutboxDrains.delete(drain));
    return drain;
  }

  async #drainOutbox(): Promise<void> {
    const client = this.#client;
    const chatId = this.#chatId;
    if (client === null || chatId === null) return;

    await drainOutbox({
      outbox: this.#outbox,
      client,
      chatId,
      logger: this.#options.logger.child('outbox'),
      maxOutgoingBytes: this.#options.loaded.config.telegram.maxOutgoingBytes,
      onDelivered: ({ deliveryPartId, sessionId: linkedSessionId, payload }) => {
        if (payload.type === 'document' && payload.partId !== undefined) {
          markAudioDelivered(this.#db.handle, payload.partId);
        }
        const sessionId = linkedSessionId ?? sessionIdFromDeliveryPart(deliveryPartId);
        if (sessionId !== null) {
          reconcileSessionDelivery(this.#db.handle, sessionId, this.#options.logger);
        }
        const incomingFileUid = incomingFileUidFromDeliveryPart(deliveryPartId);
        if (incomingFileUid !== null) {
          reconcileIncomingDelivery(this.#db.handle, incomingFileUid);
        }
      },
    });
  }

  async #tickTelegram(): Promise<void> {
    if (!(await this.#ensureTelegramConfigured(false))) return;
    const client = this.#client;
    const chatId = this.#chatId;
    const botScope = this.#botScope;
    if (client === null || chatId === null || botScope === null) return;

    const offset = readOffset(this.#db.handle, botScope);
    let updates: Awaited<ReturnType<TelegramClient['getUpdates']>>;
    try {
      updates = await client.getUpdates(
        offset,
        this.#options.loaded.config.telegram.longPollSeconds,
      );
    } catch (error) {
      if (this.#stopping && isClientShutdown(error)) return;
      throw error;
    }
    if (updates.length === 0) return;

    for (const update of updates) {
      const action = routeUpdate(update, chatId);
      // An unhandled row is replayed after a crash. Every durable side effect
      // below has an update-based idempotency key, so replay completes missing
      // work instead of duplicating it.
      if (!recordUpdate(this.#db.handle, update.update_id, action.kind, botScope)) continue;

      switch (action.kind) {
        case 'ignore':
          break;
        case 'command':
          await this.#handleCommand(action.command, update.update_id);
          break;
        case 'callback':
          await this.#handleCallback(action.query);
          break;
        case 'unknown_command':
          this.#enqueueText(
            `Неизвестная команда. ${HELP_TEXT}`,
            scopedUpdateKey('cmd', botScope, update.update_id),
            'HTML',
          );
          break;
        case 'audio':
          enqueueIncomingRequest(
            this.#db.handle,
            update.update_id,
            action.message,
            hostname(),
            botScope,
            this.#asrLanguage,
          );
          continue;
        case 'text':
          break;
      }
      markUpdateHandled(this.#db.handle, update.update_id, botScope);
    }
    writeOffset(this.#db.handle, nextOffsetFor(updates, offset), botScope);
  }

  async #handleCommand(
    command: '/status' | '/health' | '/help' | '/start' | '/settings',
    updateId: number,
  ): Promise<void> {
    const botScope = this.#botScope ?? 'legacy';
    if (command === '/help' || command === '/start') {
      this.#enqueueText(HELP_TEXT, scopedUpdateKey('help', botScope, updateId), 'HTML');
      return;
    }
    if (command === '/settings') {
      const language = this.#asrLanguage;
      this.#enqueueText(
        renderAsrSettings(hostname(), language),
        scopedUpdateKey('settings', botScope, updateId),
        'HTML',
        asrSettingsKeyboard(language),
      );
      return;
    }
    if (command === '/health') {
      const report = evaluateHealth(
        await this.#collectHealth(),
        this.#options.loaded.config.health,
      );
      this.#enqueueText(
        renderHealthLines(report),
        scopedUpdateKey('health', botScope, updateId),
        undefined,
      );
      return;
    }

    const parts = new PartRepository(this.#db.handle);
    const lastPart = parts.lastFinalized();
    const snapshot = this.#recorder.snapshot();
    const lastDelivery = this.#outbox.lastDeliveryAt();

    this.#enqueueText(
      renderStatus({
        hostName: hostname(),
        recording: this.#recorder.running && this.#recorderFailure === null,
        lastFrameSecondsAgo:
          this.#capture.msSinceLastFrame() === null
            ? null
            : (this.#capture.msSinceLastFrame() ?? 0) / 1000,
        processingLagSeconds:
          this.#capture.processingLagMs() === null
            ? null
            : (this.#capture.processingLagMs() ?? 0) / 1000,
        sessionState: snapshot.state,
        sessionElapsedMs:
          snapshot.sessionStartedMonotonicMs === null
            ? null
            : Number(process.hrtime.bigint() / 1_000_000n) - snapshot.sessionStartedMonotonicMs,
        lastClosedPartMinutesAgo:
          lastPart?.ended_at == null ? null : (Date.now() - Date.parse(lastPart.ended_at)) / 60_000,
        asrBacklog: this.#jobs.pendingCount('asr'),
        failedJobs: this.#jobs.deadCount(),
        outboxPending: this.#outbox.pendingCount(),
        failedOutbox: this.#outbox.deadCount(),
        lastDeliveryMinutesAgo:
          lastDelivery === null ? null : (Date.now() - Date.parse(lastDelivery)) / 60_000,
        diskFreeGb: await diskFreeGb(this.#options.loaded.paths.root),
        asrStatus: `${this.#options.loaded.config.asr.model} (${this.#options.loaded.config.asr.backend})`,
        llmStatus: `${this.#options.loaded.config.llm.model} (${this.#options.loaded.config.llm.backend})`,
        version: VERSION,
      }),
      scopedUpdateKey('status', botScope, updateId),
      'HTML',
    );
  }

  async #handleCallback(query: TelegramCallbackQuery): Promise<void> {
    const selected = parseAsrModeCallback(query.data);
    const message = query.message;
    if (selected === undefined || message === undefined) {
      try {
        await this.#client?.answerCallbackQuery(query.id, 'Эта кнопка больше не поддерживается');
      } catch (error) {
        if (isRetryable(error)) throw error;
        this.#options.logger.warn('could not acknowledge an obsolete Telegram callback', {
          error: (error as Error).message,
        });
      }
      return;
    }

    new AsrPreferenceRepository(this.#db.handle).set(selected.language);
    const language = selected.language === null ? null : modelLanguageName(selected.language);
    this.#asrLanguage = language;
    const client = this.#client;
    if (client === null) throw new Error('Telegram is not configured');

    try {
      await client.answerCallbackQuery(query.id, 'Сохранено для следующих расшифровок');
      if (selected.origin === 'settings') {
        await client.editMessageText(
          message.chat.id,
          message.message_id,
          renderAsrSettings(hostname(), language),
          { parseMode: 'HTML', replyMarkup: asrSettingsKeyboard(language) },
        );
      } else {
        await client.editMessageReplyMarkup(
          message.chat.id,
          message.message_id,
          asrSettingsKeyboard(language, 'transcript'),
        );
      }
    } catch (error) {
      if (isRetryable(error)) throw error;
      // The preference is already durable. An old/deleted message must not
      // pin getUpdates forever merely because its keyboard can no longer edit.
      this.#options.logger.warn('ASR preference saved but its Telegram panel could not update', {
        error: (error as Error).message,
      });
    }
  }

  async #handleIncomingJob(payload: Record<string, unknown>): Promise<void> {
    const client = this.#client;
    if (client === null) throw new Error('Telegram is not configured');
    const { config, paths } = this.#options.loaded;

    const message = payload['message'] as Parameters<typeof extractAttachment>[0];
    const attachment = extractAttachment(message);
    if (attachment === null) return;

    const incomingFiles = new IncomingFileRepository(this.#db.handle);
    const payloadBotScope = payload['botScope'];
    const botScope = typeof payloadBotScope === 'string' ? payloadBotScope : 'legacy';
    const payloadFileUid = payload['fileUid'];
    let incoming =
      typeof payloadFileUid === 'string'
        ? incomingFiles.get(payloadFileUid)
        : findIncomingFile(this.#db.handle, attachment.fileUniqueId, botScope);
    if (incoming === undefined) {
      const updateId = payload['updateId'];
      if (typeof updateId !== 'number') throw new Error('incoming audio has no update identity');
      const claimed = claimIncomingRequest(
        this.#db.handle,
        updateId,
        message,
        hostname(),
        botScope,
      );
      if (claimed === null) throw new Error('incoming audio payload has no supported attachment');
      incoming = claimed;
    }

    try {
      if (incoming.state === 'rejected') return;

      const storedTranscript = currentIncomingTranscript(this.#db.handle, incoming.fileUid);
      if (storedTranscript !== undefined) {
        markIncomingTranscribed(this.#db.handle, incoming.fileUid);
        this.#enqueueIncomingTranscript(
          incoming,
          storedTranscript.text,
          storedTranscript.segments,
          storedTranscript.languages,
          storedTranscript.forcedLanguage,
        );
        return;
      }

      if (incoming.quarantinePath === null || !(await pathExists(incoming.quarantinePath))) {
        const downloaded = await downloadToQuarantine(
          client,
          attachment,
          paths.quarantineDir,
          {
            maxIncomingBytes: config.telegram.maxIncomingBytes,
            maxDurationSeconds: config.telegram.maxIncomingDurationSeconds,
          },
          incoming.fileUid,
        );
        incomingFiles.markDownloaded(incoming.fileUid, downloaded.path, downloaded.actualBytes);
        incoming = incomingFiles.get(incoming.fileUid);
        if (incoming === undefined) throw new Error('incoming audio disappeared after download');
      }

      const quarantinePath = incoming.quarantinePath;
      if (quarantinePath === null) throw new Error('incoming audio has no quarantine path');

      const probe = validateProbe(await probeAudio(config.audio.ffprobePath, quarantinePath), {
        maxIncomingBytes: config.telegram.maxIncomingBytes,
        maxDurationSeconds: config.telegram.maxIncomingDurationSeconds,
      });

      incomingFiles.reserveNormalizedPath(
        incoming.fileUid,
        join(paths.quarantineDir, `${incoming.fileUid}.16k.wav`),
      );
      incoming = incomingFiles.get(incoming.fileUid);
      if (incoming === undefined)
        throw new Error('incoming audio disappeared before normalization');

      const wavPath = await ensureIncomingWav(
        config.audio.ffmpegPath,
        config.audio.ffprobePath,
        quarantinePath,
        incoming,
      );
      incomingFiles.markNormalized(
        incoming.fileUid,
        wavPath,
        probe.formatName,
        Math.round(probe.durationSeconds * 1000),
      );

      const forcedLanguage = forcedLanguageFromPayload(payload, this.#asrLanguage);
      const result = await this.#asr.transcribe({
        audioPath: wavPath,
        requestId: incoming.fileUid,
        ...(forcedLanguage === null ? {} : { languageHints: [forcedLanguage] }),
        ...(config.asr.context.length > 0 ? { context: config.asr.context } : {}),
      });
      const reconciledLanguages = reconcileLanguages(result.languages, result.text).languages;
      const transcriptIncoming = incoming;

      appendIncomingTranscript(
        this.#db.handle,
        {
          incomingFileId: incoming.fileUid,
          engine: result.engine,
          model: result.model,
          languages: reconciledLanguages,
          forcedLanguage,
          text: result.text,
          segments: result.segments.map((s) => ({
            startMs: s.startMs,
            endMs: s.endMs,
            timestampSource: s.timestampSource,
            language: s.language,
            text: s.text,
          })),
        },
        () => {
          this.#enqueueIncomingTranscript(
            transcriptIncoming,
            result.text,
            result.segments,
            reconciledLanguages,
            forcedLanguage,
          );
        },
      );
    } catch (error) {
      // The only undefined assignment above is a failed reload after download;
      // there is then no durable row whose state can truthfully be changed.
      if (incoming === undefined) throw error;
      if (error instanceof IncomingRejected) {
        this.#options.logger.info('incoming Telegram media rejected', {
          fileUid: incoming.fileUid,
          reason: error.reason,
          detail: error.message,
        });
        this.#enqueueText(
          `${rejectionMessage(error.reason, {
            maxIncomingBytes: config.telegram.maxIncomingBytes,
            maxDurationSeconds: config.telegram.maxIncomingDurationSeconds,
          })}\n\n${renderProvenancePlain(incomingTelegramProvenance(incoming))}`.trim(),
          `reject:${attachment.fileUniqueId}`,
        );
        this.#db.handle
          .prepare(
            `UPDATE incoming_telegram_files SET state = 'rejected', rejection_reason = ?,
                    updated_at = ? WHERE file_uid = ?`,
          )
          .run(error.reason, new Date().toISOString(), incoming.fileUid);
        return;
      }
      incomingFiles.markFailedIfUntranscribed(incoming.fileUid);
      throw error;
    }
  }

  #enqueueIncomingTranscript(
    incoming: IncomingFileRow,
    text: string,
    segments: readonly AsrSegment[],
    languages: readonly string[],
    forcedLanguage: string | null,
  ): void {
    const fileUid = incoming.fileUid;
    for (const chunk of renderTimedTranscriptMessages(
      fileUid,
      segments,
      text.length > 0 ? text : '(речь не распознана)',
      this.#options.loaded.config.telegram.transcriptInlineLimit,
      renderProvenanceHtml(incomingTelegramProvenance(incoming)),
      { languages, forcedLanguage, showSettingsHint: true },
    )) {
      this.#outbox.enqueue({
        deliveryPartId: `incoming:${fileUid}:${chunk.partNumber}`,
        kind: 'incoming_transcript',
        ordinal: 10,
        payload: {
          type: 'text',
          text: chunk.text,
          parseMode: 'HTML',
          ...(chunk.partNumber === chunk.partCount
            ? {
                replyMarkup: asrSettingsKeyboard(this.#asrLanguage, 'transcript'),
              }
            : {}),
        },
      });
    }
  }

  async #collectHealth() {
    const { config, paths } = this.#options.loaded;
    await this.#probeLlmReadiness();
    const asrHealth = this.#asr.health();
    const parts = new PartRepository(this.#db.handle);
    const lastPart = parts.lastFinalized();
    const snapshot = this.#recorder.snapshot();
    const deadJobs = this.#jobs.deadJobs();

    return {
      recorderRunning: this.#recorder.running && this.#recorderFailure === null,
      msSinceLastFrame: this.#capture.msSinceLastFrame(),
      processingLagMs: this.#capture.processingLagMs(),
      minutesSinceLastClosedPart:
        lastPart?.ended_at == null ? null : (Date.now() - Date.parse(lastPart.ended_at)) / 60_000,
      workerReady: asrHealth.ok,
      workerDetail: asrHealth.ok ? asrHealth.detail : asrHealth.reason,
      ollamaReady: this.#llmReadiness.ready,
      ollamaDetail: this.#llmReadiness.detail,
      activeSessionMs: snapshot.sessionStartedMonotonicMs,
      asrBacklogMinutes: this.#jobs.oldestPendingAgeMinutes('asr'),
      deadJobs: deadJobs.length,
      deadJobAlert: renderDeadJobAlert(hostname(), deadJobs, config.llm.model),
      outboxAgeMinutes: this.#outbox.oldestPendingAgeMinutes(),
      deadOutbox: this.#outbox.deadCount(),
      diskFreeGb: await diskFreeGb(paths.root),
      sqliteWritable: sqliteWritable(this.#db.handle),
      hoursSinceLastDigest: config.digest.enabled ? hoursSinceLastDigest(this.#db.handle) : null,
      digestExpectedMissing: expectedDigestIsMissing(
        this.#db.handle,
        Date.now(),
        config.digest,
        DIGEST_TICK_INTERVAL_MS + config.health.pollIntervalMs,
      ),
    };
  }

  /**
   * Detects that the Mac was asleep and closes any session that would
   * otherwise appear to span the gap.
   */
  async #tickSleep(): Promise<void> {
    const event = this.#sleepDetector.poll();
    if (event === null) return;

    this.#options.logger.warn('detected a sleep gap', { sleptMs: event.sleptMs });
    const closed = await this.#recorder.closeOpenSession('machine slept');

    await this.#sendNow(renderSleepMessage(event));
    if (closed !== null) {
      this.#options.logger.info('closed a session that spanned the sleep gap', {
        sessionId: closed,
      });
    }
  }

  async #tickHealth(): Promise<void> {
    this.#writeHeartbeat();
    const inputs = await this.#collectHealth();
    const config = this.#options.loaded.config;
    const report = evaluateHealth(inputs, config.health);

    for (const check of report.checks) {
      if (check.status !== 'healthy') recordHealthEvent(this.#db.handle, check);
    }

    const conditions: {
      id: AlertId;
      active: boolean;
      detail: string;
      fingerprint?: string;
    }[] = [
      {
        id: 'recorder_stale',
        active:
          !inputs.recorderRunning ||
          (inputs.msSinceLastFrame ?? 0) > config.health.recorderStaleSeconds * 1000,
        detail:
          inputs.msSinceLastFrame === null
            ? 'нет аудио с момента запуска'
            : `нет аудио ${Math.round((inputs.msSinceLastFrame ?? 0) / 1000)} сек`,
      },
      {
        id: 'worker_crashed',
        active: !inputs.workerReady,
        detail: renderAsrUnavailableDetail(hostname(), inputs.workerDetail),
        fingerprint: inputs.workerReady ? '' : `asr:${failureCategory(inputs.workerDetail)}`,
      },
      {
        id: 'llm_unavailable',
        active: !inputs.ollamaReady,
        detail: renderLlmUnavailableDetail(hostname(), inputs.ollamaDetail, config.llm.model),
        fingerprint: inputs.ollamaReady
          ? ''
          : `ollama:${config.llm.model}:${failureCategory(inputs.ollamaDetail)}`,
      },
      {
        id: 'disk_low',
        active: inputs.diskFreeGb < config.health.diskFreeWarnGb,
        detail: `свободно ${inputs.diskFreeGb.toFixed(0)} GB`,
      },
      {
        id: 'asr_backlog',
        active: inputs.asrBacklogMinutes > config.health.asrBacklogMinutes,
        detail: `старейшая задача ${Math.round(inputs.asrBacklogMinutes)} мин`,
      },
      {
        id: 'dead_jobs',
        active: inputs.deadJobAlert.active,
        detail: inputs.deadJobAlert.detail,
        fingerprint: inputs.deadJobAlert.fingerprint,
      },
      {
        id: 'telegram_delivery',
        active: inputs.outboxAgeMinutes > config.health.outboxStaleMinutes || inputs.deadOutbox > 0,
        detail:
          inputs.deadOutbox > 0
            ? `сообщений с исчерпанными попытками: ${inputs.deadOutbox}`
            : `старейшее сообщение ${Math.round(inputs.outboxAgeMinutes)} мин`,
      },
      {
        id: 'digest_missing',
        active:
          config.digest.enabled &&
          (inputs.digestExpectedMissing ||
            (inputs.hoursSinceLastDigest !== null && inputs.hoursSinceLastDigest > 26)),
        detail: inputs.digestExpectedMissing
          ? 'ожидаемый дайджест не сформирован'
          : inputs.hoursSinceLastDigest === null
            ? 'дайджест ещё не формировался'
            : `последний дайджест ${Math.round(inputs.hoursSinceLastDigest)} ч назад`,
      },
    ];

    for (const condition of conditions) {
      this.#processHealthAlert(condition);
    }
  }

  #writeHeartbeat(): void {
    const daemonStartedAt = this.#daemonStartedAt;
    if (daemonStartedAt === null) return;
    const snapshot = this.#recorder.snapshot();
    writeDaemonHeartbeat(this.#db.handle, {
      daemonPid: process.pid,
      daemonStartedAt,
      recorderRunning: this.#recorder.running && this.#recorderFailure === null,
      sessionState: snapshot.state,
      lastSourceFrameAgeMs: this.#capture.msSinceLastFrame(),
      processingLagMs: this.#capture.processingLagMs(),
      updatedAt: new Date().toISOString(),
    });
  }

  #processHealthAlert(condition: {
    id: AlertId;
    active: boolean;
    detail: string;
    fingerprint?: string;
  }): void {
    if (condition.id === 'telegram_delivery' && condition.active) {
      retirePendingAlertDeliveries(
        this.#db.handle,
        condition.id,
        'Telegram delivery alerts stay local while delivery is delayed',
      );
    }
    this.#alerts.evaluate(condition.id, condition.active, condition.fingerprint, (decision) => {
      if (decision.transition === 'none') return;
      if (!shouldEnqueueHealthAlert(condition.id, decision.transition)) {
        this.#options.logger.warn('Telegram delivery is delayed; alert kept local', {
          detail: condition.detail,
        });
        return;
      }
      const alert = renderAlert(
        condition.id,
        decision.transition,
        condition.active ? condition.detail : '',
        Date.now(),
      );
      retirePendingAlertDeliveries(
        this.#db.handle,
        condition.id,
        `superseded by ${decision.transition} alert state`,
      );
      this.#outbox.enqueue({
        deliveryPartId: alert.deliveryPartId,
        kind: 'alert',
        ordinal: 5,
        payload: { type: 'text', text: alert.text },
      });
    });
  }

  async #tickDigest(): Promise<void> {
    const { config } = this.#options.loaded;
    const digestLogger = this.#options.logger.child('digest');
    if (!config.digest.enabled) {
      digestLogger.debug('digest scheduler skipped because it is disabled');
      return;
    }

    const date = scheduledDigestDate(Date.now(), config.digest);
    if (date === null) {
      digestLogger.debug('digest scheduler skipped because no date is due', {
        atLocalTime: config.digest.atLocalTime,
        timezone: config.digest.timezone,
      });
      return;
    }
    const existing = this.#db.handle
      .prepare('SELECT 1 AS present FROM digests WHERE digest_date = ?')
      .get(date);
    if (existing !== undefined) {
      digestLogger.debug('digest already exists', { date });
      return;
    }
    if (hasUnfinishedSessionsForDate(this.#db.handle, date, config.digest.timezone)) {
      digestLogger.info('digest scheduler waiting for unfinished sessions', {
        date,
        timezone: config.digest.timezone,
      });
      return;
    }

    const digest = buildDigest(this.#db.handle, date, config.digest.timezone);
    const rendered = renderDigest(digest, config.digest.timezone);
    let payload: OutboxPayload = { type: 'text', text: rendered, parseMode: 'HTML' };
    if (rendered.length > config.telegram.transcriptInlineLimit) {
      const filename = `digest-${date}.md`;
      const path = join(this.#options.loaded.paths.transcriptsDir, filename);
      await writeTextAtomically(path, renderDigestMarkdown(digest, config.digest.timezone));
      payload = { type: 'document', path, filename, caption: `📅 Дайджест за ${date}` };
    }
    transaction(this.#db.handle, () => {
      storeDigest(this.#db.handle, digest);
      this.#outbox.enqueue({
        deliveryPartId: `digest:${date}`,
        kind: 'digest',
        ordinal: 30,
        payload,
      });
    });
    digestLogger.info('digest stored and enqueued', {
      date,
      sessionCount: digest.sessionCount,
      speechMs: digest.totalSpeechMs,
      payloadType: payload.type,
    });
  }

  async #tickRetention(): Promise<void> {
    const plan = planRetention(this.#db.handle, this.#options.loaded.config.retention);
    if (plan.candidates.length === 0) return;

    const result = await applyRetention(this.#db.handle, plan);
    this.#options.logger.info('scheduled retention applied', {
      eligible: plan.candidates.length,
      deleted: result.deleted,
      freedBytes: result.freedBytes,
      errors: result.errors.length,
    });
    for (const error of result.errors) {
      this.#options.logger.error('scheduled retention could not delete a proven candidate', error);
    }
  }

  #enqueueText(
    text: string,
    key: string,
    parseMode?: 'HTML',
    replyMarkup?: TelegramInlineKeyboardMarkup,
  ): void {
    const payload: OutboxPayload = {
      type: 'text',
      text,
      ...(parseMode === undefined ? {} : { parseMode }),
      ...(replyMarkup === undefined ? {} : { replyMarkup }),
    };
    this.#outbox.enqueue({
      deliveryPartId: key,
      kind: 'status',
      ordinal: 1,
      payload,
    });
  }

  async #ensureTelegramConfigured(force: boolean): Promise<boolean> {
    if (this.#stopping) return false;
    if (this.#client !== null && this.#chatId !== null) return true;
    if (!force && Date.now() < this.#nextSecretsRetryAt) return false;
    this.#nextSecretsRetryAt = Date.now() + 60_000;

    try {
      const secrets = await (this.#options.secrets ?? keychainProvider).load();
      if (this.#stopping) return false;
      if (secrets === null) {
        if (!this.#telegramUnavailable) {
          this.#options.logger.warn(
            'Telegram is not configured; run `pnpm openmurmur setup telegram` from the repository checkout',
          );
        }
        this.#telegramUnavailable = true;
        return false;
      }

      const client = new TelegramClient({
        token: secrets.token,
        baseUrl: this.#options.loaded.config.telegram.apiBaseUrl,
      });
      this.#client = client;
      this.#chatId = secrets.chatId;
      this.#botScope = telegramBotScope(secrets.token);
      try {
        await client.setMyCommands(OPENMURMUR_BOT_COMMANDS);
      } catch (error) {
        this.#options.logger.warn('could not refresh the Telegram command menu', {
          error: (error as Error).message,
        });
      }
      if (this.#telegramUnavailable) {
        this.#enqueueText(
          '🟢 Доступ к Telegram восстановлен — отправляю накопленные сообщения.',
          `notice:telegram-access-recovered:${Date.now()}`,
        );
      }
      this.#telegramUnavailable = false;
      return true;
    } catch (error) {
      if (!this.#telegramUnavailable) {
        this.#options.logger.error('could not read the Telegram secrets; recording anyway', {
          error: (error as Error).message,
        });
      }
      this.#telegramUnavailable = true;
      return false;
    }
  }

  async #probeLlmReadiness(): Promise<void> {
    if (Date.now() < this.#nextReadinessProbeAt) return;
    this.#nextReadinessProbeAt = Date.now() + 60_000;

    const llm = await this.#llm
      .ready()
      .catch((error: unknown) => ({ ok: false as const, reason: (error as Error).message }));
    this.#llmReadiness = llm.ok
      ? { ready: true, detail: `${this.#llm.name}:${llm.model}` }
      : { ready: false, detail: llm.reason };
  }

  /** Enqueues a status and immediately requests a serialized outbox drain. */
  async #sendNow(text: string): Promise<void> {
    this.#enqueueText(text, `notice:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`);
    await this.#tickOutbox().catch(() => {});
  }

  #closeTelegramClient(): void {
    const client = this.#client;
    this.#client = null;
    this.#chatId = null;
    this.#botScope = null;
    client?.close();
  }

  #reconcileDeadAsrSessions(): void {
    const rows = this.#db.handle
      .prepare("SELECT payload FROM jobs WHERE kind = 'asr' AND state = 'dead'")
      .all() as { payload: string }[];
    for (const row of rows) {
      try {
        markExhaustedAsrSession(
          this.#db.handle,
          JSON.parse(row.payload) as Record<string, unknown>,
        );
      } catch (error) {
        this.#options.logger.warn('could not reconcile an exhausted ASR job', {
          error: (error as Error).message,
        });
      }
    }
  }

  #reconcileDeadIncomingFiles(): void {
    const rows = this.#db.handle
      .prepare("SELECT payload FROM jobs WHERE kind = 'incoming_audio' AND state = 'dead'")
      .all() as { payload: string }[];
    for (const row of rows) {
      try {
        markExhaustedIncomingFile(
          this.#db.handle,
          JSON.parse(row.payload) as Record<string, unknown>,
        );
      } catch (error) {
        this.#options.logger.warn('could not reconcile an exhausted incoming audio job', {
          error: (error as Error).message,
        });
      }
    }
  }
}

export function releaseInterruptedJob(db: Database['handle'], jobId: string, error: unknown): void {
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE jobs
        SET state = 'pending', attempts = MAX(0, attempts - 1), run_after = ?,
            last_error = ?, lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
      WHERE job_id = ? AND state = 'leased'`,
  ).run(now, `daemon shutdown: ${(error as Error).message}`.slice(0, 2000), now, jobId);
}

export function retireStaleNotices(
  db: Database['handle'],
  beforeIso: string,
  reason = 'superseded operational notice',
): number {
  const now = new Date().toISOString();
  const result = db
    .prepare(
      `UPDATE telegram_outbox
          SET state = 'failed', last_error = ?, updated_at = ?
        WHERE delivery_part_id GLOB 'notice:*'
          AND state IN ('pending','sending')
          AND created_at < ?`,
    )
    .run(reason.slice(0, 2000), now, beforeIso);
  return Number(result.changes);
}

export function retirePendingAlertDeliveries(
  db: Database['handle'],
  alertId: AlertId,
  reason = 'superseded alert notification',
): number {
  const now = new Date().toISOString();
  const result = db
    .prepare(
      `UPDATE telegram_outbox
          SET state = 'failed', last_error = ?, updated_at = ?
        WHERE kind = 'alert' AND state = 'pending'
          AND delivery_part_id GLOB ?`,
    )
    .run(reason.slice(0, 2000), now, `alert:${alertId}:*`);
  return Number(result.changes);
}

export function shouldEnqueueHealthAlert(
  alertId: AlertId,
  transition: 'raised' | 'cleared' | 'changed' | 'repeated',
): boolean {
  // An outage cannot report itself through the unavailable channel. Queueing
  // the warning only makes a stale warning arrive after recovery and can grow
  // the very backlog it describes. The recovery edge remains useful.
  return alertId !== 'telegram_delivery' || transition === 'cleared';
}

export function markExhaustedAsrSession(
  db: Database['handle'],
  payload: Record<string, unknown>,
): boolean {
  const sessionId = payload['sessionId'];
  if (typeof sessionId !== 'string' || sessionId.length === 0) return false;

  return transaction(db, () => {
    const row = db
      .prepare('SELECT state FROM audio_sessions WHERE session_id = ?')
      .get(sessionId) as { state: string } | undefined;
    if (row === undefined || row.state === 'DONE' || row.state === 'REJECTED') return false;

    db.prepare(
      `UPDATE audio_sessions
          SET state = 'FAILED', rejection_reason = 'asr_failed', updated_at = ?
        WHERE session_id = ?`,
    ).run(new Date().toISOString(), sessionId);
    new Outbox(db).enqueue({
      deliveryPartId: `session-status:asr-failed:${sessionId}`,
      kind: 'status',
      sessionId,
      ordinal: 15,
      payload: {
        type: 'text',
        text: '🔴 Не удалось расшифровать сессию после нескольких попыток. Аудио сохранено.',
      },
    });
    return true;
  });
}

/**
 * Turns a permanently failed incoming-audio job into one bounded chat notice.
 * The retry error remains in jobs.last_error and the local log; it never
 * becomes user-visible Telegram copy.
 */
export function markExhaustedIncomingFile(
  db: Database['handle'],
  payload: Record<string, unknown>,
): boolean {
  const fileUid = payload['fileUid'];
  if (typeof fileUid !== 'string' || fileUid.length === 0) return false;

  return transaction(db, () => {
    const incoming = new IncomingFileRepository(db).get(fileUid);
    if (
      incoming === undefined ||
      incoming.state === 'delivered' ||
      incoming.state === 'transcribed' ||
      incoming.state === 'rejected'
    ) {
      return false;
    }

    db.prepare(
      `UPDATE incoming_telegram_files
          SET state = 'failed', rejection_reason = COALESCE(rejection_reason, 'processing_failed'),
              updated_at = ?
        WHERE file_uid = ?`,
    ).run(new Date().toISOString(), fileUid);
    new Outbox(db).enqueue({
      deliveryPartId: `incoming-failed:${fileUid}`,
      kind: 'status',
      ordinal: 20,
      payload: {
        type: 'text',
        text:
          '🔴 Не удалось обработать аудио после нескольких попыток.\n\n' +
          'Технические подробности сохранены в локальном журнале.\n\n' +
          renderProvenancePlain(incomingTelegramProvenance(incoming)),
      },
    });
    return true;
  });
}

export function expectedDigestIsMissing(
  db: Database['handle'],
  epochMs: number,
  schedule: { readonly enabled: boolean; readonly atLocalTime: string; readonly timezone: string },
  graceMs = 0,
): boolean {
  const date = scheduledDigestDate(epochMs, schedule);
  if (date === null) return false;
  const dueAgeMs = scheduledDigestDueAgeMs(epochMs, schedule);
  if (dueAgeMs !== null && dueAgeMs < graceMs) return false;
  return (
    db.prepare('SELECT 1 AS present FROM digests WHERE digest_date = ?').get(date) === undefined
  );
}

function scheduledDigestDueAgeMs(
  epochMs: number,
  schedule: { readonly enabled: boolean; readonly atLocalTime: string; readonly timezone: string },
): number | null {
  if (!schedule.enabled) return null;
  const local = zonedDateTime(epochMs, schedule.timezone);
  const [dueHour, dueMinute] = schedule.atLocalTime.split(':').map(Number);
  const dueMinutes = (dueHour ?? 0) * 60 + (dueMinute ?? 0);
  const localMinutes = local.hour * 60 + local.minute;
  const elapsedMinutes =
    localMinutes >= dueMinutes ? localMinutes - dueMinutes : 24 * 60 + localMinutes - dueMinutes;
  return elapsedMinutes * 60 * 1000;
}

export interface DaemonPidRecord {
  readonly pid: number;
  readonly root: string | null;
  readonly startedAt: string | null;
  readonly processBirth: string | null;
}

export function parseDaemonPid(value: string): DaemonPidRecord | null {
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    const pid = Number.parseInt(trimmed, 10);
    return pid > 0 ? { pid, root: null, startedAt: null, processBirth: null } : null;
  }

  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    const pid = parsed['pid'];
    const root = parsed['root'];
    const startedAt = parsed['startedAt'];
    const processBirth = parsed['processBirth'];
    if (!Number.isInteger(pid) || (pid as number) <= 0) return null;
    if (typeof root !== 'string' || typeof startedAt !== 'string') return null;
    if (processBirth !== undefined && typeof processBirth !== 'string') return null;
    return {
      pid: pid as number,
      root,
      startedAt,
      processBirth: processBirth ?? null,
    };
  } catch {
    return null;
  }
}

export async function readDaemonPid(pidFile: string): Promise<DaemonPidRecord | null> {
  try {
    return parseDaemonPid(await readFile(pidFile, 'utf8'));
  } catch {
    return null;
  }
}

export function commandLooksLikeOpenMurmurDaemon(command: string): boolean {
  return command.toLowerCase().includes('openmurmur') && /(?:^|\s)start(?:\s|$)/.test(command);
}

export function processIdentityMatches(
  command: string | null,
  actualBirth: string | null,
  expectedBirth: string | null,
): boolean {
  return (
    command !== null &&
    actualBirth !== null &&
    expectedBirth !== null &&
    actualBirth === expectedBirth &&
    commandLooksLikeOpenMurmurDaemon(command)
  );
}

export async function inspectDaemonProcess(
  pid: number,
  expectedBirth: string | null,
): Promise<{
  alive: boolean;
  identityMatches: boolean;
  command: string | null;
  processBirth: string | null;
}> {
  try {
    process.kill(pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EPERM') {
      return { alive: false, identityMatches: false, command: null, processBirth: null };
    }
  }

  const [command, processBirth] = await Promise.all([processCommand(pid), processBirthMarker(pid)]);
  return {
    alive: true,
    identityMatches: processIdentityMatches(command, processBirth, expectedBirth),
    command,
    processBirth,
  };
}

interface DaemonPidClaimDependencies {
  readonly birthMarker?: (pid: number) => Promise<string | null>;
  readonly inspect?: typeof inspectDaemonProcess;
}

export async function claimDaemonPid(
  pidFile: string,
  root: string,
  dependencies: DaemonPidClaimDependencies = {},
): Promise<DaemonPidRecord> {
  const birthMarker = dependencies.birthMarker ?? processBirthMarker;
  const inspect = dependencies.inspect ?? inspectDaemonProcess;
  const processBirth = await birthMarker(process.pid);
  if (processBirth === null) {
    throw new Error('could not establish daemon process birth identity');
  }
  const identity = {
    pid: process.pid,
    root,
    startedAt: new Date().toISOString(),
    processBirth,
  } satisfies DaemonPidRecord;
  const record = JSON.stringify(identity);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await writeFile(pidFile, `${record}\n`, { mode: 0o600, flag: 'wx' });
      return identity;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }

    const existing = await readDaemonPid(pidFile);
    if (existing === null) {
      throw new Error(`daemon pid file is invalid; inspect and remove it manually: ${pidFile}`);
    }

    const processState = await inspect(existing.pid, existing.processBirth);
    if (processState.alive) {
      const detail = processState.identityMatches
        ? 'OpenMurmur is already running'
        : 'pid is in use';
      throw new Error(`${detail} (pid ${existing.pid}); refusing to replace ${pidFile}`);
    }
    await rm(pidFile, { force: true });
  }

  throw new Error(`could not claim daemon pid file: ${pidFile}`);
}

export async function releaseDaemonPid(pidFile: string, expectedPid: number): Promise<void> {
  const record = await readDaemonPid(pidFile);
  if (record?.pid !== expectedPid) return;
  await rm(pidFile, { force: true });
}

export function findIncomingFile(
  db: Database['handle'],
  telegramUniqueId: string,
  botScope = 'legacy',
): IncomingFileRow | undefined {
  return new IncomingFileRepository(db).findByTelegramUniqueId(telegramUniqueId, botScope);
}

/**
 * Claims the stable local identity and the Telegram-supplied provenance before
 * any network download. The claimed filename remains display-only.
 */
export function claimIncomingRequest(
  db: Database['handle'],
  updateId: number,
  message: TelegramMessage,
  daemonHost: string,
  botScope = 'legacy',
): IncomingFileRow | null {
  const attachment = extractAttachment(message);
  if (attachment === null) return null;
  return new IncomingFileRepository(db).claim({
    telegramFileId: attachment.fileId,
    telegramUniqueId: attachment.fileUniqueId,
    chatId: message.chat.id,
    messageId: message.message_id,
    botScope,
    updateId,
    telegramSource: message.forward_origin === undefined ? 'direct' : 'forwarded',
    attachmentType: attachment.source,
    claimedFilename: attachment.claimedFilename ?? null,
    telegramMessageAt: telegramTimestampIso(message.date, 'message.date'),
    originalSentAt:
      message.forward_origin === undefined
        ? null
        : telegramTimestampIso(message.forward_origin.date, 'forward_origin.date'),
    daemonHost,
    declaredBytes: attachment.declaredBytes ?? null,
    declaredMime: attachment.declaredMime ?? null,
  });
}

/** Claim, enqueue, acknowledge and handle one update as one crash-consistent unit. */
export function enqueueIncomingRequest(
  db: Database['handle'],
  updateId: number,
  message: TelegramMessage,
  daemonHost: string,
  botScope = 'legacy',
  forcedLanguage: string | null = null,
): IncomingFileRow {
  return transaction(db, () => {
    const incoming = claimIncomingRequest(db, updateId, message, daemonHost, botScope);
    if (incoming === null) throw new Error('incoming audio update has no supported attachment');
    new JobQueue(db).enqueue({
      kind: 'incoming_audio',
      idempotencyKey: scopedUpdateKey('incoming', botScope, updateId),
      payload: { updateId, botScope, fileUid: incoming.fileUid, message, forcedLanguage },
    });
    new Outbox(db).enqueue({
      deliveryPartId: scopedUpdateKey('ack', botScope, updateId),
      kind: 'status',
      ordinal: 1,
      payload: {
        type: 'text',
        text: `🎧 Принято, распознаю локально…\n\n${renderProvenanceHtml(incomingTelegramProvenance(incoming))}`,
        parseMode: 'HTML',
      },
    });
    markUpdateHandled(db, updateId, botScope);
    return incoming;
  });
}

function scopedUpdateKey(prefix: string, botScope: string, updateId: number): string {
  return botScope === 'legacy' ? `${prefix}:${updateId}` : `${prefix}:${botScope}:${updateId}`;
}

function telegramTimestampIso(seconds: number, field: string): string {
  if (!Number.isFinite(seconds)) throw new Error(`Telegram ${field} must be a finite number`);
  return new Date(seconds * 1000).toISOString();
}

interface IncomingDownloadInput {
  readonly attachment: NonNullable<ReturnType<typeof extractAttachment>>;
  readonly message: Parameters<typeof extractAttachment>[0];
  readonly downloaded: Awaited<ReturnType<typeof downloadToQuarantine>>;
}

export function recordIncomingDownload(
  db: Database['handle'],
  input: IncomingDownloadInput,
): IncomingFileRow {
  const nowIso = new Date().toISOString();
  db.prepare(
    `INSERT INTO incoming_telegram_files
       (file_uid, telegram_file_id, telegram_unique_id, chat_id, message_id,
        declared_bytes, actual_bytes, declared_mime, state, quarantine_path,
        created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'downloaded', ?, ?, ?)
     ON CONFLICT (telegram_unique_id) DO UPDATE SET
       telegram_file_id = excluded.telegram_file_id,
       actual_bytes = excluded.actual_bytes,
       state = 'downloaded',
       quarantine_path = excluded.quarantine_path,
       updated_at = excluded.updated_at`,
  ).run(
    input.downloaded.fileUid,
    input.attachment.fileId,
    input.attachment.fileUniqueId,
    input.message.chat.id,
    input.message.message_id,
    input.attachment.declaredBytes ?? null,
    input.downloaded.actualBytes,
    input.attachment.declaredMime ?? null,
    input.downloaded.path,
    nowIso,
    nowIso,
  );

  const stored = findIncomingFile(db, input.attachment.fileUniqueId);
  if (stored === undefined) throw new Error('could not persist incoming Telegram file');
  return stored;
}

function currentIncomingTranscript(
  db: Database['handle'],
  fileUid: string,
):
  | {
      text: string;
      segments: readonly AsrSegment[];
      languages: readonly string[];
      forcedLanguage: string | null;
    }
  | undefined {
  const row = db
    .prepare(
      `SELECT revision_id, text, languages, forced_language
         FROM transcript_revisions
        WHERE incoming_file_id = ? AND is_current = 1`,
    )
    .get(fileUid) as
    | { revision_id: string; text: string; languages: string; forced_language: string | null }
    | undefined;
  if (row === undefined) return undefined;
  return {
    text: row.text,
    segments: new TranscriptRepository(db).segments(row.revision_id),
    languages: JSON.parse(row.languages) as string[],
    forcedLanguage: row.forced_language,
  };
}

function forcedLanguageFromPayload(
  payload: Record<string, unknown>,
  fallback: string | null,
): string | null {
  if (!Object.hasOwn(payload, 'forcedLanguage')) return fallback;
  const value = payload['forcedLanguage'];
  if (value === null || typeof value === 'string') return value;
  throw new Error('incoming audio payload has an invalid forcedLanguage');
}

function markIncomingTranscribed(db: Database['handle'], fileUid: string): void {
  new IncomingFileRepository(db).markTranscribed(fileUid);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function ensureIncomingWav(
  ffmpegPath: string,
  ffprobePath: string,
  quarantinePath: string,
  incoming: IncomingFileRow,
): Promise<string> {
  const wavPath = incoming.normalizedPath;
  if (wavPath === null) throw new Error('incoming normalized path was not reserved');
  if (await pathExists(wavPath)) {
    const existing = await probeAudio(ffprobePath, wavPath);
    if (
      existing !== null &&
      existing.codec === 'pcm_s16le' &&
      existing.formatName.split(',').includes('wav') &&
      existing.channels === 1 &&
      existing.sampleRate === 16_000 &&
      Number.isFinite(existing.durationSeconds) &&
      existing.durationSeconds >= 0
    ) {
      return wavPath;
    }
  }
  if (!(await normalizeToWav(ffmpegPath, quarantinePath, wavPath))) {
    throw new IncomingRejected('corrupt_media', 'could not decode the audio');
  }
  return wavPath;
}

function processCommand(pid: number): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      execFile('/bin/ps', ['-p', String(pid), '-o', 'command='], (error, stdout) => {
        if (error !== null) {
          resolve(null);
          return;
        }
        const command = stdout.trim();
        resolve(command.length > 0 ? command : null);
      });
    } catch {
      resolve(null);
    }
  });
}

function processBirthMarker(pid: number): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      execFile('/bin/ps', ['-p', String(pid), '-o', 'lstart='], (error, stdout) => {
        const marker = stdout.trim();
        resolve(error || marker.length === 0 ? null : marker);
      });
    } catch {
      resolve(null);
    }
  });
}

/** `audio:<partId>`, `transcript:<sessionId>:2` -> the session id, if present. */
export function sessionIdFromDeliveryPart(deliveryPartId: string): string | null {
  const [kind, id] = deliveryPartId.split(':');
  if (id === undefined) return null;
  if (kind === 'transcript' || kind === 'transcript-md' || kind === 'report') return id;
  return null;
}

export function incomingFileUidFromDeliveryPart(deliveryPartId: string): string | null {
  if (!deliveryPartId.startsWith('incoming:')) return null;
  const lastSeparator = deliveryPartId.lastIndexOf(':');
  if (lastSeparator <= 'incoming:'.length) return null;
  return deliveryPartId.slice('incoming:'.length, lastSeparator);
}

export function reconcileIncomingDelivery(db: Database['handle'], fileUid: string): void {
  const prefix = `incoming:${fileUid}:`;
  const rows = db
    .prepare(
      "SELECT delivery_part_id, state FROM telegram_outbox WHERE kind = 'incoming_transcript'",
    )
    .all() as { delivery_part_id: string; state: string }[];
  const matching = rows.filter((row) => row.delivery_part_id.startsWith(prefix));
  if (matching.length === 0 || matching.some((row) => row.state !== 'sent')) return;
  db.prepare(
    `UPDATE incoming_telegram_files
        SET state = 'delivered', updated_at = ?
      WHERE file_uid = ? AND state = 'transcribed'`,
  ).run(new Date().toISOString(), fileUid);
}

export { SessionRepository };
