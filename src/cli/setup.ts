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
import { nextOffsetFor, readOffset, writeOffset } from '../telegram/router.ts';

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
  const lines = ['openmurmur setup will make these changes:', ''];
  for (const dir of plan.directories) lines.push(`  create directory  ${dir}`);
  if (plan.willCreateConfig) lines.push(`  write config      ${plan.configFile}`);
  else lines.push(`  keep config       ${plan.configFile} (already exists, untouched)`);
  lines.push(`  create database   ${plan.databaseFile}`);
  lines.push('');
  lines.push('It will NOT download models, contact any network service, or touch the Keychain.');
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
}

/**
 * Interactive Telegram onboarding.
 *
 * The token is read from a hidden prompt and goes straight to the Keychain.
 * The chat ID is discovered from a `/start` the user sends, so the user never
 * has to look up a numeric ID, and only that one chat is ever accepted.
 */
export async function setupTelegram(
  paths: Paths,
  apiBaseUrl: string,
  log: (message: string) => void,
): Promise<TelegramSetupResult> {
  const token = await promptSecret('Telegram bot token (input hidden): ');
  if (token.trim().length === 0) throw new Error('no token entered');

  const client = new TelegramClient({ token: token.trim(), baseUrl: apiBaseUrl });

  log('Verifying the token with getMe...');
  const me = await client.getMe();
  if (!me.is_bot) throw new Error('that token does not belong to a bot');
  const username = me.username ?? me.first_name;
  log(`  Bot: @${username} (id ${me.id})`);

  // Establish the boundary before asking for /start. Otherwise a message left
  // in this bot's queue by an earlier owner could silently become the allowlist.
  const baselineOffset = await drainUpdateBacklog(client);

  log('');
  log(`Now open Telegram, find @${username}, and send it:  /start`);
  log('Waiting for the message...');

  const accepted = await waitForStart(client, baselineOffset, username);
  const chatId = accepted.chatId;
  const account = accepted.username === null ? accepted.firstName : `@${accepted.username}`;
  log(`  Account: ${account} (user id ${accepted.userId})`);
  log(`  Chat ID: ${chatId}`);
  if (!(await confirmTelegramOwner(`Use ${account}, chat ${chatId}? [y/N] `))) {
    throw new Error('Telegram setup cancelled; nothing was stored');
  }

  const db = openDatabase({ file: paths.databaseFile });
  try {
    await commitTelegramSetup(
      db.handle,
      keychain,
      { token: token.trim(), chatId },
      accepted.nextOffset,
      () =>
        client.sendMessage(
          chatId,
          '✅ OpenMurmur подключён.\n\n' +
            'Этот чат будет получать аудио, транскрипты, отчёты и статус записи.\n' +
            'Команды: /status, /health, /settings, /help',
        ),
    );
  } finally {
    db.close();
  }
  log('  Stored the token and chat ID in the macOS Keychain (service io.openmurmur).');
  log('  Sent a test message.');

  return { botUsername: username, chatId };
}

/**
 * Commits the allowlisted recipient and that bot's update cursor as one setup
 * operation. Keychain and SQLite cannot share a crash-atomic transaction, but
 * ordinary failures restore the previous pair or fail closed with no secrets.
 */
export async function commitTelegramSetup(
  db: DatabaseSync,
  store: SecretsStore,
  secrets: TelegramSecrets,
  nextOffset: number,
  confirmDelivery: () => Promise<unknown>,
): Promise<void> {
  const previousSecrets = await store.load();
  const newBotScope = telegramBotScope(secrets.token);
  const previousBotScope =
    previousSecrets === null ? 'legacy' : telegramBotScope(previousSecrets.token);
  const previousOffset = readOffset(db, previousBotScope);
  let stored = false;
  let offsetWritten = false;

  try {
    await store.storeSecrets(secrets);
    stored = true;
    writeOffset(db, nextOffset, newBotScope);
    offsetWritten = true;
    await confirmDelivery();
  } catch (error) {
    if (!stored) throw error;

    const rollbackErrors: unknown[] = [];
    try {
      await store.clear();
    } catch (rollbackError) {
      rollbackErrors.push(rollbackError);
    }

    let offsetRestored = !offsetWritten;
    try {
      writeOffset(db, previousOffset, previousBotScope);
      offsetRestored = true;
    } catch (rollbackError) {
      rollbackErrors.push(rollbackError);
    }

    if (offsetRestored && previousSecrets !== null) {
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
      '`openmurmur setup telegram` again.',
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
