-- A sender may return after startup recovery has re-queued and re-claimed its
-- row. Attempts cannot fence that race because a no-fault defer deliberately
-- refunds an attempt, so claims need a separate monotonic generation.
ALTER TABLE telegram_outbox
  ADD COLUMN claim_generation INTEGER NOT NULL DEFAULT 0
    CHECK (claim_generation >= 0);
