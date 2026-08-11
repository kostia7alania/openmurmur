-- Preserve the origin and precision boundary of transcript timestamps.
--
-- Earlier versions labelled every timed segment outside the forced-aligner
-- allowlist as `vad`, even though those offsets came directly from ASR and no
-- VAD-to-transcript mapping had run. Conservatively downgrade those historical
-- claims to `coarse`; a future producer may use `vad` only for an actual VAD
-- measurement.

-- The trigger is optional legacy plumbing; the segment and FTS tables are
-- durable schema facts and a database missing either must fail closed.
SELECT 1 FROM transcript_fts LIMIT 1;
DROP TRIGGER IF EXISTS transcript_fts_insert;

CREATE TABLE transcript_segments_v16 (
  segment_id            INTEGER PRIMARY KEY AUTOINCREMENT,
  revision_id           TEXT NOT NULL REFERENCES transcript_revisions(revision_id) ON DELETE CASCADE,
  segment_index         INTEGER NOT NULL,
  start_ms              INTEGER,
  end_ms                INTEGER,
  timestamp_source      TEXT NOT NULL
                          CHECK (timestamp_source IN ('aligner','vad','coarse','none')),
  language              TEXT,
  text                  TEXT NOT NULL,
  speaker               INTEGER,
  UNIQUE (revision_id, segment_index)
) STRICT;

INSERT INTO transcript_segments_v16
  (segment_id, revision_id, segment_index, start_ms, end_ms, timestamp_source,
   language, text, speaker)
SELECT
  segment_id,
  revision_id,
  segment_index,
  start_ms,
  end_ms,
  CASE timestamp_source WHEN 'vad' THEN 'coarse' ELSE timestamp_source END,
  language,
  text,
  speaker
FROM transcript_segments;

DROP TABLE transcript_segments;
ALTER TABLE transcript_segments_v16 RENAME TO transcript_segments;

-- `transcript_fts` is an independent content table. Its existing rows stay in
-- place while the segment table is rebuilt; only future inserts need a trigger.
CREATE TRIGGER transcript_fts_insert AFTER INSERT ON transcript_segments BEGIN
  INSERT INTO transcript_fts (text, revision_id) VALUES (new.text, new.revision_id);
END;
