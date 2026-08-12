#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, rm } from 'node:fs/promises';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { parseArgs } from 'node:util';
import { isAsrLanguageCode, modelLanguageName } from '../asr/preferences.ts';
import {
  createCaptureBackend,
  defaultNativeCaptureExecutable,
  type NativeCaptureAuthorizationStatus,
  nativeCaptureAuthorizationStatus,
  nativeCaptureExecutableIsUsable,
} from '../capture/native.ts';
import { normalizeToWav, probeAudio } from '../capture/probe.ts';
import { recoverAfterCrash, renderRecoveryReport } from '../capture/recovery.ts';
import { ensureDirectories, loadConfig } from '../config/load.ts';
import { type AudioConfig, ConfigError } from '../config/schema.ts';
import { openDatabase } from '../database/db.ts';
import { TranscriptRepository } from '../database/repository.ts';
import { renderSearchResults, searchTranscripts } from '../database/search.ts';
import {
  buildDigest,
  hasUnfinishedSessionsForDate,
  readStoredDigest,
  renderDigest,
  scheduledDigestDate,
  zonedDateTime,
} from '../digest/daily.ts';
import {
  type DigestPublication,
  ensureDigestDeliveryArtifact,
  prepareDigestDelivery,
  publishDigestSnapshot,
  readDigestDeliveryPayload,
} from '../digest/delivery.ts';
import { compactJobError, renderDeadJobAlert } from '../jobs/diagnostics.ts';
import { canRetryDeadJob, JobQueue } from '../jobs/queue.ts';
import { createLogger } from '../logging/logger.ts';
import { applyRetention, planRetention } from '../retention/policy.ts';
import {
  applyDeliveryReconciliation,
  exactUtcAcknowledgement,
  listHeldLegacyDeliveries,
  renderHeldLegacyDeliveries,
} from '../retention/reconcile-delivery.ts';
import { EnergyVad, rmsDbfs } from '../sessionizer/vad.ts';
import { TelegramClient, type TelegramUpdate } from '../telegram/client.ts';
import { keychain, telegramBotScope } from '../telegram/keychain.ts';
import {
  inspectDeadOutbox,
  renderDeadOutboxReport,
  retryDeadOutbox,
} from '../telegram/outbox-recovery.ts';
import {
  applyTelegramDeliveryReconciliation,
  listUnacknowledgedTelegramDeliveries,
  renderUnacknowledgedTelegramDeliveries,
} from '../telegram/reconcile-delivery.ts';
import { readOffset, routeUpdate } from '../telegram/router.ts';
import { systemClock } from '../util/clock.ts';
import { createAsrBackend } from './backends.ts';
import {
  openMurmurRecoveryCommand,
  type RecoveryCommandContext,
  recoveryCommandContextForRoot,
  shellQuotedStateRoot,
} from './command-context.ts';
import { Daemon } from './daemon.ts';
import {
  assertCurrentDaemonMaintenance,
  claimDaemonMaintenance,
  DAEMON_MAINTENANCE_RENEW_INTERVAL_MS,
  inspectDaemonControl,
  releaseDaemonMaintenance,
  releaseDaemonPid,
  renewDaemonMaintenance,
  stopOwnedDaemon,
} from './daemon-ownership.ts';
import { doctorExitCode, formatChecks, runDoctor } from './doctor.ts';
import { normalizeRecallOptions, recallTranscripts, renderRecallResults } from './recall.ts';
import {
  applySetup,
  planSetup,
  renderSetupCompletion,
  renderSetupPlan,
  renderTelegramSetupCompletion,
  setupTelegram,
  type TelegramSetupRole,
} from './setup.ts';
import {
  heartbeatFreshForMs,
  readLocalLiveStatus,
  readLocalStatusCounts,
  renderLiveStatus,
  renderQueueStatus,
} from './status.ts';
import { VERSION } from './version.ts';

const USAGE = `openmurmur ${VERSION} — private ambient journal for Apple Silicon

Usage: pnpm openmurmur <command> [options]

Setup and diagnostics
  doctor                 Check every dependency. Read-only: changes nothing.
  setup --telegram-role owner|send-only  Create state with one explicit Telegram role.
  setup telegram owner|send-only  Connect a Telegram bot with one explicit input role.
  capture authorize      Inspect native microphone access; request it only when undecided.
  capture test           Record a few seconds and report input levels.
  recover                Report recordings an unclean shutdown left behind.

Running
  start                  Run the daemon in the foreground.
  stop                   Stop a running daemon.
  status                 Print local status without contacting Telegram.

Telegram
  telegram test          Send a test message to the configured chat.
  telegram poll          Poll once and print what would be handled.

Work
  jobs failed            Show exhausted background jobs and their causes.
  jobs retry JOB_ID      Re-queue one exhausted job after fixing its cause.
  jobs retry JOB_ID --language CODE  Retry ASR/incoming audio as ru, th, en or zh.
  outbox failed          Safely inspect exhausted Telegram deliveries.
  outbox retry DELIVERY_PART_ID  Re-queue one exact dead Telegram delivery after duplicate-risk acknowledgement.
  delivery reconcile     Report legacy delivered audio held without an exact ACK time.
  delivery reconcile apply  Set a selected exact ACK with confirmation and audit evidence.
  delivery reconcile-remote  Report outbox rows whose remote Telegram status is unknown.
  delivery reconcile-remote apply  Record one independently proven remote Telegram ACK.
  recall QUERY           Recall grounded sessions with provenance and audio availability.
  search TEXT            Search every stored transcript.
  transcribe FILE        Transcribe one audio file locally and print the text.
  digest DATE            Build and print the digest for YYYY-MM-DD.
  retention dry-run      Show exactly what retention would delete, and why.
  retention apply        Delete only what dry-run proved eligible.

Options
  --root DIR             Override the state directory (default: OPENMURMUR_HOME).
  --json                 Machine-readable output where supported.
  --yes                  Skip the confirmation prompt.
  --accept-duplicate-risk  Required with --yes for JSON outbox retry.
  --limit N              Maximum search results (default 20).
  --since ISO --until ISO  Restrict search to a time range.
  --language CODE        Force ru, th, en or zh when retrying ASR/incoming audio.
  --telegram-role ROLE   Set owner or send-only when creating a fresh config.
  --part ID | --session ID  Select delivery reconciliation scope.
  --ack-at UTC --operator ID --evidence TEXT  Exact manual reconciliation proof.
  --delivery-part ID --telegram-message-id N  Exact remote Telegram reconciliation identity.
  --help, --version
`;

class CliArgumentError extends Error {}

