import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, it } from 'node:test';
import { type Database, openDatabase } from '../../src/database/db.ts';
import { AlertEvaluator } from '../../src/health/alerts.ts';
import { nullLogger } from '../../src/logging/logger.ts';
import { TelegramClient } from '../../src/telegram/client.ts';
import { formatNotification } from '../../src/telegram/format.ts';
import { drainOutbox, Outbox } from '../../src/telegram/outbox.ts';
import { FakeClock } from '../../src/util/clock.ts';

let dir: string;
let db: Database;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'om-events-'));
  db = openDatabase({ file: join(dir, 'state.db') });
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

it('keeps one event message through restart, repeated edits and bot/chat changes', async () => {
  const calls: { method: string; body: Record<string, unknown> }[] = [];
  let notModified = false;
  const fetchImpl = (async (input, init) => {
    const method = String(input).split('/').at(-1) ?? '';
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    calls.push({ method, body });
    if (notModified) {
      return Response.json({
        ok: false,
        error_code: 400,
        description: 'Bad Request: message is not modified',
      });
    }
    return Response.json({
      ok: true,
      result: {
        message_id: body['message_id'] ?? 41,
        date: 0,
        chat: { id: body['chat_id'], type: 'private' },
      },
    });
  }) as typeof fetch;
  const client = (token = 'test-event-bot') =>
    new TelegramClient({ token, baseUrl: 'https://api.telegram.org', fetchImpl });
  const enqueue = (id: string, text: string) =>
    new Outbox(db.handle).enqueue({
      deliveryPartId: `alert:llm_unavailable:${id}`,
      kind: 'alert',
      ordinal: 5,
      payload: { type: 'text', text },
    });
  const drain = (chatId = 42, telegram = client()) =>
    drainOutbox({
      outbox: new Outbox(db.handle),
      client: telegram,
      chatId,
      logger: nullLogger,
      maxOutgoingBytes: 1024,
    });
  enqueue('raise:1', '🟡 Отчёты недоступны');
  assert.equal(await drain(), 1);
  db.close();
  db = openDatabase({ file: join(dir, 'state.db') });
  enqueue('clear:2', '🟢 Отчёты восстановлены');
  assert.equal(await drain(), 1);
  assert.deepEqual(
    calls.map((call) => call.method),
    ['sendMessage', 'editMessageText'],
  );
  assert.equal(calls[1]?.body['message_id'], 41);
  notModified = true;
  enqueue('clear:3', '🟢 Отчёты восстановлены');
  assert.equal(
    await drain(),
    1,
    'an already-applied edit is a successful retry, never another push',
  );
  notModified = false;
  enqueue('raise:4', '🟡 Отчёты недоступны');
  await drain(43);
  assert.equal(calls.at(-1)?.method, 'sendMessage', 'another chat cannot reuse the old message ID');
  enqueue('raise:5', '🟡 Отчёты недоступны');
  await drain(42, client('different-test-bot'));
  assert.equal(calls.at(-1)?.method, 'sendMessage', 'another bot cannot edit the old bot message');
});

it('serializes event edits through backoff and concurrent claims without blocking other events', () => {
  const outbox = new Outbox(db.handle);
  const add = (id: string, eventKey: string) =>
    outbox.enqueue({
      deliveryPartId: id,
      eventKey,
      kind: 'status',
      ordinal: 0,
      payload: { type: 'text', text: id },
    });
  add('first', 'one');
  const first = outbox.claimNext();
  assert.ok(first);
  add('recovered', 'one');
  add('independent', 'two');
  const other = outbox.claimNext();
  assert.equal(other?.delivery_part_id, 'independent');
  assert.equal(outbox.claimNext(), null, 'an edit cannot overtake an in-flight send');
  outbox.defer(first, 60_000, 'retry');
  assert.equal(outbox.claimNext(), null, 'a recovery cannot overtake a backed-off failure');
});

