import { spawn } from 'node:child_process';

/**
 * Secrets live in the macOS Keychain, never in the config file, argv, the
 * environment, launchd plists or shell history.
 *
 * The token is passed through an `expect`-owned pseudo-terminal on **stdin**,
 * not as an argument, because argv is world-readable via `ps` on macOS.
 */

const SERVICE = 'io.openmurmur';
const ACCOUNT_SECRETS = 'telegram-secrets-v1';
const ACCOUNT_TOKEN = 'telegram-bot-token';
const ACCOUNT_CHAT_ID = 'telegram-chat-id';
const SECURITY_COMMAND_TIMEOUT_MS = 5_000;
const SECURITY_BIN = '/usr/bin/security';
const EXPECT_BIN = '/usr/bin/expect';
/** `security` exit code for errSecItemNotFound — the only benign failure. */
const ITEM_NOT_FOUND = 44;

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

function run(command: string, args: readonly string[], stdin?: string): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const settle = (result: RunResult | Error): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      if (result instanceof Error) reject(result);
      else resolve(result);
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', (error) => settle(error));
    child.on('close', (code) => settle({ code: code ?? -1, stdout, stderr }));
    child.stdin.on('error', (error) => settle(error));
    timer = setTimeout(() => {
      child.kill('SIGKILL');
      settle(
        new KeychainError(
          `macOS Keychain command timed out after ${SECURITY_COMMAND_TIMEOUT_MS} ms`,
        ),
      );
    }, SECURITY_COMMAND_TIMEOUT_MS);
    if (stdin !== undefined) child.stdin.write(stdin);
    child.stdin.end();
  });
}

export interface KeychainWriteInvocation {
  readonly command: string;
  readonly args: readonly string[];
  readonly stdin: string;
}

/**
 * `security add-generic-password -w` only reads from a terminal prompt. With a
 * plain pipe it succeeds while storing an empty password, which looks exactly
 * like a completed setup until the first restart. `expect` supplies a private
 * PTY while the encoded secret itself still travels only over stdin.
 */
export function keychainWriteInvocation(account: string, value: string): KeychainWriteInvocation {
  if (!/^[a-z0-9-]+$/.test(account)) throw new KeychainError('invalid Keychain account');
  const promptScript = `
log_user 0
set timeout 5
if {[catch {
  gets stdin encoded
  set secret [binary format H* $encoded]
  spawn ${SECURITY_BIN} add-generic-password -U -a ${account} -s ${SERVICE} -l {OpenMurmur ${account}} -w
  expect {
    -re {password data for} {}
    timeout { exit 70 }
    eof { exit 71 }
  }
  send -- "$secret\\r"
  expect {
    -re {retype password} {}
    timeout { exit 72 }
    eof { exit 73 }
  }
  send -- "$secret\\r"
  expect eof
  set result [wait]
  set exitCode [lindex $result 3]
} message]} {
  puts stderr $message
  exit 74
}
exit $exitCode
`.trim();
  return {
    command: EXPECT_BIN,
    args: ['-c', promptScript],
    stdin: `${Buffer.from(value, 'utf8').toString('hex')}\n`,
  };
}

async function setSecret(account: string, value: string): Promise<void> {
  const invocation = keychainWriteInvocation(account, value);
  const result = await run(invocation.command, invocation.args, invocation.stdin);
  if (result.code !== 0 || result.stderr.length > 0) {
    throw new KeychainError(`Failed to store ${account} in Keychain: ${result.stderr.trim()}`);
  }
}