async function main(argv: readonly string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    strict: false,
    options: {
      root: { type: 'string' },
      json: { type: 'boolean', default: false },
      yes: { type: 'boolean', default: false },
      'accept-duplicate-risk': { type: 'boolean', default: false },
      limit: { type: 'string' },
      since: { type: 'string' },
      until: { type: 'string' },
      language: { type: 'string' },
      'telegram-role': { type: 'string' },
      part: { type: 'string' },
      session: { type: 'string' },
      'delivery-part': { type: 'string' },
      'telegram-message-id': { type: 'string' },
      'ack-at': { type: 'string' },
      operator: { type: 'string' },
      evidence: { type: 'string' },
      help: { type: 'boolean', default: false, short: 'h' },
      version: { type: 'boolean', default: false },
    },
  });
  const root = selectedStateRoot(values['root']);

  if (values['version'] === true) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  const command = positionals[0];
  if (values['help'] === true || command === undefined || command === 'help') {
    process.stdout.write(USAGE);
    return command === undefined ? 1 : 0;
  }

  const loaded = await loadConfig(root);
  const logger = createLogger({
    level: loaded.config.logLevel,
    file: join(loaded.paths.logsDir, 'openmurmur.ndjson'),
  });
  const asJson = values['json'] === true;

  switch (command) {
    case 'doctor': {
      const checks = await runDoctor(loaded);
      process.stdout.write(
        asJson ? `${JSON.stringify(checks, null, 2)}\n` : `${formatChecks(checks)}\n`,
      );
      return doctorExitCode(checks);
    }

    case 'setup':
      return setupCommand(
        loaded,
        positionals[1],
        positionals[2],
        typeof values['telegram-role'] === 'string' ? values['telegram-role'] : undefined,
        values['yes'] === true,
      );

    case 'capture':
      return captureCommand(positionals[1], loaded.config.audio, loaded.paths.root);

    case 'start': {
      await ensureDirectories(loaded.paths);
      return startDaemon(loaded, logger);
    }

    case 'stop':
      return stopDaemon(loaded);

    case 'recover': {
      await ensureDirectories(loaded.paths);
      const db = openDatabase({ file: loaded.paths.databaseFile });
      try {
        // Read-only unless --yes: seeing what a crash left is not the same as
        // agreeing to delete it.
        const report = await recoverAfterCrash(db.handle, loaded.paths, logger, {
          remove: values['yes'] === true,
          repair: values['yes'] === true,
        });
        process.stdout.write(
          asJson ? `${JSON.stringify(report, null, 2)}\n` : `${renderRecoveryReport(report)}\n`,
        );
        if (
          values['yes'] !== true &&
          (report.orphans.length > 0 ||
            report.recoveredPublishedParts.length > 0 ||
            report.stalledSessions.length > 0)
        ) {
          process.stdout.write(
            '\nRe-run with --yes to repair the database and remove temp files.\n',
          );
        }
        return 0;
      } finally {
        db.close();
      }
    }

    case 'status':
      return localStatus(loaded, asJson);

    case 'telegram':
      return telegramCommand(loaded, positionals[1]);

    case 'jobs':
      return jobsCommand(loaded, positionals[1], positionals[2], values['language'], asJson);

    case 'outbox':
      return outboxCommand(loaded, positionals.slice(1), values, values['yes'] === true, asJson);

    case 'delivery':
      return deliveryCommand(
        loaded,
        positionals[1],
        positionals[2],
        values,
        values['yes'] === true,
        asJson,
      );

    case 'recall': {
      const query = positionals.slice(1).join(' ');
      if (query.length === 0) {
        process.stderr.write('Usage: pnpm openmurmur recall QUERY\n');
        return 1;
      }
      return recallCommand(loaded, query, values, asJson);
    }

    case 'search': {
      const query = positionals.slice(1).join(' ');
      if (query.length === 0) {
        process.stderr.write('Usage: pnpm openmurmur search TEXT\n');
        return 1;
      }
      return searchCommand(loaded, query, values, asJson);
    }

    case 'transcribe': {
      const file = positionals[1];
      if (file === undefined) {
        process.stderr.write('Usage: pnpm openmurmur transcribe FILE\n');
        return 1;
      }
      return transcribeFile(loaded, file, logger, asJson);
    }

    case 'digest': {
      return digestCommand(loaded, positionals[1], asJson);
    }

    case 'retention':
      return retentionCommand(loaded, positionals[1], values['yes'] === true, asJson);

    default:
      process.stderr.write(`Unknown command "${command}".\n\n${USAGE}`);
      return 1;
  }
}

async function digestCommand(
  loaded: Awaited<ReturnType<typeof loadConfig>>,
  requestedDate: string | undefined,
  asJson: boolean,
): Promise<number> {
  const scheduled = requestedDate === 'scheduled';
  const date = scheduled
    ? scheduledDigestDate(Date.now(), loaded.config.digest)
    : (requestedDate ?? zonedDateTime(Date.now(), loaded.config.digest.timezone).date);
  if (date === null) return 0;

  await ensureDirectories(loaded.paths);
  const db = openDatabase({ file: loaded.paths.databaseFile });
  try {
    let winner = readStoredDigest(db.handle, date);
    let publication: DigestPublication = 'exists';
    if (winner === undefined) {
      if (
        scheduled &&
        hasUnfinishedSessionsForDate(db.handle, date, loaded.config.digest.timezone)
      ) {
        return 0;
      }
      const digest = buildDigest(db.handle, date, loaded.config.digest.timezone, hostname());
      const prepared = prepareDigestDelivery(
        digest,
        loaded.config.digest.timezone,
        loaded.config.telegram.transcriptInlineLimit,
        loaded.paths.transcriptsDir,
      );
      publication = publishDigestSnapshot(
        db.handle,
        digest,
        prepared.payload,
        loaded.config.digest.timezone,
      );
      winner = readStoredDigest(db.handle, date);
    }
    if (publication === 'stale') {
      throw new Error(`digest ${date} sources changed while the snapshot was being built; retry`);
    }
    if (winner === undefined) throw new Error(`digest ${date} publication produced no winner`);

    const payload = readDigestDeliveryPayload(db.handle, date);
    await ensureDigestDeliveryArtifact(winner, payload, loaded.paths.transcriptsDir);
    if (scheduled && publication === 'exists') {
      return 0;
    }
    const displayTimezone =
      payload.type === 'document' && payload.digestTimezone !== undefined
        ? payload.digestTimezone
        : loaded.config.digest.timezone;
    const rendered = payload.type === 'text' ? payload.text : renderDigest(winner, displayTimezone);
    process.stdout.write(asJson ? `${JSON.stringify(winner, null, 2)}\n` : `${rendered}\n`);
    return 0;
  } finally {
    db.close();
  }
}

async function searchCommand(
  loaded: Awaited<ReturnType<typeof loadConfig>>,
  query: string,
  values: Record<string, unknown>,
  asJson: boolean,
): Promise<number> {
  const db = openDatabase({ file: loaded.paths.databaseFile });
  try {
    const hits = searchTranscripts(db.handle, {
      query,
      ...(typeof values['limit'] === 'string'
        ? { limit: Number.parseInt(values['limit'], 10) }
        : {}),
      ...(typeof values['since'] === 'string' ? { since: values['since'] } : {}),
      ...(typeof values['until'] === 'string' ? { until: values['until'] } : {}),
    });
    process.stdout.write(
      asJson ? `${JSON.stringify(hits, null, 2)}\n` : `${renderSearchResults(hits, query)}\n`,
    );
    // Exit 1 on no match, so `pnpm openmurmur search x || echo none` works in a script.
    return hits.length > 0 ? 0 : 1;
  } finally {
    db.close();
  }
}

