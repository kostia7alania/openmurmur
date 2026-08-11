# Data model

Canonical store: local SQLite at `~/Library/Application Support/OpenMurmur/openmurmur.db`.

Schema: [`src/database/migrations/`](../src/database/migrations/).

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
| `part_count` | Number of successfully finalized archive parts. After a partial encoder/finalization failure this is the surviving deliverable count, not the number of attempted `audio_parts` rows. |
| `rejection_reason` | `insufficient_speech`, `insufficient_words`, `asr_empty`; terminal failures currently use `asr_failed` or `audio_finalize_failed` in the same diagnostic column. |
| `languages` | JSON array, filled after ASR. |
| `capture_host` | Daemon hostname captured when the live session opened; nullable only for legacy rows. |
| `capture_timezone` | Resolved IANA timezone captured with the session so its original wall time remains reproducible; nullable for legacy rows. |

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
| `delivered_at` | UTC time of the last acknowledgement in this part's exact direct or split manifest. NULL means the time is not proven and blocks retention. |
| `deleted_at` | Set only after the file is really gone from disk. |

The facts `finalized`, `sha256 IS NOT NULL`, `delivered` and `delivered_at` are
checked independently by retention rather than being inferred from session
state, because each represents a distinct way to lose a user's recording.
`delivered_at` is written only for one unambiguous manifest: either a single
direct upload or a contiguous `split0..splitN` set whose every row is `sent` and
belongs to the same session. Legacy absence or ambiguity stays NULL.

An operator may release that legacy hold only with `pnpm openmurmur delivery
reconcile apply`: one selected part or session, an exact UTC acknowledgement,
an operator id and a non-secret evidence reference are required. The command
never derives the acknowledgement from session, outbox or filesystem times. It
atomically writes `delivered_at` and one immutable
`audio_delivery_reconciliation_audit` row containing the supplied fact, prior
delivery state, scope and apply time. Session scope uses the supplied final
session-audio ACK conservatively for every previewed held part. A stale preview,
an ACK before recording ended, or an ACK in the future aborts the whole commit.

Atomic rename necessarily precedes the SQLite update. If the process dies in
that gap, startup scans non-finalized part rows whose archive path now exists,
hashes the complete published FLAC, fills size/SHA-256/finalized, then reconciles
the session's durable `deliver_audio` and `asr` jobs. A missing archive path is
never treated as proof that a recording was safely delivered or deletable.

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

`forced_language` is null when Qwen performed automatic language identification.
A value records the single language selected by config or `/settings`; it must
not be presented as an independently detected language.

### `asr_preferences`

One host-local singleton row. Absence means the legacy config fallback applies;
an explicit null selects Auto; `th`, `ru`, `en` or `zh` selects one forced
language for future jobs. The job and immutable transcript revision snapshot
the effective model-language name, so later button presses cannot alter a retry.

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
| `idempotency_key` | `UNIQUE`. Natural key, e.g. `deliver-audio:<sessionId>` or `asr:<sessionId>`. |
| `state` | `pending` → `leased` → `done`; a failed lease returns to `pending` with backoff until exhaustion changes it to `dead`. |
| `lease_owner`, `lease_expires_at` | A crashed worker's job returns to the pool when the lease expires. |
| `attempts`, `max_attempts` | Exhausted jobs become `dead`, visible, not silently dropped. |
| `run_after` | Exponential backoff, capped at 15 minutes. |

Enqueue is `ON CONFLICT (idempotency_key) DO NOTHING`, which is what makes the
whole pipeline safe to re-drive after a crash.

An operator may explicitly return one supported `dead` job to `pending` with
`openmurmur jobs retry JOB_ID`. This resets its attempt budget only for that
selected row. Legacy kinds without a daemon handler are refused rather than
reported as runnable.

Recorded sessions use staged jobs rather than one serial delivery job:
`deliver_audio` is eligible alongside `asr`; ASR creates
`deliver_transcript` and `summarize`; summarize creates `deliver_report`.
Summarize and report jobs carry the immutable transcript revision in both their
payload and idempotency key, so a reclaimed job cannot drift to a newer current
revision.
Session finalization and the first two job inserts share one transaction, so a
persisted `PROCESSING` session cannot exist without its audio and ASR work.

### `telegram_outbox`

| Column | Notes |
| --- | --- |
| `delivery_part_id` | `UNIQUE`. Stable per logical delivery unit. |
| `ordinal` | Delivery-stage metadata retained for stable rows; it does not let a newly queued row overtake older ready work. |
| `state` | `pending` → `sending` → `sent` / `failed` / `dead`. |
| `telegram_message_id` | Recorded on success. |

