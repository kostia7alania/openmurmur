-- Older builds kept the current pointer consistent in TranscriptRepository,
-- but direct SQL could leave multiple current revisions. Preserve every
-- immutable revision and deterministically keep the newest numbered one.
UPDATE transcript_revisions AS stale
   SET is_current = 0
 WHERE stale.is_current = 1
   AND stale.session_id IS NOT NULL
   AND EXISTS (
         SELECT 1
           FROM transcript_revisions AS newer
          WHERE newer.session_id = stale.session_id
            AND newer.is_current = 1
            AND newer.revision_number > stale.revision_number
       );

UPDATE transcript_revisions AS stale
   SET is_current = 0
 WHERE stale.is_current = 1
   AND stale.incoming_file_id IS NOT NULL
   AND EXISTS (
         SELECT 1
           FROM transcript_revisions AS newer
          WHERE newer.incoming_file_id = stale.incoming_file_id
            AND newer.is_current = 1
            AND newer.revision_number > stale.revision_number
       );

CREATE UNIQUE INDEX idx_transcript_current_session
  ON transcript_revisions (session_id)
  WHERE session_id IS NOT NULL AND is_current = 1;

CREATE UNIQUE INDEX idx_transcript_current_incoming
  ON transcript_revisions (incoming_file_id)
  WHERE incoming_file_id IS NOT NULL AND is_current = 1;