async function recallCommand(
  loaded: Awaited<ReturnType<typeof loadConfig>>,
  query: string,
  values: Record<string, unknown>,
  asJson: boolean,
): Promise<number> {
  const options = normalizeRecallOptions({
    query,
    ...(typeof values['limit'] === 'string' ? { limit: values['limit'] } : {}),
    ...(typeof values['since'] === 'string' ? { since: values['since'] } : {}),
    ...(typeof values['until'] === 'string' ? { until: values['until'] } : {}),
  });
  const db = openDatabase({ file: loaded.paths.databaseFile });
  try {
    const matches = await recallTranscripts(db.handle, options);
    process.stdout.write(
      asJson ? `${JSON.stringify(matches, null, 2)}\n` : `${renderRecallResults(matches, query)}\n`,
    );
    return matches.length > 0 ? 0 : 1;
  } finally {
    db.close();
  }
}

function selectedStateRoot(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  if (value.trim().length === 0) throw new CliArgumentError('--root must be a non-empty path.');
  return value;
}

async function setupCommand(
  loaded: Awaited<ReturnType<typeof loadConfig>>,
  subcommand: string | undefined,
  positionalTelegramRole: string | undefined,
  requestedTelegramRole: string | undefined,
  yes: boolean,
): Promise<number> {
  if (subcommand === 'telegram') {
    if (requestedTelegramRole !== undefined) {
      process.stderr.write(
        '--telegram-role is only for creating the base config; use the positional role here.\n',
      );
      return 1;
    }
    if (positionalTelegramRole !== 'owner' && positionalTelegramRole !== 'send-only') {
      process.stderr.write('Usage: pnpm openmurmur setup telegram <owner|send-only>\n');
      return 1;
    }
    const configuredRole = telegramRoleFor(loaded.config.telegram.receiveUpdates);
    if (positionalTelegramRole !== configuredRole) {
      process.stderr.write(
        `Telegram setup role is ${positionalTelegramRole}, but telegram.receiveUpdates selects ${configuredRole}. ` +
          `Set it to ${positionalTelegramRole === 'owner' ? 'true' : 'false'} and retry.\n`,
      );
      return 1;
    }
    const command = `setup telegram ${positionalTelegramRole}` as const;
    return withStoppedDaemonForTelegram(loaded, command, async () => {
      await ensureDirectories(loaded.paths);
      const result = await setupTelegram(
        loaded.paths,
        loaded.config.telegram.apiBaseUrl,
        positionalTelegramRole,
        (message) => process.stdout.write(`${message}\n`),
      );
      process.stdout.write(`\n${renderTelegramSetupCompletion(loaded.paths.root, result)}\n`);
      return 0;
    });
  }

  if (subcommand !== undefined || positionalTelegramRole !== undefined) {
    process.stderr.write(
      'Usage: pnpm openmurmur setup [--telegram-role owner|send-only] [--yes]\n',
    );
    return 1;
  }
  if (
    requestedTelegramRole !== undefined &&
    requestedTelegramRole !== 'owner' &&
    requestedTelegramRole !== 'send-only'
  ) {
    process.stderr.write('--telegram-role must be owner or send-only.\n');
    return 1;
  }

  // Every filesystem change is printed before anything is written.
  const configExists = await exists(loaded.paths.configFile);
  if (!configExists && requestedTelegramRole === undefined) {
    process.stderr.write(
      'Fresh setup requires --telegram-role owner or --telegram-role send-only. Nothing was changed.\n',
    );
    return 1;
  }
  const configuredRole = telegramRoleFor(loaded.config.telegram.receiveUpdates);
  if (
    configExists &&
    requestedTelegramRole !== undefined &&
    requestedTelegramRole !== configuredRole
  ) {
    process.stderr.write(
      `The existing config selects Telegram role ${configuredRole} and setup will not rewrite it. ` +
        `Edit telegram.receiveUpdates intentionally, then rerun without --telegram-role.\n`,
    );
    return 1;
  }
  const telegramRole = requestedTelegramRole ?? configuredRole;
  const plan = planSetup(loaded.paths, configExists, telegramRole);
  process.stdout.write(`${renderSetupPlan(plan)}\n\n`);
  if (!yes && !(await confirm('Proceed? [y/N] '))) {
    process.stdout.write('Cancelled. Nothing was changed.\n');
    return 1;
  }

  await applySetup(loaded.paths, plan);
  process.stdout.write(`\n${renderSetupCompletion(loaded.paths.root, telegramRole)}\n`);
  return 0;
}

function telegramRoleFor(receiveUpdates: boolean): TelegramSetupRole {
  return receiveUpdates ? 'owner' : 'send-only';
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function captureCommand(
  subcommand: string | undefined,
  audio: AudioConfig,
  root: string,
): Promise<number> | number {
  const commandContext = recoveryCommandContextForRoot(root);
  switch (subcommand) {
    case 'authorize':
      return captureAuthorize(commandContext);
    case 'test':
      return captureTest(audio);
    default:
      process.stderr.write('Usage: pnpm openmurmur capture <authorize|test>\n');
      return 1;
  }
}

async function captureAuthorize(commandContext: RecoveryCommandContext): Promise<number> {
  const executable = defaultNativeCaptureExecutable();
  if (!nativeCaptureExecutableIsUsable(executable)) {
    process.stderr.write(
      'The verified native capture helper is not installed at its supported path.\n' +
        'Run ./scripts/install-capture-app, then retry this command.\n',
    );
    return 1;
  }

  let status: NativeCaptureAuthorizationStatus;
  try {
    status = nativeCaptureAuthorizationStatus(executable);
  } catch {
    process.stderr.write(
      'Could not read the native helper microphone authorization status. Reinstall it with ./scripts/install-capture-app.\n',
    );
    return 1;
  }
  if (status !== 'not_determined') return renderNativeAuthorizationResult(status, commandContext);

  const app = dirname(dirname(dirname(executable)));
  process.stdout.write(
    'Opening the native capture helper. macOS may ask for microphone access now.\n',
  );
  const exitCode = await new Promise<number>((resolve) => {
    let settled = false;
    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      resolve(code);
    };
    const child = spawn('/usr/bin/open', [app, '--args', '--authorize'], {
      stdio: 'inherit',
    });
    child.once('error', (error) => {
      process.stderr.write(`Could not open the authorization flow: ${error.message}\n`);
      finish(1);
    });
    child.once('close', (code, signal) => {
      if (settled) return;
      if (code === 0) finish(0);
      else {
        process.stderr.write(
          `The GUI launcher did not finish normally (${signal ?? `exit ${code}`}).\n`,
        );
        finish(1);
      }
    });
  });
  if (exitCode !== 0) return exitCode;

  const deadline = Date.now() + 30_000;
  do {
    try {
      status = nativeCaptureAuthorizationStatus(executable);
    } catch {
      process.stderr.write(
        'The GUI flow opened, but its authorization status could not be read safely. No permission is claimed.\n',
      );
      return 1;
    }
    if (status !== 'not_determined') return renderNativeAuthorizationResult(status, commandContext);
    await new Promise((resolve) => setTimeout(resolve, 250));
  } while (Date.now() < deadline);

  process.stderr.write(
    'The GUI flow opened, but no macOS decision was observed within 30 seconds. No permission is claimed.\n' +
      `Finish the dialog in the GUI session, then prove real PCM with: ${openMurmurRecoveryCommand(commandContext, 'capture test')}\n`,
  );
  return 1;
}

