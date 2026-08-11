import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { pollTelegramReadOnly } from '../../src/cli/main.ts';
import { type Database, openDatabase } from '../../src/database/db.ts';
import { readOffset, writeOffset } from '../../src/telegram/router.ts';

let dir: string;
let db: Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'om-cli-telegram-poll-'));
  db = openDatabase({ file: join(dir, 'test.db') });
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

    const result = await pollTelegramReadOnly(db.handle, client, botScope, 42, true);

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
  });
});
