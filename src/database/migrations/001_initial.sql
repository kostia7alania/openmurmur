-- OpenMurmur initial schema.
-- All timestamps are UTC. Wall-clock columns end in _at (ISO 8601 strings) or
-- _ms (epoch milliseconds). Durations are milliseconds.

CREATE TABLE audio_sessions (
  session_id            TEXT PRIMARY KEY,
  state                 TEXT NOT NULL
                          CHECK (state IN ('ACTIVE','FINALIZING','PROCESSING',
                                           'DELIVERING','DONE','REJECTED','FAILED')),
  started_at            TEXT NOT NULL,
  ended_at              TEXT,
  duration_ms           INTEGER,
  speech_ms             INTEGER NOT NULL DEFAULT 0,
  part_count            INTEGER NOT NULL DEFAULT 0,
  rejection_reason      TEXT,
  languages             TEXT,              -- JSON array, filled after ASR
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL
) STRICT;

CREATE INDEX idx_sessions_state ON audio_sessions (state);
CREATE INDEX idx_sessions_started ON audio_sessions (started_at);

CREATE TABLE audio_parts (
  part_id               TEXT PRIMARY KEY,
  session_id            TEXT NOT NULL REFERENCES audio_sessions(session_id) ON DELETE CASCADE,
  part_index            INTEGER NOT NULL,
  path                  TEXT NOT NULL,
  started_at            TEXT NOT NULL,
  ended_at              TEXT,
  duration_ms           INTEGER,
  bytes                 INTEGER,
  sha256                TEXT,
  -- Set once the file is closed, fsynced and atomically renamed into place.
  finalized             INTEGER NOT NULL DEFAULT 0 CHECK (finalized IN (0,1)),
  -- Set once Telegram has acknowledged the upload of this exact part.
  delivered             INTEGER NOT NULL DEFAULT 0 CHECK (delivered IN (0,1)),
  deleted_at            TEXT,
  created_at            TEXT NOT NULL,
  UNIQUE (session_id, part_index)
) STRICT;

CREATE INDEX idx_parts_session ON audio_parts (session_id);
CREATE INDEX idx_parts_retention ON audio_parts (deleted_at, delivered);

CREATE TABLE vad_segments (
  segment_id            INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id            TEXT NOT NULL REFERENCES audio_sessions(session_id) ON DELETE CASCADE,
  start_ms              INTEGER NOT NULL,   -- offset from session start
  end_ms                INTEGER NOT NULL,
  mean_probability      REAL
) STRICT;

CREATE INDEX idx_vad_session ON vad_segments (session_id);

-- Transcripts are immutable: a re-run of ASR with a better model appends a new
-- revision rather than overwriting. `is_current` marks the one to display.
CREATE TABLE transcript_revisions (
  revision_id           TEXT PRIMARY KEY,
  session_id            TEXT REFERENCES audio_sessions(session_id) ON DELETE CASCADE,
  incoming_file_id      TEXT REFERENCES incoming_telegram_files(file_uid) ON DELETE CASCADE,
  revision_number       INTEGER NOT NULL,
  engine                TEXT NOT NULL,
  model                 TEXT NOT NULL,
  languages             TEXT NOT NULL,      -- JSON array
  text                  TEXT NOT NULL,
  word_count            INTEGER NOT NULL,
  is_current            INTEGER NOT NULL DEFAULT 1 CHECK (is_current IN (0,1)),
  created_at            TEXT NOT NULL,
  CHECK ((session_id IS NULL) <> (incoming_file_id IS NULL))
) STRICT;

CREATE UNIQUE INDEX idx_revision_session_number
  ON transcript_revisions (session_id, revision_number) WHERE session_id IS NOT NULL;
CREATE UNIQUE INDEX idx_revision_incoming_number
  ON transcript_revisions (incoming_file_id, revision_number) WHERE incoming_file_id IS NOT NULL;

CREATE TABLE transcript_segments (
  segment_id            INTEGER PRIMARY KEY AUTOINCREMENT,
  revision_id           TEXT NOT NULL REFERENCES transcript_revisions(revision_id) ON DELETE CASCADE,
  segment_index         INTEGER NOT NULL,
  start_ms              INTEGER,
  end_ms                INTEGER,
  -- 'aligner' for RU/EN word-level output, 'vad' where no aligner exists (TH).
  timestamp_source      TEXT NOT NULL CHECK (timestamp_source IN ('aligner','vad','none')),
  language              TEXT,
  text                  TEXT NOT NULL,
  UNIQUE (revision_id, segment_index)
) STRICT;

CREATE VIRTUAL TABLE transcript_fts USING fts5(
  text,
  revision_id UNINDEXED,
  tokenize = "trigram"
);

CREATE TRIGGER transcript_fts_insert AFTER INSERT ON transcript_segments BEGIN
  INSERT INTO transcript_fts (text, revision_id) VALUES (new.text, new.revision_id);
END;

CREATE TABLE summaries (
  summary_id            TEXT PRIMARY KEY,
  session_id            TEXT REFERENCES audio_sessions(session_id) ON DELETE CASCADE,
  incoming_file_id      TEXT REFERENCES incoming_telegram_files(file_uid) ON DELETE CASCADE,
  revision_id           TEXT NOT NULL REFERENCES transcript_revisions(revision_id) ON DELETE CASCADE,
  engine                TEXT NOT NULL,
  model                 TEXT NOT NULL,
  payload               TEXT NOT NULL,      -- JSON matching the extraction schema
  created_at            TEXT NOT NULL
) STRICT;

