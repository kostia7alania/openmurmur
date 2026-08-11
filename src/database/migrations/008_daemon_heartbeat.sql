CREATE TABLE daemon_heartbeat (
  heartbeat_id              INTEGER PRIMARY KEY CHECK (heartbeat_id = 1),
  daemon_pid                INTEGER NOT NULL CHECK (daemon_pid > 0),
  daemon_started_at         TEXT NOT NULL,
  recorder_running          INTEGER NOT NULL CHECK (recorder_running IN (0, 1)),
  session_state             TEXT NOT NULL,
  last_source_frame_age_ms  INTEGER CHECK (
                              last_source_frame_age_ms IS NULL
                              OR last_source_frame_age_ms >= 0
                            ),
  processing_lag_ms         INTEGER CHECK (
                              processing_lag_ms IS NULL
                              OR processing_lag_ms >= 0
                            ),
  updated_at                TEXT NOT NULL
) STRICT;
