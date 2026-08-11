-- Releases before revision-scoped summarize jobs could race and leave more than
-- one result for a revision. Preserve every non-canonical row for audit/recovery
-- before enforcing the invariant; the earliest committed summary remains live.
CREATE TABLE IF NOT EXISTS summary_revision_conflicts (
  summary_id            TEXT PRIMARY KEY,
  session_id            TEXT,
  incoming_file_id      TEXT,
  revision_id           TEXT NOT NULL,
  engine                TEXT NOT NULL,
  model                 TEXT NOT NULL,
  payload               TEXT NOT NULL,
  created_at            TEXT NOT NULL,
  archived_at           TEXT NOT NULL,
  archive_reason        TEXT NOT NULL
) STRICT;

INSERT INTO summary_revision_conflicts
  (summary_id, session_id, incoming_file_id, revision_id, engine, model, payload,
   created_at, archived_at, archive_reason)
SELECT duplicate.summary_id, duplicate.session_id, duplicate.incoming_file_id,
       duplicate.revision_id, duplicate.engine, duplicate.model, duplicate.payload,
       duplicate.created_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
       'duplicate_revision_before_012'
  FROM summaries AS duplicate
 WHERE EXISTS (
       SELECT 1
         FROM summaries AS winner
        WHERE winner.revision_id = duplicate.revision_id
          AND (winner.created_at < duplicate.created_at
               OR (winner.created_at = duplicate.created_at
                   AND winner.summary_id < duplicate.summary_id))
 );

DELETE FROM summaries
 WHERE summary_id IN (SELECT summary_id FROM summary_revision_conflicts);

-- One immutable transcript revision has at most one live summary. Reclaimed
-- workers may both finish model calls, but only the first committed result wins.
CREATE UNIQUE INDEX idx_summaries_revision
  ON summaries (revision_id);
