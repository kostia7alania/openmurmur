import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { type Database, openDatabase } from '../../src/database/db.ts';

let root: string;
let db: Database;

const STARTED = '2026-08-11T09:00:00.000Z';
const ENDED = '2026-08-11T10:00:00.000Z';
const ACK = '2026-08-11T10:05:00.000Z';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'om-cli-delivery-reconcile-'));
  db = openDatabase({ file: join(root, 'openmurmur.db') });
  db.handle
    .prepare(
      `INSERT INTO audio_sessions
         (session_id, state, started_at, ended_at, duration_ms, speech_ms, part_count,
          created_at, updated_at)
       VALUES ('cli-session', 'DONE', ?, ?, 3600000, 3000000, 1, ?, ?)`,
    )
    .run(STARTED, ENDED, STARTED, ENDED);
  db.handle
    .prepare(
      `INSERT INTO audio_parts
         (part_id, session_id, part_index, path, started_at, ended_at, duration_ms,
          bytes, sha256, finalized, delivered, delivered_at, created_at)
       VALUES ('cli-part', 'cli-session', 0, ?, ?, ?, 3600000,
               100, 'sha', 1, 1, NULL, ?)`,
    )
    .run(join(root, 'cli-part.flac'), STARTED, ENDED, STARTED);
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

function storedClock(): string | null {
  const row = db.handle
    .prepare("SELECT delivered_at FROM audio_parts WHERE part_id = 'cli-part'")
    .get() as { delivered_at: string | null };
  return row.delivered_at;
}

describe('delivery reconciliation CLI', () => {
  it('is report-only by default and emits a machine-readable held set', () => {
    const result = run('delivery', 'reconcile', '--part', 'cli-part', '--json');
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout) as { held: { partId: string }[] };
    assert.deepEqual(
      payload.held.map((row) => row.partId),
      ['cli-part'],
    );
    assert.equal(storedClock(), null);
  });

  it('does not apply without an interactive confirmation or explicit --yes', () => {
    const result = run(
      'delivery',
      'reconcile',
      'apply',
      '--part',
      'cli-part',
      '--ack-at',
      ACK,
      '--operator',
      'cli-test',
      '--evidence',
      'Telegram export row 501',
    );
    assert.equal(result.status, 1);
    assert.match(result.stdout, /Cancelled\. No delivery clocks were changed/);
    assert.equal(storedClock(), null);
  });

  it('requires one explicit scope before apply', () => {
    const result = run(
      'delivery',
      'reconcile',
      'apply',
      '--ack-at',
      ACK,
      '--operator',
      'cli-test',
      '--evidence',
      'Telegram export row 501',
      '--yes',
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /exactly one --part or --session/);
    assert.equal(storedClock(), null);
  });

  it('applies one selected exact ACK with explicit proof and audit', () => {
    const result = run(
      'delivery',
      'reconcile',
      'apply',
      '--part',
      'cli-part',
      '--ack-at',
      ACK,
      '--operator',
      'cli-test',
      '--evidence',
      'Telegram export row 501',
      '--yes',
      '--json',
    );
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout) as { acknowledgedAt: string; partIds: string[] };
    assert.equal(payload.acknowledgedAt, ACK);
    assert.deepEqual(payload.partIds, ['cli-part']);
    assert.equal(storedClock(), ACK);
    const audit = db.handle
      .prepare('SELECT operator_id, evidence FROM audio_delivery_reconciliation_audit')
      .get() as { operator_id: string; evidence: string };
    assert.deepEqual(
      { ...audit },
      { operator_id: 'cli-test', evidence: 'Telegram export row 501' },
    );
  });
});
