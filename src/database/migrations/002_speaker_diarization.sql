-- Speaker diarization: which voice said each line.
--
-- `speaker` is an index within one recording and nothing more. Voice 0 in one
-- session has no relation to voice 0 in the next, and nothing here associates
-- a voice with a person. Storing it as an integer rather than a name keeps
-- that honest — there is no field to quietly start putting names in.
--
-- NULL means unknown, not "the first speaker": a segment with no timestamps,
-- or one falling in a gap between turns, gets no speaker rather than a guess.
ALTER TABLE transcript_segments ADD COLUMN speaker INTEGER;

-- The turns as diarization produced them, before they are matched to
-- transcript segments. Kept because the two can disagree: the aligner and the
-- diarizer segment the audio independently, and when a report looks wrong this
-- is the only way to tell which of them was.
CREATE TABLE speaker_turns (
  session_id            TEXT NOT NULL REFERENCES audio_sessions(session_id) ON DELETE CASCADE,
  turn_index            INTEGER NOT NULL,
  start_ms              INTEGER NOT NULL,
  end_ms                INTEGER NOT NULL,
  speaker               INTEGER NOT NULL,
  created_at            TEXT NOT NULL,
  PRIMARY KEY (session_id, turn_index)
) STRICT;

CREATE INDEX idx_speaker_turns_session ON speaker_turns (session_id, start_ms);
