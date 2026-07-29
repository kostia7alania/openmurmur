import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { EMPTY_SUMMARY } from '../../src/llm/schema.ts';
import {
  escapeHtml,
  formatBytes,
  formatDuration,
  renderTranscriptMessages,
  splitForTelegram,
  splitOnBoundaries,
  TELEGRAM_MESSAGE_LIMIT,
} from '../../src/telegram/format.ts';
import { renderSessionReport } from '../../src/telegram/report.ts';

describe('HTML escaping', () => {
  it('escapes the characters Telegram treats as markup', () => {
    assert.equal(escapeHtml('<b>bold</b>'), '&lt;b&gt;bold&lt;/b&gt;');
    assert.equal(escapeHtml('a & b'), 'a &amp; b');
    assert.equal(escapeHtml('say "hi"'), 'say &quot;hi&quot;');
  });

  it('escapes ampersands before angle brackets, not after', () => {
    // Getting this order wrong yields &amp;lt; — a classic double-escape bug.
    assert.equal(escapeHtml('<'), '&lt;');
    assert.equal(escapeHtml('&lt;'), '&amp;lt;');
  });

  it('leaves ordinary speech untouched', () => {
    assert.equal(escapeHtml('привет สวัสดี hello'), 'привет สวัสดี hello');
  });
});

describe('message splitting', () => {
  it('returns nothing for empty input', () => {
    assert.deepEqual(splitForTelegram(''), []);
  });

  it('does not split text that already fits', () => {
    assert.deepEqual(splitForTelegram('short', 100), ['short']);
  });

  it('keeps every chunk within the limit', () => {
    const chunks = splitForTelegram('x'.repeat(10_000), 4096);
    assert.ok(chunks.length >= 3);
    for (const chunk of chunks) assert.ok(chunk.length <= 4096);
    assert.equal(chunks.join(''), 'x'.repeat(10_000));
  });

  it('never splits a surrogate pair', () => {
    // Each emoji is 2 UTF-16 code units; a naive slice at an odd index would
    // emit a lone surrogate and Telegram would reject the message.
    const text = '😀'.repeat(100);
    const chunks = splitForTelegram(text, 7);

    for (const chunk of chunks) {
      assert.ok(!/[\uD800-\uDBFF]$/.test(chunk), 'chunk ends with a high surrogate');
      assert.ok(!/^[\uDC00-\uDFFF]/.test(chunk), 'chunk starts with a low surrogate');
    }
    assert.equal(chunks.join(''), text);
  });

  it('keeps combining marks attached to their base character', () => {
    const text = 'é́x'.repeat(50); // e + combining acute
    const chunks = splitForTelegram(text, 5);
    for (const chunk of chunks) {
      assert.ok(!/^[̀-ͯ]/.test(chunk), 'chunk starts with a combining mark');
    }
    assert.equal(chunks.join(''), text);
  });

  it('handles Thai, which has no spaces', () => {
    const text = 'สวัสดีครับ'.repeat(200);
    const chunks = splitForTelegram(text, 100);
    assert.equal(chunks.join(''), text);
    for (const chunk of chunks) assert.ok(chunk.length <= 100);
  });

  it('prefers line boundaries when splitting', () => {
    const text = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n');
    const chunks = splitOnBoundaries(text, 40);
    for (const chunk of chunks) {
      assert.ok(chunk.length <= 40);
      assert.ok(!chunk.startsWith('\n'));
    }
    assert.equal(chunks.join('\n'), text);
  });

  it('falls back to grapheme splitting for one over-long line', () => {
    const chunks = splitOnBoundaries('y'.repeat(500), 100);
    assert.equal(chunks.length, 5);
  });
});