it('creates a replacement only for a confirmed missing message, never for a transport error', async () => {
  const outbox = new Outbox(db.handle);
  const calls: string[] = [];
  let missing = false;
  const client = new TelegramClient({
    token: 'test-events',
    baseUrl: 'https://api.telegram.org',
    fetchImpl: (async (input) => {
      const method = String(input).split('/').at(-1) ?? '';
      calls.push(method);
      if (method === 'sendMessage') return Response.json({ ok: true, result: { message_id: 42 } });
      return Response.json(
        missing
          ? { ok: false, error_code: 400, description: 'Bad Request: message to edit not found' }
          : { ok: false, error_code: 500, description: 'Internal Server Error' },
      );
    }) as typeof fetch,
  });
  outbox.recordEventMessage('event', client.messageScope(1), 41);
  outbox.enqueue({
    deliveryPartId: 'update',
    eventKey: 'event',
    kind: 'status',
    ordinal: 0,
    payload: { type: 'text', text: 'recovered' },
  });
  const deps = { outbox, client, chatId: 1, logger: nullLogger, maxOutgoingBytes: 1024 };
  assert.equal(await drainOutbox(deps), 0);
  assert.deepEqual(calls, ['editMessageText']);
  missing = true;
  db.handle
    .prepare("UPDATE telegram_outbox SET run_after = ? WHERE delivery_part_id = 'update'")
    .run(new Date(0).toISOString());
  assert.equal(await drainOutbox({ ...deps, outbox: new Outbox(db.handle) }), 1);
  assert.deepEqual(calls, ['editMessageText', 'editMessageText', 'sendMessage']);
  assert.equal(outbox.eventMessageId('event', client.messageScope(1)), 42);
});

it('waits for a stable health edge on monotonic time and preserves failed enqueue retries', () => {
  const clock = new FakeClock();
  const alerts = new AlertEvaluator(db.handle, {
    cooldownMinutes: 30,
    debounceSeconds: 60,
    now: () => clock.wallMs(),
    monotonicNow: () => clock.monotonicMs(),
  });
  assert.equal(alerts.evaluate('llm_unavailable', true).send, false);
  clock.advance(59_999);
  clock.jumpWallClock(86_400_000);
  assert.equal(alerts.evaluate('llm_unavailable', true).send, false);
  assert.equal(alerts.evaluate('llm_unavailable', false).send, false, 'brief failures are silent');
  assert.equal(alerts.evaluate('llm_unavailable', true).send, false);
  clock.advance(60_000);
  assert.throws(() =>
    alerts.evaluate('llm_unavailable', true, undefined, () => {
      throw new Error('disk');
    }),
  );
  assert.equal(alerts.isActive('llm_unavailable'), false);
  assert.equal(alerts.evaluate('llm_unavailable', true).transition, 'raised');
  assert.equal(alerts.evaluate('llm_unavailable', false).send, false);
  clock.advance(60_000);
  assert.equal(alerts.evaluate('llm_unavailable', false).transition, 'cleared');
  assert.equal(
    alerts.evaluate('capture_failed', true).send,
    true,
    'a terminal failure must persist before exit',
  );
});

it('collapses long notification details without interpreting or truncating text', async () => {
  assert.deepEqual(formatNotification('🟢 Запись включена'), { text: '🟢 Запись включена' });
  const formatted = formatNotification(
    `Ошибка\n\n${'<b>данные & не HTML</b> 🧑🏽‍💻\n'.repeat(30)}`,
  );
  assert.equal(formatted.parseMode, 'HTML');
  assert.match(formatted.text, /^Ошибка\n\n<blockquote expandable>/u);
  assert.match(formatted.text, /&lt;b&gt;данные &amp; не HTML/u);
  const client = new TelegramClient({
    token: 'fixture',
    baseUrl: 'https://api.telegram.org',
    fetchImpl: (async () => Response.json({ ok: true, result: true })) as typeof fetch,
  });
  await client.editMessageText(1, 1, formatted.text, { parseMode: 'HTML' });
  assert.equal(formatNotification('a'.repeat(4097)).text.length, 4097);
});
