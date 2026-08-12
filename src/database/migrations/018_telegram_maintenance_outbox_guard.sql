-- Telegram setup may replace the Keychain bot/chat pair only after proving
-- every existing delivery reached its original destination. While that
-- external Keychain commit is in progress, the durable maintenance owner is
-- the cross-process fence that keeps a scheduler from creating a row for the
-- old destination after the proof.
CREATE TRIGGER telegram_outbox_block_insert_during_maintenance
BEFORE INSERT ON telegram_outbox
WHEN EXISTS (
  SELECT 1
    FROM daemon_ownership
   WHERE ownership_id = 1
     AND process_birth GLOB 'openmurmur-maintenance:v1:*'
)
BEGIN
  SELECT RAISE(ABORT, 'Telegram outbox is paused during exclusive Telegram maintenance');
END;

-- A previously terminal row must not be made deliverable after credentials
-- have been proved safe to replace. Updates to sent remain allowed so an
-- independently established remote acknowledgement can reduce the backlog.
CREATE TRIGGER telegram_outbox_block_requeue_during_maintenance
BEFORE UPDATE OF state ON telegram_outbox
WHEN NEW.state IN ('pending', 'sending')
 AND OLD.state NOT IN ('pending', 'sending')
 AND EXISTS (
   SELECT 1
     FROM daemon_ownership
    WHERE ownership_id = 1
      AND process_birth GLOB 'openmurmur-maintenance:v1:*'
 )
BEGIN
  SELECT RAISE(ABORT, 'Telegram outbox is paused during exclusive Telegram maintenance');
END;
