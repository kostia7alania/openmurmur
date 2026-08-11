import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { type Database, openDatabase } from '../../src/database/db.ts';
import { SessionRepository, TranscriptRepository } from '../../src/database/repository.ts';
import {
  escapeFtsQuery,
  renderSearchResults,
  SearchError,
  searchTranscripts,
} from '../../src/database/search.ts';

let dir: string;
let db: Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'om-search-'));
  db = openDatabase({ file: join(dir, 'test.db') });

  const sessions = new SessionRepository(db.handle);
  const transcripts = new TranscriptRepository(db.handle);
  const fixtures: [string, string, string, string][] = [
    [
      's1',
      '2026-07-28T14:02:00.000Z',
      'ru',
      'Обсудили сроки запуска проекта и настройку телеграм-бота.',
    ],
    [
      's2',
      '2026-07-29T09:15:00.000Z',
      'en',
      'Let us ship the public MVP on Friday and set up GitHub Actions.',
    ],
    ['s3', '2026-07-30T18:40:00.000Z', 'th', 'สวัสดีครับ วันนี้เราจะพูดคุยเกี่ยวกับโครงการ'],
    [
      's4',
      '2026-07-31T11:00:00.000Z',
      'ru',
      'Встреча перенесена на вторник, нужно предупредить команду.',
    ],
    // Shares "телеграм" with s1, so limit and ordering have something to work on.
    ['s5', '2026-08-01T08:00:00.000Z', 'ru', 'Телеграм-бот отвечает, статус приходит вовремя.'],
  ];
  for (const [id, at, language, text] of fixtures) {
    sessions.create(id, at);
    sessions.finalize(id, at, 60_000, 30_000, 1);
    transcripts.append({
      sessionId: id,
      engine: 'e',
      model: 'm',
      languages: [language],
      text,
      segments: [{ startMs: 0, endMs: 5000, timestampSource: 'vad', language, text }],
    });
  }
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const search = (query: string, options = {}) => searchTranscripts(db.handle, { query, ...options });

