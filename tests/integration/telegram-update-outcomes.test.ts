import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { AsrPreferenceRepository } from '../../src/asr/preferences.ts';
import { enqueueIncomingRequest } from '../../src/cli/daemon.ts';
import { type Database, openDatabase } from '../../src/database/db.ts';
import { Outbox } from '../../src/telegram/outbox.ts';
import {
  completeTelegramUpdate,
  readOffset,
  recordUpdate,
  writeOffset,
  writeOffsetAfterHandledUpdates,
} from '../../src/telegram/router.ts';

let dir: string;
let databaseFile: string;
let db: Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'om-telegram-outcomes-'));
  databaseFile = join(dir, 'test.db');
  db = openDatabase({ file: databaseFile });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function handled(updateId: number, botScope: string): number {
  const row = db.handle
    .prepare('SELECT handled FROM telegram_updates WHERE bot_scope = ? AND update_id = ?')
    .get(botScope, updateId) as { handled: number };
  return row.handled;
}

function outboxCount(deliveryPartId: string): number {
  const row = db.handle
    .prepare('SELECT count(*) AS count FROM telegram_outbox WHERE delivery_part_id = ?')
    .get(deliveryPartId) as { count: number };
  return row.count;
}

describe('durable Telegram update outcomes', () => {
  it('records one explicit durable outcome for every routed action across restart', () => {
    const botScope = 'bot-matrix';
    const updates = [
      { update_id: 101, kind: 'ignore' },
      { update_id: 102, kind: 'command' },
      { update_id: 103, kind: 'callback' },
      { update_id: 104, kind: 'unknown_command' },
      { update_id: 105, kind: 'audio' },
      { update_id: 106, kind: 'text' },
    ] as const;
    writeOffset(db.handle, 101, botScope);
    for (const update of updates) {
      assert.equal(recordUpdate(db.handle, update.update_id, update.kind, botScope), true);
    }

    completeTelegramUpdate(db.handle, 101, 'ignore', botScope, () => {});
    completeTelegramUpdate(db.handle, 102, 'command', botScope, () => {
      new Outbox(db.handle).enqueue({
        deliveryPartId: 'help:bot-matrix:102',
        kind: 'status',
        ordinal: 1,
        payload: { type: 'text', text: 'help' },
      });
    });
    completeTelegramUpdate(db.handle, 103, 'callback', botScope, () => {
      new AsrPreferenceRepository(db.handle).set('ru');
    });
    completeTelegramUpdate(db.handle, 104, 'unknown_command', botScope, () => {
      new Outbox(db.handle).enqueue({
        deliveryPartId: 'cmd:bot-matrix:104',
        kind: 'status',
        ordinal: 1,
        payload: { type: 'text', text: 'unknown command' },
      });
    });
    enqueueIncomingRequest(
      db.handle,
      105,
      {
        message_id: 5,
        date: 0,
        chat: { id: 42, type: 'private' },
        voice: { file_id: 'matrix-file', file_unique_id: 'matrix-unique' },
      },
      'matrix-host',
      botScope,
    );
    completeTelegramUpdate(db.handle, 106, 'text', botScope, () => {});
    assert.equal(
      writeOffsetAfterHandledUpdates(
        db.handle,
        updates.map(({ update_id }) => ({ update_id })),
        101,
        botScope,
      ),
      107,
    );

    db.close();
    db = openDatabase({ file: databaseFile });
    for (const update of updates) {
      assert.equal(handled(update.update_id, botScope), 1);
      assert.equal(recordUpdate(db.handle, update.update_id, update.kind, botScope), false);
    }
    assert.equal(readOffset(db.handle, botScope), 107);
    assert.equal(outboxCount('help:bot-matrix:102'), 1);
    assert.equal(outboxCount('cmd:bot-matrix:104'), 1);
    assert.equal(outboxCount('ack:bot-matrix:105'), 1);
    assert.equal(new AsrPreferenceRepository(db.handle).stored(), 'ru');
    assert.equal(
      (
        db.handle
          .prepare(
            "SELECT count(*) AS count FROM jobs WHERE idempotency_key = 'incoming:bot-matrix:105'",
          )
          .get() as { count: number }
      ).count,
      1,
    );
  });

  it('rolls back command outbox and callback state when handled publication fails', () => {
    const botScope = 'bot-fault';
    assert.equal(recordUpdate(db.handle, 201, 'command', botScope), true);
    db.handle.exec(`CREATE TEMP TRIGGER fail_command_handled
      BEFORE UPDATE OF handled ON telegram_updates
      WHEN NEW.bot_scope = 'bot-fault' AND NEW.update_id = 201 AND NEW.handled = 1
      BEGIN SELECT RAISE(ABORT, 'simulated handled failure'); END`);

    assert.throws(
      () =>
        completeTelegramUpdate(db.handle, 201, 'command', botScope, () => {
          new Outbox(db.handle).enqueue({
            deliveryPartId: 'help:bot-fault:201',
            kind: 'status',
            ordinal: 1,
            payload: { type: 'text', text: 'help' },
          });
        }),
      /simulated handled failure/,
    );
    assert.equal(handled(201, botScope), 0);
    assert.equal(outboxCount('help:bot-fault:201'), 0);

    db.handle.exec('DROP TRIGGER fail_command_handled');
    assert.equal(recordUpdate(db.handle, 202, 'callback', botScope), true);
    db.handle.exec(`CREATE TEMP TRIGGER fail_callback_handled
      BEFORE UPDATE OF handled ON telegram_updates
      WHEN NEW.bot_scope = 'bot-fault' AND NEW.update_id = 202 AND NEW.handled = 1
      BEGIN SELECT RAISE(ABORT, 'simulated handled failure'); END`);
    assert.throws(
      () =>
        completeTelegramUpdate(db.handle, 202, 'callback', botScope, () => {
          new AsrPreferenceRepository(db.handle).set('en');
        }),
      /simulated handled failure/,
    );
    assert.equal(handled(202, botScope), 0);
    assert.equal(new AsrPreferenceRepository(db.handle).stored(), undefined);

    db.close();
    db = openDatabase({ file: databaseFile });
    assert.equal(recordUpdate(db.handle, 201, 'command', botScope), true);
    completeTelegramUpdate(db.handle, 201, 'command', botScope, () => {
      new Outbox(db.handle).enqueue({
        deliveryPartId: 'help:bot-fault:201',
        kind: 'status',
        ordinal: 1,
        payload: { type: 'text', text: 'help' },
      });
    });
    assert.equal(recordUpdate(db.handle, 202, 'callback', botScope), true);
    completeTelegramUpdate(db.handle, 202, 'callback', botScope, () => {
      new AsrPreferenceRepository(db.handle).set('en');
    });

    assert.equal(outboxCount('help:bot-fault:201'), 1);
    assert.equal(new AsrPreferenceRepository(db.handle).stored(), 'en');
    assert.equal(
      completeTelegramUpdate(db.handle, 202, 'callback', botScope, () => {
        new AsrPreferenceRepository(db.handle).set('th');
      }),
      false,
    );
    assert.equal(new AsrPreferenceRepository(db.handle).stored(), 'en');
    assert.equal(recordUpdate(db.handle, 201, 'command', botScope), false);
    assert.equal(recordUpdate(db.handle, 202, 'callback', botScope), false);
  });

  it('never advances past an unhandled update and recovers an offset-write fault', () => {
    const botScope = 'bot-offset';
    const updates = [{ update_id: 301 }, { update_id: 302 }];
    writeOffset(db.handle, 301, botScope);
    assert.equal(recordUpdate(db.handle, 301, 'command', botScope), true);
    assert.equal(recordUpdate(db.handle, 302, 'text', botScope), true);
    completeTelegramUpdate(db.handle, 301, 'command', botScope, () => {
      new Outbox(db.handle).enqueue({
        deliveryPartId: 'help:bot-offset:301',
        kind: 'status',
        ordinal: 1,
        payload: { type: 'text', text: 'help' },
      });
    });

    assert.throws(
      () => writeOffsetAfterHandledUpdates(db.handle, updates, 301, botScope),
      /unhandled update bot-offset\/302/,
    );
    assert.equal(readOffset(db.handle, botScope), 301);
    assert.equal(recordUpdate(db.handle, 303, 'ignore', botScope), true);
    completeTelegramUpdate(db.handle, 303, 'ignore', botScope, () => {});
    assert.throws(
      () => writeOffsetAfterHandledUpdates(db.handle, [{ update_id: 303 }], 301, botScope),
      /unhandled update bot-offset\/302/,
      'an omitted later response must not skip an update recorded by an earlier attempt',
    );

    completeTelegramUpdate(db.handle, 302, 'text', botScope, () => {});
    db.handle.exec(`CREATE TEMP TRIGGER fail_offset_write
      BEFORE UPDATE ON telegram_offset
      WHEN NEW.bot_scope = 'bot-offset'
      BEGIN SELECT RAISE(ABORT, 'simulated offset failure'); END`);
    assert.throws(
      () => writeOffsetAfterHandledUpdates(db.handle, updates, 301, botScope),
      /simulated offset failure/,
    );
    assert.equal(readOffset(db.handle, botScope), 301);
    assert.equal(handled(301, botScope), 1);
    assert.equal(handled(302, botScope), 1);

    db.close();
    db = openDatabase({ file: databaseFile });
    assert.equal(recordUpdate(db.handle, 301, 'command', botScope), false);
    assert.equal(recordUpdate(db.handle, 302, 'text', botScope), false);
    assert.equal(writeOffsetAfterHandledUpdates(db.handle, updates, 301, botScope), 303);
    assert.equal(readOffset(db.handle, botScope), 303);
    assert.equal(outboxCount('help:bot-offset:301'), 1);
  });

  it('fails closed if an unhandled replay changes route', () => {
    assert.equal(recordUpdate(db.handle, 401, 'ignore', 'bot-route'), true);
    assert.throws(
      () => recordUpdate(db.handle, 401, 'command', 'bot-route'),
      /changed route from ignore to command/,
    );
    assert.equal(handled(401, 'bot-route'), 0);
  });
});
