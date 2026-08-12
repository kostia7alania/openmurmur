import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import {
  normalizeRecallOptions,
  recallTranscripts,
  renderRecallResults,
  sourceAudioAvailability,
} from '../../src/cli/recall.ts';
import { type Database, openDatabase } from '../../src/database/db.ts';
import { SessionRepository, TranscriptRepository } from '../../src/database/repository.ts';

let db: Database;
let directory: string;

interface SessionFixture {
  readonly id: string;
  readonly at: string;
  readonly expectedParts: number;
  readonly parts: readonly ('available' | 'deleted')[];
}

function partPath(sessionId: string, index: number): string {
  return join(directory, `${sessionId}-${index}.flac`);
}

function seedSession(fixture: SessionFixture): void {
  const sessions = new SessionRepository(db.handle);
  const transcripts = new TranscriptRepository(db.handle);
  sessions.create(fixture.id, fixture.at, {
    hostName: 'studio-mac',
    timezone: 'Europe/Moscow',
  });
  sessions.finalize(fixture.id, fixture.at, 60_000, 30_000, fixture.expectedParts);
  transcripts.append({
    sessionId: fixture.id,
    engine: 'fixture',
    model: 'fixture',
    languages: ['en'],
    text: 'The grounded launch decision was recorded here.',
    segments: [
      {
        startMs: 1000,
        endMs: 5000,
        timestampSource: 'vad',
        language: 'en',
        text: 'The grounded launch decision was recorded here.',
      },
    ],
  });
  const insertPart = db.handle.prepare(
    `INSERT INTO audio_parts
       (part_id, session_id, part_index, path, started_at, ended_at, duration_ms, bytes,
        sha256, finalized, delivered, deleted_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 60000, 100, ?, 1, 1, ?, ?)`,
  );
  fixture.parts.forEach((state, index) => {
    const path = partPath(fixture.id, index);
    if (state === 'available') writeFileSync(path, `audio-${fixture.id}-${index}`);
    insertPart.run(
      `${fixture.id}-p${index}`,
      fixture.id,
      index,
      path,
      fixture.at,
      fixture.at,
      `sha-${fixture.id}-${index}`,
      state === 'deleted' ? '2026-08-11T23:00:00.000Z' : null,
      fixture.at,
    );
  });
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'om-recall-'));
  db = openDatabase({ file: ':memory:' });
  seedSession({
    id: 'available-session',
    at: '2026-08-11T20:00:00.000Z',
    expectedParts: 1,
    parts: ['available'],
  });
  seedSession({
    id: 'partial-session',
    at: '2026-08-11T19:00:00.000Z',
    expectedParts: 2,
    parts: ['available', 'deleted'],
  });
  seedSession({
    id: 'deleted-session',
    at: '2026-08-11T18:00:00.000Z',
    expectedParts: 1,
    parts: ['deleted'],
  });
  seedSession({
    id: 'unknown-session',
    at: '2026-08-11T17:00:00.000Z',
    expectedParts: 2,
    parts: ['available'],
  });
});

afterEach(() => {
  db.close();
  rmSync(directory, { recursive: true, force: true });
});