The claim query selects `pending` rows whose `run_after` is ready, FIFO by
creation time and insertion order. `delivery_part_id` makes re-enqueueing the
same logical unit a conflict. It cannot make the Telegram network effect
exactly-once: a crash after Telegram accepts a request but before `sent` commits
causes a retry and may produce a visible duplicate.

Lifecycle status rows use stable keys
`session-status:<started|finalized|rejected|failed>:<sessionId>`. The recorder
enqueues them after the corresponding session transition; no Telegram I/O
occurs there. If only some rotated parts finalize, the normal `finalized` row
truthfully says that only the surviving parts will be uploaded. If none
finalize, the session becomes `FAILED`, queues the `failed` row, and creates no
audio or ASR work.

Session content uses `transcript:<sessionId>:1` for an inline transcript or
`transcript-md:<sessionId>` for its document. Reports use
`report:<sessionId>:<revisionId>`; when a long report also has a compact
collapsed summary, that companion row is
`report-summary:<sessionId>:<revisionId>`. Replaying a delivery stage therefore
cannot create a second logical copy of either presentation.

Long reports and digests are document payloads pointing only at trusted
`<sessionId>.<revisionId>.report.md` and `digest-YYYY-MM-DD.md` paths. Telegram's
user-facing report filename remains `<sessionId>.report.md`.

### `telegram_updates` and `telegram_offset`

`telegram_updates` is keyed by `(bot_scope, update_id)`. `bot_scope` is a
non-secret fingerprint of the Keychain credential; `update_id` is Telegram's
own id within that bot. A row is first recorded as unhandled, then marked
handled only after its durable action exists. Redelivery of a handled update is
ignored; an unhandled row is replayed so a crash between deduplication and
enqueue cannot silently skip it. The work created during replay uses the same
bot scope in its stable idempotency key.

`telegram_offset` holds one `getUpdates` cursor per `bot_scope`. Persisting it
means a restart neither replays an hour of updates nor skips the ones that
arrived while down, while rebinding the same data root to a different bot
cannot inherit the previous bot's cursor.

### `incoming_telegram_files`

Audio a user sent the bot. `file_uid` is **our** UUID — Telegram's filename
never reaches the filesystem. `telegram_unique_id` is `UNIQUE`, so resending the
same file is recognized.

Provenance is durable rather than reconstructed during delivery: `bot_scope`
plus `update_id` and the existing `message_id` identify the request;
`telegram_source` distinguishes direct from forwarded input;
`attachment_type` records voice/audio/document/video-note; `telegram_message_at`
is when the message reached the bot chat, while nullable `original_sent_at` is
Telegram's `forward_origin.date`; `daemon_host` identifies the claiming daemon.
`claimed_filename` is untrusted display metadata only. Renderers bound and
escape it; it never controls routing or a command. Provenance columns remain
NULL on legacy rows and are displayed as unknown rather than backfilled.

`state`: `received` → `downloaded` → `validated` → `transcribed` → `delivered`,
or `rejected` / `failed`.

`quarantine_path` and `normalized_path` are the durable owners of generated
incoming artifacts. Startup scans only strict OpenMurmur UUID names inside
`quarantine/`. An artifact whose UID is absent from every owner is removed only
after ownership is read again immediately before unlink. Every present file UID
protects all of its generated path variants, covering crashes after publication
but before a NULL or older path is updated. Invalid or out-of-root ownership
makes the whole cleanup fail closed; session audio is never scanned.

`delivered_at` is the last Telegram acknowledgement in one exact, contiguous
incoming-transcript manifest. Every row must be sent and have the expected text
payload; exactly the final row carries the settings keyboard. Missing or
ambiguous legacy proof leaves this field NULL and therefore blocks retention.
Once a delivery manifest exists, its current transcript revision cannot be
superseded, so an acknowledgement cannot become evidence for different text.

### `alert_state`

One row per alert identity. Proactive Telegram messages are sent when `active`
changes and no more often than the cooldown. Set-valued failures such as dead
jobs also persist a fingerprint: an unchanged set is silent, while a changed
failure generation produces one new edge. Alert state and its durable outbox
row are written in one transaction, so a failed enqueue cannot consume the
notification. Without this, a health poll every 5 seconds would send hundreds
of duplicate messages.

### `health_events`, `summaries`, `digests`, `schema_migrations`