function renderNativeAuthorizationResult(
  status: NativeCaptureAuthorizationStatus,
  commandContext: RecoveryCommandContext,
): number {
  switch (status) {
    case 'authorized':
      process.stdout.write(
        `Microphone access is granted to OpenMurmur Capture. Prove real PCM with: ${openMurmurRecoveryCommand(commandContext, 'capture test')}\n`,
      );
      return 0;
    case 'denied':
      process.stderr.write(
        'Microphone access is denied. macOS will not show the prompt again for this app identity.\n' +
          'Open System Settings -> Privacy & Security -> Microphone and enable “OpenMurmur Capture”.\n' +
          'If the entry is absent or stuck, reset only this app, then retry from a GUI session:\n' +
          '  /usr/bin/tccutil reset Microphone io.openmurmur.capture\n' +
          `  ${openMurmurRecoveryCommand(commandContext, 'capture authorize')}\n`,
      );
      return 1;
    case 'restricted':
      process.stderr.write(
        'Microphone access is restricted by macOS policy, Screen Time, or MDM. Re-running authorization cannot override it; ask the Mac administrator to allow microphone access for OpenMurmur Capture.\n',
      );
      return 1;
    case 'unavailable':
      process.stderr.write(
        'macOS did not return a supported microphone authorization state. Reinstall the helper and inspect System Settings -> Privacy & Security -> Microphone.\n',
      );
      return 1;
    case 'not_determined':
      process.stderr.write('Microphone authorization has not been decided.\n');
      return 1;
  }
}

