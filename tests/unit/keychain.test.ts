import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  createTelegramKeychain,
  decodeTelegramSecrets,
  keychainWriteInvocation,
  type SecretStorageBackend,
} from '../../src/telegram/keychain.ts';

function memoryBackend(initial: Readonly<Record<string, string>> = {}): {
  readonly backend: SecretStorageBackend;
  readonly values: Map<string, string>;
  readonly writes: { account: string; value: string }[];
} {
  const values = new Map(Object.entries(initial));
  const writes: { account: string; value: string }[] = [];
  return {
    values,
    writes,
    backend: {
      async get(account) {
        return values.get(account) ?? null;
      },
      async set(account, value) {
        writes.push({ account, value });
        values.set(account, value);
      },
      async delete(account) {
        values.delete(account);
      },
    },
  };
}

describe('Telegram Keychain credential pair', () => {
  it('passes the credential only over stdin to a private Keychain prompt', () => {
    const secret = '{"version":1,"token":"123:secret","chatId":42}';
    const invocation = keychainWriteInvocation('telegram-secrets-v1', secret);

    assert.equal(invocation.command, '/usr/bin/expect');
    assert.ok(invocation.args.includes('-c'));
    assert.ok(invocation.args.some((arg) => arg.includes('/usr/bin/security')));
    assert.ok(!invocation.args.some((arg) => arg.includes(secret)));
    assert.equal(Buffer.from(invocation.stdin.trim(), 'hex').toString('utf8'), secret);
  });

  it('rejects a Keychain account that could alter the expect program', () => {
    assert.throws(
      () => keychainWriteInvocation('telegram-secrets-v1; puts $secret', 'value'),
      /invalid Keychain account/,
    );
  });

  it('publishes token and chat ID in one versioned generic-password item', async () => {
    const memory = memoryBackend();
    const keychain = createTelegramKeychain(memory.backend);

    await keychain.storeSecrets({ token: 'bot-token', chatId: 42 });

    assert.equal(memory.writes.length, 1, 'one setup cannot leave half of a credential pair');
    assert.deepEqual(decodeTelegramSecrets(memory.writes[0]?.value ?? ''), {
      token: 'bot-token',
      chatId: 42,
    });
  });

  it('does not mutate the previous pair when its single Keychain update fails', async () => {
    const memory = memoryBackend();
    const keychain = createTelegramKeychain(memory.backend);
    await keychain.storeSecrets({ token: 'old-token', chatId: 11 });
    const original = new Map(memory.values);
    let attemptedWrites = 0;
    const failing = createTelegramKeychain({
      ...memory.backend,
      async set() {
        attemptedWrites += 1;
        throw new Error('Keychain write failed');
      },
    });

    await assert.rejects(
      failing.storeSecrets({ token: 'new-token', chatId: 22 }),
      /Keychain write failed/,
    );
    assert.equal(attemptedWrites, 1);
    assert.deepEqual(memory.values, original);
    assert.deepEqual(await keychain.load(), { token: 'old-token', chatId: 11 });
  });

  it('loads a complete legacy pair, then publishes the combined item before cleanup', async () => {
    const memory = memoryBackend({
      'telegram-bot-token': 'legacy-token',
      'telegram-chat-id': '73',
    });
    const keychain = createTelegramKeychain(memory.backend);

    assert.deepEqual(await keychain.load(), { token: 'legacy-token', chatId: 73 });
    assert.equal(memory.writes.length, 1);
    assert.equal(memory.values.has('telegram-bot-token'), false);
    assert.equal(memory.values.has('telegram-chat-id'), false);
    assert.deepEqual(decodeTelegramSecrets(memory.writes[0]?.value ?? ''), {
      token: 'legacy-token',
      chatId: 73,
    });
  });

  it('fails closed on an incomplete legacy pair', async () => {
    const memory = memoryBackend({ 'telegram-bot-token': 'orphan-token' });
    const keychain = createTelegramKeychain(memory.backend);

    await assert.rejects(keychain.load(), /credentials.*incomplete/i);
    assert.equal(memory.writes.length, 0);
  });

  it('clear removes both the combined item and every legacy item', async () => {
    const memory = memoryBackend({
      'telegram-secrets-v1': '{"version":1,"token":"current","chatId":1}',
      'telegram-bot-token': 'legacy-token',
      'telegram-chat-id': '73',
    });
    const keychain = createTelegramKeychain(memory.backend);

    await keychain.clear();

    assert.equal(memory.values.size, 0);
    assert.equal(await keychain.load(), null);
  });
});