Append-only records, one live JSON summary payload per immutable transcript
revision, one digest per local date (`UNIQUE`, upserted), and the
applied-migration ledger. Migration 012 archives ambiguous legacy duplicates in
`summary_revision_conflicts` before enforcing revision uniqueness; no payload
is discarded. Each summary row is bound to one immutable
`transcript_revisions.revision_id`. Its optional
`claimEvidence` entries name a normalized summary field/item and revision-local
segment indexes. The indexes are bounded both before storage and again before
delivery; reports name the revision and enumerate those exact source segments.
They remain model-reported provenance, never a retention or routing fact.

Digest day bounds use the configured `digest.timezone`, including IANA-zone DST
transitions. Digest storage and enqueue of `digest:<date>` share one transaction,
so the daemon and CLI/launchd safety net converge on one delivery unit. A long
digest document uses the trusted path `digest-YYYY-MM-DD.md`. Automatic digests
select only `DONE` sessions and defer while a session already belonging to that
date is unfinished. The stable row is a cutoff: sessions starting after it was
stored require the late-session revision policy tracked in AR-08.

## Invariants

These are enforced by schema constraints, by code, or by both — and are covered
by tests.

1. A row in `audio_parts` with `finalized = 1` refers to a complete, valid FLAC
   at `path` (unless `deleted_at` is set).
2. `sha256` is non-null exactly when the file was hashed after its rename.
3. `delivered = 1` means Telegram acknowledged *that specific part*.
4. `delivered_at` is the last acknowledgement in its proven direct/split audio
   manifest and never moves backwards.
5. Exactly one `transcript_revisions` row per owner has `is_current = 1`.
6. A transcript revision belongs to a session **or** an incoming file, never
   both and never neither (`CHECK`).
7. `jobs.idempotency_key` is unique, so a unit of work exists at most once.
8. `telegram_outbox.delivery_part_id` is unique, so a logical delivery unit is
   enqueued at most once. Telegram acceptance remains at-least-once across the
   network/SQLite acknowledgement window.
9. `(telegram_updates.bot_scope, update_id)` is unique; handled updates are
   ignored and unhandled updates are safely re-driven through bot-scoped
   idempotent work keys.
10. `deleted_at` is set only after `rm` succeeded.
11. All timestamps are UTC.
12. Incoming-audio retention starts only from a complete transcript-manifest
    acknowledgement; NULL or ambiguous delivery time retains the source file.

## Retention eligibility

The single most important query in the system. Audio is deletable only when
**every** one of these holds:

```sql
p.finalized = 1                     -- the file was closed, fsynced, renamed
AND p.sha256 IS NOT NULL            -- and hashed
AND p.delivered = 1                 -- Telegram confirmed this exact part
AND p.delivered_at <= :cutoff       -- the window elapsed after its last ACK
AND s.state = 'DONE'                -- the whole session completed
AND s.ended_at IS NOT NULL           -- its recording facts are complete
AND EXISTS (current transcript revision)
AND EXISTS (transcript outbox row in state 'sent')
AND NOT EXISTS (outbox row still pending/sending for this session)
AND NOT EXISTS (job still pending/leased for this session)
```

If any fact is missing, the file stays and `retention dry-run` reports **why**.

An `insufficient_speech` rejection happens before upload, so its shorter cleanup
window starts at `audio_sessions.ended_at`. `asr_empty` and
`insufficient_words` happen after audio-first delivery; those parts use the
ordinary delivered-audio window from `delivered_at` instead.

The LLM has no involvement. Eligibility is pure SQL over recorded facts.

## Concurrency

One daemon owns a data root. It claims the PID file with exclusive creation and
records the root and process start metadata; `status` and `stop` verify live
process identity before trusting it. This prevents a second daemon from becoming
another database writer and prevents a stale reused PID from being signalled.

Inside that daemon, one writer at a time. Write transactions use
`BEGIN IMMEDIATE`, which takes the write lock up front so two writers fail fast
with `SQLITE_BUSY` instead of deadlocking after doing work. No transaction
performs I/O, so all of them are short.

Readers (health checks, `/status`, `pnpm openmurmur status`) use WAL snapshots
and never block the recorder.

## Migrations

Filename-ordered `.sql` files in `src/database/migrations/`, each applied in its
own transaction and recorded in `schema_migrations`. Re-running is a no-op,
which is what makes daemon restarts safe. Tested explicitly for idempotency.

Migrations are forward-only. There is no `down` — a rollback on a database
containing the user's only copy of a transcript is more dangerous than the
problem it solves.
