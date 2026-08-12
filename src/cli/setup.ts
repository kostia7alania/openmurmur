import { type FileHandle, open, unlink } from 'node:fs/promises';
import process, { stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline/promises';
import type { DatabaseSync } from 'node:sqlite';
import { ensureDirectories } from '../config/load.ts';
import type { Paths } from '../config/paths.ts';
import { managedDirectories } from '../config/paths.ts';
import { DEFAULT_CONFIG } from '../config/schema.ts';
import { openDatabase } from '../database/db.ts';
import type { TelegramUpdate } from '../telegram/client.ts';
import { TelegramClient } from '../telegram/client.ts';
import {
  keychain,
  type SecretsStore,
  type TelegramSecrets,
  telegramBotScope,
} from '../telegram/keychain.ts';
import { clearOffset, nextOffsetFor, readOffsetOrZero, writeOffset } from '../telegram/router.ts';
import { writeTextAtomically } from '../util/atomic-file.ts';

/**
 * Reads a secret without echoing it and without leaving it in shell history.
 *
 * Node's readline has no built-in hidden mode, so the terminal is put into raw
 * mode for the duration. If stdin is not a TTY (a pipe, CI) the prompt refuses
 * rather than silently reading an echoed line.
 */
export async function promptSecret(prompt: string): Promise<string> {
  if (!stdin.isTTY) {
    throw new Error(
      'A bot token must be typed into an interactive terminal.\n' +
        'It is deliberately not accepted from a pipe, an argument, or an environment variable.',
    );
  }

  stdout.write(prompt);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');

  return new Promise<string>((resolve, reject) => {
    let value = '';
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === '\n' || char === '\r' || char === '\u0004') {
          cleanup();
          stdout.write('\n');
          resolve(value);
          return;
        }
        if (char === '\u0003') {
          cleanup();
          stdout.write('\n');
          reject(new Error('cancelled'));
          return;
        }
        if (char === '\u007f' || char === '\b') {
          value = value.slice(0, -1);
          continue;
        }
        // Ignore other control characters; never echo, not even a mask
        // character, so the token length does not leak to a shoulder surfer.
        if (char >= ' ') value += char;
      }
    };
    const cleanup = () => {
      stdin.removeListener('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
    };
    stdin.on('data', onData);
  });
}

export interface SetupPlan {
  readonly directories: readonly string[];
  readonly configFile: string;
  readonly databaseFile: string;
  readonly willCreateConfig: boolean;
  readonly telegramRole: TelegramSetupRole;
}

export function planSetup(
  paths: Paths,
  configExists: boolean,
  telegramRole: TelegramSetupRole,
): SetupPlan {
  return {
    directories: managedDirectories(paths),
    configFile: paths.configFile,
    databaseFile: paths.databaseFile,
    willCreateConfig: !configExists,
    telegramRole,
  };
}

export function renderSetupPlan(plan: SetupPlan): string {
  const lines = ['pnpm openmurmur setup will make these changes:', ''];
  for (const dir of plan.directories) {
    lines.push(`  create directory  ${setupPathForDisplay(dir)}`);
  }
  if (plan.willCreateConfig) {
    lines.push(`  write config      ${setupPathForDisplay(plan.configFile)}`);
    lines.push(
      `  set Telegram role ${plan.telegramRole} (telegram.receiveUpdates=${plan.telegramRole === 'owner'})`,
    );
  } else {
    lines.push(
      `  keep config       ${setupPathForDisplay(plan.configFile)} (already exists, untouched)`,
    );
    lines.push(`  keep Telegram role ${plan.telegramRole} (from existing config)`);
  }
  lines.push(`  create database   ${setupPathForDisplay(plan.databaseFile)}`);
  lines.push('');
  lines.push('It will NOT download models, contact any network service, or touch the Keychain.');
  return lines.join('\n');
}

export function shellQuotedStateRoot(root: string): string | null {
  if (root.length > 512 || !/^[\x20-\x7e]+$/.test(root)) {
    return null;
  }
  return `'${root.replaceAll("'", `'"'"'`)}'`;
}

