-- Update ids and offsets belong to one Telegram bot credential. Keeping the
-- bot scope in the key prevents a data root rebound to another bot from
-- treating unrelated update ids as already handled.
ALTER TABLE telegram_updates RENAME TO telegram_updates_unscoped;

CREATE TABLE telegram_updates (
  bot_scope             TEXT NOT NULL,
  update_id             INTEGER NOT NULL,
  received_at           TEXT NOT NULL,
  kind                  TEXT NOT NULL,
  handled               INTEGER NOT NULL DEFAULT 0 CHECK (handled IN (0,1)),
  PRIMARY KEY (bot_scope, update_id)
) STRICT;

INSERT INTO telegram_updates (bot_scope, update_id, received_at, kind, handled)
SELECT 'legacy', update_id, received_at, kind, handled
  FROM telegram_updates_unscoped;

DROP TABLE telegram_updates_unscoped;

ALTER TABLE telegram_offset RENAME TO telegram_offset_unscoped;

CREATE TABLE telegram_offset (
  bot_scope             TEXT PRIMARY KEY,
  next_offset           INTEGER NOT NULL,
  updated_at            TEXT NOT NULL
) STRICT;

INSERT INTO telegram_offset (bot_scope, next_offset, updated_at)
SELECT 'legacy', next_offset, updated_at
  FROM telegram_offset_unscoped
 WHERE id = 1;

DROP TABLE telegram_offset_unscoped;

ALTER TABLE incoming_telegram_files
  ADD COLUMN bot_scope TEXT NOT NULL DEFAULT 'legacy';

DROP INDEX idx_incoming_update_id;
CREATE UNIQUE INDEX idx_incoming_bot_update
  ON incoming_telegram_files (bot_scope, update_id) WHERE update_id IS NOT NULL;
