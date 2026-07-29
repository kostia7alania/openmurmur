import { spawn } from 'node:child_process';

/**
 * Secrets live in the macOS Keychain, never in the config file, argv, the
 * environment, launchd plists or shell history.
 *
 * The token is passed to `security` on **stdin**, not as an argument, because
 * argv is world-readable via `ps` on macOS.
 */

const SERVICE = 'io.openmurmur';
const ACCOUNT_TOKEN = 'telegram-bot-token';
const ACCOUNT_CHAT_ID = 'telegram-chat-id';

export class KeychainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KeychainError';
  }
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function run(args: readonly string[], stdin?: string): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('security', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
    if (stdin !== undefined) child.stdin.write(stdin);
    child.stdin.end();
  });
}

async function setSecret(account: string, value: string): Promise<void> {
  // -w with no value makes `security` read the secret from stdin.
  const result = await run(
    [
      'add-generic-password',
      '-U',
      '-a',
      account,
      '-s',
      SERVICE,
      '-l',
      `OpenMurmur ${account}`,
      '-w',
    ],
    `${value}\n`,
  );
  if (result.code !== 0) {
    throw new KeychainError(`Failed to store ${account} in Keychain: ${result.stderr.trim()}`);
  }
}

async function getSecret(account: string): Promise<string | null> {
  const result = await run(['find-generic-password', '-a', account, '-s', SERVICE, '-w']);
  if (result.code !== 0) return null;
  const value = result.stdout.trim();
  return value.length > 0 ? value : null;
}

async function deleteSecret(account: string): Promise<boolean> {
  const result = await run(['delete-generic-password', '-a', account, '-s', SERVICE]);
  return result.code === 0;
}

export interface TelegramSecrets {
  readonly token: string;
  readonly chatId: number;
}

export const keychain = {
  async storeToken(token: string): Promise<void> {
    await setSecret(ACCOUNT_TOKEN, token);
  },
  async storeChatId(chatId: number): Promise<void> {
    await setSecret(ACCOUNT_CHAT_ID, String(chatId));
  },
  async load(): Promise<TelegramSecrets | null> {
    const token = await getSecret(ACCOUNT_TOKEN);
    const chatIdRaw = await getSecret(ACCOUNT_CHAT_ID);
    if (token === null || chatIdRaw === null) return null;
    const chatId = Number.parseInt(chatIdRaw, 10);
    if (!Number.isFinite(chatId)) return null;
    return { token, chatId };
  },
  async clear(): Promise<void> {
    await deleteSecret(ACCOUNT_TOKEN);
    await deleteSecret(ACCOUNT_CHAT_ID);
  },
};

/**
 * Secrets provider indirection so tests, `--dry-run` and CI never touch the
 * real Keychain (and never prompt for the login password).
 */
export interface SecretsProvider {
  load(): Promise<TelegramSecrets | null>;
}

export const keychainProvider: SecretsProvider = keychain;

export function staticProvider(secrets: TelegramSecrets | null): SecretsProvider {
  return { load: async () => secrets };
}
