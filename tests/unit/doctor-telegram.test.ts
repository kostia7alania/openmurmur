import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { checkTelegramSetup } from '../../src/cli/doctor.ts';
import {
  createTelegramSetupReadinessProbe,
  type KeychainMetadataCommand,
  type TelegramSetupReadinessProvider,
} from '../../src/telegram/keychain.ts';

describe('Telegram setup readiness', () => {
  it('recognizes configured credentials using metadata only', async () => {
    const calls: string[][] = [];
    const command: KeychainMetadataCommand = async (args) => {
      calls.push([...args]);
      return { code: 0, stderr: '' };
    };

    const result = await createTelegramSetupReadinessProbe(command).inspect();

    assert.deepEqual(result, { status: 'configured', format: 'combined' });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], [
      'find-generic-password',
      '-a',
      'telegram-secrets-v1',
      '-s',
      'io.openmurmur',
    ]);
    assert.equal(calls.flat().includes('-g'), false);
    assert.equal(calls.flat().includes('-w'), false);
  });

  it('distinguishes missing setup without touching the live Keychain', async () => {
    const provider = createTelegramSetupReadinessProbe(async () => ({ code: 44, stderr: '' }));

    assert.deepEqual(await provider.inspect(), { status: 'not_configured' });
    assert.deepEqual(await checkTelegramSetup(provider), {
      name: 'telegram_setup',
      level: 'warn',
      detail: 'no Telegram credential items found in the macOS Keychain',
      fix: 'Run `pnpm openmurmur setup telegram` from the repository checkout.',
    });
  });

  it('reports inaccessible metadata without pretending setup is missing', async () => {
    const provider: TelegramSetupReadinessProvider = {
      inspect: async () => ({
        status: 'inaccessible',
        detail: 'User interaction is not allowed',
      }),
    };

    const check = await checkTelegramSetup(provider);

    assert.equal(check.name, 'telegram_setup');
    assert.equal(check.level, 'warn');
    assert.match(check.detail, /metadata is inaccessible/i);
    assert.doesNotMatch(check.detail, /not configured/i);
  });
});
