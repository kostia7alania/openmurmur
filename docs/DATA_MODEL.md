# Data model

Canonical store: local SQLite at `~/Library/Application Support/OpenMurmur/openmurmur.db`.

Schema: [`src/database/migrations/001_initial.sql`](../src/database/migrations/001_initial.sql).

## Connection settings

```sql
PRAGMA journal_mode = WAL;      -- readers never block the recorder
PRAGMA foreign_keys = ON;       -- referential integrity is enforced, not assumed
PRAGMA busy_timeout = 5000;     -- covers brief exclusive moments (checkpoint)
PRAGMA synchronous = NORMAL;    -- WAL-safe; full fsync is done explicitly for audio
```

All tables are `STRICT`. All timestamps are **UTC ISO-8601 strings**; all
durations are **milliseconds**.

### SQLite version

The target minimum is **3.53.4**. Node 26.7.0 bundles **3.53.4**, and
`openDatabase` still queries the actual runtime so the value is reported rather
than assumed. [ADR-0004](adr/0004-sqlite-driver.md) explains why the runtime is
tied to Node.

Note that `node:sqlite` uses the SQLite compiled into Node. Installing a newer
`sqlite3` via Homebrew does not change it.

## Tables

### `audio_sessions`

One row per logical session.

| Column | Notes |
| --- | --- |
| `session_id` | UUID, primary key. |
| `state` | `ACTIVE` → `FINALIZING` → `PROCESSING` → `DELIVERING` → `DONE`, or `REJECTED` / `FAILED`. |
| `started_at`, `ended_at` | UTC. `started_at` is backdated by the pre-roll. |
| `duration_ms` | From the **monotonic** span, not from the wall-clock difference. |
| `speech_ms` | Total speech, not elapsed time. |
| `part_count` | Number of physical files. |
| `rejection_reason` | `insufficient_speech`, `insufficient_words`, `asr_empty`, `asr_failed`. |
| `languages` | JSON array, filled after ASR. |

### `audio_parts`

One row per physical FLAC file.

| Column | Notes |
| --- | --- |
| `part_id` | UUID. |
| `session_id` | FK, `ON DELETE CASCADE`. |
| `part_index` | 0-based. `UNIQUE (session_id, part_index)`. |
| `path` | Absolute path. |
| `sha256` | Computed after the atomic rename. |
| `finalized` | 1 once closed, fsynced and renamed. **Retention requires this.** |
| `delivered` | 1 once Telegram confirmed *this exact part*. **Retention requires this.** |
| `deleted_at` | Set only after the file is really gone from disk. |

The three flags `finalized`, `sha256 IS NOT NULL` and `delivered` are checked
independently by retention rather than being inferred from session state,
because each represents a distinct way to lose a user's recording.

### `vad_segments`

Speech segments with millisecond offsets from session start. Used for Thai
segment timings, where no word-level aligner exists.

### `transcript_revisions`

**Immutable.** A re-run of ASR with a better model appends a new revision; the
previous one is demoted (`is_current = 0`), never overwritten.

A row belongs to *either* a session *or* an incoming Telegram file, enforced by
a `CHECK` constraint. `revision_number` is unique per owner.

This is deliberate: a model upgrade that turns out to be worse must be
recoverable, and the transcript is the artefact users keep forever.

### `transcript_segments`

| Column | Notes |
| --- | --- |
| `timestamp_source` | `aligner` \| `vad` \| `none`. |

`aligner` means the Qwen forced aligner produced real word-level timings (RU,
EN). `vad` means the timing came from segment/VAD boundaries. Thai never gets
`aligner`: no official aligner supports it, and presenting a guess as a
measurement would be worse than admitting the gap.

### `transcript_fts`

FTS5 with the **trigram** tokenizer, populated by an `AFTER INSERT` trigger.
Trigram is chosen over the default tokenizer because it handles Thai and Russian
substring search, where whitespace tokenization does not.

### `jobs`

| Column | Notes |
| --- | --- |
| `idempotency_key` | `UNIQUE`. Natural key, e.g. `asr:<sessionId>`. |
| `state` | `pending` → `leased` → `done` / `failed` / `dead`. |
| `lease_owner`, `lease_expires_at` | A crashed worker's job returns to the pool when the lease expires. |
| `attempts`, `max_attempts` | Exhausted jobs become `dead`, visible, not silently dropped. |
| `run_after` | Exponential backoff, capped at 15 minutes. |

