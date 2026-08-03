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
});
