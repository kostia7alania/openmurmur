#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { access, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { FfmpegCapture } from '../capture/ffmpeg.ts';
import { normalizeToWav, probeAudio } from '../capture/probe.ts';
import { recoverAfterCrash, renderRecoveryReport } from '../capture/recovery.ts';
import { ensureDirectories, loadConfig } from '../config/load.ts';
import { ConfigError } from '../config/schema.ts';
import { openDatabase, transaction } from '../database/db.ts';
import { TranscriptRepository } from '../database/repository.ts';
import { renderSearchResults, searchTranscripts } from '../database/search.ts';
import {
  buildDigest,
  hasUnfinishedSessionsForDate,
  renderDigest,
  renderDigestMarkdown,
  scheduledDigestDate,
  storeDigest,
  zonedDateTime,
} from '../digest/daily.ts';
import { createLogger } from '../logging/logger.ts';
import { applyRetention, planRetention } from '../retention/policy.ts';
import { EnergyVad, rmsDbfs } from '../sessionizer/vad.ts';
import { TelegramClient } from '../telegram/client.ts';
import { keychain, telegramBotScope } from '../telegram/keychain.ts';
import { Outbox, type OutboxPayload } from '../telegram/outbox.ts';
import { nextOffsetFor, readOffset, routeUpdate, writeOffset } from '../telegram/router.ts';
import { writeTextAtomically } from '../util/atomic-file.ts';
import { systemClock } from '../util/clock.ts';
import { createAsrBackend } from './backends.ts';
import { Daemon, inspectDaemonProcess, readDaemonPid } from './daemon.ts';
import { doctorExitCode, formatChecks, runDoctor } from './doctor.ts';
import { applySetup, planSetup, renderSetupPlan, setupTelegram } from './setup.ts';
import { VERSION } from './version.ts';

const USAGE = `openmurmur ${VERSION} — private ambient journal for Apple Silicon

Usage: openmurmur <command> [options]

Setup and diagnostics
  doctor                 Check every dependency. Read-only: changes nothing.
  setup                  Create directories, config and database (shows a plan first).
  setup telegram         Connect a Telegram bot. Token is entered hidden.
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
  search TEXT            Search every stored transcript.
  transcribe FILE        Transcribe one audio file locally and print the text.
  digest DATE            Build and print the digest for YYYY-MM-DD.
  retention dry-run      Show exactly what retention would delete, and why.
  retention apply        Delete only what dry-run proved eligible.

Options
  --root DIR             Override the state directory (default: OPENMURMUR_HOME).
  --json                 Machine-readable output where supported.
  --yes                  Skip the confirmation prompt.
  --limit N              Maximum search results (default 20).
  --since ISO --until ISO  Restrict search to a time range.
  --help, --version
`;

async function main(argv: readonly string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    strict: false,
    options: {
      root: { type: 'string' },
      json: { type: 'boolean', default: false },
      yes: { type: 'boolean', default: false },
      limit: { type: 'string' },
      since: { type: 'string' },
      until: { type: 'string' },
      help: { type: 'boolean', default: false, short: 'h' },
      version: { type: 'boolean', default: false },
    },
  });

  if (values['version'] === true) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  const command = positionals[0];
  if (values['help'] === true || command === undefined || command === 'help') {
    process.stdout.write(USAGE);
    return command === undefined ? 1 : 0;
  }

  const root = typeof values['root'] === 'string' ? values['root'] : undefined;
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
      return setupCommand(loaded, positionals[1], values['yes'] === true);

    case 'capture':
      return captureCommand(
        positionals[1],
        loaded.config.audio.ffmpegPath,
        loaded.config.audio.captureDevice,
      );

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

    case 'search': {
      const query = positionals.slice(1).join(' ');
      if (query.length === 0) {
        process.stderr.write('Usage: openmurmur search TEXT\n');
        return 1;
      }
      return searchCommand(loaded, query, values, asJson);
    }

    case 'transcribe': {
      const file = positionals[1];
      if (file === undefined) {
        process.stderr.write('Usage: openmurmur transcribe FILE\n');
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
    if (scheduled) {
      const existing = db.handle
        .prepare('SELECT 1 AS present FROM digests WHERE digest_date = ?')
        .get(date);
      if (
        existing !== undefined ||
        hasUnfinishedSessionsForDate(db.handle, date, loaded.config.digest.timezone)
      ) {
        return 0;
      }
    }

    const digest = buildDigest(db.handle, date, loaded.config.digest.timezone);
    const rendered = renderDigest(digest, loaded.config.digest.timezone);
    let payload: OutboxPayload = { type: 'text', text: rendered, parseMode: 'HTML' };
    if (rendered.length > loaded.config.telegram.transcriptInlineLimit) {
      const filename = `digest-${date}.md`;
      const path = join(loaded.paths.transcriptsDir, filename);
      await writeTextAtomically(path, renderDigestMarkdown(digest, loaded.config.digest.timezone));
      payload = { type: 'document', path, filename, caption: `📅 Дайджест за ${date}` };
    }
    transaction(db.handle, () => {
      storeDigest(db.handle, digest);
      new Outbox(db.handle).enqueue({
        deliveryPartId: `digest:${date}`,
        kind: 'digest',
        ordinal: 30,
        payload,
      });
    });
    process.stdout.write(asJson ? `${JSON.stringify(digest, null, 2)}\n` : `${rendered}\n`);
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
    // Exit 1 on no match, so `openmurmur search x || echo none` works in a script.
    return hits.length > 0 ? 0 : 1;
  } finally {
    db.close();
  }
}