describe('grounded transcript recall', () => {
  it('returns provenance and source-audio availability proven by a filesystem snapshot', async () => {
    const matches = await recallTranscripts(db.handle, { query: 'launch decision' });

    assert.deepEqual(
      matches.map((match) => [match.sessionId, match.audioAvailability]),
      [
        ['available-session', 'available'],
        ['partial-session', 'partial'],
        ['deleted-session', 'deleted'],
        ['unknown-session', 'unknown'],
      ],
    );
    assert.equal(matches[0]?.captureTimezone, 'Europe/Moscow');
    assert.equal(matches[0]?.captureHost, 'studio-mac');
    assert.equal(matches[0]?.recordedAt, '2026-08-11T20:00:00.000Z');
    assert.equal(matches[0]?.audioAvailabilityBasis, 'filesystem_snapshot');
    assert.match(matches[0]?.audioCheckedAt ?? '', /^\d{4}-\d{2}-\d{2}T/);
    assert.deepEqual(Object.keys(matches[0] ?? {}), [
      'revisionId',
      'sessionId',
      'recordedAt',
      'captureTimezone',
      'captureHost',
      'snippet',
      'audioAvailability',
      'audioAvailabilityBasis',
      'audioCheckedAt',
      'audioExpectedParts',
      'audioKnownParts',
      'audioAvailableParts',
      'audioDeletedParts',
      'audioUnknownParts',
    ]);
  });

  it('searches current revision text even when the ASR emitted no segments', async () => {
    new TranscriptRepository(db.handle).append({
      sessionId: 'available-session',
      engine: 'fixture',
      model: 'revision-only',
      languages: ['en'],
      text: 'A revision-only launch decision remains grounded in durable text.',
      segments: [],
    });

    const matches = await recallTranscripts(db.handle, { query: 'launch decision', limit: 1 });
    const match = matches.find((candidate) => candidate.sessionId === 'available-session');
    assert.ok(match);
    assert.equal(matches.length, 1);
    assert.match(match.snippet, /\[launch decision\]/);
  });

  it('finds a remembered phrase that crosses two ASR segment boundaries', async () => {
    new TranscriptRepository(db.handle).append({
      sessionId: 'available-session',
      engine: 'fixture',
      model: 'segmented-ru',
      languages: ['ru'],
      text: 'Обсудили бюджет на пятницу и записали решение.',
      segments: [
        {
          startMs: 0,
          endMs: 1000,
          timestampSource: 'vad',
          language: 'ru',
          text: 'Обсудили бюджет',
        },
        {
          startMs: 1000,
          endMs: 2000,
          timestampSource: 'vad',
          language: 'ru',
          text: ' на пятницу и записали решение.',
        },
      ],
    });

    const matches = await recallTranscripts(db.handle, { query: 'бюджет на пятницу' });
    assert.equal(matches.length, 1);
    assert.equal(matches[0]?.sessionId, 'available-session');
    assert.equal(matches[0]?.captureTimezone, 'Europe/Moscow');
    assert.equal(matches[0]?.audioAvailability, 'available');
    assert.match(matches[0]?.snippet ?? '', /\[бюджет на пятницу\]/u);
  });

  it('Unicode-folds Russian revision-only text outside SQLite NOCASE', async () => {
    new TranscriptRepository(db.handle).append({
      sessionId: 'available-session',
      engine: 'fixture',
      model: 'revision-only-ru',
      languages: ['ru'],
      text: 'ПРИВЕТ ИЗ МОСКВЫ — РЕШЕНИЕ ЗАПИСАНО.',
      segments: [],
    });

    const matches = await recallTranscripts(db.handle, { query: 'привет' });
    const match = matches.find((candidate) => candidate.sessionId === 'available-session');
    assert.ok(match);
    assert.match(match.snippet, /\[ПРИВЕТ\]/);
  });

  it('normalizes revision-only text before Unicode casefold matching', async () => {
    new TranscriptRepository(db.handle).append({
      sessionId: 'available-session',
      engine: 'fixture',
      model: 'revision-only-ru-nfd',
      languages: ['ru'],
      text: 'ВСЕ\u0308 РЕШЕНО И ЗАПИСАНО.',
      segments: [],
    });

    const matches = await recallTranscripts(db.handle, { query: 'всё' });
    assert.equal(
      matches.some((candidate) => candidate.sessionId === 'available-session'),
      true,
    );
  });

  it('finds an older Unicode match behind more than 2000 newer revision-only nonmatches', async () => {
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
        'ДАВНИЙ ПРИВЕТ СОХРАНЕН.',
        olderAt,
      );
      const newerBase = Date.parse('2021-01-01T00:00:00.000Z');
      for (let index = 0; index < 2_001; index += 1) {
        const sessionId = `newer-nonmatch-${index}`;
        const at = new Date(newerBase + index * 1000).toISOString();
        insertSession.run(sessionId, at, at, at, at);
        insertRevision.run(`${sessionId}-revision`, sessionId, 'НЕРЕЛЕВАНТНАЯ ЗАПИСЬ.', at);
      }
      db.handle.exec('COMMIT');
    } catch (error) {
      db.handle.exec('ROLLBACK');
      throw error;
    }

    const matches = await recallTranscripts(db.handle, { query: 'привет', limit: 1 });
    assert.deepEqual(
      matches.map((match) => match.sessionId),
      ['older-unicode-match'],
    );
  });

  it('searches only the current transcript revision', async () => {
    new TranscriptRepository(db.handle).append({
      sessionId: 'available-session',
      engine: 'fixture',
      model: 'corrected',
      languages: ['en'],
      text: 'The corrected transcript contains no matching phrase.',
      segments: [
        {
          startMs: 0,
          endMs: 1000,
          timestampSource: 'vad',
          language: 'en',
          text: 'The corrected transcript contains no matching phrase.',
        },
      ],
    });

    const ids = (await recallTranscripts(db.handle, { query: 'launch decision' })).map(
      (match) => match.sessionId,
    );
    assert.equal(ids.includes('available-session'), false);
  });

  it('applies normalized UTC bounds rather than comparing caller offsets as strings', async () => {
    const matches = await recallTranscripts(db.handle, {
      query: 'launch decision',
      since: '2026-08-11T22:30:00+03:00',
      until: '2026-08-11T23:30:00+03:00',
    });

    assert.deepEqual(
      matches.map((match) => match.sessionId),
      ['available-session'],
    );
  });

  it('does not claim available from an untombstoned database row when its file is absent', async () => {
    rmSync(partPath('available-session', 0));

    const matches = await recallTranscripts(db.handle, { query: 'launch decision' });
    assert.equal(
      matches.find((match) => match.sessionId === 'available-session')?.audioAvailability,
      'unknown',
    );
  });

  it('treats a readable tombstoned path as inconsistent rather than available', async () => {
    db.handle
      .prepare('UPDATE audio_parts SET deleted_at = ? WHERE session_id = ?')
      .run('2026-08-11T23:00:00.000Z', 'available-session');

    const matches = await recallTranscripts(db.handle, { query: 'launch decision' });
    assert.equal(
      matches.find((match) => match.sessionId === 'available-session')?.audioAvailability,
      'unknown',
    );
  });

  it('renders UTC and capture-local provenance without paths or bidi controls', async () => {
    const matches = await recallTranscripts(db.handle, { query: 'launch decision', limit: 1 });
    const match = matches[0];
    assert.ok(match);
    const unsafe = [{ ...match, snippet: `safe\u202Ehidden` }];
    const rendered = renderRecallResults(unsafe, `launch\u2066 decision`);

    assert.match(rendered, /session available-session/);
    assert.match(rendered, /recorded UTC: 2026-08-11T20:00:00.000Z/);
    assert.match(rendered, /capture local: 2026-08-11 23:00:00 \[Europe\/Moscow\]/);
    assert.match(rendered, /source audio \(filesystem snapshot .*\): available/);
    assert.doesNotMatch(rendered, /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u);
    assert.doesNotMatch(rendered, new RegExp(directory));
  });
});

