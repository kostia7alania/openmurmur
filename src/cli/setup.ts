import { writeFile } from 'node:fs/promises';
import { stdin, stdout } from 'node:process';
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
}

export function planSetup(paths: Paths, configExists: boolean): SetupPlan {
  return {
    directories: managedDirectories(paths),
    configFile: paths.configFile,
    databaseFile: paths.databaseFile,
    willCreateConfig: !configExists,
  };
}

export function renderSetupPlan(plan: SetupPlan): string {
  const lines = ['pnpm openmurmur setup will make these changes:', ''];
  for (const dir of plan.directories) lines.push(`  create directory  ${dir}`);
  if (plan.willCreateConfig) lines.push(`  write config      ${plan.configFile}`);
  else lines.push(`  keep config       ${plan.configFile} (already exists, untouched)`);
  lines.push(`  create database   ${plan.databaseFile}`);
  lines.push('');
  lines.push('It will NOT download models, contact any network service, or touch the Keychain.');
  return lines.join('\n');
}

/** The clone-based install has no global binary, so every next step is runnable as printed. */
export function renderSetupNextSteps(telegramConfigured: boolean): string {
  const lines = ['Next, verify the complete foreground path:'];
  let step = 1;
  if (!telegramConfigured) {
    lines.push(
      `  ${step}. Choose the one input owner, set telegram.receiveUpdates=true there, then run: pnpm openmurmur setup telegram owner`,
    );
    step += 1;
  }
  lines.push(`  ${step}. Verify the microphone: pnpm openmurmur capture test`);
  step += 1;
  lines.push(`  ${step}. Start in the foreground: pnpm openmurmur start`);
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
    await writeFile(paths.configFile, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`, {
      mode: 0o600,
    });
  }
  const db = openDatabase({ file: paths.databaseFile });
  db.close();
}

export interface TelegramSetupResult {
  readonly botUsername: string;
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
}

export function renderSetupCompletion(): string {
  return `✅ Setup complete.\n\n${renderSetupNextSteps(false)}`;
}

export function renderTelegramSetupCompletion(result: TelegramSetupResult): string {
  return `✅ Connected @${result.botUsername}, chat ${result.chatId} (${result.role})\n\n${renderSetupNextSteps(true)}`;
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
  const token = await (
    dependencies.promptToken ?? (() => promptSecret('Telegram bot token (input hidden): '))
  )();
  if (token.trim().length === 0) throw new Error('no token entered');

  const client = new TelegramClient({
    token: token.trim(),
    baseUrl: apiBaseUrl,
    ...(dependencies.fetchImpl === undefined ? {} : { fetchImpl: dependencies.fetchImpl }),
  });
  const confirmRecipient = dependencies.confirmRecipient ?? confirmTelegramOwner;

  log('Verifying the token with getMe...');
  const me = await client.getMe();
  if (!me.is_bot) throw new Error('that token does not belong to a bot');
  const username = me.username ?? me.first_name;
  log(`  Bot: @${username} (id ${me.id})`);

  let chatId: number;
  let commit: TelegramSetupCommit;
  if (role === 'owner') {
    // Establish the boundary before asking for /start. Otherwise a message left
    // in this bot's queue by an earlier owner could silently become the allowlist.
    const baselineOffset = await drainUpdateBacklog(client);

    log('');
    log(`Now open Telegram, find @${username}, and send it:  /start`);
    log('Waiting for the message...');

    const accepted = await waitForStart(client, baselineOffset, username);
    chatId = accepted.chatId;
    const account = accepted.username === null ? accepted.firstName : `@${accepted.username}`;
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
      dependencies.secrets ?? keychain,
      { token: token.trim(), chatId },
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

  return { botUsername: username, chatId, role };
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
  botUsername: string,
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
      const addressed = `/start@${botUsername.toLowerCase()}`;
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