CREATE TABLE jobs (
  job_id                TEXT PRIMARY KEY,
  kind                  TEXT NOT NULL,
  -- Natural key for the unit of work. Uniqueness makes enqueue idempotent.
  idempotency_key       TEXT NOT NULL UNIQUE,
  payload               TEXT NOT NULL,
  state                 TEXT NOT NULL DEFAULT 'pending'
                          CHECK (state IN ('pending','leased','done','failed','dead')),
  attempts              INTEGER NOT NULL DEFAULT 0,
  max_attempts          INTEGER NOT NULL DEFAULT 5,
  -- A worker holds a time-boxed lease; a crashed worker's job is reclaimed
  -- once the lease expires rather than being lost.
  lease_owner           TEXT,
  lease_expires_at      TEXT,
  run_after             TEXT NOT NULL,
  last_error            TEXT,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL
) STRICT;

CREATE INDEX idx_jobs_claim ON jobs (state, run_after);
CREATE INDEX idx_jobs_lease ON jobs (state, lease_expires_at);

CREATE TABLE health_events (
  event_id              INTEGER PRIMARY KEY AUTOINCREMENT,
  component             TEXT NOT NULL,
  status                TEXT NOT NULL CHECK (status IN ('healthy','degraded','failed','recovering')),
  detail                TEXT,
  created_at            TEXT NOT NULL
) STRICT;

CREATE INDEX idx_health_created ON health_events (created_at);

-- One row per alert identity. Proactive Telegram messages are sent only when
-- `active` changes, and never more often than the cooldown.
CREATE TABLE alert_state (
  alert_id              TEXT PRIMARY KEY,
  active                INTEGER NOT NULL DEFAULT 0 CHECK (active IN (0,1)),
  last_sent_at          TEXT,
  last_changed_at       TEXT,
  occurrences           INTEGER NOT NULL DEFAULT 0
) STRICT;

CREATE TABLE telegram_updates (
  update_id             INTEGER PRIMARY KEY,   -- Telegram's own id; dedupes replays
  received_at           TEXT NOT NULL,
  kind                  TEXT NOT NULL,
  handled               INTEGER NOT NULL DEFAULT 0 CHECK (handled IN (0,1))
) STRICT;

-- Single-row table holding the getUpdates offset so a restart cannot replay
-- (or skip) updates.
CREATE TABLE telegram_offset (
  id                    INTEGER PRIMARY KEY CHECK (id = 1),
  next_offset           INTEGER NOT NULL,
  updated_at            TEXT NOT NULL
) STRICT;

INSERT INTO telegram_offset (id, next_offset, updated_at)
  VALUES (1, 0, '1970-01-01T00:00:00.000Z');

CREATE TABLE telegram_outbox (
  outbox_id             TEXT PRIMARY KEY,
  -- Stable per logical delivery unit; retrying a send cannot duplicate it.
  delivery_part_id      TEXT NOT NULL UNIQUE,
  session_id            TEXT REFERENCES audio_sessions(session_id) ON DELETE CASCADE,
  kind                  TEXT NOT NULL
                          CHECK (kind IN ('audio','transcript','report','digest',
                                          'status','alert','incoming_transcript')),
  ordinal               INTEGER NOT NULL DEFAULT 0,
  payload               TEXT NOT NULL,
  state                 TEXT NOT NULL DEFAULT 'pending'
                          CHECK (state IN ('pending','sending','sent','failed','dead')),
  attempts              INTEGER NOT NULL DEFAULT 0,
  max_attempts          INTEGER NOT NULL DEFAULT 8,
  run_after             TEXT NOT NULL,
  telegram_message_id   INTEGER,
  last_error            TEXT,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL
) STRICT;

CREATE INDEX idx_outbox_claim ON telegram_outbox (state, run_after, ordinal);
CREATE INDEX idx_outbox_session ON telegram_outbox (session_id);

CREATE TABLE incoming_telegram_files (
  file_uid              TEXT PRIMARY KEY,   -- our UUID, never Telegram's filename
  telegram_file_id      TEXT NOT NULL,
  telegram_unique_id    TEXT NOT NULL UNIQUE,
  chat_id               INTEGER NOT NULL,
  message_id            INTEGER NOT NULL,
  declared_bytes        INTEGER,
  actual_bytes          INTEGER,
  declared_mime         TEXT,
  probed_format         TEXT,
  duration_ms           INTEGER,
  state                 TEXT NOT NULL DEFAULT 'received'
                          CHECK (state IN ('received','downloaded','validated','transcribed',
                                           'delivered','rejected','failed')),
  rejection_reason      TEXT,
  quarantine_path       TEXT,
  normalized_path       TEXT,
  deleted_at            TEXT,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL
) STRICT;

CREATE INDEX idx_incoming_state ON incoming_telegram_files (state);
CREATE INDEX idx_incoming_retention ON incoming_telegram_files (deleted_at, state);

CREATE TABLE digests (
  digest_id             TEXT PRIMARY KEY,
  digest_date           TEXT NOT NULL UNIQUE,  -- YYYY-MM-DD, local date
  session_count         INTEGER NOT NULL,
  speech_ms             INTEGER NOT NULL,
  payload               TEXT NOT NULL,
  created_at            TEXT NOT NULL
) STRICT;
