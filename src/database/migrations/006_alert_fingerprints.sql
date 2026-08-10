ALTER TABLE alert_state ADD COLUMN fingerprint TEXT;

-- Older releases folded every exhausted job into the ASR backlog alert. Avoid
-- emitting a false "ASR queue recovered" edge when the new dead_jobs alert
-- takes ownership of that condition on the first poll after this migration.
UPDATE alert_state
   SET active = 0,
       last_sent_at = NULL
 WHERE alert_id = 'asr_backlog';

UPDATE telegram_outbox
   SET state = 'failed',
       last_error = 'superseded by dedicated dead-job diagnostics'
 WHERE kind = 'alert'
   AND state IN ('pending', 'sending')
   AND delivery_part_id GLOB 'alert:asr_backlog:*';
