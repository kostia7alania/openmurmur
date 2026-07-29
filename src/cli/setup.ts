import { writeFile } from 'node:fs/promises';
import { stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline/promises';
import { ensureDirectories } from '../config/load.ts';
import type { Paths } from '../config/paths.ts';
import { managedDirectories } from '../config/paths.ts';
import { DEFAULT_CONFIG } from '../config/schema.ts';
import { openDatabase } from '../database/db.ts';
import { TelegramClient } from '../telegram/client.ts';
import { keychain } from '../telegram/keychain.ts';
import { writeOffset } from '../telegram/router.ts';

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

  log('');
  log(`Now open Telegram, find @${username}, and send it:  /start`);
  log('Waiting for the message...');

  const chatId = await waitForStart(client);
  log(`  Chat ID: ${chatId}`);

  await keychain.storeToken(token.trim());
  await keychain.storeChatId(chatId);
  log('  Stored the token and chat ID in the macOS Keychain (service io.openmurmur).');

  // Persist the offset so the /start we consumed is not replayed at startup.
  const db = openDatabase({ file: paths.databaseFile });
  try {
    const updates = await client.getUpdates(0, 0);
    const next = updates.reduce((max, u) => Math.max(max, u.update_id + 1), 0);
    writeOffset(db.handle, next);
  } finally {
    db.close();
  }

  await client.sendMessage(
    chatId,
    '✅ OpenMurmur подключён.\n\n' +
      'Этот чат будет получать аудио, транскрипты, отчёты и статус записи.\n' +
      'Команды: /status, /health, /help',
  );
  log('  Sent a test message.');

  return { botUsername: username, chatId };
}

async function waitForStart(client: TelegramClient, attempts = 30): Promise<number> {
  let offset = 0;
  for (let i = 0; i < attempts; i += 1) {
    const updates = await client.getUpdates(offset, 10);
    for (const update of updates) {
      offset = Math.max(offset, update.update_id + 1);
      const message = update.message;
      if (message === undefined) continue;
      // Any message from a private chat identifies the owner; requiring the
      // exact text "/start" would fail for users whose client localizes it.
      if (message.chat.type === 'private') return message.chat.id;
    }
  }
  throw new Error(
    'No message arrived. Make sure you messaged the right bot, then run ' +
      '`openmurmur setup telegram` again.',
  );
}

export function createPrompt() {
  return createInterface({ input: stdin, output: stdout });
}
