import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  claimDaemonMaintenance,
  claimDaemonPid,
  releaseDaemonMaintenance,
  releaseDaemonPid,
} from '../../src/cli/daemon-ownership.ts';
import { withStoppedDaemonForTelegram } from '../../src/cli/main.ts';
import {
  commitTelegramSetup,
  drainUpdateBacklog,
  planSetup,
  renderSetupCompletion,
  renderSetupPlan,
  renderTelegramSetupCompletion,
  setupTelegram,
  waitForStart,
} from '../../src/cli/setup.ts';
import { resolvePaths } from '../../src/config/paths.ts';
import { DEFAULT_CONFIG } from '../../src/config/schema.ts';
import { openDatabase } from '../../src/database/db.ts';
import type { TelegramUpdate } from '../../src/telegram/client.ts';
import {
  type SecretsStore,
  type TelegramSecrets,
  telegramBotScope,
} from '../../src/telegram/keychain.ts';
import { Outbox } from '../../src/telegram/outbox.ts';
import { readOffset, writeOffset } from '../../src/telegram/router.ts';

function update(
  updateId: number,
  chatId: number,
  text: string,
  chatType = 'private',
): TelegramUpdate {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: 0,
      chat: { id: chatId, type: chatType },
      from: { id: chatId, is_bot: false, first_name: `User ${chatId}`, username: `user${chatId}` },
      text,
    },
  };
}

function updateWithIdentity(
  updateId: number,
  chatId: number,
  text: string,
  firstName: string,
  username: string,
): TelegramUpdate {
  const result = update(updateId, chatId, text);
  if (result.message?.from === undefined) throw new Error('test update sender is missing');
  result.message.from.first_name = firstName;
  result.message.from.username = username;
  return result;
}

