-- Event updates keep their own immutable outbox rows but share one Telegram
-- message. The scope binds that message to the exact bot credential and chat.
ALTER TABLE telegram_outbox ADD COLUMN event_key TEXT;

CREATE INDEX idx_outbox_event_sending ON telegram_outbox (event_key, state);

CREATE TABLE telegram_event_messages (
  event_key TEXT NOT NULL,
  chat_scope TEXT NOT NULL,
  telegram_message_id INTEGER NOT NULL,
  PRIMARY KEY (event_key, chat_scope)
) STRICT;