describe('transcript search', () => {
  it('finds a Russian word inside a session', () => {
    const hits = search('телеграм').filter((h) => h.sessionId === 's1');
    assert.equal(hits.length, 1);
    assert.match(hits[0]?.snippet ?? '', /\[телеграм\]/i);
  });

  it('matches across inflection, which is why the tokenizer is trigram', () => {
    // "встреч" is not a word in the transcript; "Встреча" is. A whitespace
    // tokenizer would miss this, and Russian is heavily inflected.
    const hits = search('встреч');
    assert.equal(hits.length, 1);
    assert.equal(hits[0]?.sessionId, 's4');
  });

  it('finds Thai, which is written without spaces', () => {
    const hits = search('โครงการ');
    assert.equal(hits.length, 1);
    assert.equal(hits[0]?.sessionId, 's3');
  });

  it('is case-insensitive for Latin text', () => {
    assert.equal(search('github').length, 1);
    assert.equal(search('GITHUB').length, 1);
  });

  it('uses Unicode full case folding for multi-character and compatibility folds', () => {
    const transcripts = new TranscriptRepository(db.handle);
    const cases: readonly [string, string][] = [
      ['s1', 'Die STRAẞE ist frei.'],
      ['s2', 'Die Straße ist frei.'],
      ['s3', 'Die STRASSE ist frei.'],
      ['s4', 'Das ist ſafe.'],
      ['s5', 'Das ist SAFE.'],
    ];
    for (const [sessionId, text] of cases) {
      transcripts.append({
        sessionId,
        engine: 'e',
        model: 'unicode-full-fold',
        languages: ['de'],
        text,
        segments: [
          {
            startMs: 0,
            endMs: 5000,
            timestampSource: 'vad',
            language: 'de',
            text,
          },
        ],
      });
    }

    assert.deepEqual(
      new Set(search('STRASSE').map((hit) => hit.sessionId)),
      new Set(['s1', 's2', 's3']),
    );
    assert.deepEqual(
      new Set(search('straße').map((hit) => hit.sessionId)),
      new Set(['s1', 's2', 's3']),
    );
    assert.deepEqual(new Set(search('SAFE').map((hit) => hit.sessionId)), new Set(['s4', 's5']));
    assert.deepEqual(new Set(search('ſafe').map((hit) => hit.sessionId)), new Set(['s4', 's5']));
    assert.match(
      search('STRASSE').find((hit) => hit.sessionId === 's1')?.snippet ?? '',
      /\[STRAẞE\]/,
    );
  });

  it('preserves the Unicode Cherokee uppercase fold in both directions', () => {
    const transcripts = new TranscriptRepository(db.handle);
    const cases: readonly [string, string][] = [
      ['s1', 'ᎠᎠᎠ'],
      ['s2', 'ꭰꭰꭰ'],
    ];
    for (const [sessionId, text] of cases) {
      transcripts.append({
        sessionId,
        engine: 'e',
        model: 'unicode-cherokee-fold',
        languages: ['chr'],
        text,
        segments: [
          {
            startMs: 0,
            endMs: 5000,
            timestampSource: 'vad',
            language: 'chr',
            text,
          },
        ],
      });
    }

    assert.deepEqual(new Set(search('ꭰꭰꭰ').map((hit) => hit.sessionId)), new Set(['s1', 's2']));
    assert.deepEqual(new Set(search('ᎠᎠᎠ').map((hit) => hit.sessionId)), new Set(['s1', 's2']));
    assert.match(search('ꭰꭰꭰ').find((hit) => hit.sessionId === 's1')?.snippet ?? '', /\[ᎠᎠᎠ\]/);
  });

  it('matches Cyrillic case and canonically equivalent NFC/NFD text', () => {
    const transcripts = new TranscriptRepository(db.handle);
    transcripts.append({
      sessionId: 's1',
      engine: 'e',
      model: 'unicode-case',
      languages: ['ru'],
      text: 'ПРИВЕТ ИЗ МОСКВЫ.',
      segments: [
        {
          startMs: 0,
          endMs: 5000,
          timestampSource: 'vad',
          language: 'ru',
          text: 'ПРИВЕТ ИЗ МОСКВЫ.',
        },
      ],
    });
    transcripts.append({
      sessionId: 's2',
      engine: 'e',
      model: 'unicode-nfd',
      languages: ['ru'],
      text: 'ВСЕ\u0308 РЕШЕНО И ЗАПИСАНО.',
      segments: [
        {
          startMs: 0,
          endMs: 5000,
          timestampSource: 'vad',
          language: 'ru',
          text: 'ВСЕ\u0308 РЕШЕНО И ЗАПИСАНО.',
        },
      ],
    });

    assert.equal(search('привет')[0]?.sessionId, 's1');
    assert.match(search('привет')[0]?.snippet ?? '', /\[ПРИВЕТ\]/);
    const rawFtsCase = db.handle
      .prepare('SELECT count(*) AS c FROM transcript_fts WHERE transcript_fts MATCH ?')
      .get(escapeFtsQuery('привет')) as { c: number };
    assert.equal(rawFtsCase.c, 1, 'SQLite trigram folds Cyrillic case');
    const rawFtsNfc = db.handle
      .prepare('SELECT count(*) AS c FROM transcript_fts WHERE transcript_fts MATCH ?')
      .get(escapeFtsQuery('всё')) as { c: number };
    assert.equal(rawFtsNfc.c, 0, 'SQLite trigram does not normalize stored NFD text to NFC');
    const normalizedHit = search('всё')[0];
    assert.equal(normalizedHit?.sessionId, 's2');
    assert.match(normalizedHit?.snippet ?? '', /\[ВСЕ\u0308\]/);

    transcripts.append({
      sessionId: 's3',
      engine: 'e',
      model: 'unicode-nfc',
      languages: ['ru'],
      text: 'ВСЁ РЕШЕНО В NFC.',
      segments: [
        {
          startMs: 0,
          endMs: 5000,
          timestampSource: 'vad',
          language: 'ru',
          text: 'ВСЁ РЕШЕНО В NFC.',
        },
      ],
    });
    assert.equal(search('все\u0308')[0]?.sessionId, 's3');
  });

  it('searches durable current text when a revision has no segments', () => {
    new TranscriptRepository(db.handle).append({
      sessionId: 's1',
      engine: 'e',
      model: 'revision-only',
      languages: ['ru'],
      text: 'Текущая ревизия без сегментов содержит важное решение.',
      segments: [],
    });

    const hits = search('важное решение');
    assert.equal(hits.length, 1);
    assert.equal(hits[0]?.sessionId, 's1');
    assert.equal(hits[0]?.startMs, null);
    assert.match(hits[0]?.snippet ?? '', /\[важное решение\]/i);
  });

  it('falls back to durable revision text when segments omit the matching phrase', () => {
    new TranscriptRepository(db.handle).append({
      sessionId: 's1',
      engine: 'e',
      model: 'segment-drift',
      languages: ['ru'],
      text: 'Полная ревизия сохраняет скрытое решение между сегментами.',
      segments: [
        {
          startMs: 0,
          endMs: 5000,
          timestampSource: 'vad',
          language: 'ru',
          text: 'Сегмент не содержит нужной фразы.',
        },
      ],
    });

    const hits = search('скрытое решение');
    assert.equal(hits.length, 1);
    assert.equal(hits[0]?.sessionId, 's1');
    assert.equal(hits[0]?.startMs, null);
    assert.match(hits[0]?.snippet ?? '', /\[скрытое решение\]/i);
  });

  it('finds an older Unicode match behind more than 2000 newer nonmatches', () => {
    const insertSession = db.handle.prepare(
      `INSERT INTO audio_sessions
         (session_id, state, started_at, ended_at, duration_ms, speech_ms, part_count,
          created_at, updated_at)
       VALUES (?, 'DONE', ?, ?, 1000, 1000, 0, ?, ?)`,
    );
    const insertRevision = db.handle.prepare(
      `INSERT INTO transcript_revisions
         (revision_id, session_id, revision_number, engine, model, languages, text,
          word_count, is_current, created_at)
       VALUES (?, ?, 1, 'fixture', 'revision-only', '["ru"]', ?, 3, 1, ?)`,
    );
    db.handle.exec('BEGIN');
    try {
      const olderAt = '2020-01-01T00:00:00.000Z';
      insertSession.run('older-unicode-match', olderAt, olderAt, olderAt, olderAt);
      insertRevision.run(
        'older-unicode-match-revision',
        'older-unicode-match',
        'ДАВНЕЕ РЕДКОЕ РЕШЕНИЕ.',
        olderAt,
      );
      const newerBase = Date.parse('2021-01-01T00:00:00.000Z');
      for (let index = 0; index < 2_001; index += 1) {
        const sessionId = `newer-search-nonmatch-${index}`;
        const at = new Date(newerBase + index * 1000).toISOString();
        insertSession.run(sessionId, at, at, at, at);
        insertRevision.run(`${sessionId}-revision`, sessionId, 'НЕРЕЛЕВАНТНАЯ ЗАПИСЬ.', at);
      }
      db.handle.exec('COMMIT');
    } catch (error) {
      db.handle.exec('ROLLBACK');
      throw error;
    }

    assert.deepEqual(
      search('редкое решение', { limit: 1 }).map((hit) => hit.sessionId),
      ['older-unicode-match'],
    );
  });

  it('returns nothing for a phrase that does not occur', () => {
    assert.deepEqual(search('совершенно отсутствующая фраза'), []);
  });

  it('restricts results to a time range', () => {
    assert.equal(search('телеграм').length, 2, 'both sessions mention it');
    assert.equal(
      search('телеграм', { since: '2026-08-01T00:00:00.000Z' }).length,
      1,
      'since drops the older session',
    );
    assert.equal(
      search('телеграм', { until: '2026-07-29T00:00:00.000Z' }).length,
      1,
      'until drops the newer session',
    );
    assert.equal(search('телеграм', { until: '2026-07-01T00:00:00.000Z' }).length, 0);
  });

  it('returns the most recent match first', () => {
    const hits = search('телеграм');
    assert.equal(hits[0]?.sessionId, 's5', 'newest first');
    assert.equal(hits[1]?.sessionId, 's1');
  });

  it('honours the limit and clamps it to something sane', () => {
    assert.equal(search('телеграм', { limit: 1 }).length, 1);
    assert.ok(search('телеграм', { limit: 99_999 }).length <= 200);
    assert.throws(() => search('телеграм', { limit: Number.NaN }), /limit must be an integer/);
    assert.throws(() => search('телеграм', { limit: 1.5 }), /limit must be an integer/);
  });

  it('searches only the current revision', () => {
    // A re-run of ASR must not make the same session appear twice.
    new TranscriptRepository(db.handle).append({
      sessionId: 's1',
      engine: 'e',
      model: 'better',
      languages: ['ru'],
      text: 'Обсудили сроки запуска проекта и настройку телеграм-бота, уточнённая версия.',
      segments: [
        {
          startMs: 0,
          endMs: 5000,
          timestampSource: 'vad',
          language: 'ru',
          text: 'Обсудили сроки запуска проекта и настройку телеграм-бота, уточнённая версия.',
        },
      ],
    });

    const hits = search('телеграм').filter((h) => h.sessionId === 's1');
    assert.equal(hits.length, 1, 'the superseded revision must not appear as a second hit');
    assert.match(hits[0]?.text ?? '', /уточнённая/);
  });
});