function setupPathForDisplay(path: string): string {
  return shellQuotedStateRoot(path) === null ? '<path not printed>' : path;
}

/** The clone-based install has no global binary, so every next step is runnable as printed. */
export function renderSetupNextSteps(
  root: string,
  telegramConfigured: boolean,
  telegramRole?: TelegramSetupRole,
): string {
  const quotedRoot = shellQuotedStateRoot(root);
  const rootArgument = quotedRoot ?? '"$OPENMURMUR_STATE_ROOT"';
  const command = (args: string) => `pnpm openmurmur --root ${rootArgument} ${args}`;
  const lines = [
    ...(quotedRoot === null
      ? [
          'The state root is not safe to print. Set OPENMURMUR_STATE_ROOT to its exact value',
          'outside this terminal, then use the placeholder below.',
        ]
      : []),
    'Next, verify the complete foreground path:',
  ];
  let step = 1;
  if (!telegramConfigured) {
    if (telegramRole === undefined) {
      throw new Error('Telegram role is required before Telegram setup');
    }
    lines.push(`  ${step}. Connect Telegram: ${command(`setup telegram ${telegramRole}`)}`);
    step += 1;
  }
  lines.push(`  ${step}. Verify the microphone: ${command('capture test')}`);
  step += 1;
  lines.push(`  ${step}. Start in the foreground: ${command('start')}`);
  step += 1;
  lines.push(`  ${step}. After "first audio frame received", speak for more than 3 seconds.`);
  step += 1;
  lines.push(`  ${step}. Stop speaking and wait for 60 seconds of silence.`);
  lines.push('Expected in Telegram: source FLAC, then transcript, then report.');
  return lines.join('\n');
}

export async function applySetup(paths: Paths, plan: SetupPlan): Promise<void> {
  await ensureDirectories(paths);
  if (plan.willCreateConfig) {
    const config = {
      ...DEFAULT_CONFIG,
      telegram: {
        ...DEFAULT_CONFIG.telegram,
        receiveUpdates: plan.telegramRole === 'owner',
      },
    };
    await writeTextAtomically(paths.configFile, `${JSON.stringify(config, null, 2)}\n`, {
      replaceExisting: false,
    });
  }
  const db = openDatabase({ file: paths.databaseFile });
  db.close();
}

export interface TelegramSetupResult {
  readonly botDisplay: string;
  readonly chatId: number;
  readonly role: TelegramSetupRole;
}

export type TelegramSetupRole = 'owner' | 'send-only';

export interface TelegramSetupDependencies {
  readonly promptToken?: () => Promise<string>;
  readonly promptSendOnlyChatId?: () => Promise<number>;
  readonly confirmRecipient?: (prompt: string) => Promise<boolean>;
  readonly secrets?: SecretsStore;
  readonly fetchImpl?: typeof fetch;
  /** Test seam; production uses one per-user lock shared by every state root. */
  readonly setupLockPath?: string;
}

const TELEGRAM_SETUP_LOCK_PATH = `/private/tmp/openmurmur-telegram-setup-${typeof process.getuid === 'function' ? process.getuid() : 'user'}.lock`;

async function withTelegramSetupLock<T>(
  lockPath: string,
  log: (message: string) => void,
  action: () => Promise<T>,
): Promise<T> {
  let handle: FileHandle;
  try {
    handle = await open(lockPath, 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(
        `Another Telegram setup is running, or a prior setup was interrupted. Verify no setup process is active, remove the stale lock ${lockPath}, and retry.`,
      );
    }
    throw error;
  }

  try {
    return await action();
  } finally {
    try {
      await handle.close();
    } catch {
      log(
        `Warning: Telegram setup lock handle cleanup failed; later setup will fail closed: ${lockPath}`,
      );
    }
    try {
      await unlink(lockPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        log(
          `Warning: Telegram setup lock cleanup failed; later setup will fail closed: ${lockPath}`,
        );
      }
    }
  }
}

export function renderSetupCompletion(root: string, telegramRole: TelegramSetupRole): string {
  return `✅ Setup complete.\n\n${renderSetupNextSteps(root, false, telegramRole)}`;
}

