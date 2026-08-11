import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { type Database, openDatabase } from '../../src/database/db.ts';

const CREATED = '2026-08-11T10:00:00.000Z';
const ACK = '2026-08-11T10:05:00.000Z';

let root: string;
let db: Database;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'om-cli-telegram-delivery-reconcile-'));
  db = openDatabase({ file: join(root, 'openmurmur.db') });
  db.handle
    .prepare(
      `INSERT INTO telegram_outbox
         (outbox_id, delivery_part_id, kind, ordinal, payload, state, attempts,
          run_after, created_at, updated_at)
       VALUES ('cli-remote', 'status:cli-remote', 'status', 0, ?, 'pending', 1, ?, ?, ?)`,
    )
    .run(
      JSON.stringify({ type: 'text', text: 'remote evidence target' }),
      CREATED,
      CREATED,
      CREATED,
    );
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

function run(...args: string[]) {
  return spawnSync(process.execPath, ['src/cli/main.ts', ...args, '--root', root], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
}

function applyArgs(): string[] {
  return [
    'delivery',
    'reconcile-remote',
    'apply',
    '--delivery-part',
    'status:cli-remote',
    '--telegram-message-id',
    '501',
    '--ack-at',
    ACK,
    '--operator',
    'cli-test',
    '--evidence',
    'Telegram export message 501 matched payload hash',
  ];
}

describe('remote Telegram delivery reconciliation CLI', () => {
  it('is report-only by default and labels remote status unknown', () => {
    const result = run(
      'delivery',
      'reconcile-remote',
      '--delivery-part',
      'status:cli-remote',
      '--json',
    );

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout) as {
      deliveries: { deliveryPartId: string; remoteStatus: string; payloadSha256: string }[];
    };
    assert.deepEqual(
      payload.deliveries.map((row) => [row.deliveryPartId, row.remoteStatus]),
      [['status:cli-remote', 'unknown']],
    );
    assert.match(payload.deliveries[0]?.payloadSha256 ?? '', /^[0-9a-f]{64}$/);
    const stored = db.handle
      .prepare('SELECT state FROM telegram_outbox WHERE outbox_id = ?')
      .get('cli-remote') as { state: string };
    assert.equal(stored.state, 'pending');
  });

  it('requires explicit confirmation and then applies one exact remote identity', () => {
    const cancelled = run(...applyArgs());
    assert.equal(cancelled.status, 1);
    assert.match(cancelled.stdout, /Cancelled\. No outbox or domain facts were changed/);

    const applied = run(...applyArgs(), '--yes', '--json');
    assert.equal(applied.status, 0, applied.stderr);
    const result = JSON.parse(applied.stdout) as {
      deliveryPartId: string;
      telegramMessageId: number;
      acknowledgedAt: string;
      alreadyApplied: boolean;
    };
    assert.deepEqual(result, {
      ...result,
      deliveryPartId: 'status:cli-remote',
      telegramMessageId: 501,
      acknowledgedAt: ACK,
      alreadyApplied: false,
    });
    const stored = db.handle
      .prepare('SELECT state, telegram_message_id, updated_at FROM telegram_outbox')
      .get() as { state: string; telegram_message_id: number; updated_at: string };
    assert.deepEqual({ ...stored }, { state: 'sent', telegram_message_id: 501, updated_at: ACK });

    const replayed = run(...applyArgs(), '--yes', '--json');
    assert.equal(replayed.status, 0, replayed.stderr);
    assert.equal((JSON.parse(replayed.stdout) as { alreadyApplied: boolean }).alreadyApplied, true);
    const audits = db.handle
      .prepare('SELECT count(*) AS count FROM telegram_delivery_reconciliation_audit')
      .get() as { count: number };
    assert.equal(audits.count, 1);
  });

  it('refuses apply while the state root names a live daemon pid', () => {
    const runtime = join(root, 'run');
    mkdirSync(runtime, { recursive: true });
    writeFileSync(
      join(runtime, 'daemon.pid'),
      `${JSON.stringify({
        pid: process.pid,
        root,
        startedAt: CREATED,
        processBirth: 'independent-test-process',
      })}\n`,
    );

    const result = run(...applyArgs(), '--yes', '--json');

    assert.equal(result.status, 1);
    assert.match(result.stderr, /stop the OpenMurmur daemon before reconciling remote delivery/);
    const stored = db.handle
      .prepare('SELECT state FROM telegram_outbox WHERE outbox_id = ?')
      .get('cli-remote') as { state: string };
    assert.equal(stored.state, 'pending');
  });
});
