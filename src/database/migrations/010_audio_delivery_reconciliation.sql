-- Manual reconciliation never derives a delivery clock. It records the exact
-- UTC acknowledgement supplied by an operator and the evidence for that fact
-- in the same transaction that releases the retention hold.
CREATE TABLE audio_delivery_reconciliation_audit (
  reconciliation_id     TEXT PRIMARY KEY,
  part_id                TEXT NOT NULL UNIQUE
                           REFERENCES audio_parts(part_id) ON DELETE RESTRICT,
  session_id             TEXT NOT NULL,
  scope_kind             TEXT NOT NULL CHECK (scope_kind IN ('part','session')),
  scope_id               TEXT NOT NULL,
  acknowledged_at        TEXT NOT NULL,
  operator_id             TEXT NOT NULL CHECK (length(operator_id) > 0),
  evidence                TEXT NOT NULL CHECK (length(evidence) > 0),
  previous_delivered      INTEGER NOT NULL CHECK (previous_delivered = 1),
  previous_delivered_at   TEXT CHECK (previous_delivered_at IS NULL),
  applied_at              TEXT NOT NULL
) STRICT;

CREATE INDEX idx_audio_delivery_reconciliation_session
  ON audio_delivery_reconciliation_audit (session_id, applied_at);

CREATE TRIGGER audio_delivery_reconciliation_audit_no_update
BEFORE UPDATE ON audio_delivery_reconciliation_audit
BEGIN
  SELECT RAISE(ABORT, 'audio delivery reconciliation audit is immutable');
END;

CREATE TRIGGER audio_delivery_reconciliation_audit_no_delete
BEFORE DELETE ON audio_delivery_reconciliation_audit
BEGIN
  SELECT RAISE(ABORT, 'audio delivery reconciliation audit is immutable');
END;
