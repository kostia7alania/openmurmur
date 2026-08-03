import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { FfmpegCapture } from '../capture/ffmpeg.ts';
import { normalizeToWav, probeAudio } from '../capture/probe.ts';
import { recoverAfterCrash } from '../capture/recovery.ts';
import type { LoadedConfig } from '../config/load.ts';
import { type Database, openDatabase } from '../database/db.ts';
import { PartRepository, SessionRepository, TranscriptRepository } from '../database/repository.ts';
import { buildDigest, hoursSinceLastDigest, renderDigest, storeDigest } from '../digest/daily.ts';
import { AlertEvaluator, type AlertId, renderAlert } from '../health/alerts.ts';
import {
  diskFreeGb,
  evaluateHealth,
  recordHealthEvent,
  renderHealthLines,
  sqliteWritable,
} from '../health/monitor.ts';
import { renderSleepMessage, SleepDetector } from '../health/sleep.ts';
import { handleJob, markAudioDelivered, reconcileSessionDelivery } from '../jobs/pipeline.ts';
import { JobQueue } from '../jobs/queue.ts';
import type { Logger } from '../logging/logger.ts';
import { Recorder } from '../sessionizer/recorder.ts';
import { EnergyVad } from '../sessionizer/vad.ts';
import { TelegramClient } from '../telegram/client.ts';
import { renderTranscriptMessages } from '../telegram/format.ts';
import {
  downloadToQuarantine,
  extractAttachment,
  IncomingRejected,
  rejectionMessage,
  validateProbe,
} from '../telegram/incoming.ts';
import { keychainProvider, type SecretsProvider } from '../telegram/keychain.ts';
import { drainOutbox, Outbox, type OutboxPayload } from '../telegram/outbox.ts';
import { HELP_TEXT, renderStatus } from '../telegram/report.ts';
import {
  nextOffsetFor,
  readOffset,
  recordUpdate,
  routeUpdate,
  writeOffset,
} from '../telegram/router.ts';
import { createAsrBackend, createLlmBackend } from './backends.ts';
import { VERSION } from './version.ts';