async function startDaemon(
  loaded: Awaited<ReturnType<typeof loadConfig>>,
  logger: ReturnType<typeof createLogger>,
): Promise<number> {
  const daemon = new Daemon({ loaded, logger });
  let shutdownPromise: Promise<void> | null = null;
  const shutdown = () => {
    shutdownPromise ??= daemon.stop();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  try {
    await daemon.start();
    if (shutdownPromise === null) {
      // `start()` only returns by itself when capture has failed or ended.
      // A healthy daemon remains here until a signal asks it to stop.
      return 1;
    }
    await shutdownPromise;
    return 0;
  } catch (error) {
    await daemon.stop();
    throw error;
  } finally {
    process.off('SIGINT', shutdown);
    process.off('SIGTERM', shutdown);
  }
}

async function stopDaemon(loaded: Awaited<ReturnType<typeof loadConfig>>): Promise<number> {
  const db = openDatabase({ file: loaded.paths.databaseFile });
  try {
    const result = await stopOwnedDaemon(db.handle, loaded.paths.pidFile, loaded.paths.root);
    if (result.outcome === 'not_running') {
      process.stdout.write('No running daemon found.\n');
      return 1;
    }
    if (result.outcome === 'stale') {
      process.stderr.write(
        `Daemon pid ${result.pid} is no longer running; no live daemon was signalled.\n`,
      );
      return 1;
    }
    if (result.outcome === 'identity_mismatch') {
      process.stderr.write(
        `Refusing to signal pid ${result.pid}: it is not recognisable as an OpenMurmur daemon.\n`,
      );
      return 1;
    }
    process.stdout.write(`Sent SIGTERM to pid ${result.pid}.\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`Could not stop daemon: ${(error as Error).message}\n`);
    return 1;
  } finally {
    db.close();
  }
}

async function confirm(prompt: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(prompt)).trim().toLowerCase();
    return answer === 'y' || answer === 'yes';
  } finally {
    rl.close();
  }
}

/** Opens the configured backend and accepts only real PCM frames as success. */
async function captureTest(audio: AudioConfig): Promise<number> {
  const capture = createCaptureBackend({
    backend: audio.captureBackend,
    sampleRate: audio.sampleRate,
    channels: audio.channels,
    device: audio.captureDevice,
    frameSamples: 512,
    ffmpegPath: audio.ffmpegPath,
    clock: systemClock,
  });
  const vad = new EnergyVad();

  process.stdout.write(`Testing configured capture backend: ${audio.captureBackend}.\n`);
  process.stdout.write('Recording 5 seconds of real PCM. Say something.\n');
  process.stdout.write('macOS shows an orange dot near Control Center while the mic is open.\n\n');

  let deadline: number | null = null;
  let frames = 0;
  let capturedDurationMs = 0;
  let speechFrames = 0;
  let peakDbfs = Number.NEGATIVE_INFINITY;

  try {
    for await (const frame of capture.start()) {
      frames += 1;
      capturedDurationMs += frame.durationMs;
      deadline ??= Date.now() + 5000;
      const dbfs = rmsDbfs(frame.pcm);
      if (Number.isFinite(dbfs)) peakDbfs = Math.max(peakDbfs, dbfs);
      if (vad.probability(frame.pcm) >= 0.5) speechFrames += 1;
      if (Date.now() >= deadline) break;
    }
  } catch (error) {
    process.stderr.write(`\n❌ ${(error as Error).message}\n`);
    return 1;
  } finally {
    await capture.stop();
  }

  if (frames === 0) {
    process.stderr.write('❌ No PCM frames arrived. The configured backend did not open.\n');
    return 1;
  }

  process.stdout.write(
    `✅ ${frames} PCM frames captured (${(capturedDurationMs / 1000).toFixed(2)}s of audio)\n`,
  );
  process.stdout.write(`   Peak level: ${peakDbfs.toFixed(1)} dBFS\n`);
  process.stdout.write(`   Frames above the speech gate: ${speechFrames}\n`);
  if (peakDbfs < -60) {
    process.stdout.write('\n⚠️  Very quiet. Check System Settings -> Sound -> Input.\n');
  }
  return 0;
}

async function localStatus(
  loaded: Awaited<ReturnType<typeof loadConfig>>,
  asJson: boolean,
): Promise<number> {
  const commandContext = localRecoveryCommandContext(loaded.paths.root);
  const db = openDatabase({ file: loaded.paths.databaseFile });
  try {
    const daemon = await inspectDaemonControl(db.handle, loaded.paths.pidFile, loaded.paths.root);
    const alive = daemon.process?.alive === true && daemon.process.identityMatches;
    const pid = daemon.source === 'maintenance' ? null : (daemon.record?.pid ?? null);

    const counts = readLocalStatusCounts(db.handle);
    const live = readLocalLiveStatus(db.handle, {
      daemonRunning: alive,
      daemonPid: pid,
      daemonStartedAt: daemon.record?.startedAt ?? null,
      nowMs: Date.now(),
      freshForMs: heartbeatFreshForMs(loaded.config.health.pollIntervalMs),
    });

    const payload = {
      version: VERSION,
      daemon: alive ? 'running' : 'stopped',
      pid,
      ...counts,
      ...live,
    };
    if (asJson) {
      process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
      return 0;
    }
    process.stdout.write(
      [
        `OpenMurmur ${VERSION}`,
        `Daemon:            ${alive ? `running (pid ${pid})` : 'stopped'}`,
        ...renderLiveStatus(live),
        `Sessions:          ${counts.sessions} (${counts.done} delivered, ${counts.rejected} rejected)`,
        `Audio parts on disk: ${counts.parts}`,
        ...renderQueueStatus(counts, join(loaded.paths.logsDir, 'openmurmur.ndjson')),
        ...(counts.jobsDead > 0
          ? [`Failed job details: ${openMurmurRecoveryCommand(commandContext, 'jobs failed')}`]
          : []),
        `SQLite:            ${db.sqliteVersion}`,
        '',
      ].join('\n'),
    );
    return 0;
  } finally {
    db.close();
  }
}

function localRecoveryCommandContext(root: string): RecoveryCommandContext {
  return recoveryCommandContextForRoot(root);
}

function jobsCommand(
  loaded: Awaited<ReturnType<typeof loadConfig>>,
  subcommand: string | undefined,
  jobId: string | undefined,
  languageOption: unknown,
  asJson: boolean,
): number {
  if (subcommand !== 'failed' && subcommand !== 'retry') {
    process.stderr.write('Usage: openmurmur jobs <failed|retry JOB_ID>\n');
    return 1;
  }

  const db = openDatabase({ file: loaded.paths.databaseFile });
  try {
    const jobs = new JobQueue(db.handle);
    const commandContext = localRecoveryCommandContext(loaded.paths.root);
    if (subcommand === 'failed') {
      if (languageOption !== undefined) {
        process.stderr.write('--language is only valid with jobs retry JOB_ID.\n');
        return 1;
      }
      const failed = jobs.deadJobs();
      if (asJson) {
        process.stdout.write(
          `${JSON.stringify(
            {
              hostName: hostname(),
              failedJobs: failed.map((job) => ({
                ...job,
                lastError: compactJobError(job.lastError),
              })),
            },
            null,
            2,
          )}\n`,
        );
      } else if (failed.length === 0) {
        process.stdout.write('No failed jobs.\n');
      } else {
        process.stdout.write(
          `${
            renderDeadJobAlert(hostname(), failed, loaded.config.llm.model, commandContext, {
              technicalDetails: true,
            }).detail
          }\n`,
        );
        for (const job of failed.slice(1).filter((candidate) => canRetryDeadJob(candidate.kind))) {
          process.stdout.write(
            `Retry ${job.kind}: ${openMurmurRecoveryCommand(commandContext, `jobs retry ${job.jobId}`)}\n`,
          );
        }
      }
      return 0;
    }

    return retryDeadJob(jobs, jobId, languageOption, asJson, commandContext);
  } finally {
    db.close();
  }
}

async function outboxCommand(
  loaded: Awaited<ReturnType<typeof loadConfig>>,
  args: readonly string[],
  values: Record<string, unknown>,
  yes: boolean,
  asJson: boolean,
): Promise<number> {
  const parsed = parseOutboxCommand(args, values['delivery-part']);
  if ('error' in parsed) {
    process.stderr.write(`${parsed.error}\n`);
    return 1;
  }
  const { subcommand, selector } = parsed;
  const db = openDatabase({ file: loaded.paths.databaseFile });
  try {
    const report = inspectDeadOutbox(db.handle, loaded.paths, {
      ...(selector === undefined ? {} : { deliveryPartId: selector }),
    });
    if (subcommand === 'failed') {
      process.stdout.write(
        asJson ? `${JSON.stringify(report, null, 2)}\n` : `${renderDeadOutboxReport(report)}\n`,
      );
      return 0;
    }

    const expected = report.deliveries[0];
    if (expected === undefined) {
      process.stderr.write('No dead Telegram delivery found for that exact id.\n');
      return 1;
    }
    if (!expected.retryable) {
      process.stderr.write(
        `Dead Telegram delivery cannot be retried safely: ${expected.blockedReason ?? 'unknown reason'}.\n`,
      );
      return 1;
    }
    if (asJson && (!yes || values['accept-duplicate-risk'] !== true)) {
      process.stderr.write(
        'JSON retry requires --yes and --accept-duplicate-risk after independent ACK reconciliation.\n',
      );
      return 1;
    }
    if (!asJson) {
      process.stdout.write(`${renderDeadOutboxReport(report)}\n\n`);
      process.stdout.write(`Warning: ${OUTBOX_RETRY_WARNING}\n`);
    }
    if (!(await confirmOutboxRetry(yes, expected.deliveryPartId))) {
      process.stdout.write('Cancelled. No outbox facts were changed.\n');
      return 1;
    }

    await assertDaemonStoppedForOutboxMutation(
      db.handle,
      loaded,
      'retrying a dead Telegram delivery',
    );
    const result = retryDeadOutbox(
      db.handle,
      loaded.paths,
      selector ?? '',
      expected.snapshotSha256,
      { requireDaemonStopped: true },
    );
    process.stdout.write(
      asJson
        ? `${JSON.stringify({ ...result, requeued: true, warning: OUTBOX_RETRY_WARNING }, null, 2)}\n`
        : `Re-queued ${result.deliveryPartId}. It will run when the OpenMurmur daemon is running.\n`,
    );
    return 0;
  } finally {
    db.close();
  }
}

const OUTBOX_RETRY_WARNING =
  'Telegram remote status is unknown. Reconcile an independently proven ACK first; retrying may duplicate a message Telegram already accepted.';

async function confirmOutboxRetry(yes: boolean, deliveryPartId: string): Promise<boolean> {
  return yes || (await confirm(`\nRe-queue exact Telegram delivery ${deliveryPartId}? [y/N] `));
}

type ParsedOutboxCommand =
  | { readonly subcommand: 'failed'; readonly selector: string | undefined }
  | { readonly subcommand: 'retry'; readonly selector: string }
  | { readonly error: string };

function parseOutboxCommand(args: readonly string[], option: unknown): ParsedOutboxCommand {
  const [subcommand, positional, ...extra] = args;
  if (subcommand !== 'failed' && subcommand !== 'retry') {
    return {
      error: 'Usage: pnpm openmurmur outbox <failed [--delivery-part ID]|retry DELIVERY_PART_ID>',
    };
  }
  if (extra.length > 0) {
    return { error: 'Outbox commands do not accept extra positional arguments.' };
  }
  const selected = typeof option === 'string' ? option.trim() : undefined;
  if (selected !== undefined && selected.length === 0) {
    return { error: '--delivery-part requires one non-empty exact id.' };
  }
  if (subcommand === 'failed') {
    return positional === undefined
      ? { subcommand, selector: selected }
      : { error: 'Use --delivery-part ID to scope the failed outbox report.' };
  }
  if (positional === undefined || positional.trim().length === 0 || selected !== undefined) {
    return { error: 'Retry requires one exact positional DELIVERY_PART_ID.' };
  }
  return { subcommand, selector: positional.trim() };
}

function retryDeadJob(
  jobs: JobQueue,
  jobId: string | undefined,
  languageOption: unknown,
  asJson: boolean,
  commandContext: RecoveryCommandContext,
): number {
  if (jobId === undefined) {
    process.stderr.write('Usage: pnpm openmurmur jobs retry JOB_ID [--language ru|th|en|zh]\n');
    return 1;
  }
  if (languageOption !== undefined && !isAsrLanguageCode(languageOption)) {
    process.stderr.write('--language must be one of: ru, th, en, zh.\n');
    return 1;
  }
  const outcome = jobs.retryDead(
    jobId,
    languageOption === undefined ? {} : { language: languageOption },
  );
  if (outcome === 'not_found') {
    process.stderr.write(`No failed job found with id ${jobId}.\n`);
    return 1;
  }
  if (outcome === 'unsupported') {
    process.stderr.write(
      `Failed job ${jobId} has no daemon worker and cannot be retried. ` +
        `Run: ${openMurmurRecoveryCommand(commandContext, 'doctor')}\n`,
    );
    return 1;
  }
  if (outcome === 'language_unsupported') {
    process.stderr.write(
      `Failed job ${jobId} is not ASR or incoming audio; --language cannot be applied.\n`,
    );
    return 1;
  }
  const forcedLanguage =
    languageOption === undefined ? undefined : modelLanguageName(languageOption);
  const result = {
    jobId,
    requeued: true,
    ...(forcedLanguage === undefined ? {} : { forcedLanguage }),
  };
  process.stdout.write(
    asJson
      ? `${JSON.stringify(result, null, 2)}\n`
      : `Re-queued ${jobId}${
          forcedLanguage === undefined ? '' : ` with forced language ${forcedLanguage}`
        }. It will run when the OpenMurmur daemon is running.\n`,
  );
  return 0;
}

async function deliveryCommand(
  loaded: Awaited<ReturnType<typeof loadConfig>>,
  subcommand: string | undefined,
  action: string | undefined,
  values: Record<string, unknown>,
  yes: boolean,
  asJson: boolean,
): Promise<number> {
  if (subcommand === 'reconcile-remote') {
    return telegramDeliveryReconciliationCommand(loaded, action, values, yes, asJson);
  }
  if (
    subcommand !== 'reconcile' ||
    (action !== undefined && action !== 'report' && action !== 'apply')
  ) {
    process.stderr.write(
      'Usage: pnpm openmurmur delivery reconcile [report|apply] [--part ID|--session ID]\n',
    );
    return 1;
  }
  const mode = action ?? 'report';
  const hasPart = typeof values['part'] === 'string';
  const hasSession = typeof values['session'] === 'string';
  if (mode === 'apply' && hasPart === hasSession) {
    process.stderr.write('Apply requires exactly one --part or --session selector.\n');
    return 1;
  }
  const selector = {
    ...(typeof values['part'] === 'string' ? { partId: values['part'] } : {}),
    ...(typeof values['session'] === 'string' ? { sessionId: values['session'] } : {}),
  };
  const db = openDatabase({ file: loaded.paths.databaseFile });
  try {
    const held = listHeldLegacyDeliveries(db.handle, selector);
    if (mode === 'report') {
      process.stdout.write(
        asJson ? `${JSON.stringify({ held }, null, 2)}\n` : `${renderHeldLegacyDeliveries(held)}\n`,
      );
      return 0;
    }

    const acknowledgedAt = values['ack-at'];
    const operatorId = values['operator'];
    const evidence = values['evidence'];
    if (
      typeof acknowledgedAt !== 'string' ||
      typeof operatorId !== 'string' ||
      typeof evidence !== 'string'
    ) {
      process.stderr.write(
        'Apply requires --ack-at YYYY-MM-DDTHH:mm:ss.sssZ, --operator ID and --evidence TEXT.\n',
      );
      return 1;
    }
    const exactAcknowledgedAt = exactUtcAcknowledgement(acknowledgedAt);
    if (held.length === 0) {
      process.stderr.write('No held legacy delivery matches the selected scope.\n');
      return 1;
    }
    if (asJson && !yes) {
      process.stderr.write('JSON apply requires explicit --yes confirmation.\n');
      return 1;
    }
    if (!asJson) {
      process.stdout.write(`${renderHeldLegacyDeliveries(held)}\n`);
      process.stdout.write(
        'Warning: an elapsed supplied ACK may make this audio eligible for retention deletion.\n',
      );
    }
    if (
      !yes &&
      !(await confirm(
        `\nSet exact ACK ${exactAcknowledgedAt} for ${held.length} held part(s)? [y/N] `,
      ))
    ) {
      process.stdout.write('Cancelled. No delivery clocks were changed.\n');
      return 1;
    }

    const result = applyDeliveryReconciliation(db.handle, {
      selector,
      acknowledgedAt: exactAcknowledgedAt,
      operatorId,
      evidence,
      expectedPartIds: held.map((row) => row.partId),
    });
    process.stdout.write(
      asJson
        ? `${JSON.stringify(result, null, 2)}\n`
        : `Reconciled ${result.partIds.length} part(s) at exact ACK ${result.acknowledgedAt}.\n`,
    );
    return 0;
  } finally {
    db.close();
  }
}

function parsedTelegramMessageId(value: unknown): number | null {
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function remoteReconciliationProof(values: Record<string, unknown>): {
  readonly telegramMessageId: number;
  readonly acknowledgedAt: string;
  readonly operatorId: string;
  readonly evidence: string;
} | null {
  const telegramMessageId = parsedTelegramMessageId(values['telegram-message-id']);
  const acknowledgedAt = values['ack-at'];
  const operatorId = values['operator'];
  const evidence = values['evidence'];
  if (
    telegramMessageId === null ||
    typeof acknowledgedAt !== 'string' ||
    typeof operatorId !== 'string' ||
    typeof evidence !== 'string'
  ) {
    return null;
  }
  return { telegramMessageId, acknowledgedAt, operatorId, evidence };
}

async function assertDaemonStoppedForOutboxMutation(
  db: DatabaseSync,
  loaded: Awaited<ReturnType<typeof loadConfig>>,
  action: string,
  daemonRunningError?: string,
): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const daemon = await inspectDaemonControl(db, loaded.paths.pidFile, loaded.paths.root);
    if (daemon.source === 'none' || daemon.record === null || daemon.process === null) return;
    if (daemon.process.alive) {
      throw new Error(
        daemonRunningError ??
          `stop the OpenMurmur daemon before ${action} (pid ${daemon.record.pid})`,
      );
    }
    if (daemon.source === 'legacy') return;
    if (await releaseDaemonPid(db, loaded.paths.pidFile, daemon.record)) return;
  }
  throw new Error(`daemon ownership changed while checking whether it was safe to ${action}`);
}

type StoppedDaemonTelegramCommand =
  | 'setup telegram owner'
  | 'setup telegram send-only'
  | 'telegram poll';

function stoppedDaemonTelegramRunbook(root: string, command: StoppedDaemonTelegramCommand): string {
  const quotedRoot = shellQuotedStateRoot(root);
  const commandContext = recoveryCommandContextForRoot(root);
  return [
    'The OpenMurmur daemon must be stopped before this Telegram control operation.',
    ...(quotedRoot === null
      ? [
          'The state root is not safe to print. Set OPENMURMUR_STATE_ROOT to its exact value',
          'outside this terminal, then use the placeholder below.',
        ]
      : []),
    'Run from the repository checkout:',
    `  ${openMurmurRecoveryCommand(commandContext, 'stop')}`,
    `  ${openMurmurRecoveryCommand(commandContext, command)}`,
    `  ${openMurmurRecoveryCommand(commandContext, 'start')}`,
  ].join('\n');
}

/** Keeps credential publication and diagnostic getUpdates exclusive with the exact root owner. */
export async function withStoppedDaemonForTelegram<T>(
  loaded: Awaited<ReturnType<typeof loadConfig>>,
  command: StoppedDaemonTelegramCommand,
  action: (db: DatabaseSync) => Promise<T>,
  maintenanceDependencies: Parameters<typeof claimDaemonMaintenance>[3] = {},
): Promise<T> {
  const db = openDatabase({ file: loaded.paths.databaseFile });
  let claim: Awaited<ReturnType<typeof claimDaemonMaintenance>> | null = null;
  let renewalFailure: Error | null = null;
  let renewalTimer: NodeJS.Timeout | null = null;
  try {
    claim = await claimDaemonMaintenance(db.handle, loaded.paths.pidFile, loaded.paths.root, {
      ...maintenanceDependencies,
      daemonRunningError: stoppedDaemonTelegramRunbook(loaded.paths.root, command),
    });
    assertCurrentDaemonMaintenance(db.handle, claim);
    const renew = () => {
      if (claim === null) return;
      try {
        if (!renewDaemonMaintenance(db.handle, claim)) {
          renewalFailure = new Error('exclusive Telegram maintenance ownership was lost');
        } else {
          renewalFailure = null;
        }
      } catch (error) {
        renewalFailure = new Error('could not renew exclusive Telegram maintenance ownership', {
          cause: error,
        });
      }
    };
    renewalTimer = setInterval(renew, DAEMON_MAINTENANCE_RENEW_INTERVAL_MS);
    renewalTimer.unref();
    const result = await action(db.handle);
    assertCurrentDaemonMaintenance(db.handle, claim);
    renew();
    if (renewalFailure !== null) {
      // A transient claimed_at refresh failure cannot forfeit a live exact-birth
      // authority. Re-prove the generation synchronously before returning.
      assertCurrentDaemonMaintenance(db.handle, claim);
      renewalFailure = null;
    }
    return result;
  } finally {
    if (renewalTimer !== null) clearInterval(renewalTimer);
    if (claim !== null) await releaseDaemonMaintenance(db.handle, loaded.paths.pidFile, claim);
    db.close();
  }
}

function writeRemoteReconciliationReport(
  report: ReturnType<typeof listUnacknowledgedTelegramDeliveries>,
  asJson: boolean,
): void {
  process.stdout.write(
    asJson
      ? `${JSON.stringify(report, null, 2)}\n`
      : `${renderUnacknowledgedTelegramDeliveries(report)}\n`,
  );
}

function writeRemoteReconciliationResult(
  result: ReturnType<typeof applyTelegramDeliveryReconciliation>,
  asJson: boolean,
): void {
  if (asJson) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else if (result.alreadyApplied) {
    process.stdout.write(
      `Remote ACK was already reconciled by audit ${result.reconciliationId}.\n`,
    );
  } else {
    process.stdout.write(
      `Reconciled ${result.deliveryPartId} to Telegram message ${result.telegramMessageId} at ${result.acknowledgedAt}.\n`,
    );
  }
}

async function telegramDeliveryReconciliationCommand(
  loaded: Awaited<ReturnType<typeof loadConfig>>,
  action: string | undefined,
  values: Record<string, unknown>,
  yes: boolean,
  asJson: boolean,
): Promise<number> {
  if (action !== undefined && action !== 'report' && action !== 'apply') {
    process.stderr.write(
      'Usage: pnpm openmurmur delivery reconcile-remote [report|apply] [--delivery-part ID]\n',
    );
    return 1;
  }
  const mode = action ?? 'report';
  const deliveryPartId =
    typeof values['delivery-part'] === 'string' ? values['delivery-part'].trim() : undefined;
  if (mode === 'apply' && (deliveryPartId === undefined || deliveryPartId.length === 0)) {
    process.stderr.write('Apply requires one exact --delivery-part selector.\n');
    return 1;
  }

  const db = openDatabase({ file: loaded.paths.databaseFile });
  try {
    const report = listUnacknowledgedTelegramDeliveries(db.handle, {
      ...(deliveryPartId === undefined ? {} : { deliveryPartId }),
    });
    if (mode === 'report') {
      writeRemoteReconciliationReport(report, asJson);
      return 0;
    }

    const proof = remoteReconciliationProof(values);
    if (proof === null) {
      process.stderr.write(
        'Apply requires --telegram-message-id N, --ack-at YYYY-MM-DDTHH:mm:ss.sssZ, --operator ID and --evidence TEXT.\n',
      );
      return 1;
    }
    if (report.deliveries.length > 1) {
      process.stderr.write('Exact --delivery-part selector resolved to multiple rows.\n');
      return 1;
    }
    const expected = report.deliveries[0];
    if (expected?.blockedReason) {
      process.stderr.write(`Delivery cannot be reconciled: ${expected.blockedReason}.\n`);
      return 1;
    }
    if (asJson && !yes) {
      process.stderr.write('JSON apply requires explicit --yes confirmation.\n');
      return 1;
    }
    if (!asJson) {
      process.stdout.write(`${renderUnacknowledgedTelegramDeliveries(report)}\n`);
      process.stdout.write(
        'Warning: Telegram has no post-hoc lookup here. Apply only after comparing the payload hash with independent Telegram evidence.\n',
      );
    }
    if (
      !yes &&
      !(await confirm(
        `\nRecord Telegram message ${proof.telegramMessageId} as the exact ACK for ${deliveryPartId}? [y/N] `,
      ))
    ) {
      process.stdout.write('Cancelled. No outbox or domain facts were changed.\n');
      return 1;
    }

    await assertDaemonStoppedForOutboxMutation(db.handle, loaded, 'reconciling remote delivery');
    const result = applyTelegramDeliveryReconciliation(db.handle, {
      deliveryPartId: deliveryPartId ?? '',
      telegramMessageId: proof.telegramMessageId,
      acknowledgedAt: proof.acknowledgedAt,
      operatorId: proof.operatorId,
      evidence: proof.evidence,
      ...(expected === undefined ? {} : { expected }),
      requireDaemonStopped: true,
    });
    writeRemoteReconciliationResult(result, asJson);
    return 0;
  } finally {
    db.close();
  }
}

async function telegramCommand(
  loaded: Awaited<ReturnType<typeof loadConfig>>,
  subcommand: string | undefined,
): Promise<number> {
  if (subcommand === 'poll') {
    if (!loaded.config.telegram.receiveUpdates) {
      process.stderr.write(
        'Telegram polling is disabled on this send-only host. Run this only on the explicit input owner with telegram.receiveUpdates=true.\n',
      );
      return 1;
    }
    return withStoppedDaemonForTelegram(loaded, 'telegram poll', async (db) => {
      const secrets = await keychain.load();
      if (secrets === null) {
        const setupCommand = openMurmurRecoveryCommand(
          recoveryCommandContextForRoot(loaded.paths.root),
          'setup telegram owner',
        );
        process.stderr.write(`Telegram is not configured. Run: ${setupCommand}\n`);
        return 1;
      }
      const client = new TelegramClient({
        token: secrets.token,
        baseUrl: loaded.config.telegram.apiBaseUrl,
      });
      const botScope = telegramBotScope(secrets.token);
      const inspection = await pollTelegramReadOnly(
        db,
        client,
        botScope,
        secrets.chatId,
        true,
        openMurmurRecoveryCommand(
          recoveryCommandContextForRoot(loaded.paths.root),
          'setup telegram owner',
        ),
      );
      process.stdout.write(
        `Fetched ${inspection.updates.length} update(s) from offset ${inspection.offset} ` +
          '(read-only; offset unchanged).\n',
      );
      for (const update of inspection.updates) {
        process.stdout.write(`  #${update.updateId}: ${update.kind}\n`);
      }
      return 0;
    });
  }

  if (subcommand === 'test') {
    const secrets = await keychain.load();
    if (secrets === null) {
      const role = loaded.config.telegram.receiveUpdates ? 'owner' : 'send-only';
      const setupCommand = openMurmurRecoveryCommand(
        recoveryCommandContextForRoot(loaded.paths.root),
        `setup telegram ${role}`,
      );
      process.stderr.write(`Telegram is not configured. Run: ${setupCommand}\n`);
      return 1;
    }
    const client = new TelegramClient({
      token: secrets.token,
      baseUrl: loaded.config.telegram.apiBaseUrl,
    });
    const me = await client.getMe();
    await client.sendMessage(
      secrets.chatId,
      `✅ Тестовое сообщение от OpenMurmur ${VERSION}\nБот: @${me.username ?? me.first_name}`,
    );
    process.stdout.write(`Sent a test message to chat ${secrets.chatId}.\n`);
    return 0;
  }

  process.stderr.write('Usage: pnpm openmurmur telegram <test|poll>\n');
  return 1;
}

