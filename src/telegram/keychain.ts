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

/** `security` exit code for errSecItemNotFound — the only benign failure. */
const ITEM_NOT_FOUND = 44;

async function getSecret(account: string): Promise<string | null> {
  const result = await run(['find-generic-password', '-a', account, '-s', SERVICE, '-w']);

  if (result.code === 0) {
    const value = result.stdout.trim();
    return value.length > 0 ? value : null;
  }

  // "Not configured yet" and "configured, but I cannot read it" must not look
  // the same. On a headless server the login Keychain is locked until someone
  // logs in, and `security` then fails with errSecInteractionNotAllowed —
  // which, reported as "not configured", sends you off to re-create a bot that
  // was never the problem.
  if (result.code === ITEM_NOT_FOUND) return null;

  const stderr = result.stderr.trim();
  const locked =
    stderr.includes('interaction is not allowed') ||
    stderr.includes('-25308') ||
    result.code === 36;

  throw new KeychainError(
    locked
      ? `The macOS Keychain is locked, so "${account}" could not be read (${stderr}).\n` +
          'This is what a headless or SSH-only session looks like: the login Keychain\n' +
          'is not unlocked until someone logs in.\n' +
          'Fix it with one of:\n' +
          '  * enable automatic login so the login Keychain unlocks at boot, or\n' +
          '  * run `security unlock-keychain` before starting the daemon, or\n' +
          '  * start the daemon from a LaunchAgent in the logged-in GUI session.\n' +
          'The token itself is intact; nothing needs to be re-created.'
      : `Could not read "${account}" from the Keychain (exit ${result.code}): ${stderr}`,
  );
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
