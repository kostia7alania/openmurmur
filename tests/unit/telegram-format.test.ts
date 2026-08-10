import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { EMPTY_SUMMARY } from '../../src/llm/schema.ts';
import {
  escapeHtml,
  formatBytes,
  formatDuration,
  formatTimedTranscript,
  formatTimestamp,
  renderTimedTranscriptMessages,
  renderTranscriptMessages,
  splitForTelegram,
  splitOnBoundaries,
  TELEGRAM_MESSAGE_LIMIT,
} from '../../src/telegram/format.ts';
import {
  renderProvenanceHtml,
  renderProvenanceMarkdown,
  renderProvenancePlain,
} from '../../src/telegram/provenance.ts';
import {
  HELP_TEXT,
  renderSessionReport,
  renderSessionReportMarkdown,
  renderSessionSummaryPreview,
  renderStatus,
} from '../../src/telegram/report.ts';

describe('help text', () => {
  it('keeps commands visible while using Telegram HTML markup', () => {
    assert.match(HELP_TEXT, /^<b>OpenMurmur<\/b>/);
    assert.match(HELP_TEXT, /^\/status — подробное состояние демона$/m);
    assert.match(HELP_TEXT, /^\/help — этот текст$/m);
  });
});

describe('output provenance', () => {
  it('labels a live capture with its persisted host, timezone, wall time and UID', () => {
    const provenance = {
      kind: 'live_capture' as const,
      hostName: 'Kostia <Mac>',
      timezone: 'Europe/Moscow',
      originalAt: '2026-08-09T10:00:00.000Z',
      sessionId: 'session-1',
    };
    const html = renderProvenanceHtml(provenance);
    assert.match(html, /фоновая запись OpenMurmur/);
    assert.match(html, /Kostia &lt;Mac&gt;/);
    assert.match(html, /Europe\/Moscow/);
    assert.match(html, /UID сессии: <code>session-1<\/code>/);
  });

  it('keeps a forwarded filename display-only, bounded and escaped', () => {
    const provenance = {
      kind: 'telegram_audio' as const,
      hostName: '&'.repeat(1000),
      telegramSource: 'forwarded' as const,
      attachmentType: 'document' as const,
      telegramMessageAt: '2026-08-09T12:00:00.000Z',
      originalSentAt: '2026-08-08T08:00:00.000Z',
      claimedFilename: `<b>../../secret\u0000</b>${'👨‍👩‍👧‍👦'.repeat(500)}.mp3`,
      updateId: 99,
      messageId: 10,
      fileUid: 'file-uid',
    };
    const html = renderProvenanceHtml(provenance);
    assert.match(html, /пересланное аудио из Telegram \(документ\)/);
    assert.match(html, /ID обновления\/сообщения Telegram: <code>99\/10<\/code>/);
    assert.match(html, /UID файла: <code>file-uid<\/code>/);
    assert.ok(!html.includes('<b>../../secret'));
    assert.ok(!html.includes('\u0000'));
    assert.ok(html.length <= 1024, 'the provenance must fit a Telegram caption by UTF-16 units');
    assert.match(renderProvenancePlain(provenance), /UID файла: file-uid/);
    assert.match(renderProvenanceMarkdown(provenance), /- UID файла: `file-uid`/);
  });

  it('renders missing legacy provenance as unknown instead of inventing current facts', () => {
    const html = renderProvenanceHtml({
      kind: 'live_capture',
      hostName: null,
      timezone: null,
      originalAt: '2026-08-09T10:00:00.000Z',
      sessionId: 'legacy',
    });
    assert.match(html, /Демон: <code>неизвестно<\/code>/);
    assert.match(html, /часовой пояс неизвестно/);
  });
});

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
    assert.ok(messages[0]?.text.includes('<blockquote expandable>'));
  });

  it('shows detected languages, forced mode and the future-settings boundary', () => {
    const message = renderTranscriptMessages(sessionId, 'สวัสดี hello', 3500, undefined, {
      languages: ['th', 'en'],
      forcedLanguage: 'Thai',
      showSettingsHint: true,
    })[0]?.text;

    assert.match(message ?? '', /<b>Расшифровка<\/b>/);
    assert.match(message ?? '', /Языки: тайский, английский/);
    assert.match(message ?? '', /Режим: только тайский/);
    assert.match(message ?? '', /следующих расшифровок/);
  });

  it('numbers the parts of a long transcript', () => {
    const messages = renderTranscriptMessages(sessionId, 'word '.repeat(4000), 3500);
    assert.ok(messages.length > 1);

    messages.forEach((message, index) => {
      assert.equal(message.partNumber, index + 1);
      assert.equal(message.partCount, messages.length);
      assert.ok(message.text.includes(`${index + 1}/${messages.length}`));
      assert.ok(message.text.includes('<blockquote expandable>'));
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

  it('renders timed transcript blocks from ASR segments', () => {
    const text = formatTimedTranscript([
      { startMs: 80, endMs: 320, text: 'Yes ' },
      { startMs: 640, endMs: 880, text: 'okay ' },
      { startMs: 31_000, endMs: 31_400, text: 'second ' },
      { startMs: 31_400, endMs: 31_900, text: 'block.' },
    ]);

    assert.equal(text, '0:00  Yes okay\n\n0:31  second block.');
  });

  it('falls back to the raw transcript when segments have no timing', () => {
    const messages = renderTimedTranscriptMessages(
      sessionId,
      [{ startMs: null, endMs: null, text: 'untimed' }],
      'raw transcript',
      3500,
    );

    assert.ok(messages[0]?.text.includes('raw transcript'));
    assert.ok(!messages[0]?.text.includes('untimed'));
  });

  it('escapes markup after rendering timed transcript blocks', () => {
    const messages = renderTimedTranscriptMessages(
      sessionId,
      [{ startMs: 0, endMs: 1000, text: '<b>spoken</b>' }],
      '',
      3500,
    );

    assert.ok(messages[0]?.text.includes('0:00'));
    assert.ok(messages[0]?.text.includes('&lt;b&gt;spoken&lt;/b&gt;'));
    assert.ok(!messages[0]?.text.includes('<b>spoken'));
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
    assert.equal(report.match(/<blockquote expandable>/g)?.length, 2);
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

  it('renders a complete Markdown artifact for file delivery', () => {
    const report = renderSessionReportMarkdown({
      ...base,
      summary: { ...EMPTY_SUMMARY, summary: 'Краткий итог', tasks: ['Позвонить завтра'] },
      transcript: 'fallback',
      transcriptSegments: [
        { startMs: 0, endMs: 1000, text: 'Начали обсуждение.', speaker: 0 },
        { startMs: 1000, endMs: 2000, text: 'Продолжили.', speaker: 1 },
      ],
    });
    assert.match(report, /^# Отчёт OpenMurmur/);
    assert.match(report, /## Кратко\n\nКраткий итог/);
    assert.match(report, /## Задачи\n\n- Позвонить завтра/);
    assert.match(report, /## Таймлайн и голоса/);
    assert.match(report, /0:00 {2}Голос 1: Начали обсуждение\\\./);
    assert.match(report, /0:01 {2}Голос 2: Продолжили\\\./);
  });

  it('keeps a long summary preview compact and collapsible', () => {
    const preview = renderSessionSummaryPreview({
      ...base,
      summary: { ...EMPTY_SUMMARY, summary: '<важно> '.repeat(1000) },
    });
    assert.ok(preview.includes('<blockquote expandable>'));
    assert.ok(preview.includes('&lt;важно&gt;'));
    assert.ok(preview.length < TELEGRAM_MESSAGE_LIMIT);
    assert.ok(preview.endsWith('…</blockquote>'));
  });

  it('bounds a preview containing multi-code-unit graphemes', () => {
    const preview = renderSessionSummaryPreview({
      ...base,
      summary: { ...EMPTY_SUMMARY, summary: '👨‍👩‍👧‍👦'.repeat(1000) },
    });
    assert.ok(preview.length <= TELEGRAM_MESSAGE_LIMIT);
    assert.ok(preview.endsWith('…</blockquote>'));
  });

  it('keeps transcript-derived Markdown as literal text', () => {
    const report = renderSessionReportMarkdown({
      ...base,
      summary: {
        ...EMPTY_SUMMARY,
        summary: '<script># heading</script>',
        tasks: ['[click](https://example.com)'],
      },
    });
    assert.ok(!report.includes('<script>'));
    assert.ok(!report.includes('[click](https://example.com)'));
    assert.match(report, /&lt;script/);
    assert.match(report, /\\\[click\\\]/);
  });
});

describe('formatting helpers', () => {
  it('formats durations for humans', () => {
    assert.equal(formatDuration(45_000), '45 сек');
    assert.equal(formatDuration(90_000), '1 мин 30 сек');
    assert.equal(formatDuration(3_600_000), '1 ч 0 мин');
  });

  it('formats transcript offsets', () => {
    assert.equal(formatTimestamp(0), '0:00');
    assert.equal(formatTimestamp(65_000), '1:05');
    assert.equal(formatTimestamp(3_665_000), '1:01:05');
  });

  it('formats byte counts', () => {
    assert.equal(formatBytes(512), '512 B');
    assert.equal(formatBytes(1536), '1.5 KB');
    assert.equal(formatBytes(50 * 1024 * 1024), '50.0 MB');
  });
});

describe('status report', () => {
  it('shows the escaped daemon host in the heading', () => {
    const report = renderStatus({
      hostName: 'Kostia <Mac> & Studio',
      recording: true,
      lastFrameSecondsAgo: 1,
      sessionState: 'IDLE',
      sessionElapsedMs: null,
      lastClosedPartMinutesAgo: 2,
      asrBacklog: 0,
      failedJobs: 1,
      outboxPending: 0,
      failedOutbox: 2,
      lastDeliveryMinutesAgo: 3,
      diskFreeGb: 100,
      asrStatus: 'ready',
      llmStatus: 'ready',
      version: '0.1.0',
    });

    assert.match(
      report,
      /^🟢 <b>OpenMurmur работает<\/b> — <code>Kostia &lt;Mac&gt; &amp; Studio<\/code>/,
    );
    assert.ok(!report.includes('<Mac>'));
    assert.match(report, /Ошибочные задачи: 1/);
    assert.match(report, /Недоставленные сообщения: 2/);
  });
});