interface TelegramUpdatePoller {
  getUpdates(offset: number, timeoutSeconds: number): Promise<readonly TelegramUpdate[]>;
}

export async function pollTelegramReadOnly(
  db: DatabaseSync,
  client: TelegramUpdatePoller,
  botScope: string,
  chatId: number,
  receiveUpdates: boolean,
  missingOffsetSetupCommand?: string,
): Promise<{
  readonly offset: number;
  readonly updates: readonly { readonly updateId: number; readonly kind: string }[];
}> {
  if (!receiveUpdates) {
    throw new Error('Telegram polling is disabled on this send-only host');
  }
  const offset = readOffset(db, botScope, missingOffsetSetupCommand);
  const updates = await client.getUpdates(offset, 5);
  return {
    offset,
    updates: updates.map((update) => ({
      updateId: update.update_id,
      kind: routeUpdate(update, chatId).kind,
    })),
  };
}

async function transcribeFile(
  loaded: Awaited<ReturnType<typeof loadConfig>>,
  file: string,
  logger: ReturnType<typeof createLogger>,
  asJson: boolean,
): Promise<number> {
  const probe = await probeAudio(loaded.config.audio.ffprobePath, file);
  if (probe === null) {
    process.stderr.write(`Could not read "${file}" as audio.\n`);
    return 1;
  }

  await ensureDirectories(loaded.paths);
  const wavPath = join(loaded.paths.tempDir, `${randomUUID()}.16k.wav`);
  if (!(await normalizeToWav(loaded.config.audio.ffmpegPath, file, wavPath))) {
    process.stderr.write('Could not decode the file to 16 kHz mono.\n');
    return 1;
  }

  const asr = createAsrBackend(loaded, logger);
  try {
    const readiness = await asr.ready();
    if (!readiness.ok) {
      process.stderr.write(`${readiness.reason}\n`);
      return 1;
    }
    const result = await asr.transcribe({ audioPath: wavPath, requestId: randomUUID() });
    process.stdout.write(asJson ? `${JSON.stringify(result, null, 2)}\n` : `${result.text}\n`);
    return 0;
  } finally {
    await asr.close();
    await rm(wavPath, { force: true });
  }
}