async function getSecret(account: string): Promise<string | null> {
  const result = await run(SECURITY_BIN, [
    'find-generic-password',
    '-a',
    account,
    '-s',
    SERVICE,
    '-w',
  ]);

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

async function deleteSecret(account: string): Promise<void> {
  const result = await run(SECURITY_BIN, ['delete-generic-password', '-a', account, '-s', SERVICE]);
  if (result.code === 0 || result.code === ITEM_NOT_FOUND) return;
  throw new KeychainError(`Failed to remove ${account} from Keychain: ${result.stderr.trim()}`);
}

export interface TelegramSecrets {
  readonly token: string;
  readonly chatId: number;
}

export interface SecretStorageBackend {
  get(account: string): Promise<string | null>;
  set(account: string, value: string): Promise<void>;
  delete(account: string): Promise<void>;
}

export interface SecretsStore {
  storeSecrets(secrets: TelegramSecrets): Promise<void>;
  load(): Promise<TelegramSecrets | null>;
  clear(): Promise<void>;
}

export function encodeTelegramSecrets(secrets: TelegramSecrets): string {
  if (secrets.token.trim().length === 0) throw new KeychainError('Telegram bot token is empty');
  if (!Number.isSafeInteger(secrets.chatId) || secrets.chatId === 0) {
    throw new KeychainError('Telegram chat ID is invalid');
  }
  return JSON.stringify({ version: 1, token: secrets.token, chatId: secrets.chatId });
}

export function decodeTelegramSecrets(value: string): TelegramSecrets {
  let decoded: unknown;
  try {
    decoded = JSON.parse(value);
  } catch {
    throw new KeychainError('Telegram credentials in Keychain are not valid JSON');
  }
  if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)) {
    throw new KeychainError('Telegram credentials in Keychain have an invalid shape');
  }
  const record = decoded as Record<string, unknown>;
  if (record['version'] !== 1) {
    throw new KeychainError('Telegram credentials in Keychain use an unsupported version');
  }
  const token = record['token'];
  const chatId = record['chatId'];
  if (typeof token !== 'string' || token.trim().length === 0) {
    throw new KeychainError('Telegram credentials in Keychain contain an empty token');
  }
  if (typeof chatId !== 'number' || !Number.isSafeInteger(chatId) || chatId === 0) {
    throw new KeychainError('Telegram credentials in Keychain contain an invalid chat ID');
  }
  return { token, chatId };
}

function decodeLegacySecrets(token: string, chatIdRaw: string): TelegramSecrets {
  if (!/^-?\d+$/.test(chatIdRaw)) {
    throw new KeychainError('Legacy Telegram chat ID in Keychain is invalid');
  }
  const chatId = Number(chatIdRaw);
  return decodeTelegramSecrets(encodeTelegramSecrets({ token, chatId }));
}

export function createTelegramKeychain(backend: SecretStorageBackend): SecretsStore {
  return {
    async storeSecrets(secrets: TelegramSecrets): Promise<void> {
      await backend.set(ACCOUNT_SECRETS, encodeTelegramSecrets(secrets));
    },
    async load(): Promise<TelegramSecrets | null> {
      const encoded = await backend.get(ACCOUNT_SECRETS);
      if (encoded !== null) return decodeTelegramSecrets(encoded);

      const token = await backend.get(ACCOUNT_TOKEN);
      const chatIdRaw = await backend.get(ACCOUNT_CHAT_ID);
      if (token === null && chatIdRaw === null) return null;
      if (token === null || chatIdRaw === null) {
        throw new KeychainError(
          'Legacy Telegram credentials in Keychain are incomplete; run setup again',
        );
      }
      const legacy = decodeLegacySecrets(token, chatIdRaw);

      // Publish the combined item first. Once it exists it is authoritative, so
      // interrupted cleanup can leave duplicate legacy items but never a mixed pair.
      try {
        await backend.set(ACCOUNT_SECRETS, encodeTelegramSecrets(legacy));
        await Promise.all([backend.delete(ACCOUNT_TOKEN), backend.delete(ACCOUNT_CHAT_ID)]);
      } catch {
        // A read-only/locked Keychain must not make an otherwise valid legacy
        // installation unusable. A later load retries this best-effort migration.
      }
      return legacy;
    },
    async clear(): Promise<void> {
      const failures: unknown[] = [];
      for (const account of [ACCOUNT_SECRETS, ACCOUNT_TOKEN, ACCOUNT_CHAT_ID]) {
        try {
          await backend.delete(account);
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length > 0) throw failures[0];
    },
  };
}

const securityBackend: SecretStorageBackend = {
  get: getSecret,
  set: setSecret,
  delete: deleteSecret,
};

export const keychain = createTelegramKeychain(securityBackend);

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
