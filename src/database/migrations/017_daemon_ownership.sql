-- The PID file is an operator-facing mirror. SQLite is the atomic ownership
-- authority so two concurrent restarts cannot both replace one stale file.
CREATE TABLE daemon_ownership (
  ownership_id       INTEGER PRIMARY KEY CHECK (ownership_id = 1),
  daemon_pid         INTEGER NOT NULL CHECK (daemon_pid > 0 AND daemon_pid <= 9007199254740991),
  daemon_root        TEXT NOT NULL CHECK (length(trim(daemon_root)) > 0),
  daemon_started_at  TEXT NOT NULL CHECK (length(trim(daemon_started_at)) > 0),
  process_birth      TEXT NOT NULL CHECK (length(trim(process_birth)) > 0),
  claimed_at         TEXT NOT NULL CHECK (length(trim(claimed_at)) > 0)
) STRICT;