export function renderTelegramSetupCompletion(root: string, result: TelegramSetupResult): string {
  return `✅ Connected ${result.botDisplay}, chat ${result.chatId} (${result.role})\n\n${renderSetupNextSteps(root, true)}`;
}

/**
 * Interactive Telegram onboarding with an explicit input-owner/send-only role.
 * The owner discovers the chat through a fresh `/start`; a send-only sibling
 * copies that confirmed private chat ID without touching the update stream.
 */
export async function setupTelegram(
  paths: Paths,
  apiBaseUrl: string,
  role: TelegramSetupRole,
  log: (message: string) => void,
  dependencies: TelegramSetupDependencies = {},
): Promise<TelegramSetupResult> {
  return withTelegramSetupLock(dependencies.setupLockPath ?? TELEGRAM_SETUP_LOCK_PATH, log, () =>
    setupTelegramLocked(paths, apiBaseUrl, role, log, dependencies),
  );
}

async function setupTelegramLocked(
  paths: Paths,
  apiBaseUrl: string,
  role: TelegramSetupRole,
  log: (message: string) => void,
  dependencies: TelegramSetupDependencies,
): Promise<TelegramSetupResult> {
  const token = await (
    dependencies.promptToken ?? (() => promptSecret('Telegram bot token (input hidden): '))
  )();
  if (token.trim().length === 0) throw new Error('no token entered');
  const normalizedToken = token.trim();
  const secretsStore = dependencies.secrets ?? keychain;

  if (role === 'owner') {
    const previousSecrets = await secretsStore.peek();
    if (
      previousSecrets !== null &&
      telegramBotScope(previousSecrets.token) === telegramBotScope(normalizedToken)
    ) {
      throw new Error(
        'This bot token is already configured as an input owner. Rebinding it could discard queued updates; create a separate bot with @BotFather and retry with its token.',
      );
    }
  }

  const client = new TelegramClient({
    token: normalizedToken,
    baseUrl: apiBaseUrl,
    ...(dependencies.fetchImpl === undefined ? {} : { fetchImpl: dependencies.fetchImpl }),
  });
  const confirmRecipient = dependencies.confirmRecipient ?? confirmTelegramOwner;

  log('Verifying the token with getMe...');
  const me = await client.getMe();
  if (!me.is_bot) throw new Error('that token does not belong to a bot');
  const botUsername = telegramUsername(me.username);
  const botDisplay = telegramIdentityDisplay(me.username, me.first_name, 'Telegram bot');
  log(`  Bot: ${botDisplay} (id ${me.id})`);

  let chatId: number;
  let commit: TelegramSetupCommit;
  if (role === 'owner') {
    // Establish the boundary before asking for /start. Otherwise a message left
    // in this bot's queue by an earlier owner could silently become the allowlist.
    const baselineOffset = await drainUpdateBacklog(client);

    log('');
    log(`Now open Telegram, find ${botDisplay}, and send it:  /start`);
    log('Waiting for the message...');

    const accepted = await waitForStart(client, baselineOffset, botUsername);
    chatId = accepted.chatId;
    const account = telegramIdentityDisplay(
      accepted.username ?? undefined,
      accepted.firstName,
      'Telegram user',
    );
    log(`  Account: ${account} (user id ${accepted.userId})`);
    log(`  Chat ID: ${chatId}`);
    if (
      !(await confirmRecipient(`Use ${account}, chat ${chatId} as this bot's input owner? [y/N] `))
    ) {
      throw new Error('Telegram setup cancelled; nothing was stored');
    }
    commit = { role, nextOffset: accepted.nextOffset };
  } else {
    log('');
    log('This host will only send. Copy the private chat ID printed by the input-owner setup.');
    chatId = await (dependencies.promptSendOnlyChatId ?? (() => promptTelegramChatId()))();
    if (!Number.isSafeInteger(chatId) || chatId <= 0) {
      throw new Error('Telegram chat ID must be a positive safe integer copied from owner setup');
    }
    log(`  Chat ID: ${chatId}`);
    if (
      !(await confirmRecipient(
        `Send to chat ${chatId} without receiving updates on this host? [y/N] `,
      ))
    ) {
      throw new Error('Telegram setup cancelled; nothing was stored');
    }
    commit = { role };
  }

  const db = openDatabase({ file: paths.databaseFile });
  try {
    await commitTelegramSetup(
      db.handle,
      secretsStore,
      { token: normalizedToken, chatId },
      commit,
      () =>
        client.sendMessage(
          chatId,
          role === 'owner'
            ? '✅ OpenMurmur подключён.\n\n' +
                'Этот чат будет получать аудио, транскрипты, отчёты и статус записи.\n' +
                'Команды: /status, /health, /settings, /help'
            : '✅ OpenMurmur подключён в режиме только отправки.\n\n' +
                'Команды обрабатывает назначенный input-owner этого бота.',
        ),
    );
  } finally {
    db.close();
  }
  log('  Stored the token and chat ID in the macOS Keychain (service io.openmurmur).');
  log('  Sent a test message.');

  return { botDisplay, chatId, role };
}

