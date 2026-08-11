import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  commitTelegramSetup,
  drainUpdateBacklog,
  renderSetupCompletion,
  renderTelegramSetupCompletion,
  waitForStart,
} from '../../src/cli/setup.ts';
import { openDatabase } from '../../src/database/db.ts';
import type { TelegramUpdate } from '../../src/telegram/client.ts';
import {
  type SecretsStore,
  type TelegramSecrets,
  telegramBotScope,
} from '../../src/telegram/keychain.ts';
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

describe('setup completion output', () => {
  it('leads a fresh setup through Telegram to one verifiable ambient session', () => {
    const output = renderSetupCompletion();
    const expectedInOrder = [
      'pnpm openmurmur setup telegram',
      'pnpm openmurmur capture test',
      'pnpm openmurmur start',
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

  it('continues a completed Telegram setup without promising a global binary', () => {
    const output = renderTelegramSetupCompletion({ botUsername: 'murmur_bot', chatId: 42 });

    assert.match(output, /^✅ Connected @murmur_bot, chat 42$/m);
    assert.doesNotMatch(output, /setup telegram/);
    assert.match(output, /pnpm openmurmur capture test/);
    assert.match(output, /pnpm openmurmur start/);
    assert.doesNotMatch(output, /(^|\n)\s*(?:\d+\.\s+)?openmurmur\s/m);
  });
});

describe('Telegram setup ownership handshake', () => {
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
  it('publishes the matching scoped offset before the Keychain pair', async () => {
    const db = openDatabase({ file: ':memory:' });
    const next = { token: 'new-token', chatId: 20 } as const;
    let stored: TelegramSecrets | null = null;
    const store: SecretsStore = {
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
      await commitTelegramSetup(db.handle, store, next, 101, async () => {});
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
        101,
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
          101,
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
          101,
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
          101,
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
        /Telegram update offset is missing.*pnpm openmurmur setup telegram/,
      );
      assert.equal(readOffset(db.handle), 0, 'only the pre-scoping legacy cursor defaults to zero');
    } finally {
      db.close();
    }
  });
});
