-- Telegram has no idempotency key or post-hoc getMessage lookup. An operator
-- may reconcile one exact outbox row only from independently observed remote
-- evidence. Keep that evidence immutable and in the same transaction as the
-- recovered local acknowledgement.
CREATE TABLE telegram_delivery_reconciliation_audit (
  reconciliation_id     TEXT PRIMARY KEY,
  outbox_id              TEXT NOT NULL UNIQUE
                           REFERENCES telegram_outbox(outbox_id) ON DELETE RESTRICT,
  delivery_part_id       TEXT NOT NULL UNIQUE,
  kind                   TEXT NOT NULL,
  session_id             TEXT,
  payload_sha256         TEXT NOT NULL
                           CHECK (
                             length(payload_sha256) = 64
                             AND payload_sha256 NOT GLOB '*[^0-9a-f]*'
                           ),
  previous_state         TEXT NOT NULL
                           CHECK (previous_state IN ('pending','sending','failed','dead')),
  previous_attempts      INTEGER NOT NULL CHECK (previous_attempts > 0),
  previous_updated_at    TEXT NOT NULL,
  telegram_message_id    INTEGER NOT NULL CHECK (telegram_message_id > 0),
  acknowledged_at        TEXT NOT NULL,
  operator_id            TEXT NOT NULL CHECK (length(operator_id) > 0),
  evidence               TEXT NOT NULL CHECK (length(evidence) > 0),
  applied_at             TEXT NOT NULL
) STRICT;

CREATE INDEX idx_telegram_delivery_reconciliation_applied
  ON telegram_delivery_reconciliation_audit (applied_at, delivery_part_id);

CREATE TRIGGER telegram_delivery_reconciliation_audit_no_update
BEFORE UPDATE ON telegram_delivery_reconciliation_audit
BEGIN
  SELECT RAISE(ABORT, 'telegram delivery reconciliation audit is immutable');
END;

CREATE TRIGGER telegram_delivery_reconciliation_audit_no_delete
BEFORE DELETE ON telegram_delivery_reconciliation_audit
BEGIN
  SELECT RAISE(ABORT, 'telegram delivery reconciliation audit is immutable');
END;
