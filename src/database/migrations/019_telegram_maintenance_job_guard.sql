-- A job can be latent Telegram output even before it creates an outbox row.
-- Credential replacement runs under the durable maintenance owner, so keep
-- cross-process recovery/retry from inserting such work after setup proves the
-- current backlog empty. Digest and retention are scheduler-only legacy jobs
-- and cannot publish through the daemon job pipeline.
CREATE TRIGGER telegram_jobs_block_insert_during_maintenance
BEFORE INSERT ON jobs
WHEN NEW.state IN ('pending', 'leased', 'dead')
 AND NEW.kind NOT IN ('digest', 'retention')
 AND EXISTS (
   SELECT 1
     FROM daemon_ownership
    WHERE ownership_id = 1
      AND process_birth GLOB 'openmurmur-maintenance:v1:*'
 )
BEGIN
  SELECT RAISE(ABORT, 'Telegram-producing jobs are paused during exclusive Telegram maintenance');
END;

-- Completion/failure may reduce the backlog while maintenance holds the root,
-- but no terminal or scheduler-only row may become live Telegram work.
CREATE TRIGGER telegram_jobs_block_requeue_during_maintenance
BEFORE UPDATE OF state, kind ON jobs
WHEN NEW.state IN ('pending', 'leased', 'dead')
 AND NEW.kind NOT IN ('digest', 'retention')
 AND (NEW.state <> OLD.state OR NEW.kind <> OLD.kind)
 AND EXISTS (
   SELECT 1
     FROM daemon_ownership
    WHERE ownership_id = 1
      AND process_birth GLOB 'openmurmur-maintenance:v1:*'
 )
BEGIN
  SELECT RAISE(ABORT, 'Telegram-producing jobs are paused during exclusive Telegram maintenance');
END;