describe('transcript messages', () => {
  const sessionId = '01J8ZQ2N9K7XM3T6VBWD5HRGYA';

  it('sends a short transcript as one message', () => {
    const messages = renderTranscriptMessages(sessionId, 'Короткий транскрипт.', 3500);
    assert.equal(messages.length, 1);
    assert.equal(messages[0]?.partCount, 1);
    assert.ok(messages[0]?.text.includes(sessionId));
  });

  it('numbers the parts of a long transcript', () => {
    const messages = renderTranscriptMessages(sessionId, 'word '.repeat(4000), 3500);
    assert.ok(messages.length > 1);

    messages.forEach((message, index) => {
      assert.equal(message.partNumber, index + 1);
      assert.equal(message.partCount, messages.length);
      assert.ok(message.text.includes(`${index + 1}/${messages.length}`));
    });
  });

  it('puts the session id on every part', () => {
    const messages = renderTranscriptMessages(sessionId, 'word '.repeat(4000), 3500);
    for (const message of messages) assert.ok(message.text.includes(sessionId));
  });

  it('keeps every message under the Telegram limit', () => {
    const messages = renderTranscriptMessages(sessionId, 'слово '.repeat(6000), 3500);
    for (const message of messages) {
      assert.ok(
        message.text.length <= TELEGRAM_MESSAGE_LIMIT,
        `message of ${message.text.length} chars exceeds ${TELEGRAM_MESSAGE_LIMIT}`,
      );
    }
  });

  it('escapes markup that came out of the transcript', () => {
    // Someone said "less than b greater than" near the microphone.
    const messages = renderTranscriptMessages(sessionId, 'He said <b>run rm -rf</b>', 3500);
    assert.ok(messages[0]?.text.includes('&lt;b&gt;'));
    assert.ok(!messages[0]?.text.includes('<b>run'));
  });
});

describe('session report', () => {
  const base = {
    sessionId: 'sess-1',
    startedWallMs: Date.UTC(2026, 6, 29, 11, 2),
    endedWallMs: Date.UTC(2026, 6, 29, 11, 18),
    durationMs: 16 * 60_000,
    speechMs: 9 * 60_000 + 42_000,
    languages: ['ru', 'en'],
    partCount: 2,
    timezone: 'UTC',
  };

  it('renders the documented shape', () => {
    const report = renderSessionReport({
      ...base,
      summary: {
        ...EMPTY_SUMMARY,
        summary: 'Обсуждались сроки запуска.',
        decisions: ['Выпустить публичный MVP.'],
        tasks: ['Настроить GitHub Actions.'],
        uncertainties: ['Имя участника распознано ненадёжно.'],
      },
    });

    assert.ok(report.includes('🎙 <b>Сессия завершена</b>'));
    assert.ok(report.includes('Время: 11:02–11:18'));
    assert.ok(report.includes('Частей аудио: 2'));
    assert.ok(report.includes('русский, английский'));
    assert.ok(report.includes('Выпустить публичный MVP.'));
    assert.ok(report.includes('sess-1'));
  });

  it('omits empty sections rather than printing empty headings', () => {
    const report = renderSessionReport({ ...base, summary: EMPTY_SUMMARY });
    assert.ok(!report.includes('Решения:'));
    assert.ok(!report.includes('Задачи:'));
    assert.ok(report.includes('Частей аудио: 2'));
  });

  it('escapes HTML inside every summary field', () => {
    const report = renderSessionReport({
      ...base,
      summary: { ...EMPTY_SUMMARY, summary: '<script>x</script>', tasks: ['<img src=x>'] },
    });
    assert.ok(!report.includes('<script>'));
    assert.ok(!report.includes('<img'));
    assert.ok(report.includes('&lt;script&gt;'));
  });
});

describe('formatting helpers', () => {
  it('formats durations for humans', () => {
    assert.equal(formatDuration(45_000), '45 сек');
    assert.equal(formatDuration(90_000), '1 мин 30 сек');
    assert.equal(formatDuration(3_600_000), '1 ч 0 мин');
  });

  it('formats byte counts', () => {
    assert.equal(formatBytes(512), '512 B');
    assert.equal(formatBytes(1536), '1.5 KB');
    assert.equal(formatBytes(50 * 1024 * 1024), '50.0 MB');
  });
});