describe('recall option validation', () => {
  it('normalizes offset timestamps to UTC before applying the range', () => {
    assert.deepEqual(
      normalizeRecallOptions({
        query: ' launch decision ',
        limit: '7',
        since: '2026-08-11T23:00:00+03:00',
        until: '2026-08-12T01:30:00+03:00',
      }),
      {
        query: 'launch decision',
        limit: 7,
        since: '2026-08-11T20:00:00.000Z',
        until: '2026-08-11T22:30:00.000Z',
      },
    );
  });

  it('rejects invalid, timezone-free, and non-increasing ranges', () => {
    assert.throws(
      () => normalizeRecallOptions({ query: 'launch', since: '2026-02-30T12:00:00Z' }),
      /valid calendar timestamp/,
    );
    assert.throws(
      () => normalizeRecallOptions({ query: 'launch', since: '2026-08-11T12:00:00' }),
      /with a timezone/,
    );
    assert.throws(
      () =>
        normalizeRecallOptions({
          query: 'launch',
          since: '2026-08-12T00:00:00Z',
          until: '2026-08-11T00:00:00Z',
        }),
      /earlier than/,
    );
  });

  it('accepts only an exact positive integer limit within the supported bound', () => {
    for (const limit of ['0', '-1', '1.5', '10x', ' 10', 1.5, 201]) {
      assert.throws(
        () => normalizeRecallOptions({ query: 'launch', limit }),
        /integer from 1 to 200/,
      );
    }
    assert.equal(normalizeRecallOptions({ query: 'launch', limit: '200' }).limit, 200);
  });
});

describe('source audio classification', () => {
  it('fails closed when the durable part manifest is incomplete', () => {
    assert.equal(
      sourceAudioAvailability({
        expectedParts: 2,
        knownParts: 1,
        finalizedParts: 1,
        availableParts: 1,
        deletedParts: 0,
        unknownParts: 0,
      }),
      'unknown',
    );
  });
});