describe('search query escaping', () => {
  it('treats FTS5 syntax characters literally', () => {
    // A user typing a quote or an operator means it as text.
    for (const query of ['say "hello"', 'a OR b', 'foo-bar', 'x AND y', '"']) {
      assert.doesNotThrow(() => escapeFtsQuery(`${query}xyz`));
    }
    assert.equal(escapeFtsQuery('say "hi"'), '"say ""hi"""');
  });

  it('rejects a query too short for the trigram index', () => {
    // Silently returning nothing would look like "no results" rather than
    // "that cannot match".
    assert.throws(() => escapeFtsQuery('ab'), SearchError);
    assert.throws(() => escapeFtsQuery(''), SearchError);
    assert.doesNotThrow(() => escapeFtsQuery('abc'));
  });

  it('rejects an oversized query before scanning transcripts', () => {
    assert.throws(() => search('я'.repeat(513)), /maximum is 512 characters/);
  });

  it('does not let a crafted query break out of the MATCH expression', () => {
    assert.doesNotThrow(() => search('" OR transcript_fts MATCH "'));
    assert.deepEqual(search('" OR transcript_fts MATCH "'), []);
  });
});

describe('search output', () => {
  it('says so plainly when nothing matches', () => {
    assert.match(renderSearchResults([], 'кот'), /No transcript contains "кот"/);
  });

  it('shows when each hit was recorded', () => {
    const rendered = renderSearchResults(search('телеграм'), 'телеграм');
    assert.match(rendered, /2026-07-28 14:02/);
    assert.match(rendered, /s1/);
  });

  it('removes terminal controls and bidi overrides from user-visible output', () => {
    const rendered = renderSearchResults(
      [
        {
          sessionId: 'safe\u001b[31m\u202Eid',
          incomingFileId: null,
          startedAt: '2026-08-11T20:00:00.000Z',
          language: 'ru',
          snippet: 'line one\nline two\u202E',
          text: 'line one line two',
          startMs: 0,
        },
      ],
      'query\u001b[2J\u202E',
    );

    assert.equal(rendered.includes('\u001b'), false);
    assert.equal(rendered.includes('\u202e'), false);
    assert.match(rendered, /line one line two/);
  });
});