export async function promptTelegramChatId(): Promise<number> {
  if (!stdin.isTTY) {
    throw new Error('The send-only chat ID must be entered in an interactive terminal.');
  }
  const input = createInterface({ input: stdin, output: stdout });
  try {
    const value = Number(
      (await input.question('Private chat ID copied from owner setup: ')).trim(),
    );
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error('Telegram chat ID must be a positive safe integer copied from owner setup');
    }
    return value;
  } finally {
    input.close();
  }
}

export type TelegramSetupCommit =
  | { readonly role: 'owner'; readonly nextOffset: number }
  | { readonly role: 'send-only' };

function publishTelegramSetupCursor(
  db: DatabaseSync,
  newBotScope: string,
  previousBotScope: string,
  commit: TelegramSetupCommit,
): () => void {
  if (commit.role === 'send-only') {
    const previous = db
      .prepare('SELECT next_offset FROM telegram_offset WHERE bot_scope = ?')
      .get(newBotScope) as { next_offset: number } | undefined;
    clearOffset(db, newBotScope);
    return previous === undefined
      ? () => clearOffset(db, newBotScope)
      : () => writeOffset(db, previous.next_offset, newBotScope);
  }

  const previousOffset = readOffsetOrZero(db, previousBotScope);
  writeOffset(db, commit.nextOffset, newBotScope);
  return newBotScope === previousBotScope
    ? () => writeOffset(db, previousOffset, previousBotScope)
    : () => clearOffset(db, newBotScope);
}

/**
 * Commits the allowlisted recipient and, for the sole owner, its update cursor.
 * Send-only never creates or advances a cursor. Owner setup publishes the
 * credential-scoped cursor before Keychain credentials; ordinary failures
 * restore the previous pair and cursor or fail closed with no secrets.
 */
