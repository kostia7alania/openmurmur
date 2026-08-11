import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../../src/database/db.ts';
import { SessionRepository, TranscriptRepository } from '../../src/database/repository.ts';

const migrations = join(dirname(fileURLToPath(import.meta.url)), '../../src/database/migrations');

function migration(name: string): string {
  return readFileSync(join(migrations, name), 'utf8');
}

describe('transcript timestamp provenance migration', () => {
  it('fails before rebuilding when a required durable FTS table is missing', () => {
    const db = new DatabaseSync(':memory:');
    try {
      db.exec(migration('001_initial.sql'));
      db.exec(migration('002_speaker_diarization.sql'));
      db.exec('DROP TRIGGER transcript_fts_insert; DROP TABLE transcript_fts');

      assert.throws(
        () => db.exec(migration('016_transcript_timestamp_provenance.sql')),
        /no such table: transcript_fts/,
      );
      assert.doesNotThrow(() => db.prepare('SELECT speaker FROM transcript_segments').all());
      assert.equal(
        db
          .prepare(
            "SELECT COUNT(*) AS count FROM sqlite_schema WHERE name = 'transcript_segments_v16'",
          )
          .get()?.['count'],
        0,
        'the prerequisite check must run before creating the replacement table',
      );
    } finally {
      db.close();
    }
  });

  it('repairs historical VAD overclaims and preserves segment and FTS facts', () => {
    const db = new DatabaseSync(':memory:');
    try {
      db.exec('PRAGMA foreign_keys = ON');
      db.exec(migration('001_initial.sql'));
      db.exec(migration('002_speaker_diarization.sql'));
      db.prepare(
        `INSERT INTO audio_sessions
           (session_id, state, started_at, ended_at, duration_ms, speech_ms, part_count,
            created_at, updated_at)
         VALUES ('session-1', 'PROCESSING', ?, ?, 3000, 2000, 1, ?, ?)`,
      ).run(
        '2026-08-11T00:00:00.000Z',
        '2026-08-11T00:00:03.000Z',
        '2026-08-11T00:00:00.000Z',
        '2026-08-11T00:00:03.000Z',
      );
      db.prepare(
        `INSERT INTO transcript_revisions
           (revision_id, session_id, revision_number, engine, model, languages, text,
            word_count, is_current, created_at)
         VALUES ('revision-1', 'session-1', 1, 'mlx', 'model', '["ru","th"]',
                 'привет สวัสดี untimed', 3, 1, '2026-08-11T00:00:04.000Z')`,
      ).run();
      const insertLegacy = db.prepare(
        `INSERT INTO transcript_segments
           (revision_id, segment_index, start_ms, end_ms, timestamp_source, language, text,
            speaker)
         VALUES ('revision-1', ?, ?, ?, ?, ?, ?, ?)`,
      );
      insertLegacy.run(0, 0, 1000, 'aligner', 'ru', 'привет', 0);
      insertLegacy.run(1, 1000, 2000, 'vad', 'th', 'สวัสดี', 1);
      insertLegacy.run(2, null, null, 'none', null, 'untimed', null);

      db.exec('DROP TRIGGER transcript_fts_insert');

      db.exec(migration('016_transcript_timestamp_provenance.sql'));

      const rows = db
        .prepare(
          `SELECT segment_id, segment_index, timestamp_source, speaker
           FROM transcript_segments
           ORDER BY segment_index`,
        )
        .all() as unknown as {
        segment_id: number;
        segment_index: number;
        timestamp_source: string;
        speaker: number | null;
      }[];
      assert.deepEqual(
        rows.map(({ segment_index, timestamp_source, speaker }) => ({
          segment_index,
          timestamp_source,
          speaker,
        })),
        [
          { segment_index: 0, timestamp_source: 'aligner', speaker: 0 },
          { segment_index: 1, timestamp_source: 'coarse', speaker: 1 },
          { segment_index: 2, timestamp_source: 'none', speaker: null },
        ],
      );
      assert.equal(
        db.prepare('SELECT COUNT(*) AS count FROM transcript_fts').get()?.['count'],
        3,
        'the table rebuild must neither lose nor duplicate existing FTS rows',
      );

      const insertCurrent = db.prepare(
        `INSERT INTO transcript_segments
           (revision_id, segment_index, start_ms, end_ms, timestamp_source, language, text)
         VALUES ('revision-1', ?, ?, ?, ?, 'th', ?)`,
      );
      insertCurrent.run(3, 2000, 2500, 'coarse', 'примерно');
      insertCurrent.run(4, 2500, 3000, 'vad', 'измерено VAD');
      assert.throws(
        () => insertCurrent.run(5, 3000, 3500, 'invented', 'bad'),
        /CHECK constraint failed/,
      );

      const newest = db.prepare('SELECT MAX(segment_id) AS id FROM transcript_segments').get()?.[
        'id'
      ];
      assert.equal(newest, 5, 'AUTOINCREMENT identity must survive the rebuild');
      assert.equal(
        db.prepare('SELECT COUNT(*) AS count FROM transcript_fts').get()?.['count'],
        5,
        'the recreated trigger must index future segments exactly once',
      );
    } finally {
      db.close();
    }
  });

  it('round-trips coarse and none through the production repository', () => {
    const db = openDatabase({ file: ':memory:' });
    try {
      new SessionRepository(db.handle).create('session-production', '2026-08-11T00:00:00.000Z');
      const transcripts = new TranscriptRepository(db.handle);
      const revisionId = transcripts.append({
        sessionId: 'session-production',
        engine: 'mlx-qwen3-asr',
        model: 'model',
        languages: ['th'],
        text: 'สวัสดี untimed',
        segments: [
          {
            startMs: 0,
            endMs: 500,
            timestampSource: 'coarse',
            language: 'th',
            text: 'สวัสดี',
          },
          {
            startMs: null,
            endMs: null,
            timestampSource: 'none',
            language: 'th',
            text: 'untimed',
          },
        ],
      });

      assert.deepEqual(transcripts.segments(revisionId), [
        {
          startMs: 0,
          endMs: 500,
          timestampSource: 'coarse',
          language: 'th',
          text: 'สวัสดี',
          speaker: null,
        },
        {
          startMs: null,
          endMs: null,
          timestampSource: 'none',
          language: 'th',
          text: 'untimed',
          speaker: null,
        },
      ]);
    } finally {
      db.close();
    }
  });
});
