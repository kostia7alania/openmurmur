-- Exact monotonic capture facts must survive the filesystem publication window.
-- A journal row is written before the archive rename and consumed only with the
-- database transition it proves. Existing rows with a duration came from the
-- recorder's monotonic sessionizer when its paired wall-clock end also landed;
-- incomplete legacy rows remain explicitly unknown.
ALTER TABLE audio_sessions
  ADD COLUMN timing_exact INTEGER NOT NULL DEFAULT 0
    CHECK (
      timing_exact IN (0, 1)
      AND (timing_exact = 0 OR (ended_at IS NOT NULL AND duration_ms IS NOT NULL))
    );

UPDATE audio_sessions
   SET timing_exact = 1
 WHERE ended_at IS NOT NULL
   AND duration_ms IS NOT NULL
   AND NOT (
     state = 'REJECTED'
     AND rejection_reason IN ('asr_empty', 'insufficient_words')
   );

CREATE TABLE audio_finalization_journal (
  part_id                 TEXT PRIMARY KEY
                            REFERENCES audio_parts(part_id) ON DELETE CASCADE,
  session_id              TEXT NOT NULL
                            REFERENCES audio_sessions(session_id) ON DELETE CASCADE,
  part_ended_at           TEXT NOT NULL,
  part_duration_ms        INTEGER NOT NULL CHECK (part_duration_ms >= 0),
  session_ended_at        TEXT,
  session_duration_ms     INTEGER CHECK (session_duration_ms >= 0),
  session_speech_ms       INTEGER CHECK (session_speech_ms >= 0),
  created_at              TEXT NOT NULL,
  CHECK (
    (session_ended_at IS NULL AND session_duration_ms IS NULL AND session_speech_ms IS NULL)
    OR
    (session_ended_at IS NOT NULL AND session_duration_ms IS NOT NULL
      AND session_speech_ms IS NOT NULL AND session_speech_ms <= session_duration_ms)
  )
) STRICT;

CREATE UNIQUE INDEX idx_audio_finalization_session
  ON audio_finalization_journal(session_id)
  WHERE session_duration_ms IS NOT NULL;

CREATE TRIGGER audio_finalization_journal_immutable
BEFORE UPDATE ON audio_finalization_journal
BEGIN
  SELECT RAISE(ABORT, 'audio finalization journal is immutable');
END;

CREATE TRIGGER audio_finalization_journal_owned_part
BEFORE INSERT ON audio_finalization_journal
WHEN NOT EXISTS (
  SELECT 1
    FROM audio_parts p
   WHERE p.part_id = NEW.part_id
     AND p.session_id = NEW.session_id
     AND p.finalized = 0
     AND p.ended_at IS NULL
     AND p.duration_ms IS NULL
     AND p.bytes IS NULL
     AND p.sha256 IS NULL
)
BEGIN
  SELECT RAISE(ABORT, 'audio finalization journal requires its unfinalized owned part');
END;
