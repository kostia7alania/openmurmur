import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { recoverAfterCrash } from '../../src/capture/recovery.ts';
import { resolvePaths } from '../../src/config/paths.ts';
import { type Database, openDatabase } from '../../src/database/db.ts';
import { PartRepository, SessionRepository } from '../../src/database/repository.ts';
import { nullLogger } from '../../src/logging/logger.ts';
import { TelegramClient } from '../../src/telegram/client.ts';
import { drainOutbox, Outbox } from '../../src/telegram/outbox.ts';

let root: string;
let db: Database;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'om-cli-outbox-recovery-'));
  for (const directory of ['audio', 'tmp', 'transcripts', 'logs', 'run']) {
    mkdirSync(join(root, directory), { recursive: true });
  }
  db = openDatabase({ file: join(root, 'openmurmur.db') });
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

function scriptedFetch(response: () => Response): typeof fetch {
  return (async () => response()) as typeof fetch;
}

function badRequest(): Response {
  return new Response(
    JSON.stringify({ ok: false, error_code: 400, description: 'Bad Request: document rejected' }),
    { status: 400, headers: { 'content-type': 'application/json' } },
  );
}

function accepted(messageId: number): Response {
  return new Response(
    JSON.stringify({
      ok: true,
      result: { message_id: messageId, date: 0, chat: { id: 42, type: 'private' } },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function worker(fetchImpl: typeof fetch) {
  return {
    outbox: new Outbox(db.handle),
    client: new TelegramClient({
      token: 'test-token',
      baseUrl: 'https://api.telegram.org',
      fetchImpl,
    }),
    chatId: 42,
    logger: nullLogger,
    maxOutgoingBytes: 50 * 1024 * 1024,
  };
}

describe('dead Telegram outbox recovery CLI', () => {
  it('retains one exact failed split through recovery and deletes it only after retry succeeds', async () => {
    const paths = resolvePaths(root);
    const now = '2026-08-11T10:00:00.000Z';
    const sessionId = 'outbox-recovery-session';
    const sourcePath = join(paths.audioDir, `${sessionId}.p000.flac`);
    const sourceBytes = Buffer.from('durable source audio');
    writeFileSync(sourcePath, sourceBytes);

    const sessions = new SessionRepository(db.handle);
    sessions.create(sessionId, now, { hostName: 'test-host', timezone: 'Europe/Moscow' });
    sessions.finalize(sessionId, now, 1_000, 500, 1);
    const parts = new PartRepository(db.handle);
    const partId = parts.open(sessionId, 0, sourcePath, now);
    parts.finalizePart(partId, now, 1_000, sourceBytes.length, 'source-sha256');

    const splitStem = basename(sourcePath).replace(/\.flac$/i, '');
    const splitPath = join(paths.tempDir, `${splitStem}.lease-a.split000.flac`);
    const splitBytes = Buffer.from('exact failed split bytes');
    writeFileSync(splitPath, splitBytes);
    const deliveryPartId = `audio:${partId}:split0`;
    const payload = {
      type: 'document' as const,
      path: splitPath,
      filename: `${splitStem}.split000.flac`,
      partId,
      deleteAfterSend: true,
      caption: 'private caption must not be printed',
    };
    const outbox = new Outbox(db.handle);
    assert.equal(
      outbox.enqueue({
        deliveryPartId,
        kind: 'audio',
        sessionId,
        ordinal: 0,
        payload,
      }),
      true,
    );

    assert.equal(await drainOutbox(worker(scriptedFetch(badRequest)), 1), 0);
    const deadBefore = db.handle
      .prepare(
        `SELECT outbox_id, payload, state, attempts, claim_generation
           FROM telegram_outbox WHERE delivery_part_id = ?`,
      )
      .get(deliveryPartId) as {
      outbox_id: string;
      payload: string;
      state: string;
      attempts: number;
      claim_generation: number;
    };
    assert.equal(deadBefore.state, 'dead');
    assert.equal(
      existsSync(splitPath),
      true,
      'a terminal 400 must retain the exact retry artifact',
    );

    const botToken = `123456789:${'A'.repeat(35)}`;
    const privatePath = join(root, 'private folder', 'recording.flac');
    const privateChatId = '987654321';
    db.handle
      .prepare('UPDATE telegram_outbox SET last_error = ? WHERE delivery_part_id = ?')
      .run(
        `upload ${privatePath} for chat_id=${privateChatId} via https://api.telegram.org/bot${botToken}/sendDocument failed`,
        deliveryPartId,
      );
    const recovered = await recoverAfterCrash(db.handle, paths, nullLogger, {
      remove: true,
      repair: false,
    });
    assert.equal(recovered.removed, 0);
    assert.equal(
      existsSync(splitPath),
      true,
      'startup recovery must preserve a canonical dead split',
    );

    const inspected = run('outbox', 'failed', '--delivery-part', deliveryPartId, '--json');
    assert.equal(inspected.status, 0, inspected.stderr);
    assert.equal(
      inspected.stdout.includes(root),
      false,
      'the report must not disclose local paths',
    );
    assert.equal(inspected.stdout.includes(botToken), false, 'the report must redact bot tokens');
    assert.equal(inspected.stdout.includes(privateChatId), false, 'the report must hide chat ids');
    assert.equal(inspected.stdout.includes(privatePath), false, 'paths with spaces stay private');
    assert.equal(
      inspected.stdout.includes(payload.caption),
      false,
      'the report must not dump message or caption content',
    );
    const report = JSON.parse(inspected.stdout) as {
      deliveries: {
        deliveryPartId: string;
        lastError: string;
        payloadSha256: string;
        documentFilename: string;
        artifactStatus: string;
        artifactBytes: number;
        retryable: boolean;
      }[];
    };
    assert.deepEqual(report.deliveries, [
      {
        ...report.deliveries[0],
        deliveryPartId,
        documentFilename: payload.filename,
        artifactStatus: 'available',
        artifactBytes: splitBytes.length,
        retryable: true,
      },
    ]);
    assert.match(
      report.deliveries[0]?.lastError ?? '',
      /^Telegram delivery failed; private details sha256 [0-9a-f]{64}$/,
    );
    assert.match(report.deliveries[0]?.payloadSha256 ?? '', /^[0-9a-f]{64}$/);

    const blankSelector = run('outbox', 'failed', '--delivery-part', '', '--json');
    assert.equal(blankSelector.status, 1);
    assert.match(blankSelector.stderr, /requires one non-empty exact id/);
    const privateSelector = `${privatePath}:chat_id=${privateChatId}`;
    const unknown = run(
      'outbox',
      'retry',
      privateSelector,
      '--json',
      '--yes',
      '--accept-duplicate-risk',
    );
    assert.equal(unknown.status, 1);
    assert.equal(unknown.stderr.includes(privateSelector), false, 'errors must not echo selectors');
    const extra = run('outbox', 'retry', deliveryPartId, 'extra', '--json');
    assert.equal(extra.status, 1);
    assert.match(extra.stderr, /do not accept extra positional arguments/);

    assert.equal(
      outbox.enqueue({
        deliveryPartId: `audio:${partId}`,
        kind: 'audio',
        sessionId,
        ordinal: 0,
        payload: {
          type: 'document',
          path: sourcePath,
          filename: basename(sourcePath),
          partId,
        },
      }),
      true,
    );
    const ambiguousManifest = run(
      'outbox',
      'retry',
      deliveryPartId,
      '--json',
      '--yes',
      '--accept-duplicate-risk',
    );
    assert.equal(ambiguousManifest.status, 1);
    assert.match(ambiguousManifest.stderr, /mixes direct and split delivery/);
    assert.equal(
      (
        db.handle
          .prepare('SELECT state FROM telegram_outbox WHERE delivery_part_id = ?')
          .get(deliveryPartId) as { state: string }
      ).state,
      'dead',
    );
    db.handle
      .prepare('DELETE FROM telegram_outbox WHERE delivery_part_id = ?')
      .run(`audio:${partId}`);

    const unconfirmed = run('outbox', 'retry', deliveryPartId, '--json', '--yes');
    assert.equal(unconfirmed.status, 1);
    assert.match(unconfirmed.stderr, /--yes and --accept-duplicate-risk/);
    assert.equal(
      (
        db.handle
          .prepare('SELECT state FROM telegram_outbox WHERE delivery_part_id = ?')
          .get(deliveryPartId) as { state: string }
      ).state,
      'dead',
    );

    const retried = run(
      'outbox',
      'retry',
      deliveryPartId,
      '--json',
      '--yes',
      '--accept-duplicate-risk',
    );
    assert.equal(retried.status, 0, retried.stderr);
    const retryResult = JSON.parse(retried.stdout) as { warning: string };
    assert.match(retryResult.warning, /remote status is unknown/);
    assert.match(retryResult.warning, /may duplicate a message/);
    const pending = db.handle
      .prepare(
        `SELECT outbox_id, payload, state, attempts, claim_generation
           FROM telegram_outbox WHERE delivery_part_id = ?`,
      )
      .get(deliveryPartId) as typeof deadBefore;
    assert.equal(pending.outbox_id, deadBefore.outbox_id, 'retry must reuse the exact outbox row');
    assert.equal(pending.payload, deadBefore.payload, 'retry must preserve the exact payload');
    assert.equal(pending.state, 'pending');
    assert.equal(pending.attempts, 0);
    assert.equal(pending.claim_generation, deadBefore.claim_generation + 1);
    assert.deepEqual(readFileSync(splitPath), splitBytes);

    assert.equal(await drainOutbox(worker(scriptedFetch(() => accepted(701))), 1), 1);
    assert.equal(
      (
        db.handle
          .prepare('SELECT state FROM telegram_outbox WHERE delivery_part_id = ?')
          .get(deliveryPartId) as { state: string }
      ).state,
      'sent',
    );
    assert.equal(existsSync(splitPath), false, 'only the generation-fenced ACK permits cleanup');
    assert.deepEqual(readFileSync(sourcePath), sourceBytes, 'the archive source is never deleted');

    const missingPath = join(paths.tempDir, `${splitStem}.lease-b.split001.flac`);
    writeFileSync(missingPath, Buffer.from('legacy split'));
    const missingDeliveryPartId = `audio:${partId}:split1`;
    assert.equal(
      outbox.enqueue({
        deliveryPartId: missingDeliveryPartId,
        kind: 'audio',
        sessionId,
        ordinal: 1,
        payload: {
          ...payload,
          path: missingPath,
          filename: `${splitStem}.split001.flac`,
        },
      }),
      true,
    );
    assert.equal(await drainOutbox(worker(scriptedFetch(badRequest)), 1), 0);
    const missingBefore = db.handle
      .prepare('SELECT state, claim_generation FROM telegram_outbox WHERE delivery_part_id = ?')
      .get(missingDeliveryPartId) as { state: string; claim_generation: number };
    assert.equal(missingBefore.state, 'dead');
    rmSync(missingPath);

    const blocked = run(
      'outbox',
      'retry',
      missingDeliveryPartId,
      '--json',
      '--yes',
      '--accept-duplicate-risk',
    );
    assert.equal(blocked.status, 1);
    assert.match(blocked.stderr, /document artifact is missing; exact retry is unavailable/);
    const missingAfter = db.handle
      .prepare('SELECT state, claim_generation FROM telegram_outbox WHERE delivery_part_id = ?')
      .get(missingDeliveryPartId) as typeof missingBefore;
    assert.deepEqual(missingAfter, missingBefore, 'missing legacy artifacts remain terminal');
  });
});