export async function commitTelegramSetup(
  db: DatabaseSync,
  store: SecretsStore,
  secrets: TelegramSecrets,
  commit: TelegramSetupCommit,
  confirmDelivery: () => Promise<unknown>,
): Promise<void> {
  const previousSecrets = await store.load();
  const replacesDestination =
    previousSecrets === null ||
    previousSecrets.token !== secrets.token ||
    previousSecrets.chatId !== secrets.chatId;
  if (
    replacesDestination &&
    db
      .prepare("SELECT 1 FROM telegram_outbox WHERE state IN ('pending','sending','dead') LIMIT 1")
      .get() !== undefined
  ) {
    throw new Error(
      'Cannot replace Telegram credentials while unresolved deliveries exist. ' +
        'Restore the current credentials, finish or reconcile those deliveries, then retry setup.',
    );
  }
  const newBotScope = telegramBotScope(secrets.token);
  const previousBotScope =
    previousSecrets === null ? 'legacy' : telegramBotScope(previousSecrets.token);
  let stored = false;
  let restoreCursor: (() => void) | null = null;

  try {
    restoreCursor = publishTelegramSetupCursor(db, newBotScope, previousBotScope, commit);
    await store.storeSecrets(secrets);
    stored = true;
    await confirmDelivery();
  } catch (error) {
    const rollbackErrors: unknown[] = [];
    if (stored) {
      try {
        await store.clear();
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }

    let offsetRestored = restoreCursor === null;
    if (restoreCursor !== null) {
      try {
        restoreCursor();
        offsetRestored = true;
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }

    if (stored && offsetRestored && previousSecrets !== null) {
      try {
        await store.storeSecrets(previousSecrets);
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }

    if (rollbackErrors.length > 0) {
      throw new AggregateError(
        [error, ...rollbackErrors],
        'Telegram setup failed and its previous configuration could not be fully restored',
      );
    }
    throw error;
  }
}

interface UpdatePoller {
  getUpdates(offset: number, timeoutSeconds: number): Promise<TelegramUpdate[]>;
}

export async function drainUpdateBacklog(client: UpdatePoller, maxBatches = 100): Promise<number> {
  let offset = 0;
  for (let batch = 0; batch < maxBatches; batch += 1) {
    const updates = await client.getUpdates(offset, 0);
    if (updates.length === 0) return offset;
    offset = nextOffsetFor(updates, offset);
  }
  throw new Error('Telegram update backlog is still growing; clear it before setup');
}

export async function waitForStart(
  client: UpdatePoller,
  baselineOffset: number,
  botUsername: string | null,
  attempts = 30,
): Promise<{
  chatId: number;
  nextOffset: number;
  userId: number;
  username: string | null;
  firstName: string;
}> {
  let offset = baselineOffset;
  for (let i = 0; i < attempts; i += 1) {
    const updates = await client.getUpdates(offset, 10);
    for (const update of updates) {
      offset = Math.max(offset, update.update_id + 1);
      const message = update.message;
      if (message === undefined) continue;
      if (message.chat.type !== 'private') continue;
      if (message.from === undefined || message.from.is_bot) continue;

      const command = (message.text ?? '').trim().split(/\s+/)[0]?.toLowerCase();
      const direct = '/start';
      const addressed =
        botUsername === null ? null : `/start@${botUsername.toLocaleLowerCase('en-US')}`;
      if (command === direct || command === addressed) {
        return {
          chatId: message.chat.id,
          nextOffset: offset,
          userId: message.from.id,
          username: message.from.username ?? null,
          firstName: message.from.first_name,
        };
      }
    }
  }
  throw new Error(
    'No message arrived. Make sure you messaged the right bot, then run ' +
      '`pnpm openmurmur setup telegram owner` again.',
  );
}

const TELEGRAM_IDENTITY_MAX_CODE_POINTS = 80;

function telegramUsername(value: string | undefined): string | null {
  return value !== undefined && /^[A-Za-z0-9_]{5,32}$/.test(value) ? value : null;
}

/** Makes Bot API identity fields safe for logs and interactive confirmation prompts. */
function telegramIdentityDisplay(
  username: string | undefined,
  firstName: string,
  fallback: string,
): string {
  const validUsername = telegramUsername(username);
  if (validUsername !== null) return `@${validUsername}`;

  let safe = '';
  for (const character of firstName.normalize('NFC')) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (/\p{Cf}/u.test(character)) continue;
    safe += codePoint <= 31 || (codePoint >= 127 && codePoint <= 159) ? ' ' : character;
  }
  const collapsed = safe.replace(/\s+/gu, ' ').trim() || fallback;
  const codePoints = [...collapsed];
  if (codePoints.length <= TELEGRAM_IDENTITY_MAX_CODE_POINTS) return collapsed;
  return `${codePoints.slice(0, TELEGRAM_IDENTITY_MAX_CODE_POINTS - 1).join('')}…`;
}

export async function confirmTelegramOwner(prompt: string): Promise<boolean> {
  if (!stdin.isTTY) return false;
  const input = createInterface({ input: stdin, output: stdout });
  try {
    const answer = (await input.question(prompt)).trim().toLowerCase();
    return answer === 'y' || answer === 'yes';
  } finally {
    input.close();
  }
}

export function createPrompt() {
  return createInterface({ input: stdin, output: stdout });
}
