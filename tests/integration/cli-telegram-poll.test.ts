import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { claimDaemonPid, releaseDaemonPid } from '../../src/cli/daemon-ownership.ts';
import { pollTelegramReadOnly, withStoppedDaemonForTelegram } from '../../src/cli/main.ts';
import { type Paths, resolvePaths } from '../../src/config/paths.ts';
import { DEFAULT_CONFIG } from '../../src/config/schema.ts';
import { type Database, openDatabase } from '../../src/database/db.ts';
import { readOffset, writeOffset } from '../../src/telegram/router.ts';

let dir: string;
let db: Database;
let paths: Paths;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "om-cli-telegram-poll-'-"));
  paths = resolvePaths(dir);
  db = openDatabase({ file: paths.databaseFile });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('telegram poll CLI', () => {
  it('reports routing decisions without consuming the production scoped offset', async () => {
    const botScope = 'production-bot';
    writeOffset(db.handle, 700, botScope);
    const requestedOffsets: number[] = [];
    const client = {
      async getUpdates(offset: number) {
        requestedOffsets.push(offset);
        return [
          {
            update_id: 700,
            message: {
              message_id: 1,
              date: 0,
              chat: { id: 42, type: 'private' },
              text: '/help',
            },
          },
          {
            update_id: 701,
            message: {
              message_id: 2,
              date: 0,
              chat: { id: 99, type: 'private' },
              text: 'not allowlisted',
            },
          },
        ];
      },
    };

    await assert.rejects(
      pollTelegramReadOnly(db.handle, client, botScope, 42, false),
      /disabled on this send-only host/,
    );
    assert.deepEqual(requestedOffsets, [], 'send-only diagnostics must not call getUpdates');

    const result = await withStoppedDaemonForTelegram(
      { config: DEFAULT_CONFIG, paths, fromFile: false },
      'telegram poll',
      (controlDb) => pollTelegramReadOnly(controlDb, client, botScope, 42, true),
      { birthMarker: async () => 'poll-maintenance-birth' },
    );

    assert.deepEqual(requestedOffsets, [700]);
    assert.deepEqual(result, {
      offset: 700,
      updates: [
        { updateId: 700, kind: 'command' },
        { updateId: 701, kind: 'ignore' },
      ],
    });
    assert.equal(readOffset(db.handle, botScope), 700);
    assert.equal(
      (
        db.handle.prepare('SELECT count(*) AS count FROM telegram_updates').get() as {
          count: number;
        }
      ).count,
      0,
    );

    let actionStarted = 0;
    await assert.rejects(
      withStoppedDaemonForTelegram(
        { config: DEFAULT_CONFIG, paths, fromFile: false },
        'telegram poll',
        async () => {
          actionStarted += 1;
        },
        { birthMarker: async () => null },
      ),
      /could not establish maintenance process birth identity/,
    );
    assert.equal(actionStarted, 0);
  });

  it('refuses a live exact-root owner before reading credentials or polling Telegram', async () => {
    const botScope = 'production-bot';
    writeOffset(db.handle, 700, botScope);
    mkdirSync(paths.runtimeDir, { mode: 0o700 });
    const owner = await claimDaemonPid(db.handle, paths.pidFile, paths.root, {
      birthMarker: async () => 'telegram-poll-test-birth',
      inspect: async () => ({
        alive: true,
        identityMatches: false,
        command: 'test process',
        processBirth: 'telegram-poll-test-birth',
      }),
    });
    const mirrorBefore = readFileSync(paths.pidFile, 'utf8');
    const ownershipBefore = db.handle
      .prepare('SELECT * FROM daemon_ownership WHERE ownership_id = 1')
      .get();
    let credentialReads = 0;
    let fetches = 0;
    const quotedRoot = `'${paths.root.replaceAll("'", `'"'"'`)}'`;

    try {
      await assert.rejects(
        withStoppedDaemonForTelegram(
          { config: DEFAULT_CONFIG, paths, fromFile: false },
          'telegram poll',
          async () => {
            credentialReads += 1;
            fetches += 1;
          },
        ),
        (error: unknown) => {
          assert.equal(
            (error as Error).message,
            [
              'The OpenMurmur daemon must be stopped before this Telegram control operation.',
              'Run from the repository checkout:',
              `  pnpm openmurmur --root ${quotedRoot} stop`,
              `  pnpm openmurmur --root ${quotedRoot} telegram poll`,
              `  pnpm openmurmur --root ${quotedRoot} start`,
            ].join('\n'),
          );
          return true;
        },
      );

      assert.equal(credentialReads, 0);
      assert.equal(fetches, 0);
      assert.equal(readOffset(db.handle, botScope), 700);
      assert.equal(existsSync(paths.configFile), false);
      assert.equal(readFileSync(paths.pidFile, 'utf8'), mirrorBefore);
      assert.deepEqual(
        db.handle.prepare('SELECT * FROM daemon_ownership WHERE ownership_id = 1').get(),
        ownershipBefore,
      );
    } finally {
      await releaseDaemonPid(db.handle, paths.pidFile, owner);
    }
  });
});