async function retentionCommand(
  loaded: Awaited<ReturnType<typeof loadConfig>>,
  subcommand: string | undefined,
  yes: boolean,
  asJson: boolean,
): Promise<number> {
  if (subcommand !== 'dry-run' && subcommand !== 'apply') {
    process.stderr.write('Usage: pnpm openmurmur retention <dry-run|apply>\n');
    return 1;
  }

  const db = openDatabase({ file: loaded.paths.databaseFile });
  try {
    const plan = planRetention(db.handle, loaded.config.retention);

    if (asJson) {
      process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
    } else {
      process.stdout.write(`${plan.candidates.length} file(s) eligible for deletion:\n`);
      for (const candidate of plan.candidates) {
        process.stdout.write(`  ${candidate.path}\n      ${candidate.reason}\n`);
      }
      if (plan.blocked.length > 0) {
        process.stdout.write(`\n${plan.blocked.length} file(s) kept despite their age:\n`);
        for (const blocked of plan.blocked) {
          process.stdout.write(`  ${blocked.path}\n      held: ${blocked.reason}\n`);
        }
      }
      process.stdout.write(`\nWould free ${(plan.totalBytes / 1024 ** 2).toFixed(1)} MB.\n`);
    }

    if (subcommand === 'dry-run') return 0;
    if (plan.candidates.length === 0) return 0;
    if (!yes && !(await confirm(`\nDelete ${plan.candidates.length} file(s)? [y/N] `))) {
      process.stdout.write('Cancelled. Nothing was deleted.\n');
      return 1;
    }

    const result = await applyRetention(db.handle, plan);
    process.stdout.write(
      `Deleted ${result.deleted} file(s), freed ${(result.freedBytes / 1024 ** 2).toFixed(1)} MB.\n`,
    );
    for (const error of result.errors) {
      process.stderr.write(`  failed: ${error.path} — ${error.error}\n`);
    }
    return result.errors.length > 0 ? 1 : 0;
  } finally {
    db.close();
  }
}

if (import.meta.main) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    if (error instanceof CliArgumentError || error instanceof ConfigError) {
      process.stderr.write(`${error.message}\n`);
    } else {
      process.stderr.write(`Error: ${(error as Error).message}\n`);
    }
    process.exitCode = 1;
  }
}

export { main, TranscriptRepository };