describe('setup completion output', () => {
  it('leads a fresh setup through Telegram to one verifiable ambient session on the exact root', () => {
    const root = "/private/tmp/Open Murmur's state";
    const rootArgument = `'/private/tmp/Open Murmur'"'"'s state'`;
    const output = renderSetupCompletion(root, 'owner');
    const expectedInOrder = [
      `pnpm openmurmur --root ${rootArgument} setup telegram owner`,
      `pnpm openmurmur --root ${rootArgument} capture test`,
      `pnpm openmurmur --root ${rootArgument} start`,
      'speak for more than 3 seconds',
      'wait for 60 seconds of silence',
      'source FLAC, then transcript, then report',
    ];

    let previous = -1;
    for (const text of expectedInOrder) {
      const index = output.indexOf(text);
      assert.ok(index > previous, `expected "${text}" after the previous onboarding step`);
      previous = index;
    }
  });

  it('does not echo a nonprintable state root in copyable follow-up commands', () => {
    const root = '/private/tmp/openmurmur\nspoofed';
    const output = [
      renderSetupPlan(planSetup(resolvePaths(root), false, 'send-only')),
      renderSetupCompletion(root, 'send-only'),
    ].join('\n');

    assert.doesNotMatch(output, /spoofed/);
    assert.match(output, /create directory {2}<path not printed>/);
    assert.match(output, /write config {6}<path not printed>/);
    assert.match(output, /create database {3}<path not printed>/);
    assert.match(output, /state root is not safe to print/);
    assert.match(
      output,
      /pnpm openmurmur --root "\$OPENMURMUR_STATE_ROOT" setup telegram send-only/,
    );
    assert.match(output, /pnpm openmurmur --root "\$OPENMURMUR_STATE_ROOT" capture test/);
    assert.match(output, /pnpm openmurmur --root "\$OPENMURMUR_STATE_ROOT" start/);
  });

  it('selects the fresh Telegram role without ever rewriting an existing config', () => {
    const root = mkdtempSync(join(tmpdir(), 'om-setup-role-'));
    const configFile = resolvePaths(root).configFile;
    try {
      const ambiguous = spawnSync(
        process.execPath,
        ['src/cli/main.ts', 'setup', '--yes', '--root', root],
        { cwd: process.cwd(), encoding: 'utf8' },
      );
      assert.equal(ambiguous.status, 1);
      assert.match(ambiguous.stderr, /Fresh setup requires --telegram-role/);
      assert.equal(existsSync(configFile), false);

      const created = spawnSync(
        process.execPath,
        ['src/cli/main.ts', 'setup', '--telegram-role', 'owner', '--yes', '--root', root],
        { cwd: process.cwd(), encoding: 'utf8' },
      );
      assert.equal(created.status, 0, created.stderr);
      assert.match(created.stdout, /set Telegram role owner \(telegram\.receiveUpdates=true\)/);
      assert.ok(created.stdout.includes(`pnpm openmurmur --root '${root}' setup telegram owner`));

      const original = readFileSync(configFile, 'utf8');
      const config = JSON.parse(original) as { telegram?: { receiveUpdates?: unknown } };
      assert.equal(config.telegram?.receiveUpdates, true);

      const refused = spawnSync(
        process.execPath,
        ['src/cli/main.ts', 'setup', '--telegram-role', 'send-only', '--yes', '--root', root],
        { cwd: process.cwd(), encoding: 'utf8' },
      );
      assert.equal(refused.status, 1);
      assert.match(refused.stderr, /existing config selects Telegram role owner/);
      assert.equal(readFileSync(configFile, 'utf8'), original);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('blocks Telegram setup before the token prompt while the exact root is owned', async () => {
    const root = mkdtempSync(join(tmpdir(), 'om-setup-live-owner-'));
    const paths = resolvePaths(root);
    const created = spawnSync(
      process.execPath,
      ['src/cli/main.ts', 'setup', '--telegram-role', 'owner', '--yes', '--root', root],
      { cwd: process.cwd(), encoding: 'utf8' },
    );
    assert.equal(created.status, 0, created.stderr);

    const originalConfig = readFileSync(paths.configFile, 'utf8');
    const db = openDatabase({ file: paths.databaseFile });
    writeOffset(db.handle, 41, 'setup-guard');
    const owner = await claimDaemonPid(db.handle, paths.pidFile, paths.root, {
      birthMarker: async () => 'telegram-setup-test-birth',
      inspect: async () => ({
        alive: true,
        identityMatches: false,
        command: 'test process',
        processBirth: 'telegram-setup-test-birth',
      }),
    });
    const originalMirror = readFileSync(paths.pidFile, 'utf8');
    const originalOwnership = db.handle
      .prepare('SELECT * FROM daemon_ownership WHERE ownership_id = 1')
      .get();

    try {
      const blocked = spawnSync(
        process.execPath,
        ['src/cli/main.ts', 'setup', 'telegram', 'owner', '--root', root],
        { cwd: process.cwd(), encoding: 'utf8' },
      );
      assert.equal(blocked.status, 1);
      assert.equal(
        blocked.stderr,
        [
          'Error: The OpenMurmur daemon must be stopped before this Telegram control operation.',
          'Run from the repository checkout:',
          `  pnpm openmurmur --root '${root}' stop`,
          `  pnpm openmurmur --root '${root}' setup telegram owner`,
          `  pnpm openmurmur --root '${root}' start`,
          '',
        ].join('\n'),
      );
      assert.doesNotMatch(blocked.stderr, /bot token|interactive terminal/i);
      assert.equal(readFileSync(paths.configFile, 'utf8'), originalConfig);
      assert.equal(readOffset(db.handle, 'setup-guard'), 41);
      assert.equal(readFileSync(paths.pidFile, 'utf8'), originalMirror);
      assert.deepEqual(
        db.handle.prepare('SELECT * FROM daemon_ownership WHERE ownership_id = 1').get(),
        originalOwnership,
      );
    } finally {
      await releaseDaemonPid(db.handle, paths.pidFile, owner);
    }

    try {
      let reachedSetupBoundary = 0;
      await withStoppedDaemonForTelegram(
        { config: DEFAULT_CONFIG, paths, fromFile: false },
        'setup telegram owner',
        async () => {
          reachedSetupBoundary += 1;
        },
        { birthMarker: async () => 'setup-maintenance-birth' },
      );
      assert.equal(reachedSetupBoundary, 1);
      assert.equal(readFileSync(paths.configFile, 'utf8'), originalConfig);
      assert.equal(readOffset(db.handle, 'setup-guard'), 41);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('continues a completed Telegram setup without promising a global binary', () => {
    const output = renderTelegramSetupCompletion('/private/tmp/openmurmur-live', {
      botDisplay: '@murmur_bot',
      chatId: 42,
      role: 'owner',
    });

    assert.match(output, /^✅ Connected @murmur_bot, chat 42 \(owner\)$/m);
    assert.doesNotMatch(output, /setup telegram/);
    assert.match(output, /pnpm openmurmur --root '\/private\/tmp\/openmurmur-live' capture test/);
    assert.match(output, /pnpm openmurmur --root '\/private\/tmp\/openmurmur-live' start/);
    assert.doesNotMatch(output, /(^|\n)\s*(?:\d+\.\s+)?openmurmur\s/m);
  });
});

describe('Telegram setup ownership handshake', () => {
  it('serializes every setup role before token, Keychain or Telegram access', async () => {
    const root = mkdtempSync(join(tmpdir(), 'om-telegram-lock-'));
    const setupLockPath = join(root, 'telegram-setup.lock');
    let enteredPrompt!: () => void;
    let releasePrompt!: () => void;
    const promptEntered = new Promise<void>((resolve) => {
      enteredPrompt = resolve;
    });
    const promptRelease = new Promise<void>((resolve) => {
      releasePrompt = resolve;
    });
    let secondPrompted = false;

    try {
      const first = setupTelegram(resolvePaths(root), '', 'owner', () => {}, {
        setupLockPath,
        promptToken: async () => {
          enteredPrompt();
          await promptRelease;
          throw new Error('first setup cancelled');
        },
      });
      await promptEntered;

      await assert.rejects(
        setupTelegram(resolvePaths(root), '', 'send-only', () => {}, {
          setupLockPath,
          promptToken: async () => {
            secondPrompted = true;
            return 'second-token';
          },
        }),
        /Another Telegram setup is running/,
      );
      assert.equal(secondPrompted, false);

      releasePrompt();
      await assert.rejects(first, /first setup cancelled/);
    } finally {
      releasePrompt();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('lets only the explicit owner poll while send-only proves delivery', async () => {
    const ownerRoot = mkdtempSync(join(tmpdir(), 'om-telegram-owner-'));
    const senderRoot = mkdtempSync(join(tmpdir(), 'om-telegram-sender-'));
    const calls: string[] = [];
    const ownerOutput: string[] = [];
    const setupLockPath = join(ownerRoot, 'telegram-setup.lock');
    let actor: 'owner' | 'send-only' = 'owner';
    let ownerPoll = 0;
    let ownerPrompt = '';
    const ownerBot = {
      id: 1,
      is_bot: true,
      first_name: ` Open\tMurmur ${'界'.repeat(120)}\u001b[2J\u202e\u200b\u200c\u200d\u2060\ufeff `,
      username: 'invalid-bot\u001b[31m',
    };
    const senderBot = {
      id: 2,
      is_bot: true,
      first_name: 'send-only',
      username: 'send_only_bot',
    };
    const hostileStart = updateWithIdentity(
      7,
      700,
      '/start',
      ` Owner\n${'X'.repeat(120)}\u009b31m\u202e `,
      'bad-name\u2066',
    );
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = url.slice(url.lastIndexOf('/') + 1);
      assert.match(url, /botshared-token/);
      calls.push(`${actor}:${method}`);

      let result: unknown;
      if (method === 'getMe') {
        result = actor === 'owner' ? ownerBot : senderBot;
      } else if (method === 'getUpdates') {
        ownerPoll += 1;
        result = ownerPoll === 1 ? [] : [hostileStart];
      } else {
        const body = JSON.parse(String(init?.body)) as { chat_id: number };
        result = { message_id: 1, date: 0, chat: { id: body.chat_id, type: 'private' } };
      }
      return new Response(JSON.stringify({ ok: true, result }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    const ownerSecrets = memorySecrets({ token: 'old-owner-token', chatId: 70 });
    const senderSecrets = memorySecrets(null);
    try {
      const priorOwnerDb = openDatabase({ file: resolvePaths(ownerRoot).databaseFile });
      try {
        writeOffset(priorOwnerDb.handle, 41, telegramBotScope('old-owner-token'));
      } finally {
        priorOwnerDb.close();
      }
      await assert.rejects(
        setupTelegram(resolvePaths(ownerRoot), 'https://api.telegram.org', 'owner', () => {}, {
          promptToken: async () => 'old-owner-token',
          confirmRecipient: async () => true,
          secrets: ownerSecrets.store,
          setupLockPath,
          fetchImpl: (async () => {
            assert.fail('same-token owner rebind must fail before contacting Telegram');
          }) as typeof fetch,
        }),
        /already configured.*discard queued updates.*separate bot/i,
      );
      assert.deepEqual(ownerSecrets.get(), { token: 'old-owner-token', chatId: 70 });
      const unchangedOwnerDb = openDatabase({ file: resolvePaths(ownerRoot).databaseFile });
      try {
        assert.equal(readOffset(unchangedOwnerDb.handle, telegramBotScope('old-owner-token')), 41);
      } finally {
        unchangedOwnerDb.close();
      }

      const staleSenderDb = openDatabase({ file: resolvePaths(senderRoot).databaseFile });
      try {
        const scope = telegramBotScope('shared-token');
        writeOffset(staleSenderDb.handle, 41, scope);
        await assert.rejects(
          commitTelegramSetup(
            staleSenderDb.handle,
            senderSecrets.store,
            { token: 'shared-token', chatId: 700 },
            { role: 'send-only' },
            async () => {
              throw new Error('send capability failed');
            },
          ),
          /send capability failed/,
        );
        assert.equal(readOffset(staleSenderDb.handle, scope), 41);
        assert.equal(senderSecrets.get(), null);
      } finally {
        staleSenderDb.close();
      }

      const owner = await setupTelegram(
        resolvePaths(ownerRoot),
        'https://api.telegram.org',
        'owner',
        (message) => ownerOutput.push(message),
        {
          promptToken: async () => 'shared-token',
          confirmRecipient: async (prompt) => {
            ownerPrompt = prompt;
            return true;
          },
          secrets: ownerSecrets.store,
          setupLockPath,
          fetchImpl,
        },
      );
      actor = 'send-only';
      const sender = await setupTelegram(
        resolvePaths(senderRoot),
        'https://api.telegram.org',
        'send-only',
        () => {},
        {
          promptToken: async () => 'shared-token',
          promptSendOnlyChatId: async () => owner.chatId,
          confirmRecipient: async () => true,
          secrets: senderSecrets.store,
          setupLockPath,
          fetchImpl,
        },
      );

      assert.equal(owner.chatId, 700);
      assert.equal(owner.role, 'owner');
      assert.ok([...owner.botDisplay].length <= 80);
      assert.ok(!owner.botDisplay.startsWith('@invalid-bot'));
      assert.deepEqual(sender, {
        botDisplay: '@send_only_bot',
        chatId: 700,
        role: 'send-only',
      });
      const attendedOutput = `${ownerOutput.join('\n')}\n${ownerPrompt}\n${renderTelegramSetupCompletion(ownerRoot, owner)}`;
      assert.match(attendedOutput, /Bot: .* \(id 1\)/);
      assert.match(attendedOutput, /Account: .* \(user id 700\)/);
      assert.match(attendedOutput, /Chat ID: 700/);
      assert.match(ownerPrompt, /chat 700/);
      assert.doesNotMatch(attendedOutput, /invalid-bot|bad-name/);
      assert.doesNotMatch(owner.botDisplay, /\s{2,}/u);
      assert.ok(ownerPrompt.length < 200, 'the attended confirmation prompt must stay bounded');
      const identitySurfaces = [
        owner.botDisplay,
        ownerPrompt,
        ownerOutput.find((line) => line.startsWith('  Bot:')) ?? '',
        ownerOutput.find((line) => line.startsWith('  Account:')) ?? '',
        renderTelegramSetupCompletion(ownerRoot, owner).split('\n')[0] ?? '',
      ];
      for (const surface of identitySurfaces) {
        for (const character of surface) {
          const codePoint = character.codePointAt(0) ?? 0;
          const formatControl = /\p{Cf}/u.test(character);
          assert.equal(
            codePoint <= 31 || (codePoint >= 127 && codePoint <= 159) || formatControl,
            false,
            `unsafe identity character U+${codePoint.toString(16)}`,
          );
        }
      }
      assert.deepEqual(calls, [
        'owner:getMe',
        'owner:getUpdates',
        'owner:getUpdates',
        'owner:sendMessage',
        'send-only:getMe',
        'send-only:sendMessage',
      ]);
      assert.deepEqual(ownerSecrets.get(), { token: 'shared-token', chatId: 700 });
      assert.deepEqual(senderSecrets.get(), { token: 'shared-token', chatId: 700 });

      const ownerDb = openDatabase({ file: resolvePaths(ownerRoot).databaseFile });
      const senderDb = openDatabase({ file: resolvePaths(senderRoot).databaseFile });
      try {
        assert.equal(readOffset(ownerDb.handle, telegramBotScope('shared-token')), 8);
        assert.equal(readOffset(ownerDb.handle, telegramBotScope('old-owner-token')), 41);
        assert.throws(
          () => readOffset(senderDb.handle, telegramBotScope('shared-token')),
          /Telegram update offset is missing/,
        );
      } finally {
        ownerDb.close();
        senderDb.close();
      }
    } finally {
      rmSync(ownerRoot, { recursive: true, force: true });
      rmSync(senderRoot, { recursive: true, force: true });
    }
  });

  it('drains every pre-existing update batch before asking for /start', async () => {
    const offsets: number[] = [];
    const client = {
      async getUpdates(offset: number): Promise<TelegramUpdate[]> {
        offsets.push(offset);
        if (offset === 0) return [update(4, 100, '/start')];
        if (offset === 5) return [update(9, 200, '/start')];
        return [];
      },
    };

    assert.equal(await drainUpdateBacklog(client), 10);
    assert.deepEqual(offsets, [0, 5, 10]);
  });

  it('starts polling after the pre-setup baseline and accepts a fresh /start', async () => {
    const offsets: number[] = [];
    const client = {
      async getUpdates(offset: number): Promise<TelegramUpdate[]> {
        offsets.push(offset);
        return [update(42, 700, '/start')];
      },
    };

    assert.deepEqual(await waitForStart(client, 42, 'OpenMurmurBot', 1), {
      chatId: 700,
      nextOffset: 43,
      userId: 700,
      username: 'user700',
      firstName: 'User 700',
    });
    assert.deepEqual(offsets, [42]);
  });

  it('accepts /start addressed to this bot and ignores other private messages', async () => {
    let poll = 0;
    const client = {
      async getUpdates(): Promise<TelegramUpdate[]> {
        poll += 1;
        return poll === 1
          ? [update(10, 111, 'hello'), update(11, 222, '/start@OtherBot')]
          : [update(12, 333, '/START@OpenMurmurBot payload')];
      },
    };

    assert.deepEqual(await waitForStart(client, 10, 'OpenMurmurBot', 2), {
      chatId: 333,
      nextOffset: 13,
      userId: 333,
      username: 'user333',
      firstName: 'User 333',
    });
  });

  it('does not bind to /start from a group', async () => {
    const client = {
      async getUpdates(): Promise<TelegramUpdate[]> {
        return [update(5, -100, '/start', 'group')];
      },
    };

    await assert.rejects(waitForStart(client, 5, 'OpenMurmurBot', 1), /No message arrived/);
  });

  it('requires an identifiable human sender', async () => {
    const botStart = update(5, 50, '/start');
    if (botStart.message?.from !== undefined) botStart.message.from.is_bot = true;
    const client = {
      async getUpdates(): Promise<TelegramUpdate[]> {
        return [botStart];
      },
    };

    await assert.rejects(waitForStart(client, 5, 'OpenMurmurBot', 1), /No message arrived/);
  });
});

function memorySecrets(initial: TelegramSecrets | null): {
  readonly store: SecretsStore;
  get(): TelegramSecrets | null;
  readonly writes: TelegramSecrets[];
} {
  let current = initial;
  const writes: TelegramSecrets[] = [];
  return {
    writes,
    get: () => current,
    store: {
      async peek() {
        return current;
      },
      async load() {
        return current;
      },
      async storeSecrets(secrets) {
        writes.push(secrets);
        current = secrets;
      },
      async clear() {
        current = null;
      },
    },
  };
}

describe('Telegram setup persistence', () => {
  it('does not move unresolved deliveries across a credential or chat replacement', async () => {
    const root = mkdtempSync(join(tmpdir(), 'openmurmur-setup-rebind-'));
    const paths = resolvePaths(root);
    const db = openDatabase({ file: paths.databaseFile });
    const previous = { token: 'old-token', chatId: 10 } as const;
    const secrets = memorySecrets(previous);
    const outbox = new Outbox(db.handle);
    assert.equal(
      outbox.enqueue({
        deliveryPartId: 'status:old-destination',
        kind: 'status',
        ordinal: 1,
        payload: { type: 'text', text: 'private old-destination message' },
      }),
      true,
    );
    writeOffset(db.handle, 7, telegramBotScope(previous.token));
    const claim = await claimDaemonMaintenance(db.handle, paths.pidFile, root, {
      birthMarker: async () => 'test-process-birth',
    });
    let confirmed = false;
    try {
      await assert.rejects(
        commitTelegramSetup(
          db.handle,
          secrets.store,
          { token: 'new-token', chatId: 20 },
          { role: 'owner', nextOffset: 101 },
          async () => {
            confirmed = true;
          },
        ),
        /Cannot replace Telegram credentials while unresolved deliveries exist/,
      );
      assert.deepEqual(secrets.get(), previous);
      assert.equal(readOffset(db.handle, telegramBotScope(previous.token)), 7);
      assert.equal(confirmed, false);
      assert.equal(secrets.writes.length, 0);

      db.handle
        .prepare(
          "UPDATE telegram_outbox SET state = 'failed' WHERE delivery_part_id = 'status:old-destination'",
        )
        .run();
      await commitTelegramSetup(
        db.handle,
        secrets.store,
        { token: 'new-token', chatId: 20 },
        { role: 'owner', nextOffset: 101 },
        async () => {
          confirmed = true;
        },
      );
      assert.deepEqual(secrets.get(), { token: 'new-token', chatId: 20 });
      assert.equal(confirmed, true, 'a deliberately retired row must not deadlock replacement');

      assert.throws(
        () =>
          outbox.enqueue({
            deliveryPartId: 'status:racing-old-destination',
            kind: 'status',
            ordinal: 2,
            payload: { type: 'text', text: 'must not cross the replacement proof' },
          }),
        /Telegram outbox is paused during exclusive Telegram maintenance/,
      );

      db.handle
        .prepare(
          "UPDATE telegram_outbox SET state = 'dead' WHERE delivery_part_id = 'status:old-destination'",
        )
        .run();
      await assert.rejects(
        commitTelegramSetup(
          db.handle,
          secrets.store,
          { token: 'third-token', chatId: 30 },
          { role: 'owner', nextOffset: 202 },
          async () => {},
        ),
        /Cannot replace Telegram credentials while unresolved deliveries exist/,
        'a recoverable dead delivery remains bound to the current destination',
      );
      assert.throws(
        () =>
          db.handle
            .prepare(
              "UPDATE telegram_outbox SET state = 'pending' WHERE delivery_part_id = 'status:old-destination'",
            )
            .run(),
        /Telegram outbox is paused during exclusive Telegram maintenance/,
      );
    } finally {
      await releaseDaemonMaintenance(db.handle, paths.pidFile, claim);
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('publishes the matching scoped offset before the Keychain pair', async () => {
    const db = openDatabase({ file: ':memory:' });
    const next = { token: 'new-token', chatId: 20 } as const;
    let stored: TelegramSecrets | null = null;
    const store: SecretsStore = {
      async peek() {
        return null;
      },
      async load() {
        return null;
      },
      async storeSecrets(secrets) {
        assert.equal(
          readOffset(db.handle, telegramBotScope(secrets.token)),
          101,
          'a hard death after this Keychain publish must leave a matching cursor',
        );
        stored = secrets;
      },
      async clear() {
        stored = null;
      },
    };
    try {
      await commitTelegramSetup(
        db.handle,
        store,
        next,
        { role: 'owner', nextOffset: 101 },
        async () => {},
      );
      assert.deepEqual(stored, next);
    } finally {
      db.close();
    }
  });

  it('stores one credential pair and its matching update offset on success', async () => {
    const db = openDatabase({ file: ':memory:' });
    const secrets = memorySecrets(null);
    try {
      await commitTelegramSetup(
        db.handle,
        secrets.store,
        { token: 'new-token', chatId: 20 },
        { role: 'owner', nextOffset: 101 },
        async () => {},
      );

      assert.deepEqual(secrets.get(), { token: 'new-token', chatId: 20 });
      assert.deepEqual(secrets.writes, [{ token: 'new-token', chatId: 20 }]);
      assert.equal(readOffset(db.handle, telegramBotScope('new-token')), 101);
    } finally {
      db.close();
    }
  });

  it('restores both the previous pair and offset when confirmation fails', async () => {
    const db = openDatabase({ file: ':memory:' });
    const secrets = memorySecrets({ token: 'old-token', chatId: 10 });
    const oldBotScope = telegramBotScope('old-token');
    writeOffset(db.handle, 7, oldBotScope);
    try {
      await assert.rejects(
        commitTelegramSetup(
          db.handle,
          secrets.store,
          { token: 'new-token', chatId: 20 },
          { role: 'owner', nextOffset: 101 },
          async () => {
            throw new Error('confirmation failed');
          },
        ),
        /confirmation failed/,
      );

      assert.deepEqual(secrets.get(), { token: 'old-token', chatId: 10 });
      assert.equal(readOffset(db.handle, oldBotScope), 7);
    } finally {
      db.close();
    }
  });

  it('leaves the old offset untouched when the atomic credential write fails', async () => {
    const db = openDatabase({ file: ':memory:' });
    const old = { token: 'old-token', chatId: 10 } as const;
    const oldBotScope = telegramBotScope(old.token);
    writeOffset(db.handle, 7, oldBotScope);
    const store: SecretsStore = {
      async peek() {
        return old;
      },
      async load() {
        return old;
      },
      async storeSecrets() {
        throw new Error('Keychain write failed');
      },
      async clear() {
        assert.fail('an atomic failed write needs no destructive rollback');
      },
    };
    try {
      await assert.rejects(
        commitTelegramSetup(
          db.handle,
          store,
          { token: 'new-token', chatId: 20 },
          { role: 'owner', nextOffset: 101 },
          async () => {},
        ),
        /Keychain write failed/,
      );
      assert.equal(readOffset(db.handle, oldBotScope), 7);
      assert.throws(
        () => readOffset(db.handle, telegramBotScope('new-token')),
        /Telegram update offset is missing.*setup telegram/,
        'failed credentials must not leave an apparently configured cursor',
      );
    } finally {
      db.close();
    }
  });

  it('restores the prior cursor when the same bot credential write fails', async () => {
    const db = openDatabase({ file: ':memory:' });
    const old = { token: 'same-token', chatId: 10 } as const;
    const scope = telegramBotScope(old.token);
    writeOffset(db.handle, 7, scope);
    const store: SecretsStore = {
      async peek() {
        return old;
      },
      async load() {
        return old;
      },
      async storeSecrets() {
        assert.equal(readOffset(db.handle, scope), 101);
        throw new Error('Keychain write failed');
      },
      async clear() {
        assert.fail('an atomic failed write needs no destructive rollback');
      },
    };
    try {
      await assert.rejects(
        commitTelegramSetup(
          db.handle,
          store,
          { token: old.token, chatId: 20 },
          { role: 'owner', nextOffset: 101 },
          async () => {},
        ),
        /Keychain write failed/,
      );
      assert.equal(readOffset(db.handle, scope), 7);
    } finally {
      db.close();
    }
  });

  it('fails closed when a configured credential scope has no durable cursor', () => {
    const db = openDatabase({ file: ':memory:' });
    try {
      assert.throws(
        () => readOffset(db.handle, telegramBotScope('interrupted-token')),
        /Telegram update offset is missing.*pnpm openmurmur setup telegram owner/,
      );
      assert.equal(readOffset(db.handle), 0, 'only the pre-scoping legacy cursor defaults to zero');
    } finally {
      db.close();
    }
  });
});