Enqueue is `ON CONFLICT (idempotency_key) DO NOTHING`, which is what makes the
whole pipeline safe to re-drive after a crash.

### `telegram_outbox`

| Column | Notes |
| --- | --- |
| `delivery_part_id` | `UNIQUE`. Stable per logical delivery unit. |
| `ordinal` | Send order: `0` audio, `1` status, `5` alerts, `10` transcript, `20` report, `30` digest. |
| `state` | `pending` → `sending` → `sent` / `failed` / `dead`. |
| `telegram_message_id` | Recorded on success. |

The uniqueness of `delivery_part_id` is what makes at-least-once network
delivery safe: re-enqueueing after a crash is a primary-key conflict, not a
duplicate message.

### `telegram_updates` and `telegram_offset`

`telegram_updates.update_id` is Telegram's own id as the primary key, so a
redelivered update is rejected by the database rather than reprocessed.

`telegram_offset` is a single-row table (`CHECK (id = 1)`) holding the
`getUpdates` offset. Persisting it means a restart neither replays an hour of
updates nor skips the ones that arrived while down.

### `incoming_telegram_files`

Audio a user sent the bot. `file_uid` is **our** UUID — Telegram's filename
never reaches the filesystem. `telegram_unique_id` is `UNIQUE`, so resending the
same file is recognized.

`state`: `received` → `downloaded` → `validated` → `transcribed` → `delivered`,
or `rejected` / `failed`.

### `alert_state`

One row per alert identity. Proactive Telegram messages are sent only when
`active` changes, and never more often than the cooldown. Without this, a health
poll every 5 seconds would send hundreds of "disk is low" messages per hour.

### `health_events`, `summaries`, `digests`, `schema_migrations`

Append-only records, a JSON summary payload per session, one digest per local
date (`UNIQUE`, upserted), and the applied-migration ledger.

## Invariants

These are enforced by schema constraints, by code, or by both — and are covered
by tests.

1. A row in `audio_parts` with `finalized = 1` refers to a complete, valid FLAC
   at `path` (unless `deleted_at` is set).
2. `sha256` is non-null exactly when the file was hashed after its rename.
3. `delivered = 1` means Telegram acknowledged *that specific part*.
4. Exactly one `transcript_revisions` row per owner has `is_current = 1`.
5. A transcript revision belongs to a session **or** an incoming file, never
   both and never neither (`CHECK`).
6. `jobs.idempotency_key` is unique, so a unit of work exists at most once.
7. `telegram_outbox.delivery_part_id` is unique, so a message is sent at most
   once.
8. `telegram_updates.update_id` is unique, so an update is handled at most once.
9. `deleted_at` is set only after `rm` succeeded.
10. All timestamps are UTC.

## Retention eligibility

The single most important query in the system. Audio is deletable only when
**every** one of these holds:

```sql
p.finalized = 1                     -- the file was closed, fsynced, renamed
AND p.sha256 IS NOT NULL            -- and hashed
AND p.delivered = 1                 -- Telegram confirmed this exact part
AND s.state = 'DONE'                -- the whole session completed
AND s.ended_at <= :cutoff           -- and is older than the retention window
AND EXISTS (current transcript revision)
AND EXISTS (transcript outbox row in state 'sent')
AND NOT EXISTS (outbox row still pending/sending for this session)
AND NOT EXISTS (job still pending/leased for this session)
```

If any fact is missing, the file stays and `retention dry-run` reports **why**.

The LLM has no involvement. Eligibility is pure SQL over recorded facts.

## Concurrency

One writer. Write transactions use `BEGIN IMMEDIATE`, which takes the write lock
up front so two writers fail fast with `SQLITE_BUSY` instead of deadlocking
after doing work. No transaction performs I/O, so all of them are short.

Readers (health checks, `/status`, `openmurmur status`) use WAL snapshots and
never block the recorder.

## Migrations

Filename-ordered `.sql` files in `src/database/migrations/`, each applied in its
own transaction and recorded in `schema_migrations`. Re-running is a no-op,
which is what makes daemon restarts safe. Tested explicitly for idempotency.

Migrations are forward-only. There is no `down` — a rollback on a database
containing the user's only copy of a transcript is more dangerous than the
problem it solves.
