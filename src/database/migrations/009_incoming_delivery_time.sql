-- Incoming Telegram audio retention starts only after the complete transcript
-- manifest is acknowledged. NULL is deliberately fail-closed: legacy rows
-- without an exact manifest remain on disk.
ALTER TABLE incoming_telegram_files ADD COLUMN delivered_at TEXT;

CREATE VIEW incoming_delivery_manifest_proof AS
WITH relevant AS (
  SELECT i.file_uid,
         o.delivery_part_id,
         o.state,
         o.updated_at,
         substr(
           o.delivery_part_id,
           length('incoming:' || i.file_uid || ':') + 1
         ) AS part_suffix,
         CASE
           WHEN json_valid(o.payload) THEN
             CASE
               WHEN json_type(o.payload, '$') = 'object'
                AND json_type(o.payload, '$.type') = 'text'
                AND json_extract(o.payload, '$.type') = 'text'
                AND json_type(o.payload, '$.text') = 'text'
               THEN 1 ELSE 0
             END
           ELSE 0
         END AS valid_text_payload,
         CASE
           WHEN json_valid(o.payload)
            AND json_type(o.payload, '$.replyMarkup') IS NOT NULL
           THEN 1 ELSE 0
         END AS has_reply_markup,
         CASE
           WHEN json_valid(o.payload) THEN
             CASE
               WHEN json_type(o.payload, '$.replyMarkup') = 'object'
                AND json_type(o.payload, '$.replyMarkup.inline_keyboard') = 'array'
               THEN 1 ELSE 0
             END
           ELSE 0
         END AS is_final
    FROM incoming_telegram_files i
    JOIN telegram_outbox o
      ON o.kind = 'incoming_transcript'
     AND substr(
           o.delivery_part_id,
           1,
           length('incoming:' || i.file_uid || ':')
         ) = 'incoming:' || i.file_uid || ':'
   WHERE EXISTS (
         SELECT 1
           FROM transcript_revisions r
          WHERE r.incoming_file_id = i.file_uid
            AND r.is_current = 1
       )
), parsed AS (
  SELECT *,
         CASE
           WHEN length(part_suffix) > 0
            AND part_suffix NOT GLOB '*[^0-9]*'
            AND CAST(CAST(part_suffix AS INTEGER) AS TEXT) = part_suffix
            AND CAST(part_suffix AS INTEGER) > 0
           THEN 1 ELSE 0
         END AS is_canonical,
         CAST(part_suffix AS INTEGER) AS part_number
    FROM relevant
), manifest AS (
  SELECT file_uid,
         count(*) AS total,
         sum(CASE WHEN state = 'sent' THEN 1 ELSE 0 END) AS sent,
         sum(is_canonical) AS canonical,
         min(CASE WHEN is_canonical = 1 THEN part_number END) AS first_part,
         max(CASE WHEN is_canonical = 1 THEN part_number END) AS last_part,
         count(DISTINCT CASE WHEN is_canonical = 1 THEN part_number END) AS distinct_parts,
         sum(valid_text_payload) AS valid_text_payloads,
         sum(has_reply_markup) AS reply_markup_rows,
         sum(is_final) AS final_rows,
         max(CASE WHEN is_final = 1 THEN part_number END) AS final_part,
         max(updated_at) AS delivered_at
    FROM parsed
   GROUP BY file_uid
)
SELECT file_uid, delivered_at
  FROM manifest
 WHERE total > 0
   AND sent = total
   AND canonical = total
   AND first_part = 1
   AND last_part = total
   AND distinct_parts = total
   AND valid_text_payloads = total
   AND reply_markup_rows = 1
   AND final_rows = 1
   AND final_part = total;

UPDATE incoming_telegram_files
   SET delivered_at = (
         SELECT p.delivered_at
           FROM incoming_delivery_manifest_proof p
          WHERE p.file_uid = incoming_telegram_files.file_uid
       )
 WHERE state = 'delivered'
   AND delivered_at IS NULL
   AND EXISTS (
         SELECT 1
           FROM incoming_delivery_manifest_proof p
          WHERE p.file_uid = incoming_telegram_files.file_uid
       );

-- The daemon marks the final outbox row and the domain state in one outer
-- transaction. This trigger makes the retention proof part of that commit.
CREATE TRIGGER incoming_delivery_clock_on_state
AFTER UPDATE OF state ON incoming_telegram_files
WHEN new.state = 'delivered'
BEGIN
  UPDATE incoming_telegram_files
     SET delivered_at = CASE
           WHEN delivered_at IS NULL OR delivered_at < (
                  SELECT p.delivered_at
                    FROM incoming_delivery_manifest_proof p
                   WHERE p.file_uid = new.file_uid
                )
           THEN (
                  SELECT p.delivered_at
                    FROM incoming_delivery_manifest_proof p
                   WHERE p.file_uid = new.file_uid
                )
           ELSE delivered_at
         END
   WHERE file_uid = new.file_uid
     AND EXISTS (
           SELECT 1
             FROM incoming_delivery_manifest_proof p
            WHERE p.file_uid = new.file_uid
         );
END;

-- A legacy row may already say delivered while a final pending ACK arrives
-- after this migration. Re-evaluate exact proofs without advancing any clock
-- backwards.
CREATE TRIGGER incoming_delivery_clock_on_outbox
AFTER UPDATE OF state ON telegram_outbox
WHEN new.kind = 'incoming_transcript' AND new.state = 'sent'
BEGIN
  UPDATE incoming_telegram_files
     SET delivered_at = CASE
           WHEN delivered_at IS NULL OR delivered_at < (
                  SELECT p.delivered_at
                    FROM incoming_delivery_manifest_proof p
                   WHERE p.file_uid = incoming_telegram_files.file_uid
                )
           THEN (
                  SELECT p.delivered_at
                    FROM incoming_delivery_manifest_proof p
                   WHERE p.file_uid = incoming_telegram_files.file_uid
                )
           ELSE delivered_at
         END
   WHERE state = 'delivered'
     AND EXISTS (
           SELECT 1
             FROM incoming_delivery_manifest_proof p
            WHERE p.file_uid = incoming_telegram_files.file_uid
         );
END;

-- The manifest format predates a durable revision id in its payload. Freeze
-- the current pointer as soon as its first delivery row exists. The initial
-- append remains valid because it publishes the outbox rows only after this
-- insert, from TranscriptRepository's afterStored callback in the same commit.
CREATE TRIGGER incoming_manifest_revision_is_immutable
BEFORE INSERT ON transcript_revisions
WHEN new.incoming_file_id IS NOT NULL
 AND (
       EXISTS (
         SELECT 1
           FROM incoming_telegram_files i
          WHERE i.file_uid = new.incoming_file_id
            AND i.state = 'delivered'
       )
       OR EXISTS (
         SELECT 1
           FROM telegram_outbox o
          WHERE o.kind = 'incoming_transcript'
            AND substr(
                  o.delivery_part_id,
                  1,
                  length('incoming:' || new.incoming_file_id || ':')
                ) = 'incoming:' || new.incoming_file_id || ':'
       )
     )
BEGIN
  SELECT RAISE(ABORT, 'cannot supersede an incoming transcript revision after delivery starts');
END;

CREATE INDEX idx_incoming_retention_delivered_at
  ON incoming_telegram_files (deleted_at, delivered_at);
