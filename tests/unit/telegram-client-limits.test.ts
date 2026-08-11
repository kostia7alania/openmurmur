import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { isRetryable, TelegramClient } from '../../src/telegram/client.ts';
import {
  TELEGRAM_CALLBACK_QUERY_TEXT_LIMIT,
  TELEGRAM_CAPTION_LIMIT,
  TELEGRAM_MESSAGE_LIMIT,
} from '../../src/telegram/format.ts';

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function acceptingClient(): { client: TelegramClient; calls: string[] } {
  const calls: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const method = String(input).slice(String(input).lastIndexOf('/') + 1);
    calls.push(method);
    const result =
      method === 'answerCallbackQuery'
        ? true
        : { message_id: calls.length, date: 0, chat: { id: 42, type: 'private' } };
    return new Response(JSON.stringify({ ok: true, result }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return {
    client: new TelegramClient({
      token: 'tkn',
      baseUrl: 'https://api.telegram.org',
      fetchImpl,
    }),
    calls,
  };
}

describe('Telegram transport text limits', () => {
  it('accepts every field at its UTF-16 boundary', async () => {
    const { client, calls } = acceptingClient();
    const directory = mkdtempSync(join(tmpdir(), 'om-telegram-limits-'));
    directories.push(directory);
    const document = join(directory, 'part.flac');
    writeFileSync(document, 'audio');

    const messageAtLimit = `${'x'.repeat(TELEGRAM_MESSAGE_LIMIT - 2)}😀`;
    assert.equal(messageAtLimit.length, TELEGRAM_MESSAGE_LIMIT);
    await client.sendMessage(42, messageAtLimit);
    await client.editMessageText(42, 1, messageAtLimit);
    await client.sendDocument(42, document, { caption: 'c'.repeat(TELEGRAM_CAPTION_LIMIT) });
    await client.answerCallbackQuery('callback-1', 'c'.repeat(TELEGRAM_CALLBACK_QUERY_TEXT_LIMIT));
    const htmlAtLimit = `<b>${'x'.repeat(TELEGRAM_MESSAGE_LIMIT - 1)}&amp;</b>`;
    assert.ok(htmlAtLimit.length > TELEGRAM_MESSAGE_LIMIT);
    await client.sendMessage(42, htmlAtLimit, { parseMode: 'HTML' });
    await client.sendDocument(42, document, {
      caption: `<i>${'c'.repeat(TELEGRAM_CAPTION_LIMIT)}</i>`,
      parseMode: 'HTML',
    });

    assert.deepEqual(calls, [
      'sendMessage',
      'editMessageText',
      'sendDocument',
      'answerCallbackQuery',
      'sendMessage',
      'sendDocument',
    ]);
  });

  it('rejects over-limit fields before any network or file access', async () => {
    const { client, calls } = acceptingClient();
    const messageOverLimit = `${'x'.repeat(TELEGRAM_MESSAGE_LIMIT - 1)}😀`;
    assert.equal(messageOverLimit.length, TELEGRAM_MESSAGE_LIMIT + 1);

    const cases: readonly (() => Promise<unknown>)[] = [
      () => client.sendMessage(42, messageOverLimit),
      () => client.editMessageText(42, 1, messageOverLimit),
      () =>
        client.sendDocument(42, '/path/that/must/not/be-opened.flac', {
          caption: 'c'.repeat(TELEGRAM_CAPTION_LIMIT + 1),
        }),
      () =>
        client.answerCallbackQuery(
          'callback-1',
          'c'.repeat(TELEGRAM_CALLBACK_QUERY_TEXT_LIMIT + 1),
        ),
      () =>
        client.sendMessage(42, `<b>${'x'.repeat(TELEGRAM_MESSAGE_LIMIT + 1)}</b>`, {
          parseMode: 'HTML',
        }),
    ];

    for (const invoke of cases) {
      await assert.rejects(
        async () => invoke(),
        (error: unknown) => {
          assert.equal(isRetryable(error), false);
          assert.match((error as Error).message, /UTF-16 code units/);
          return true;
        },
      );
    }
    assert.deepEqual(calls, []);
  });

  it('rejects empty message bodies as a permanent local error', async () => {
    const { client, calls } = acceptingClient();

    await assert.rejects(
      async () => client.sendMessage(42, ''),
      (error: unknown) => {
        assert.equal(isRetryable(error), false);
        assert.match((error as Error).message, /allows 1-4096/);
        return true;
      },
    );
    await assert.rejects(async () => client.editMessageText(42, 1, ''));
    assert.deepEqual(calls, []);
  });
});
