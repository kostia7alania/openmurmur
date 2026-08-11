import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { checkMlxReadiness, checkTelegramSetup } from '../../src/cli/doctor.ts';
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
      fix: 'Set telegram.receiveUpdates for this host, then run either `pnpm openmurmur setup telegram owner` or `pnpm openmurmur setup telegram send-only` from the repository checkout.',
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

describe('MLX readiness', () => {
  it('uses only package metadata, cache evidence and a bounded disk result', async () => {
    const root = mkdtempSync(join(tmpdir(), 'om-doctor-mlx-'));
    try {
      const environment = join(root, 'environment');
      const sitePackages = join(environment, 'lib', 'python3.14', 'site-packages');
      mkdirSync(join(environment, 'bin'), { recursive: true });
      writeFileSync(join(environment, 'bin', 'python'), 'fixture executable', { mode: 0o700 });
      const mlxMetadata = join(sitePackages, 'mlx-0.32.0.dist-info');
      mkdirSync(mlxMetadata, { recursive: true });
      writeFileSync(join(mlxMetadata, 'METADATA'), 'Metadata-Version: 2.4\nName: mlx\n');
      const qwenMetadata = join(sitePackages, 'mlx_qwen3_asr-0.3.5.dist-info');
      mkdirSync(qwenMetadata);
      writeFileSync(join(qwenMetadata, 'METADATA'), 'Metadata-Version: 2.4\nName: mlx-qwen3-asr\n');

      const cacheRoot = join(root, 'cache');
      const repository = join(cacheRoot, 'models--Qwen--Qwen3-ASR-1.7B');
      const revision = 'a'.repeat(40);
      const snapshot = join(repository, 'snapshots', revision);
      mkdirSync(join(repository, 'refs'), { recursive: true });
      mkdirSync(snapshot, { recursive: true });
      writeFileSync(join(repository, 'refs', 'main'), revision);
      for (const file of ['config.json', 'preprocessor_config.json', 'tokenizer_config.json']) {
        writeFileSync(join(snapshot, file), '{}');
      }
      const vocab = join(snapshot, 'vocab.json');
      writeFileSync(vocab, '{"token":0}');
      writeFileSync(join(snapshot, 'merges.txt'), '#version: 0.2\nt o\n');
      const shard = join(snapshot, 'model-00001-of-00001.safetensors');
      writeFileSync(shard, 'weights');
      writeFileSync(
        join(snapshot, 'model.safetensors.index.json'),
        JSON.stringify({ weight_map: { layer: 'model-00001-of-00001.safetensors' } }),
      );

      const asr = { backend: 'mlx', model: 'Qwen/Qwen3-ASR-1.7B' } as const;
      const ready = await checkMlxReadiness(asr, {
        pythonEnvironment: environment,
        cacheRoot,
        diskProbe: async () => 12,
      });
      assert.equal(ready.level, 'ok');
      assert.match(ready.detail, /package metadata present/);
      assert.match(ready.detail, /model snapshot evidence present/);

      writeFileSync(join(qwenMetadata, 'METADATA'), 'Name: wrong-package\n');
      rmSync(vocab);
      const incomplete = await checkMlxReadiness(asr, {
        pythonEnvironment: environment,
        cacheRoot,
        diskProbe: async () => 1,
      });
      assert.equal(incomplete.level, 'fail');
      assert.match(incomplete.detail, /missing package metadata: mlx-qwen3-asr/);
      assert.match(incomplete.detail, /snapshot evidence missing/);
      assert.match(incomplete.detail, /1 GB free/);
      assert.doesNotMatch(JSON.stringify(incomplete), new RegExp(root));

      writeFileSync(join(qwenMetadata, 'METADATA'), 'Name: mlx-qwen3-asr\n');
      writeFileSync(vocab, '{"token":0}');
      const unknownDisk = await checkMlxReadiness(asr, {
        pythonEnvironment: environment,
        cacheRoot,
        diskProbe: async () => null,
      });
      assert.equal(unknownDisk.level, 'warn');
      assert.match(unknownDisk.detail, /free space unknown/);
      assert.match(unknownDisk.fix ?? '', /Check free space/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
