import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { type Database, openDatabase } from '../../src/database/db.ts';
import { SessionRepository } from '../../src/database/repository.ts';
import { nullLogger } from '../../src/logging/logger.ts';
import {
  isClientShutdown,
  isRetryable,
  TelegramClient,
  telegramLongPollDeadlineMs,
} from '../../src/telegram/client.ts';
import { drainOutbox, Outbox } from '../../src/telegram/outbox.ts';
import {
  markUpdateHandled,
  nextOffsetFor,
  readOffset,
  recordUpdate,
  writeOffset,
} from '../../src/telegram/router.ts';

let dir: string;
let db: Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'om-outbox-'));
  db = openDatabase({ file: join(dir, 'test.db') });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Builds a fetch stand-in that replays scripted responses in order. */
function scriptedFetch(responses: readonly (() => Response)[]): {
  fetch: typeof fetch;
  calls: string[];
} {
  const calls: string[] = [];
  let index = 0;
  const impl = (async (input: string | URL | Request) => {
    calls.push(String(input));
    const next = responses[Math.min(index, responses.length - 1)];
    index += 1;
    if (next === undefined) throw new Error('no scripted response');
    return next();
  }) as unknown as typeof fetch;
  return { fetch: impl, calls };
}

const abortableHangingFetch = (async (
  _input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> => {
  const signal = init?.signal;
  if (signal === undefined || signal === null) throw new Error('request signal is required');
  return new Promise<Response>((_resolve, reject) => {
    const rejectFromSignal = () => reject(signal.reason);
    if (signal.aborted) rejectFromSignal();
    else signal.addEventListener('abort', rejectFromSignal, { once: true });
  });
}) as typeof fetch;

const okMessage = (messageId = 1) =>
  new Response(
    JSON.stringify({
      ok: true,
      result: { message_id: messageId, date: 0, chat: { id: 1, type: 'private' } },
    }),
    {
      status: 200,
      headers: { 'content-type': 'application/json' },
    },
  );

const rateLimited = (retryAfter: number) =>
  new Response(
    JSON.stringify({
      ok: false,
      error_code: 429,
      description: 'Too Many Requests',
      parameters: { retry_after: retryAfter },
    }),
    { status: 429, headers: { 'content-type': 'application/json' } },
  );

const badRequest = () =>
  new Response(
    JSON.stringify({ ok: false, error_code: 400, description: 'Bad Request: message is too long' }),
    {
      status: 400,
      headers: { 'content-type': 'application/json' },
    },
  );

function deps(
  fetchImpl: typeof fetch,
  maxOutgoingBytes = 50 * 1024 * 1024,
  requestTimeoutMs?: number,
) {
  return {
    outbox: new Outbox(db.handle),
    client: new TelegramClient({
      token: 'tkn',
      baseUrl: 'https://api.telegram.org',
      fetchImpl,
      ...(requestTimeoutMs === undefined ? {} : { requestTimeoutMs }),
    }),
    chatId: 42,
    logger: nullLogger,
    maxOutgoingBytes,
  };
}

describe('outbox idempotency', () => {
  it('refuses to enqueue the same delivery unit twice', () => {
    const outbox = new Outbox(db.handle);
    const message = {
      deliveryPartId: 'report:s1',
      kind: 'report' as const,
      ordinal: 20,
      payload: { type: 'text' as const, text: 'hello' },
    };

    assert.equal(outbox.enqueue(message), true);
    assert.equal(
      outbox.enqueue(message),
      false,
      'a retried enqueue must not duplicate the message',
    );
    assert.equal(outbox.pendingCount(), 1);
  });

  it('does not let newly queued audio starve older ready messages', () => {
    const outbox = new Outbox(db.handle);
    outbox.enqueue({
      deliveryPartId: 'report:s1',
      kind: 'report',
      ordinal: 20,
      payload: { type: 'text', text: 'report' },
    });
    outbox.enqueue({
      deliveryPartId: 'transcript:s1:1',
      kind: 'transcript',
      ordinal: 10,
      payload: { type: 'text', text: 'transcript' },
    });
    outbox.enqueue({
      deliveryPartId: 'audio:p1',
      kind: 'audio',
      ordinal: 0,
      payload: { type: 'text', text: 'audio' },
    });

    assert.equal(outbox.claimNext()?.kind, 'report');
    assert.equal(outbox.claimNext()?.kind, 'transcript');
    assert.equal(outbox.claimNext()?.kind, 'audio');
  });

  it('drains an old ready backlog while new session audio keeps arriving', () => {
    const outbox = new Outbox(db.handle);
    for (const id of ['old-report-1', 'old-report-2', 'old-report-3']) {
      outbox.enqueue({
        deliveryPartId: id,
        kind: 'report',
        ordinal: 20,
        payload: { type: 'text', text: id },
      });
    }
    db.handle.prepare("UPDATE telegram_outbox SET created_at = '2000-01-01T00:00:00.000Z'").run();

    const claimed: string[] = [];
    for (let index = 0; index < 40; index += 1) {
      outbox.enqueue({
        deliveryPartId: `new-audio-${index}`,
        kind: 'audio',
        ordinal: 0,
        payload: { type: 'text', text: `new audio ${index}` },
      });
      const row = outbox.claimNext();
      assert.ok(row);
      claimed.push(row.delivery_part_id);
      assert.equal(outbox.markSent(row, index + 1), 'sent');
    }

    assert.deepEqual(claimed.slice(0, 3), ['old-report-1', 'old-report-2', 'old-report-3']);
  });

  it('commits the sent row and its delivery facts atomically', () => {
    const outbox = new Outbox(db.handle);
    outbox.enqueue({
      deliveryPartId: 'a',
      kind: 'status',
      ordinal: 0,
      payload: { type: 'text', text: 'x' },
    });
    const row = outbox.claimNext();
    assert.ok(row);

    assert.throws(() =>
      outbox.markSent(row, 1, () => {
        throw new Error('delivery fact failed');
      }),
    );
    const state = db.handle.prepare('SELECT state FROM telegram_outbox').get() as { state: string };
    assert.equal(state.state, 'sending', 'a failed delivery callback rolls back markSent too');
  });

  it('re-queues rows a crash left in flight', () => {
    const outbox = new Outbox(db.handle);
    outbox.enqueue({
      deliveryPartId: 'a',
      kind: 'status',
      ordinal: 0,
      payload: { type: 'text', text: 'x' },
    });
    outbox.claimNext();
    assert.equal(outbox.claimNext(), null);

    assert.equal(outbox.recoverSending(), 1);
    assert.ok(outbox.claimNext(), 'the row comes back after recovery');
  });

  it('fences every stale sender mutation after another generation reclaims the row', () => {
    const outbox = new Outbox(db.handle);
    outbox.enqueue({
      deliveryPartId: 'fenced',
      kind: 'status',
      ordinal: 0,
      payload: { type: 'text', text: 'x' },
    });
    const stale = outbox.claimNext();
    assert.ok(stale);
    assert.equal(outbox.recoverSending(), 1);
    const current = outbox.claimNext();
    assert.ok(current);
    assert.ok(current.claim_generation > stale.claim_generation);

    let deliveredCallbacks = 0;
    assert.equal(
      outbox.markSent(stale, 100, () => {
        deliveredCallbacks += 1;
      }),
      'lost',
    );
    assert.equal(outbox.markFailed(stale, 'late retry', 1, 8), 'lost');
    assert.equal(outbox.markFailed(stale, 'late terminal failure', 8, 8), 'lost');
    assert.equal(outbox.defer(stale, 30_000, 'late rate limit'), 'lost');
    assert.equal(deliveredCallbacks, 0, 'a stale acknowledgement has no domain side effects');

    const duringCurrentClaim = db.handle
      .prepare(
        `SELECT state, attempts, claim_generation, telegram_message_id, last_error
           FROM telegram_outbox WHERE outbox_id = ?`,
      )
      .get(current.outbox_id) as Record<string, unknown>;
    assert.deepEqual(
      { ...duringCurrentClaim },
      {
        state: 'sending',
        attempts: 2,
        claim_generation: current.claim_generation,
        telegram_message_id: null,
        last_error: null,
      },
    );
    assert.equal(
      outbox.markSent(current, 200, () => {
        deliveredCallbacks += 1;
      }),
      'sent',
    );
    assert.equal(deliveredCallbacks, 1);
  });

  it('does not reuse a generation when a no-fault defer refunds the attempt', () => {
    const outbox = new Outbox(db.handle);
    outbox.enqueue({
      deliveryPartId: 'defer-generation',
      kind: 'status',
      ordinal: 0,
      payload: { type: 'text', text: 'x' },
    });
    const first = outbox.claimNext();
    assert.ok(first);
    assert.equal(outbox.defer(first, 0, 'rate limit'), 'deferred');
    const second = outbox.claimNext();
    assert.ok(second);
    assert.equal(second.attempts, first.attempts, 'the Telegram-owned defer refunds the attempt');
    assert.ok(second.claim_generation > first.claim_generation, 'the fencing token never rewinds');
    assert.equal(outbox.markSent(first, 100), 'lost');
    assert.equal(outbox.markSent(second, 200), 'sent');
  });

  it('does not clean up or acknowledge a stale sender after its upload returns', async () => {
    const filePath = join(dir, 'stale.split000.flac');
    writeFileSync(filePath, Buffer.alloc(100));
    let releaseFetch: (response: Response) => void = () => {
      throw new Error('controlled fetch was not started');
    };
    let markFetchStarted: () => void = () => {};
    const fetchStarted = new Promise<void>((resolve) => {
      markFetchStarted = resolve;
    });
    const controlledFetch = (async () => {
      markFetchStarted();
      return new Promise<Response>((resolve) => {
        releaseFetch = resolve;
      });
    }) as typeof fetch;
    const d = deps(controlledFetch, 500);
    d.outbox.enqueue({
      deliveryPartId: 'audio:stale:split0',
      kind: 'audio',
      ordinal: 0,
      payload: {
        type: 'document',
        path: filePath,
        filename: 'stale.split000.flac',
        deleteAfterSend: true,
      },
    });
    let delivered = 0;
    const staleDrain = drainOutbox(
      {
        ...d,
        onDelivered: () => {
          delivered += 1;
        },
      },
      1,
    );
    await fetchStarted;
    assert.equal(d.outbox.recoverSending(), 1);
    const current = d.outbox.claimNext();
    assert.ok(current);

    releaseFetch(okMessage(321));
    assert.equal(await staleDrain, 0);
    assert.equal(delivered, 0);
    assert.equal(existsSync(filePath), true, 'the current generation still owns its upload file');
    assert.equal(
      (
        db.handle
          .prepare('SELECT state FROM telegram_outbox WHERE outbox_id = ?')
          .get(current.outbox_id) as { state: string }
      ).state,
      'sending',
    );
  });
});

describe('outbox delivery', () => {
  it('keeps long-poll transport deadline safely beyond Telegram server timeout', () => {
    assert.equal(telegramLongPollDeadlineMs(30_000, 25), 35_000);
  });

  it('sends a pending message and records the Telegram message id', async () => {
    const { fetch: impl } = scriptedFetch([() => okMessage(777)]);
    const d = deps(impl);
    let deliveredSession: string | null = null;
    new SessionRepository(db.handle).create('s1', new Date().toISOString());
    d.outbox.enqueue({
      deliveryPartId: 'a',
      kind: 'status',
      sessionId: 's1',
      ordinal: 0,
      payload: { type: 'text', text: 'hi' },
    });

    assert.equal(
      await drainOutbox({
        ...d,
        onDelivered: ({ sessionId }) => {
          deliveredSession = sessionId;
        },
      }),
      1,
    );
    assert.equal(deliveredSession, 's1', 'audio-last delivery can reconcile its session');

    const row = db.handle
      .prepare('SELECT state, telegram_message_id FROM telegram_outbox')
      .get() as { state: string; telegram_message_id: number };
    assert.equal(row.state, 'sent');
    assert.equal(row.telegram_message_id, 777);
  });

  it('delivers inline settings controls from the durable outbox', async () => {
    let sentBody = '';
    const captureFetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      sentBody = String(init?.body ?? '');
      return okMessage(778);
    }) as typeof fetch;
    const d = deps(captureFetch);
    d.outbox.enqueue({
      deliveryPartId: 'settings:1',
      kind: 'status',
      ordinal: 0,
      payload: {
        type: 'text',
        text: 'settings',
        replyMarkup: {
          inline_keyboard: [[{ text: '○ Авто', callback_data: 'asr-mode:v1:settings:auto' }]],
        },
      },
    });

    assert.equal(await drainOutbox(d), 1);
    const body = JSON.parse(sentBody) as Record<string, unknown>;
    assert.deepEqual(body['reply_markup'], {
      inline_keyboard: [[{ text: '○ Авто', callback_data: 'asr-mode:v1:settings:auto' }]],
    });
  });

  it('polls callback queries and acknowledges and edits their keyboard', async () => {
    const calls: { method: string; body: Record<string, unknown> }[] = [];
    const captureFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = url.slice(url.lastIndexOf('/') + 1);
      calls.push({
        method,
        body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
      });
      const result = method === 'getUpdates' ? [] : true;
      return new Response(JSON.stringify({ ok: true, result }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    const client = new TelegramClient({
      token: 'tkn',
      baseUrl: 'https://api.telegram.org',
      fetchImpl: captureFetch,
    });

    await client.getUpdates(5, 0);
    await client.setMyCommands([{ command: 'settings', description: 'Настройки' }]);
    await client.answerCallbackQuery('callback-1', 'Сохранено');
    await client.editMessageReplyMarkup(42, 7, {
      inline_keyboard: [[{ text: '✅ Авто', callback_data: 'asr-mode:v1:transcript:auto' }]],
    });

    assert.deepEqual(calls[0]?.body['allowed_updates'], ['message', 'callback_query']);
    assert.deepEqual(calls[1]?.body['commands'], [
      { command: 'settings', description: 'Настройки' },
    ]);
    assert.equal(calls[2]?.body['callback_query_id'], 'callback-1');
    assert.equal(calls[3]?.body['message_id'], 7);
  });

  it('honours retry_after on 429 and stops draining', async () => {
    const { fetch: impl, calls } = scriptedFetch([() => rateLimited(30), () => okMessage()]);
    const d = deps(impl);
    for (const id of ['a', 'b', 'c']) {
      d.outbox.enqueue({
        deliveryPartId: id,
        kind: 'status',
        ordinal: 0,
        payload: { type: 'text', text: id },
      });
    }

    assert.equal(await drainOutbox(d), 0);
    assert.equal(calls.length, 1, 'draining must stop rather than hammer a rate-limited API');

    const row = db.handle
      .prepare(
        "SELECT state, attempts, run_after FROM telegram_outbox WHERE delivery_part_id = 'a'",
      )
      .get() as { state: string; attempts: number; run_after: string };
    assert.equal(row.state, 'pending', 'the message is retried, not lost');
    assert.equal(row.attempts, 0, 'a 429 is not the message’s fault, so no attempt is burned');
    assert.ok(
      Date.parse(row.run_after) > Date.now() + 25_000,
      'the retry is deferred by roughly retry_after',
    );
  });

  it('gives up immediately on a non-retryable 400', async () => {
    const { fetch: impl } = scriptedFetch([badRequest]);
    const d = deps(impl);
    d.outbox.enqueue({
      deliveryPartId: 'a',
      kind: 'status',
      ordinal: 0,
      payload: { type: 'text', text: 'x' },
    });

    assert.equal(await drainOutbox(d), 0);
    const row = db.handle.prepare('SELECT state FROM telegram_outbox').get() as { state: string };
    assert.equal(
      row.state,
      'dead',
      'a malformed message will never succeed; retrying is pointless',
    );
  });

  it('marks an over-limit local payload dead without calling Telegram', async () => {
    const { fetch: impl, calls } = scriptedFetch([() => okMessage()]);
    const d = deps(impl);
    d.outbox.enqueue({
      deliveryPartId: 'too-long',
      kind: 'status',
      ordinal: 0,
      payload: { type: 'text', text: 'x'.repeat(4097) },
    });

    assert.equal(await drainOutbox(d), 0);
    const row = db.handle
      .prepare("SELECT state, last_error FROM telegram_outbox WHERE delivery_part_id = 'too-long'")
      .get() as { state: string; last_error: string };
    assert.equal(row.state, 'dead');
    assert.match(row.last_error, /4097 UTF-16 code units/);
    assert.deepEqual(calls, []);
  });

  it('retries a 5xx', async () => {
    const { fetch: impl } = scriptedFetch([
      () =>
        new Response('{"ok":false,"error_code":502,"description":"Bad Gateway"}', {
          status: 502,
          headers: { 'content-type': 'application/json' },
        }),
    ]);
    const d = deps(impl);
    d.outbox.enqueue({
      deliveryPartId: 'a',
      kind: 'status',
      ordinal: 0,
      payload: { type: 'text', text: 'x' },
    });

    await drainOutbox(d);
    const row = db.handle.prepare('SELECT state FROM telegram_outbox').get() as { state: string };
    assert.equal(row.state, 'pending');
  });

  it('returns a timed-out send to pending without burning its last attempt', async () => {
    const d = deps(abortableHangingFetch, 50 * 1024 * 1024, 20);
    d.outbox.enqueue({
      deliveryPartId: 'timeout',
      kind: 'status',
      ordinal: 0,
      payload: { type: 'text', text: 'retry me' },
    });
    db.handle
      .prepare(
        `UPDATE telegram_outbox
            SET attempts = max_attempts - 1
          WHERE delivery_part_id = 'timeout'`,
      )
      .run();

    assert.equal(await drainOutbox(d), 0);
    const row = db.handle
      .prepare(
        `SELECT state, attempts, max_attempts, last_error
           FROM telegram_outbox WHERE delivery_part_id = 'timeout'`,
      )
      .get() as { state: string; attempts: number; max_attempts: number; last_error: string };
    assert.equal(row.state, 'pending');
    assert.equal(row.attempts, row.max_attempts - 1);
    assert.match(row.last_error, /request timed out after 20 ms/);
  });

  it('aborts an in-flight send when its client closes', async () => {
    const client = new TelegramClient({
      token: 'tkn',
      baseUrl: 'https://api.telegram.org',
      fetchImpl: abortableHangingFetch,
      requestTimeoutMs: 60_000,
    });
    const request = client.getMe();

    client.close();

    await assert.rejects(request, (error: unknown) => {
      assert.match((error as Error).message, /client shutdown/);
      assert.equal(isClientShutdown(error), true);
      return true;
    });
  });

  it('bounds Telegram file downloads with the transfer deadline', async () => {
    const client = new TelegramClient({
      token: 'tkn',
      baseUrl: 'https://api.telegram.org',
      fetchImpl: abortableHangingFetch,
      transferTimeoutMs: 20,
    });

    await assert.rejects(client.downloadFile('voice/file.ogg'), /request timed out after 20 ms/);
  });

  it('classifies errors correctly', () => {
    assert.equal(isRetryable({ errorCode: 429 }), true);
    assert.equal(isRetryable({ errorCode: 500 }), true);
    assert.equal(isRetryable({ errorCode: 400 }), false);
    assert.equal(isRetryable({ errorCode: 403 }), false);
    assert.equal(isRetryable(new Error('network down')), true, 'a network failure is transient');
  });

  it('refuses to upload a file over the 50 MB Telegram limit', async () => {
    const filePath = join(dir, 'big.flac');
    writeFileSync(filePath, Buffer.alloc(2048));

    const { fetch: impl, calls } = scriptedFetch([() => okMessage()]);
    const d = deps(impl, 1024); // pretend limit of 1 KB
    d.outbox.enqueue({
      deliveryPartId: 'audio:p1',
      kind: 'audio',
      ordinal: 0,
      payload: { type: 'document', path: filePath, filename: 'big.flac' },
    });

    assert.equal(await drainOutbox(d), 0);
    assert.equal(calls.length, 0, 'the oversize file must never reach the network');

    const row = db.handle.prepare('SELECT state, last_error FROM telegram_outbox').get() as {
      state: string;
      last_error: string;
    };
    assert.equal(row.state, 'dead');
    assert.match(row.last_error, /over the 1024 byte Telegram limit/);
  });

  it('checks the live file size, not the size recorded earlier', async () => {
    const filePath = join(dir, 'grew.flac');
    writeFileSync(filePath, Buffer.alloc(100));

    const { fetch: impl, calls } = scriptedFetch([() => okMessage()]);
    const d = deps(impl, 500);
    d.outbox.enqueue({
      deliveryPartId: 'audio:p1',
      kind: 'audio',
      ordinal: 0,
      payload: { type: 'document', path: filePath, filename: 'grew.flac' },
    });

    // The file grows between enqueue and send.
    writeFileSync(filePath, Buffer.alloc(900));
    assert.equal(await drainOutbox(d), 0);
    assert.equal(calls.length, 0);
  });

  it('removes an ephemeral split only after Telegram accepts it', async () => {
    const filePath = join(dir, 'split.flac');
    writeFileSync(filePath, Buffer.alloc(100));
    const { fetch: impl } = scriptedFetch([() => okMessage()]);
    const d = deps(impl, 500);
    d.outbox.enqueue({
      deliveryPartId: 'audio:p1:split0',
      kind: 'audio',
      ordinal: 0,
      payload: {
        type: 'document',
        path: filePath,
        filename: 'split.flac',
        deleteAfterSend: true,
      },
    });

    assert.equal(await drainOutbox(d), 1);
    assert.equal(existsSync(filePath), false);
  });

  it('removes an ephemeral split when delivery permanently fails', async () => {
    const path = join(dir, 'dead.split000.flac');
    writeFileSync(path, Buffer.alloc(100));
    const { fetch: impl } = scriptedFetch([badRequest]);
    const d = deps(impl);
    d.outbox.enqueue({
      deliveryPartId: 'audio:dead:split0',
      kind: 'audio',
      ordinal: 0,
      payload: {
        type: 'document',
        path,
        filename: 'dead.split000.flac',
        deleteAfterSend: true,
      },
    });

    assert.equal(await drainOutbox(d), 0);
    assert.equal(existsSync(path), false);
    assert.equal(d.outbox.deadCount(), 1);
  });

  it('reports the age of the oldest pending message', () => {
    const outbox = new Outbox(db.handle);
    assert.equal(outbox.oldestPendingAgeMinutes(), 0);

    outbox.enqueue({
      deliveryPartId: 'a',
      kind: 'status',
      ordinal: 0,
      payload: { type: 'text', text: 'x' },
    });
    db.handle.prepare("UPDATE telegram_outbox SET created_at = '2000-01-01T00:00:00.000Z'").run();
    assert.ok(outbox.oldestPendingAgeMinutes() > 1000);
  });
});

describe('update deduplication and offset persistence', () => {
  it('replays an update until its durable work is marked handled', () => {
    assert.equal(recordUpdate(db.handle, 500, 'command'), true);
    assert.equal(
      recordUpdate(db.handle, 500, 'command'),
      true,
      'a crash after recording the update must not skip its work',
    );
    markUpdateHandled(db.handle, 500);
    assert.equal(recordUpdate(db.handle, 500, 'command'), false);
  });

  it('treats each distinct update independently', () => {
    assert.equal(recordUpdate(db.handle, 1, 'audio'), true);
    assert.equal(recordUpdate(db.handle, 2, 'audio'), true);
    markUpdateHandled(db.handle, 1);
    assert.equal(recordUpdate(db.handle, 1, 'audio'), false);
    assert.equal(recordUpdate(db.handle, 2, 'audio'), true);
  });

  it('keeps colliding update ids and offsets independent across bot credentials', () => {
    assert.equal(recordUpdate(db.handle, 1, 'audio', 'bot-a'), true);
    markUpdateHandled(db.handle, 1, 'bot-a');
    assert.equal(recordUpdate(db.handle, 1, 'audio', 'bot-a'), false);
    assert.equal(recordUpdate(db.handle, 1, 'audio', 'bot-b'), true);

    writeOffset(db.handle, 11, 'bot-a');
    writeOffset(db.handle, 22, 'bot-b');
    assert.equal(readOffset(db.handle, 'bot-a'), 11);
    assert.equal(readOffset(db.handle, 'bot-b'), 22);
  });

  it('marks an update handled', () => {
    recordUpdate(db.handle, 7, 'command');
    markUpdateHandled(db.handle, 7);
    const row = db.handle
      .prepare('SELECT handled FROM telegram_updates WHERE update_id = 7')
      .get() as { handled: number };
    assert.equal(row.handled, 1);
  });

  it('persists the offset across restarts', () => {
    assert.equal(readOffset(db.handle), 0);
    writeOffset(db.handle, 12_345);
    assert.equal(readOffset(db.handle), 12_345);

    // Simulate a restart by reopening the same file.
    db.close();
    db = openDatabase({ file: join(dir, 'test.db') });
    assert.equal(
      readOffset(db.handle),
      12_345,
      'a restart must neither replay old updates nor skip new ones',
    );
  });

  it('computes the next offset as max(update_id) + 1', () => {
    assert.equal(nextOffsetFor([{ update_id: 5 }, { update_id: 9 }, { update_id: 7 }], 0), 10);
    assert.equal(nextOffsetFor([], 99), 99, 'an empty poll leaves the offset alone');
    assert.equal(nextOffsetFor([{ update_id: 3 }], 100), 100, 'the offset never goes backwards');
  });
});
