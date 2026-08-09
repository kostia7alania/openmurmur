CREATE TABLE asr_preferences (
  preference_id   INTEGER PRIMARY KEY CHECK (preference_id = 1),
  forced_language TEXT CHECK (forced_language IS NULL OR forced_language IN ('th', 'ru', 'en', 'zh')),
  updated_at      TEXT NOT NULL
) STRICT;

ALTER TABLE transcript_revisions ADD COLUMN forced_language TEXT;
