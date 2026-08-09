-- Durable provenance shown with every delivered recording artefact.
--
-- Columns are nullable for rows created before this migration. Missing legacy
-- facts are rendered as unknown; they must never be backfilled from the host
-- or timezone that happens to open the database later.
ALTER TABLE audio_sessions ADD COLUMN capture_host TEXT;
ALTER TABLE audio_sessions ADD COLUMN capture_timezone TEXT;

ALTER TABLE incoming_telegram_files ADD COLUMN update_id INTEGER;
ALTER TABLE incoming_telegram_files ADD COLUMN telegram_source TEXT
  CHECK (telegram_source IN ('direct', 'forwarded'));
ALTER TABLE incoming_telegram_files ADD COLUMN attachment_type TEXT
  CHECK (attachment_type IN ('voice', 'audio', 'document', 'video_note'));
ALTER TABLE incoming_telegram_files ADD COLUMN claimed_filename TEXT;
ALTER TABLE incoming_telegram_files ADD COLUMN telegram_message_at TEXT;
ALTER TABLE incoming_telegram_files ADD COLUMN original_sent_at TEXT;
ALTER TABLE incoming_telegram_files ADD COLUMN daemon_host TEXT;

CREATE UNIQUE INDEX idx_incoming_update_id
  ON incoming_telegram_files (update_id) WHERE update_id IS NOT NULL;