async function setupCommand(
  loaded: Awaited<ReturnType<typeof loadConfig>>,
  subcommand: string | undefined,
  yes: boolean,
): Promise<number> {
  if (subcommand === 'telegram') {
    await ensureDirectories(loaded.paths);
    const result = await setupTelegram(loaded.paths, loaded.config.telegram.apiBaseUrl, (message) =>
      process.stdout.write(`${message}\n`),
    );
    process.stdout.write(`\n✅ Connected @${result.botUsername}, chat ${result.chatId}\n`);
    return 0;
  }

  // Every filesystem change is printed before anything is written.
  const plan = planSetup(loaded.paths, await exists(loaded.paths.configFile));
  process.stdout.write(`${renderSetupPlan(plan)}\n\n`);
  if (!yes && !(await confirm('Proceed? [y/N] '))) {
    process.stdout.write('Cancelled. Nothing was changed.\n');
    return 1;
  }

  await applySetup(loaded.paths, plan);
  process.stdout.write('\n✅ Setup complete. Next: openmurmur setup telegram\n');
  return 0;
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
  ffmpegPath: string,
  captureDevice: string,
): Promise<number> | number {
  if (subcommand !== 'test') {
    process.stderr.write('Unknown subcommand. Did you mean `capture test`?\n');
    return 1;
  }
  return captureTest(ffmpegPath, captureDevice);
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
  const record = await readDaemonPid(loaded.paths.pidFile);
  if (record === null) {
    process.stdout.write('No running daemon found.\n');
    return 1;
  }
  if (record.root !== null && record.root !== loaded.paths.root) {
    process.stderr.write(`PID file belongs to a different OpenMurmur root: ${record.root}\n`);
    return 1;
  }
  const state = await inspectDaemonProcess(record.pid);
  if (!state.alive) {
    process.stderr.write(
      `Daemon pid ${record.pid} is no longer running; removed stale PID file.\n`,
    );
    await rm(loaded.paths.pidFile, { force: true });
    return 1;
  }
  if (!state.identityMatches) {
    process.stderr.write(
      `Refusing to signal pid ${record.pid}: it is not recognisable as an OpenMurmur daemon.\n`,
    );
    return 1;
  }
  try {
    process.kill(record.pid, 'SIGTERM');
    process.stdout.write(`Sent SIGTERM to pid ${record.pid}.\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`Could not stop pid ${record.pid}: ${(error as Error).message}\n`);
    return 1;
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

/** How long to wait for the first frame before assuming a pending TCC prompt. */
const FIRST_FRAME_TIMEOUT_MS = 10_000;

/** Best-effort name of the app that owns the microphone grant. */
function terminalHint(): string {
  return process.env['TERM_PROGRAM'] ?? 'your terminal';
}

/**
 * Opens the microphone for a few seconds and reports levels. This is the
 * command that triggers the macOS TCC prompt on a fresh install, which is why
 * the README tells users to run it before `start`.
 */
async function captureTest(ffmpegPath: string, device: string): Promise<number> {
  const capture = new FfmpegCapture({
    sampleRate: 16_000,
    channels: 1,
    device,
    frameSamples: 512,
    ffmpegPath,
    clock: systemClock,
  });
  const vad = new EnergyVad();

  process.stdout.write('Recording for 5 seconds. Say something.\n');
  process.stdout.write('macOS shows an orange dot near Control Center while the mic is open.\n\n');

  const deadline = Date.now() + 5000;
  let frames = 0;
  let timedOut = false;
  let speechFrames = 0;
  let peakDbfs = Number.NEGATIVE_INFINITY;

  try {
    // Watchdog for the first frame. Until the user answers the macOS
    // permission dialog, ffmpeg neither exits nor produces audio, so without
    // this the command hangs forever and then reports a useless exit code.
    const watchdog = setTimeout(() => {
      if (frames > 0) return;
      process.stderr.write(
        [
          '',
          '⏳ No audio yet after 10 seconds.',
          '',
          'macOS is almost certainly showing a microphone permission dialog.',
          'Click "Allow", then run this command again.',
          '',
          'If you see no dialog, grant access manually:',
          '  System Settings -> Privacy & Security -> Microphone',
          `  and enable it for the app running this command (${terminalHint()}).`,
          '',
          'The permission belongs to the app that launches OpenMurmur, so',
          'switching terminals means being asked again.',
          '',
        ].join('\n'),
      );
      timedOut = true;
      void capture.stop();
    }, FIRST_FRAME_TIMEOUT_MS);

    try {
      for await (const frame of capture.start()) {
        frames += 1;
        if (frames === 1) clearTimeout(watchdog);
        const dbfs = rmsDbfs(frame.pcm);
        if (Number.isFinite(dbfs)) peakDbfs = Math.max(peakDbfs, dbfs);
        if (vad.probability(frame.pcm) >= 0.5) speechFrames += 1;
        if (Date.now() >= deadline) break;
      }
    } finally {
      clearTimeout(watchdog);
    }
  } catch (error) {
    // A capture we stopped ourselves reports a spurious exit; the watchdog has
    // already printed the useful explanation.
    if (!timedOut) process.stderr.write(`\n❌ ${(error as Error).message}\n`);
    return 1;
  } finally {
    await capture.stop();
  }

  if (frames === 0) {
    if (!timedOut) {
      process.stderr.write('❌ No audio frames arrived. The microphone did not open.\n');
    }
    return 1;
  }

  process.stdout.write(`✅ ${frames} frames captured (${(frames * 32) / 1000}s of audio)\n`);
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
  const db = openDatabase({ file: loaded.paths.databaseFile });
  try {
    const pidRecord = await readDaemonPid(loaded.paths.pidFile);
    const pidState = pidRecord === null ? null : await inspectDaemonProcess(pidRecord.pid);
    const alive = pidState?.alive === true && pidState.identityMatches;
    const pid = pidRecord?.pid ?? null;

    const counts = db.handle
      .prepare(
        `SELECT
           (SELECT count(*) FROM audio_sessions)                                    AS sessions,
           (SELECT count(*) FROM audio_sessions WHERE state = 'DONE')               AS done,
           (SELECT count(*) FROM audio_sessions WHERE state = 'REJECTED')           AS rejected,
           (SELECT count(*) FROM jobs WHERE state IN ('pending','leased'))          AS jobs,
           (SELECT count(*) FROM telegram_outbox WHERE state IN ('pending','sending')) AS outbox,
           (SELECT count(*) FROM audio_parts WHERE deleted_at IS NULL)              AS parts`,
      )
      .get() as Record<string, number>;

    const payload = { version: VERSION, daemon: alive ? 'running' : 'stopped', pid, ...counts };
    if (asJson) {
      process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
      return 0;
    }
    process.stdout.write(
      [
        `OpenMurmur ${VERSION}`,
        `Daemon:            ${alive ? `running (pid ${pid})` : 'stopped'}`,
        `Sessions:          ${counts['sessions']} (${counts['done']} delivered, ${counts['rejected']} rejected)`,
        `Audio parts on disk: ${counts['parts']}`,
        `Jobs pending:      ${counts['jobs']}`,
        `Telegram outbox:   ${counts['outbox']}`,
        `SQLite:            ${db.sqliteVersion}`,
        '',
      ].join('\n'),
    );
    return 0;
  } finally {
    db.close();
  }
}

async function telegramCommand(
  loaded: Awaited<ReturnType<typeof loadConfig>>,
  subcommand: string | undefined,
): Promise<number> {
  const secrets = await keychain.load();
  if (secrets === null) {
    process.stderr.write('Telegram is not configured. Run: openmurmur setup telegram\n');
    return 1;
  }
  const client = new TelegramClient({
    token: secrets.token,
    baseUrl: loaded.config.telegram.apiBaseUrl,
  });

  if (subcommand === 'test') {
    const me = await client.getMe();
    await client.sendMessage(
      secrets.chatId,
      `✅ Тестовое сообщение от OpenMurmur ${VERSION}\nБот: @${me.username ?? me.first_name}`,
    );
    process.stdout.write(`Sent a test message to chat ${secrets.chatId}.\n`);
    return 0;
  }

  if (subcommand === 'poll') {
    const db = openDatabase({ file: loaded.paths.databaseFile });
    try {
      const botScope = telegramBotScope(secrets.token);
      const offset = readOffset(db.handle, botScope);
      const updates = await client.getUpdates(offset, 5);
      process.stdout.write(`Fetched ${updates.length} update(s) from offset ${offset}.\n`);
      for (const update of updates) {
        const action = routeUpdate(update, secrets.chatId);
        process.stdout.write(`  #${update.update_id}: ${action.kind}\n`);
      }
      writeOffset(db.handle, nextOffsetFor(updates, offset), botScope);
      return 0;
    } finally {
      db.close();
    }
  }

  process.stderr.write('Usage: openmurmur telegram <test|poll>\n');
  return 1;
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
    process.stderr.write('Usage: openmurmur retention <dry-run|apply>\n');
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

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  if (error instanceof ConfigError) {
    process.stderr.write(`${error.message}\n`);
  } else {
    process.stderr.write(`Error: ${(error as Error).message}\n`);
  }
  process.exitCode = 1;
}

export { main, TranscriptRepository };