/**
 * The long-running daemon.
 *
 * Four cooperating loops share one SQLite database:
 *   1. the recorder   — microphone -> VAD -> sessionizer -> FLAC parts
 *   2. the job worker — ASR, summarize, deliver
 *   3. the Telegram poller — commands and incoming audio
 *   4. the health monitor  — checks and edge-triggered alerts
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

  #client: TelegramClient | null = null;
  #chatId: number | null = null;
  #stopping = false;
  #recorderFailure: string | null = null;
  readonly #sleepDetector: SleepDetector;
  #announcedRecording = false;
  readonly #timers: NodeJS.Timeout[] = [];

  constructor(options: DaemonOptions) {
    this.#options = options;
    const { config, paths } = options.loaded;

    this.#db = openDatabase({
      file: paths.databaseFile,
      onVersionWarning: (message) => options.logger.warn(message),
    });
    this.#jobs = new JobQueue(this.#db.handle);
    this.#outbox = new Outbox(this.#db.handle);
    this.#alerts = new AlertEvaluator(this.#db.handle, {
      cooldownMinutes: config.health.alertCooldownMinutes,
    });

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

    this.#recorder = new Recorder({
      config,
      paths,
      db: this.#db.handle,
      capture: this.#capture,
      vad: new EnergyVad(),
      logger: options.logger.child('recorder'),
      onFirstFrame: () => this.#announceRecordingStarted(),
    });
  }

  async start(): Promise<void> {
    const { config, paths } = this.#options.loaded;
    const logger = this.#options.logger;

    await writeFile(paths.pidFile, `${process.pid}\n`, { mode: 0o600 });

    // Reclaim anything a previous crash left half-done before new work starts.
    const recovery = await recoverAfterCrash(this.#db.handle, paths, logger);
    if (recovery.orphans.length > 0 || recovery.stalledSessions.length > 0) {
      await this.#sendNow(
        `🟡 Предыдущий запуск завершился некорректно\n\n` +
          `Прерванных записей: ${recovery.orphans.length}\n` +
          `Незавершённых сессий: ${recovery.stalledSessions.length}`,
      );
    }

    const reclaimedJobs = this.#jobs.recoverStaleLeases();
    const reclaimedSends = this.#outbox.recoverSending();
    if (reclaimedJobs > 0 || reclaimedSends > 0) {
      logger.info('recovered work from a previous run', { reclaimedJobs, reclaimedSends });
    }

    const secrets = await (this.#options.secrets ?? keychainProvider).load();
    if (secrets === null) {
      logger.warn('Telegram is not configured; run `openmurmur setup telegram`');
    } else {
      this.#client = new TelegramClient({
        token: secrets.token,
        baseUrl: config.telegram.apiBaseUrl,
      });
      this.#chatId = secrets.chatId;
    }

    this.#loop('jobs', () => this.#tickJobs(), 1000);
    this.#loop('outbox', () => this.#tickOutbox(), 1500);
    this.#loop('telegram', () => this.#tickTelegram(), config.telegram.pollIntervalMs);
    this.#loop('health', () => this.#tickHealth(), config.health.pollIntervalMs);
    this.#loop('sleep', () => this.#tickSleep(), 2000);
    this.#loop('retention', () => this.#tickDigest(), 5 * 60 * 1000);

    logger.info('daemon started', { pid: process.pid, version: VERSION });

    try {
      await this.#recorder.run();
      // A clean end to the capture stream still means recording stopped.
      if (!this.#stopping) this.#recorderFailure = 'capture stream ended unexpectedly';
    } catch (error) {
      this.#recorderFailure = (error as Error).message;
      logger.error('capture failed', { error: this.#recorderFailure });
      await this.#sendNow(`🔴 Запись остановлена\n\n${this.#recorderFailure.slice(0, 900)}`);
    }
  }

  async stop(): Promise<void> {
    if (this.#stopping) return;
    this.#stopping = true;
    for (const timer of this.#timers) clearInterval(timer);
    await this.#recorder.stop();
    await this.#sendNow('🔴 Запись остановлена (демон завершается)');
    try {
      await rm(this.#options.loaded.paths.pidFile, { force: true });
    } catch {
      // Nothing useful to do if the pid file is already gone.
    }
    this.#db.close();
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
      tick()
        .catch((error: unknown) => {
          this.#options.logger.error(`${name} loop failed`, { error: (error as Error).message });
        })
        .finally(() => {
          running = false;
        });
    }, intervalMs);
    timer.unref();
    this.#timers.push(timer);
  }

  async #tickJobs(): Promise<void> {
    this.#jobs.recoverStaleLeases();
    const job = this.#jobs.claim(['asr', 'summarize', 'deliver', 'incoming_audio']);
    if (job === null) return;

    try {
      if (job.kind === 'incoming_audio') await this.#handleIncomingJob(job.payload);
      else {
        await handleJob(
          {
            db: this.#db.handle,
            config: this.#options.loaded.config,
            paths: this.#options.loaded.paths,
            asr: createAsrBackend(this.#options.loaded, this.#options.logger),
            llm: createLlmBackend(this.#options.loaded.config),
            jobs: this.#jobs,
            logger: this.#options.logger,
          },
          job,
        );
      }
      this.#jobs.complete(job.jobId);
    } catch (error) {
      const outcome = this.#jobs.fail(job.jobId, (error as Error).message);
      this.#options.logger.warn('job failed', {
        kind: job.kind,
        outcome,
        attempts: job.attempts,
        error: (error as Error).message,
      });
    }
  }

  async #tickOutbox(): Promise<void> {
    const client = this.#client;
    const chatId = this.#chatId;
    if (client === null || chatId === null) return;

    await drainOutbox({
      outbox: this.#outbox,
      client,
      chatId,
      logger: this.#options.logger.child('outbox'),
      maxOutgoingBytes: this.#options.loaded.config.telegram.maxOutgoingBytes,
      onDelivered: ({ deliveryPartId, payload }) => {
        if (payload.type === 'document' && payload.partId !== undefined) {
          markAudioDelivered(this.#db.handle, payload.partId);
        }
        const sessionId = sessionIdFromDeliveryPart(deliveryPartId);
        if (sessionId !== null) {
          reconcileSessionDelivery(this.#db.handle, sessionId, this.#options.logger);
        }
      },
    });
  }

  async #tickTelegram(): Promise<void> {
    const client = this.#client;
    const chatId = this.#chatId;
    if (client === null || chatId === null) return;

    const offset = readOffset(this.#db.handle);
    const updates = await client.getUpdates(
      offset,
      this.#options.loaded.config.telegram.longPollSeconds,
    );
    if (updates.length === 0) return;

    for (const update of updates) {
      const action = routeUpdate(update, chatId);
      // Record before acting: a crash mid-handling must not reprocess the file.
      if (!recordUpdate(this.#db.handle, update.update_id, action.kind)) continue;

      switch (action.kind) {
        case 'ignore':
          break;
        case 'command':
          await this.#handleCommand(action.command);
          break;
        case 'unknown_command':
          this.#enqueueText(`Неизвестная команда. ${HELP_TEXT}`, `cmd:${update.update_id}`);
          break;
        case 'audio':
          this.#jobs.enqueue({
            kind: 'incoming_audio',
            idempotencyKey: `incoming:${update.update_id}`,
            payload: { updateId: update.update_id, message: action.message },
          });
          this.#enqueueText('🎧 Принято, распознаю локально...', `ack:${update.update_id}`);
          break;
        case 'text':
          break;
      }
    }
    writeOffset(this.#db.handle, nextOffsetFor(updates, offset));
  }

  async #handleCommand(command: '/status' | '/health' | '/help' | '/start'): Promise<void> {
    if (command === '/help' || command === '/start') {
      this.#enqueueText(HELP_TEXT, `help:${Date.now()}`);
      return;
    }
    if (command === '/health') {
      const report = evaluateHealth(
        await this.#collectHealth(),
        this.#options.loaded.config.health,
      );
      this.#enqueueText(renderHealthLines(report), `health:${Date.now()}`, undefined);
      return;
    }

    const parts = new PartRepository(this.#db.handle);
    const lastPart = parts.lastFinalized();
    const snapshot = this.#recorder.snapshot();
    const lastDelivery = this.#outbox.lastDeliveryAt();

    this.#enqueueText(
      renderStatus({
        recording: this.#recorder.running && this.#recorderFailure === null,
        lastFrameSecondsAgo:
          this.#capture.msSinceLastFrame() === null
            ? null
            : (this.#capture.msSinceLastFrame() ?? 0) / 1000,
        sessionState: snapshot.state,
        sessionElapsedMs:
          snapshot.sessionStartedMonotonicMs === null
            ? null
            : Number(process.hrtime.bigint() / 1_000_000n) - snapshot.sessionStartedMonotonicMs,
        lastClosedPartMinutesAgo:
          lastPart?.ended_at == null ? null : (Date.now() - Date.parse(lastPart.ended_at)) / 60_000,
        asrBacklog: this.#jobs.pendingCount('asr'),
        outboxPending: this.#outbox.pendingCount(),
        lastDeliveryMinutesAgo:
          lastDelivery === null ? null : (Date.now() - Date.parse(lastDelivery)) / 60_000,
        diskFreeGb: await diskFreeGb(this.#options.loaded.paths.root),
        asrStatus: `${this.#options.loaded.config.asr.model} (${this.#options.loaded.config.asr.backend})`,
        llmStatus: `${this.#options.loaded.config.llm.model} (${this.#options.loaded.config.llm.backend})`,
        version: VERSION,
      }),
      `status:${Date.now()}`,
      'HTML',
    );
  }

  async #handleIncomingJob(payload: Record<string, unknown>): Promise<void> {
    const client = this.#client;
    if (client === null) throw new Error('Telegram is not configured');
    const { config, paths } = this.#options.loaded;

    const message = payload['message'] as Parameters<typeof extractAttachment>[0];
    const attachment = extractAttachment(message);
    if (attachment === null) return;

    const nowIso = new Date().toISOString();
    let downloaded: Awaited<ReturnType<typeof downloadToQuarantine>> | null = null;

    try {
      downloaded = await downloadToQuarantine(client, attachment, paths.quarantineDir, {
        maxIncomingBytes: config.telegram.maxIncomingBytes,
        maxDurationSeconds: config.telegram.maxIncomingDurationSeconds,
      });

      this.#db.handle
        .prepare(
          `INSERT INTO incoming_telegram_files
             (file_uid, telegram_file_id, telegram_unique_id, chat_id, message_id,
              declared_bytes, actual_bytes, declared_mime, state, quarantine_path,
              created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'downloaded', ?, ?, ?)
           ON CONFLICT (telegram_unique_id) DO NOTHING`,
        )
        .run(
          downloaded.fileUid,
          attachment.fileId,
          attachment.fileUniqueId,
          message.chat.id,
          message.message_id,
          attachment.declaredBytes ?? null,
          downloaded.actualBytes,
          attachment.declaredMime ?? null,
          downloaded.path,
          nowIso,
          nowIso,
        );

      const probe = validateProbe(await probeAudio(config.audio.ffprobePath, downloaded.path), {
        maxIncomingBytes: config.telegram.maxIncomingBytes,
        maxDurationSeconds: config.telegram.maxIncomingDurationSeconds,
      });

      const wavPath = join(paths.quarantineDir, `${downloaded.fileUid}.16k.wav`);
      if (!(await normalizeToWav(config.audio.ffmpegPath, downloaded.path, wavPath))) {
        throw new IncomingRejected('corrupt_media', 'could not decode the audio');
      }

      const asr = createAsrBackend(this.#options.loaded, this.#options.logger);
      const result = await asr.transcribe({ audioPath: wavPath, requestId: downloaded.fileUid });

      new TranscriptRepository(this.#db.handle).append({
        incomingFileId: downloaded.fileUid,
        engine: result.engine,
        model: result.model,
        languages: result.languages,
        text: result.text,
        segments: result.segments.map((s) => ({
          startMs: s.startMs,
          endMs: s.endMs,
          timestampSource: s.timestampSource,
          language: s.language,
          text: s.text,
        })),
      });

      this.#db.handle
        .prepare(
          `UPDATE incoming_telegram_files
              SET state = 'transcribed', normalized_path = ?, probed_format = ?,
                  duration_ms = ?, updated_at = ?
            WHERE file_uid = ?`,
        )
        .run(
          wavPath,
          probe.formatName,
          Math.round(probe.durationSeconds * 1000),
          new Date().toISOString(),
          downloaded.fileUid,
        );

      for (const chunk of renderTranscriptMessages(
        downloaded.fileUid,
        result.text.length > 0 ? result.text : '(речь не распознана)',
        config.telegram.transcriptInlineLimit,
      )) {
        this.#outbox.enqueue({
          deliveryPartId: `incoming:${downloaded.fileUid}:${chunk.partNumber}`,
          kind: 'incoming_transcript',
          ordinal: 10,
          payload: { type: 'text', text: chunk.text, parseMode: 'HTML' },
        });
      }
    } catch (error) {
      if (error instanceof IncomingRejected) {
        this.#enqueueText(
          rejectionMessage(error.reason, error.message),
          `reject:${attachment.fileUniqueId}`,
        );
        if (downloaded !== null) {
          this.#db.handle
            .prepare(
              `UPDATE incoming_telegram_files SET state = 'rejected', rejection_reason = ?,
                      updated_at = ? WHERE file_uid = ?`,
            )
            .run(error.reason, new Date().toISOString(), downloaded.fileUid);
        }
        return;
      }
      throw error;
    }
  }

  async #collectHealth() {
    const { paths } = this.#options.loaded;
    const parts = new PartRepository(this.#db.handle);
    const lastPart = parts.lastFinalized();
    const snapshot = this.#recorder.snapshot();

    return {
      recorderRunning: this.#recorder.running && this.#recorderFailure === null,
      msSinceLastFrame: this.#capture.msSinceLastFrame(),
      minutesSinceLastClosedPart:
        lastPart?.ended_at == null ? null : (Date.now() - Date.parse(lastPart.ended_at)) / 60_000,
      workerReady:
        this.#options.loaded.config.asr.backend === 'fake' || this.#jobs.pendingCount('asr') < 50,
      workerDetail: `${this.#options.loaded.config.asr.backend}:${this.#options.loaded.config.asr.model}`,
      ollamaReady: true,
      ollamaDetail: this.#options.loaded.config.llm.model,
      activeSessionMs: snapshot.sessionStartedMonotonicMs,
      asrBacklogMinutes: this.#jobs.oldestPendingAgeMinutes('asr'),
      outboxAgeMinutes: this.#outbox.oldestPendingAgeMinutes(),
      diskFreeGb: await diskFreeGb(paths.root),
      sqliteWritable: sqliteWritable(this.#db.handle),
      hoursSinceLastDigest: hoursSinceLastDigest(this.#db.handle),
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
    const inputs = await this.#collectHealth();
    const config = this.#options.loaded.config;
    const report = evaluateHealth(inputs, config.health);

    for (const check of report.checks) {
      if (check.status !== 'healthy') recordHealthEvent(this.#db.handle, check);
    }

    const conditions: { id: AlertId; active: boolean; detail: string }[] = [
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
        id: 'telegram_delivery',
        active: inputs.outboxAgeMinutes > config.health.outboxStaleMinutes,
        detail: `старейшее сообщение ${Math.round(inputs.outboxAgeMinutes)} мин`,
      },
    ];

    for (const condition of conditions) {
      const decision = this.#alerts.evaluate(condition.id, condition.active);
      if (!decision.send || decision.transition === 'none') continue;
      const alert = renderAlert(
        condition.id,
        decision.transition,
        condition.active ? condition.detail : '',
        Math.floor(Date.now() / 60_000),
      );
      this.#outbox.enqueue({
        deliveryPartId: alert.deliveryPartId,
        kind: 'alert',
        ordinal: 5,
        payload: { type: 'text', text: alert.text },
      });
    }
  }

  async #tickDigest(): Promise<void> {
    const { config } = this.#options.loaded;
    if (!config.digest.enabled) return;

    const now = new Date();
    const [hour, minute] = config.digest.atLocalTime.split(':').map(Number);
    if (now.getHours() !== hour || Math.abs(now.getMinutes() - (minute ?? 0)) > 3) return;

    const date = new Date(now.getTime() - now.getTimezoneOffset() * 60_000)
      .toISOString()
      .slice(0, 10);
    const existing = this.#db.handle
      .prepare('SELECT 1 AS present FROM digests WHERE digest_date = ?')
      .get(date);
    if (existing !== undefined) return;

    const digest = buildDigest(this.#db.handle, date, now.getTimezoneOffset());
    storeDigest(this.#db.handle, digest);
    this.#outbox.enqueue({
      deliveryPartId: `digest:${date}`,
      kind: 'digest',
      ordinal: 30,
      payload: { type: 'text', text: renderDigest(digest), parseMode: 'HTML' },
    });
  }

  #enqueueText(text: string, key: string, parseMode?: 'HTML'): void {
    const payload: OutboxPayload =
      parseMode === undefined ? { type: 'text', text } : { type: 'text', text, parseMode };
    this.#outbox.enqueue({
      deliveryPartId: key,
      kind: 'status',
      ordinal: 1,
      payload,
    });
  }

  /** Status messages bypass the outbox queue order but still go through it. */
  async #sendNow(text: string): Promise<void> {
    this.#enqueueText(text, `notice:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`);
    await this.#tickOutbox().catch(() => {});
  }
}

/** `audio:<partId>`, `transcript:<sessionId>:2` -> the session id, if present. */
export function sessionIdFromDeliveryPart(deliveryPartId: string): string | null {
  const [kind, id] = deliveryPartId.split(':');
  if (id === undefined) return null;
  if (kind === 'transcript' || kind === 'transcript-md' || kind === 'report') return id;
  return null;
}

export { SessionRepository };
