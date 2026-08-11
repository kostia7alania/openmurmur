-- Retention for delivered audio starts at Telegram's acknowledgement, not at
-- the earlier session end. NULL is deliberately fail-closed: legacy rows with
-- no exact, unambiguous delivery manifest remain on disk.
ALTER TABLE audio_parts ADD COLUMN delivered_at TEXT;

CREATE TEMP TABLE audio_delivery_backfill (
  part_id       TEXT PRIMARY KEY,
  delivered_at TEXT NOT NULL
) STRICT;

INSERT INTO audio_delivery_backfill (part_id, delivered_at)
SELECT p.part_id, MAX(o.updated_at)
  FROM audio_parts p
  JOIN telegram_outbox o
    ON o.delivery_part_id = 'audio:' || p.part_id
    OR substr(
         o.delivery_part_id,
         1,
         length('audio:' || p.part_id || ':split')
       ) = 'audio:' || p.part_id || ':split'
 WHERE p.delivered = 1
 GROUP BY p.part_id
HAVING count(*) > 0
   AND sum(
         CASE
           WHEN o.kind = 'audio'
            AND o.session_id = p.session_id
            AND o.state = 'sent'
           THEN 1 ELSE 0
         END
       ) = count(*)
   AND (
         -- One source part is either one direct upload...
         (
           sum(CASE WHEN o.delivery_part_id = 'audio:' || p.part_id THEN 1 ELSE 0 END) = 1
           AND count(*) = 1
         )
         OR
         -- ...or one complete, contiguous split0..splitN manifest. Anything
         -- else is ambiguous and therefore cannot establish a deletion clock.
         (
           sum(CASE WHEN o.delivery_part_id = 'audio:' || p.part_id THEN 1 ELSE 0 END) = 0
           AND sum(
                 CASE
                   WHEN length(
                          substr(
                            o.delivery_part_id,
                            length('audio:' || p.part_id || ':split') + 1
                          )
                        ) > 0
                   AND substr(
                          o.delivery_part_id,
                          length('audio:' || p.part_id || ':split') + 1
                        ) NOT GLOB '*[^0-9]*'
                   AND CAST(
                         CAST(
                           substr(
                             o.delivery_part_id,
                             length('audio:' || p.part_id || ':split') + 1
                           ) AS INTEGER
                         ) AS TEXT
                       ) = substr(
                             o.delivery_part_id,
                             length('audio:' || p.part_id || ':split') + 1
                           )
                   THEN 1 ELSE 0
                 END
               ) = count(*)
           AND min(
                 CAST(
                   substr(
                     o.delivery_part_id,
                     length('audio:' || p.part_id || ':split') + 1
                   ) AS INTEGER
                 )
               ) = 0
           AND max(
                 CAST(
                   substr(
                     o.delivery_part_id,
                     length('audio:' || p.part_id || ':split') + 1
                   ) AS INTEGER
                 )
               ) = count(*) - 1
           AND count(
                 DISTINCT CAST(
                   substr(
                     o.delivery_part_id,
                     length('audio:' || p.part_id || ':split') + 1
                   ) AS INTEGER
                 )
               ) = count(*)
         )
       );

UPDATE audio_parts
   SET delivered_at = (
         SELECT b.delivered_at
           FROM audio_delivery_backfill b
          WHERE b.part_id = audio_parts.part_id
       )
 WHERE part_id IN (SELECT part_id FROM audio_delivery_backfill);

DROP TABLE audio_delivery_backfill;

CREATE INDEX idx_parts_retention_delivered_at
  ON audio_parts (deleted_at, delivered_at);
