# Backlog

Every item carries: epic, user value, scope, non-goals, acceptance criteria,
dependencies, risk, estimate (S/M/L), release, tests.

**Status legend:** ✅ done and verified · 🟡 implemented, not verified end-to-end ·
⬜ not started

---

## P0 — working MVP

### P0-01 ✅ Repository bootstrap

- **Epic:** Foundation
- **User value:** A stranger can clone the repo and get a working environment.
- **Scope:** Directory layout, licence, contribution docs, `.gitignore`,
  `bootstrap` / `doctor` scripts, `.nvmrc`.
- **Non-goals:** Homebrew tap, published packages, release automation.
- **Acceptance:** `git clone && ./scripts/bootstrap` produces an installable
  tree on a clean Apple Silicon Mac with Homebrew.
- **Dependencies:** none · **Risk:** low · **Estimate:** S · **Release:** 0.1.0
- **Tests:** `scripts/doctor` exits 0; shell syntax checked in CI.

### P0-02 ✅ TypeScript 7 control plane

- **Epic:** Foundation
- **User value:** A codebase that catches its own mistakes before the user does.
- **Scope:** Node 26, TypeScript 7.0.2, ESM only, `strict` plus
  `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
  `verbatimModuleSyntax`, `erasableSyntaxOnly`; Biome; Node's built-in test
  runner, `fetch`, `parseArgs`, `node:sqlite`.
- **Non-goals:** Any CommonJS. Any tool requiring the TypeScript 6 compiler API.
- **Acceptance:** `pnpm check` (typecheck + lint + tests) exits 0.
- **Dependencies:** P0-01 · **Risk:** medium (TS 7 has no stable compiler API,
  so `typescript-eslint` is unusable — Biome is used instead) · **Estimate:** M
- **Tests:** CI runs typecheck, lint and the full suite on macOS.

### P0-03 ✅ Config and paths

- **Epic:** Foundation
- **User value:** Every threshold is adjustable, and a typo is reported rather
  than silently ignored.
- **Scope:** Typed schema with defaults, deep merge, validation that rejects
  unknown keys, path resolution under one root, `OPENMURMUR_HOME` override.
- **Non-goals:** Secrets in config — structurally excluded.
- **Acceptance:** An unknown key or a wrong type produces a `ConfigError` naming
  the exact path; all problems are reported at once.
- **Dependencies:** P0-02 · **Risk:** low · **Estimate:** S
- **Tests:** Config and path tests include a schema walk proving no field can
  hold a secret.

### P0-04 ✅ SQLite migrations

- **Epic:** Storage
- **User value:** Data survives upgrades and crashes.
- **Scope:** 16 tables, WAL, foreign keys, busy timeout, FTS5 trigram,
  idempotent filename-ordered migrations, runtime version check.
- **Non-goals:** Down-migrations (a rollback on a database holding the user's
  only transcript is worse than the problem).
- **Acceptance:** Re-running migrations applies nothing and loses nothing; the
  actual SQLite runtime version is reported, not assumed.
- **Dependencies:** P0-02 · **Risk:** low (Node 26.7.0 bundles the 3.53.4
  target — see ADR-0004) · **Estimate:** M
- **Tests:** Database tests cover migrations, transaction rollback,
  idempotency, FK enforcement and transcript/job persistence.

### P0-05 ✅ FFmpeg capture

- **Epic:** Capture
- **User value:** Recording works without an Apple Developer certificate.
- **Scope:** `CaptureBackend` interface, AVFoundation via FFmpeg, frame-aligned
  PCM with carry-over across pipe reads, TCC-aware error classification.
- **Non-goals:** Native Swift helper (P1-01).
- **Acceptance:** `openmurmur capture test` records 5 s and reports levels; a
  permission denial produces an actionable message naming System Settings.
- **Dependencies:** P0-03 · **Risk:** medium (TCC is fragile) · **Estimate:** M
- **Tests:** Argument construction asserted; device-table parsing tested;
  live capture not exercised in CI.

### P0-06 🟡 Streaming Silero VAD

- **Epic:** Capture
- **User value:** Sessions open on speech, not on a fan or traffic.
- **Scope:** ONNX Runtime, 512-sample frames, explicit LSTM state and 64-sample
  context handling, segment assembly with a 300 ms bridge across in-sentence
  gaps.
- **Non-goals:** Deletion decisions — VAD never decides what to delete.
- **Acceptance:** Speech in a noisy room is detected; a television alone does
  not sustain a session past the minimum-speech gate.
- **Dependencies:** P0-05, P0-11 · **Risk:** medium · **Estimate:** M
- **Tests:** Segment assembly fully tested in Python (7 tests). The ONNX model
  is not in the CI-installed subset; a historical same-machine smoke run is
  recorded in `docs/DEPENDENCIES.md`, but it was not repeated on this revision.

### P0-07 ✅ Sessionizer state machine

- **Epic:** Sessionizer
- **User value:** Recordings correspond to things that were actually said.
- **Scope:** Pure state machine emitting intents; monotonic-clock durations.
- **Non-goals:** Any I/O inside the machine.
- **Acceptance:** All transitions behave per `docs/SESSIONIZER.md`; a wall-clock
  jump cannot open or close a session.
- **Dependencies:** P0-03 · **Risk:** low · **Estimate:** M
- **Tests:** 29 tests with a fake clock.

### P0-08 ✅ Five-second pre-roll

- **Epic:** Sessionizer
- **User value:** You hear the whole sentence, not its second half.
- **Scope:** Ring buffer in the machine (durations) and in the recorder (PCM);
  session start backdated by the pre-roll length.
- **Non-goals:** Persisting IDLE audio.
- **Acceptance:** Pre-roll is non-empty and never exceeds the configured window;
  rotated parts get none.
- **Dependencies:** P0-07 · **Risk:** low · **Estimate:** S
- **Tests:** 3 pre-roll tests.

### P0-09 ✅ Sixty-second silence close

- **Epic:** Sessionizer
- **User value:** A pause does not fragment one conversation into ten sessions.
- **Scope:** `SILENCE_GRACE` with a configurable timeout; the timer resets on
  every return of speech.
- **Acceptance:** Speech at 59 s continues the same session; 60 s finalizes.
- **Dependencies:** P0-07 · **Risk:** low · **Estimate:** S
- **Tests:** Fake-clock tests cover the exact timeout boundary and repeated
  near-timeout speech returns.

### P0-10 ✅ Fifteen-minute physical rotation

- **Epic:** Sessionizer
- **User value:** No single enormous file; every part fits Telegram.
- **Scope:** Rotation while `ACTIVE` only; shared `session_id`; consecutive part
  numbering; atomic close of each part.
- **Non-goals:** Splitting the logical session.
- **Acceptance:** Parts rotate at the configured bound and share one session id;
  worst-case part size stays well inside 50 MB.
- **Dependencies:** P0-07 · **Risk:** low · **Estimate:** M
- **Tests:** 5 rotation tests.

### P0-11 🟡 Qwen MLX persistent worker

- **Epic:** ASR
- **User value:** On-device transcription that does not reload a 1.7B model per
  file.
- **Scope:** NDJSON protocol, long-lived process, lazy model load, crash
  recovery, per-request timeouts, RU/EN/TH with automatic detection, aligner
  timestamps for RU/EN only.
- **Non-goals:** Any cloud fallback. Invented Thai word timings.
- **Acceptance:** A real recording transcribes correctly in all three languages;
  a missing model produces an actionable error naming the `uv sync` command.
- **Dependencies:** P0-02 · **Risk:** high (model behaviour unverified here)
  · **Estimate:** L
- **Tests:** Protocol framing, dispatch, error paths and result normalization —
  36 Python tests, all without MLX. A historical same-machine inference smoke
  run is recorded in `docs/DEPENDENCIES.md`; the current revision still needs
  an end-to-end rerun.

### P0-12 ✅ Transcript revisions

- **Epic:** ASR
- **User value:** A model upgrade that turns out worse is recoverable.
- **Scope:** Append-only revisions, `is_current` pointer, per-segment timestamp
  provenance.
- **Acceptance:** A second ASR run appends rather than overwrites; the original
  text is still readable.
- **Dependencies:** P0-04 · **Risk:** low · **Estimate:** S
- **Tests:** Revision tests cover append-only history, current-pointer changes,
  segment provenance and transaction rollback.

### P0-13 🟡 Ollama structured summary

- **Epic:** LLM
- **User value:** A short report instead of a wall of text.
- **Scope:** JSON Schema constrained decoding, `temperature = 0`, `think=false`,
  localhost only, validation and clamping of the result.
- **Non-goals:** Any capability beyond text→JSON.
- **Acceptance:** A real transcript yields a useful summary; Ollama being absent
  degrades the report without blocking delivery.
- **Dependencies:** P0-12 · **Risk:** medium · **Estimate:** M
- **Tests:** Schema parsing, clamping and injection fencing are tested with the
  fake backend. `docs/DEPENDENCIES.md` records an earlier same-machine Ollama
  smoke run; the complete live path was not repeated on this revision.

### P0-14 🟡 Telegram onboarding

- **Epic:** Telegram
- **User value:** Connected in under two minutes without looking up a chat ID.
- **Scope:** Hidden token prompt, `getMe` verification, chat discovery via
  `/start`, Keychain storage, offset persistence, test message.
- **Non-goals:** Token via argv, env, config or plist.
- **Acceptance:** `openmurmur setup telegram` completes and a test message
  arrives.
- **Dependencies:** P0-04 · **Risk:** low · **Estimate:** M
- **Tests:** Redaction and Keychain isolation tested. **The interactive flow
  needs a real bot token and was not run.**

### P0-15 ✅ Source FLAC delivery

- **Epic:** Telegram
- **User value:** The lossless original, not a re-encode.
- **Scope:** `sendDocument` per part; live size re-check; lossless `-c copy`
  splitting when over 50 MB.
- **Non-goals:** Sending a derived MP3/M4A instead of the source.
- **Acceptance:** Every chunk is under the limit and still FLAC.
- **Dependencies:** P0-10 · **Risk:** low · **Estimate:** M
- **Tests:** Real-ffmpeg split test asserting size and codec of every chunk.

### P0-16 ✅ Transcript delivery

- **Epic:** Telegram
- **User value:** Readable transcripts regardless of length.
- **Scope:** Collapsed expandable quote under 3500 chars; one `.md` attachment
  above it; HTML escaping; grapheme-safe inline formatting.
- **Acceptance:** No message exceeds 4096 UTF-16 code units; no surrogate pair
  is split; an inline message carries the session id; an over-limit transcript
  produces one complete, trusted-name document and no duplicate chat chunks.
- **Dependencies:** P0-12 · **Risk:** low · **Estimate:** M
- **Tests:** Formatting tests cover HTML escaping, emoji, Thai, combining marks,
  grapheme-safe splitting and timed transcript blocks.

### P0-17 ✅ Structured report delivery

- **Epic:** Telegram
- **User value:** Decisions and tasks at a glance.
- **Scope:** The documented report format; empty sections omitted; every
  speech-derived value escaped.
- **Dependencies:** P0-13 · **Risk:** low · **Estimate:** S
- **Tests:** Report tests cover the documented shape, omitted empty sections,
  HTML injection and safe Markdown file rendering.

### P0-18 ✅ `/status`

- **Epic:** Telegram · **Estimate:** S · **Risk:** low
- **Scope:** Daemon host name, recorder state, last frame age, current session,
  ASR backlog, outbox depth, last delivery, free disk, model status, version.
- **Acceptance:** Output matches the documented format.
- **Dependencies:** P0-14 · **Tests:** Renderer tested; live command not run.

### P0-19 ✅ `/health`

- **Epic:** Health · **Estimate:** S · **Risk:** low
- **Scope:** `OK`, or one `WARN:`/`ERROR:` line per unhealthy component.
- **Acceptance:** A healthy system returns exactly `OK`.
- **Dependencies:** P0-23 · **Tests:** Health tests cover healthy, degraded and
  failed component combinations, including exhausted work.

### P0-20 🟡 Incoming Telegram audio transcription

- **Epic:** Telegram
- **User value:** Transcribe a voice note by forwarding it to the bot.
- **Scope:** The full validation pipeline in `docs/TELEGRAM.md`.
- **Non-goals:** Working around the 20 MB `getFile` limit unsafely.
- **Acceptance:** A voice message returns a transcript; an oversize file returns
  an explanation naming Telegram as the source of the limit.
- **Dependencies:** P0-11, P0-14 · **Risk:** high (largest untrusted-input
  surface) · **Estimate:** L
- **Tests:** 9 path-traversal cases, codec/duration/corruption validation
  against real ffmpeg-generated files, allowlisting, deduplication. **The live
  download path needs a real bot.**

### P0-21 🟡 launchd templates

- **Epic:** Operations
- **User value:** Runs in the background, restarts on login.
- **Scope:** Three plist templates plus install/uninstall scripts.
- **Acceptance:** `plutil -lint` passes; the agent starts on login.
- **Dependencies:** P0-05 · **Risk:** medium (TCC under launchd) · **Estimate:** S
- **Tests:** plist validation in CI. **Not loaded into a real login session.**

### P0-22 ✅ Retention dry-run

- **Epic:** Retention
- **User value:** Certainty that nothing needed will be deleted.
- **Scope:** Eligibility proof, blocked-file reporting, `apply` executing exactly
  the printed plan.
- **Non-goals:** Any LLM involvement.
- **Acceptance:** Undelivered audio is never listed; delivered audio ages from
  the last proven Telegram acknowledgement for its exact direct/split manifest,
  never from session end; missing or ambiguous legacy proof keeps the file;
  every retained file has a stated reason.
- **Dependencies:** P0-15 · **Risk:** high (irreversible) · **Estimate:** M
- **Tests:** A dedicated "must never delete" matrix covers every required proof,
  delayed delivery versus old session end, direct and split acknowledgement
  clocks, fail-closed legacy backfill, and dry-run/apply agreement.

### P0-23 ✅ Health transitions

- **Epic:** Health
- **User value:** Told when recording breaks — once, not 720 times an hour.
- **Scope:** Edge-triggered alerts, stable alert ids, cooldown, deduplication,
  recovery messages. Delivery-channel failures stay visible in local logs and
  `/health` but do not enqueue warnings into the failed channel itself; one
  recovery edge is sent after the backlog clears. New pending alert states
  supersede older unsent reminders. Exhausted jobs have their own fingerprinted
  alert instead of being mislabeled as an ASR backlog.
- **Acceptance:** A changing runtime condition produces at most one message per
  cooldown; an unchanged exhausted-job set is reported once, a changed set is
  reported once, and clearing produces exactly one recovery message.
- **Dependencies:** P0-04 · **Risk:** low · **Estimate:** M
- **Tests:** 8 alert-deduplication tests, including unchanged and changed
  exhausted-job fingerprints and rollback when durable notification creation
  fails.

### P0-24 ✅ CI

- **Epic:** Foundation
- **Scope:** macOS runner, SHA-pinned actions, typecheck, lint, Node tests,
  Python lint/typecheck/tests, shell syntax, plist validation, synthetic ffmpeg
  integration, secret scan, dependency audit.
- **Non-goals:** Publishing, releases, model downloads, Telegram calls, user
  secrets.
- **Acceptance:** All jobs green on `main`.
- **Dependencies:** P0-02 · **Risk:** low · **Estimate:** M
- **Tests:** The workflow is the test.

### P0-25 ✅ Quick start

- **Epic:** Documentation
- **User value:** First complete FLAC → transcript → report session within
  10–15 minutes, excluding model downloads and the 60-second silence close.
- **Scope:** README with requirements, model sizes, disk usage, TCC, the orange
  indicator, sleep behaviour, the Telegram boundary and limits, and the legal
  warning.
- **Acceptance:** A new user follows it without reading source.
- **Dependencies:** all P0 · **Risk:** low · **Estimate:** S

---

## Audited repair plan — 2026-08-09

This section records defects confirmed by a code-and-documentation audit of
`main`. It does not retroactively change the status of the original backlog
items above: each old status still requires its own stated evidence. Work is
ordered by data-loss/privacy risk and implementation dependency.

The 2026-08-09 repair pass implemented the yellow items below with offline
tests. They remain yellow where their full fault-injection matrix or a live
microphone/model/Telegram/launchd check is still outstanding. AR-06 and AR-11
are green because their bounded guarantees are covered entirely by the offline
suite. At that cut AR-07 and AR-14 were untouched; AR-07's later 2026-08-11
offline slice is recorded on the item itself below.

### Current UX slice

#### UX-01 🟡 Honest session lifecycle notifications

- **Severity:** P0 · **Epic:** Recorder UX · **Estimate:** M · **Release:** next
  repair release
- **User value:** The bot immediately says when speech opened a real recording
  and when that recording finished and started uploading.
- **Scope:** After the first real speech frame has opened and persisted a
  session, enqueue a non-blocking "speech heard / recording started" status.
  After every part is atomically finalized, enqueue a "recording finished /
  uploading" status. Notification work must never run on or delay the recorder
  hot path.
- **Non-goals:** Claiming that recording or upload succeeded before the
  corresponding state is true; per-frame progress messages.
- **Acceptance:** One start status per logical session, only after a real frame
  and persisted `ACTIVE` state; one finish/upload status after durable
  finalization; retries or process restarts do not duplicate either status.
- **Dependencies:** AR-02, AR-07.
- **Tests:** Recorder/daemon integration tests for ordering, deduplication,
  restart recovery, no notification for a rejected speech candidate, and proof
  that a delayed Telegram request cannot delay frame consumption.

#### UX-02 🟡 Audio-first delivery concurrent with ASR

- **Severity:** P0 · **Epic:** Delivery · **Estimate:** M · **Release:** next
  repair release
- **User value:** The finished source audio starts uploading immediately;
  transcription continues in parallel and arrives when ready.
- **Scope:** Durable finalization atomically makes both the audio delivery and
  ASR work eligible. Audio delivery must not wait for ASR, summary, or report.
  Transcript and report are delivered later through their own ordered stages.
- **Non-goals:** Re-encoding the source audio; blocking session finalization on
  Telegram or a model; promising exact network completion time.
- **Acceptance:** A blocked/slow ASR worker does not delay the first audio
  upload attempt; ASR failure does not suppress source audio; transcript is
  sent once it exists; ordering remains deterministic within each session.
- **Dependencies:** AR-01, AR-02, AR-09.
- **Tests:** Integration tests with a deliberately blocked fake ASR worker, a
  successful audio sender, restart between finalization and both consumers,
  and multiple concurrent sessions.

#### UX-03 🟡 Long reports delivered as Markdown files

- **Severity:** P1 · **Epic:** Telegram UX · **Estimate:** S · **Release:** next
  repair release
- **User value:** Large reports arrive as readable `.md` documents instead of
  dozens of chat messages or an over-limit failure.
- **Scope:** Keep short reports inline; render a bounded short introduction plus
  a UTF-8 `.md` attachment when the rendered report exceeds the inline limit.
  Use the same escaping and untrusted-input boundary as transcript delivery.
- **Non-goals:** Truncating report content; sending transcript-derived filenames
  or paths; changing the source summary schema.
- **Acceptance:** No Telegram text exceeds 4096 UTF-16 code units; a maximal
  valid summary produces one safe `.md` attachment; filenames contain only
  trusted session metadata; retry remains idempotent.
- **Dependencies:** AR-09.
- **Tests:** Boundary tests at 4095/4096/4097 UTF-16 code units, maximal schema
  output, emoji/combining marks, HTML/Markdown injection, and retry after a
  transient Telegram failure.

#### UX-05 🟡 Make every recording artefact self-identifying

- **Severity:** P1 · **Epic:** Telegram UX/data provenance · **Estimate:** M
- **User value:** An audio file, transcript, report or incoming-file reply can
  be understood after forwarding or saving it outside the original chat thread.
- **Scope:** Live-capture outputs carry source type, capture daemon host and IANA
  timezone, original wall date/time and session UID. Incoming Telegram outputs
  distinguish direct from forwarded audio, retain both original-forward and
  bot-chat message dates, daemon host, display-only claimed filename, update and
  message ids, attachment type and stable file UID. Legacy unknown facts remain
  explicitly unknown rather than being backfilled from the current host.
- **Non-goals:** Using a claimed filename in a command, archive path or routing
  decision; identifying a speaker/person; inventing provenance for old rows.
- **Acceptance:** Ack, source-audio caption, transcript and report/file caption
  contain their compact provenance without exceeding Telegram limits. Stored
  provenance survives retries and host migration. Every untrusted display value
  is bounded and escaped; original forwarded time and bot delivery time remain
  distinct.
- **Dependencies:** AR-02, AR-09, AR-15.
- **Tests:** Migration from a legacy database; direct and all official forwarded
  origin variants; hostile/control-character filename rendering; retry keeps
  one file UID and original request identity; live host/timezone persistence;
  HTML, Markdown and caption bounds.

#### UX-04 🟡 Collapsed transcript and report presentation

- **Severity:** P1 · **Epic:** Telegram UX · **Estimate:** S · **Release:** next
  repair release
- **User value:** A completed session does not fill the chat screen with text,
  while its summary, details and full artefacts stay one tap away.
- **Scope:** Render a short transcript as one expandable block quote. Render a
  short summary and report as separate expandable block quotes. For a long
  transcript send only one `.md`; for a long report send one compact summary
  quote and one `.report.md`. Include ASR timings, and `Голос N` labels only
  when diarization assigned them.
- **Non-goals:** Guessing participant names, semantic roles or missing speaker
  labels; hiding source audio; nesting a spoiler that requires a second tap
  after expanding the quote.
- **Acceptance:** Short text is collapsed by default in Telegram; long text
  produces no duplicate chat chunks; every file contains the complete text;
  unattributed speech is never presented as an invented speaker.
- **Dependencies:** UX-03, P0-22.
- **Tests:** HTML escaping and expandable-quote rendering; compact preview
  bound; long transcript file-only delivery; report preview plus file; timed
  transcript with and without diarization labels. Live Telegram rendering is
  still unverified.

#### UX-06 🟡 Visible ASR language and host-scoped recognition settings

- **Severity:** P1 · **Epic:** ASR/Telegram UX · **Estimate:** M
- **User value:** A transcript says what language handling actually happened,
  and Thai-first rooms can improve future monolingual recordings without
  editing config or pretending that Qwen supports a priority list.
- **Scope:** Show reconciled languages and Auto/forced mode in live and incoming
  transcripts. Add a durable `/settings` radio panel for Auto, Thai, Russian,
  English and Chinese. Snapshot the mode in new jobs/revisions. Attach controls
  only on the one `receiveUpdates` input-owner host and identify that host.
- **Non-goals:** A multi-language allowlist; LLM selection between several ASR
  outputs; cross-host control; changing the Telegram interface locale.
- **Acceptance:** Auto remains the default; one forced language reaches live
  and incoming ASR; a later settings change cannot alter a leased/retried job;
  forced results never claim that automatic LID ran; callback replay is
  idempotent; send-only output has no dead keyboard.
- **Tests:** Config rejects more than one legacy hint; preference persistence;
  job snapshot; callback allowlist and Bot API payloads; transcript metadata;
  input-owner versus send-only delivery. Real Bot API rendering and the real
  Qwen language modes remain unverified on this revision.

#### UX-07 ⬜ Re-transcribe one retained recording with a chosen language

- **Severity:** P1 · **Epic:** ASR correction · **Estimate:** L
- **User value:** If Auto chose the wrong language, one tap can correct that
  recording rather than only improving the next one.
- **Scope:** A `Перераспознать` action for source audio still present on the
  polling host. Append an immutable transcript revision with Auto/forced
  evidence, then run revision-scoped transcript, summary, search and delivery
  jobs with revision-specific idempotency keys.
- **Non-goals:** Reprocessing a dev-Mac file from prod; choosing the best of
  five model outputs without confidence; restoring audio already deleted by
  retention.
- **Acceptance:** The old revision remains readable; exactly one new revision
  and delivery chain is produced per callback; missing/local-on-another-host
  audio returns a truthful answer; retention and current-pointer facts remain
  crash-consistent.
- **Dependencies:** P0-12, AR-15, UX-06. **Tests:** retry at every ASR/summary/
  outbox crash boundary, expired callback, missing audio and two-host fixtures.

#### UX-08 🟡 Finish the Russian user-surface contract

- **Severity:** P1 · **Epic:** Product language · **Estimate:** M
- **User value:** Inline output and attached files do not switch labels between
  Russian and English when a Telegram size limit is crossed.
- **Scope:** Russian bot-authored Telegram labels, provenance/status/health
  names and `.md` chrome. Keep code, CLI, logs and canonical engineering docs
  English; keep transcript/summary/filenames/hostnames in their source language.
  Add a curated Russian onboarding README rather than a manually mirrored copy
  of every technical document.
- **Non-goals:** Full i18n before a second real UI locale; translating commands
  (Bot API command names remain Latin); translating user content.
- **Acceptance:** The language boundary is documented and snapshot-tested for
  short/long transcript, report, digest, status, health and rejection output;
  raw internal exceptions never become Russian-chat content.
- **Tests:** Golden bot-output fixtures with Russian, Thai, English and Chinese
  content plus Markdown/HTML/UTF-16 boundary cases.
- **Current evidence:** Transcript/report/digest Markdown chrome, provenance,
  status labels, command descriptions and the curated `README.ru.md` are
  implemented and covered by offline render/transport tests. Health, incoming
  media rejection, exhausted incoming jobs and capture failures now use stable
  Russian user copy while raw adapter/process errors stay in the redacted local
  log. Live Bot API rendering and the complete multilingual golden matrix still
  keep this item yellow.

#### UX-09 🟡 Diagnose and safely retry exhausted jobs

- **Severity:** P0 · **Epic:** Operations · **Estimate:** S
- **User value:** A failed request says which Mac and pipeline stage failed,
  why it failed, how to repair a missing local dependency, and how to retry the
  exact request without another half-hourly flood.
- **Scope:** Separate dead jobs from the ASR backlog; fingerprint the complete
  dead-job set; show bounded, token-redacted errors, daemon host, job kind and
  id; provide `jobs failed` and one-job-at-a-time `jobs retry JOB_ID` local CLI
  commands. Reviving an ASR job restores its failed session to `PROCESSING` and
  retires a pending stale failure notice atomically.
- **Non-goals:** Installing packages, starting services, or running shell
  commands from Telegram; automatically resetting attempt budgets forever;
  cross-host retries from the one input-owner bot.
- **Acceptance:** An unchanged dead job alerts once regardless of cooldown; a
  new/removed dead job changes the fingerprint and alerts once; the alert names
  the host, kind, bounded cause, dependency repair path and exact local retry
  command; only an explicitly selected dead job is re-queued.
- **Tests:** Fingerprint transitions, secret/error bounding, ASR/Ollama repair
  hints, dead-row diagnostics, fresh attempt budget, ASR session revival and
  stale-notice retirement. Offline tests only; real dependency recovery and
  Telegram rendering remain unverified on this revision.

### Blocking correctness and privacy repairs

#### AR-01 🟡 Own one bounded ASR worker lifecycle

- **Severity:** P0 · **Epic:** ASR/runtime · **Estimate:** M
- **Risk:** A new persistent Python worker is created per job and not closed,
  causing repeated model loads, leaked child processes, and memory exhaustion.
- **Acceptance:** The daemon owns one reusable ASR backend (or an explicitly
  bounded pool), creates it once, restarts it after a proven crash, and closes
  it during every shutdown path. Incoming Telegram and recorded-session jobs
  use the same lifecycle policy. Once shutdown is latched, concurrent or later
  work cannot respawn a worker between close phases. Documentation describes
  the implemented lifecycle rather than the intended one.
- **Dependencies:** none.
- **Tests:** Worker-process spawn-count test over multiple jobs, crash/restart
  test, graceful shutdown and close/start race tests proving the shutdown latch,
  timeout fencing with a fresh child, and a repeated-job resource-leak
  regression test.
- **2026-08-11 evidence:** `WorkerProcess` now owns generation-scoped child,
  request and output state; timeout, non-zero exit and intentional close use a
  bounded TERM/KILL join; restart waits for cleanup; and late events from the
  retired child cannot clear its replacement. Offline timeout/restart,
  shutdown-latch and stale-handler regressions pass. This remains yellow until
  repeated real-model jobs and process/resource cleanup are exercised live.

#### AR-02 🟡 Make state transitions crash-consistent

- **Severity:** P0 · **Epic:** Storage/orchestration · **Estimate:** L
- **Risk:** A crash can strand work at four boundaries: `PROCESSING` before ASR
  job creation; archive rename before the part is finalized in SQLite; outbox
  `sent` before its delivery callback updates domain state; Telegram update
  deduplication before its job or reply is durably created.
- **Acceptance:** Each boundary is either one SQLite transaction or has an
  explicit, idempotent startup reconciliation path. Recovery proves that every
  finalized archive has a matching database fact and eligible job, every sent
  delivery reaches its domain state, and every recorded Telegram update has a
  durable outcome. Archive reconciliation must not infer deletion eligibility.
- **Dependencies:** AR-01 for worker recovery semantics.
- **Tests:** Kill/fault injection before and after every write in all four
  boundaries; restart repeatedly until the stable result is reached; assertions
  for no lost jobs, orphaned archives, duplicate domain transitions, or skipped
  Telegram updates.
- **2026-08-11 evidence:** When archive publication succeeds but its database
  finalization fails, startup now proves the surviving part and atomically
  restores the provisional `audio_finalize_failed` session to `PROCESSING`
  with audio delivery, ASR and durable status work. Faults at the ASR-job and
  status writes roll the whole transition back; repeated startup converges
  without duplicates. Separate callback fault injection also proves that an
  outbox `sent` row commits atomically with audio delivery time and the final
  transcript/report `DONE` transition; retry converges after rollback.
- **Remaining evidence gap:** Recovery proves and republishes a FLAC renamed
  before its database update, but cannot reconstruct the exact monotonic
  `duration_ms` / `speech_ms` lost in a hard-crash window. Sent-delivery to
  domain-state and Telegram-update to durable-outcome fault matrices also
  remain. Keep AR-02 yellow until those boundaries have equivalent evidence.

#### AR-03 🟡 Make incoming Telegram retry and deduplication recoverable

- **Severity:** P0 · **Epic:** Telegram ingestion · **Estimate:** M
- **Risk:** A retry downloads to a new UUID while the unique Telegram file row
  still points at the first UUID; later transcript insertion can fail its FK and
  every retry can leak quarantine files.
- **Acceptance:** One Telegram unique file id resolves to one stable durable
  record; retries reuse or explicitly replace its owned paths transactionally;
  transient ASR/download/normalization failures can recover; every temporary or
  superseded file has a proof-based cleanup path; duplicate updates do not
  duplicate transcripts or replies.
- **Dependencies:** AR-01, AR-02.
- **Tests:** Fault injection after download, insert, normalization, ASR, and
  transcript insert; same-file resend; process restart on every state; FK and
  quarantine-leak assertions.
- **2026-08-11 evidence:** Startup now reconciles strict generated quarantine
  and normalized-WAV names against durable UID owners, repeats ownership proof
  immediately before unlink, preserves present-UID publish-before-path windows,
  symlinks and corrupt/out-of-root ownership, and never scans the recording
  archive. Focused tests cover report-only mode, both path kinds, NULL and
  non-NULL crash windows, a late owner, root replacement, capture-first startup,
  idempotency and ambient archive preservation. AR-03 remains yellow until D083
  completes the end-to-end fault injection matrix.

#### AR-04 🟡 Enforce a safe daemon singleton and PID identity

- **Severity:** P0 · **Epic:** Operations · **Estimate:** M
- **Risk:** Multiple daemons can run against one database, and a stale reused
  PID can make `stop` signal an unrelated process. Capture failure can also exit
  successfully, defeating launchd restart policy.
- **Acceptance:** Startup holds an atomic single-instance lock; status and stop
  verify process identity, not just PID liveness; stale metadata is recovered
  safely; all unexpected capture exits return failure for launchd; repeated
  signals cannot bypass orderly recorder finalization.
- **Dependencies:** AR-02.
- **Tests:** Concurrent-start race, stale/reused PID, capture startup failure,
  capture EOF, first and second signal during slow finalization, and launchd
  exit-status contract tests.
- **2026-08-11 evidence:** PID publication already uses an exclusive create;
  the record now also stores the OS process birth marker. `status` and `stop`
  require that marker and the daemon command to match, so a reused PID or a
  legacy record without exact identity cannot be signalled. Unexpected capture
  EOF already exits as failure. Repeated real signals during slow finalization
  and a live launchd restart remain before this item can turn green.

#### AR-05 🟡 Bind Telegram only to a fresh explicit `/start`

- **Severity:** P0 · **Epic:** Privacy/onboarding · **Estimate:** S
- **Risk:** Setup starts from update offset zero and can bind to an old private
  message from the wrong person.
- **Acceptance:** Setup establishes a fresh update boundary, accepts only a new
  explicit `/start`, displays the selected account/chat identity for
  confirmation, and persists the token/chat-id pair only after confirmation.
  The pair is one versioned Keychain item, so it cannot be half-configured;
  ordinary setup failures restore the previous complete pair and SQLite offset
  (or leave no pair at all). Historical and non-private updates cannot bind the
  bot.
- **Dependencies:** none.
- **Tests:** Scripted update histories containing old private messages, group
  messages, multiple users, a fresh `/start`, cancellation, restart before
  Keychain persistence, atomic pair-write failure, and rollback after the
  matching SQLite offset or confirmation fails.
- **2026-08-11 evidence:** Setup now publishes the SHA-256 credential-scoped
  cursor before atomically replacing the combined Keychain pair. A death before
  the Keychain write leaves only inactive non-secret metadata; a death after it
  leaves a matching cursor. Startup refuses to poll a concrete credential scope
  with no cursor, and ordinary rollback restores same-scope cursors or removes
  unused new-scope state. The private PTY keeps the credential off argv, env and
  files. With the same bot token and a changed chat, a death between cursor and
  Keychain publication may skip updates for the old chat, but cannot replay
  history or bind an unconfirmed chat. Keep AR-05 yellow until a fresh real-bot
  setup and disposable Keychain run repeat this evidence on macOS.

#### AR-06 ✅ Enforce local-only LLM endpoints

- **Severity:** P0 · **Epic:** Privacy/config · **Estimate:** S
- **Risk:** Configuration accepts a remote `llm.baseUrl`, contradicting the
  local-only processing boundary and allowing transcripts to leave the Mac.
- **Acceptance:** Validation accepts only loopback endpoints supported by the
  ADR, rejects redirects or resolved destinations that escape loopback, and
  fails closed before sending transcript content. ADR, schema, and doctor state
  the same boundary.
- **Dependencies:** none.
- **Tests:** Literal `127.0.0.1` positive; hostname/IPv6/public host, alternate
  notation, credentials, malformed URL, and redirect negatives; assertion that
  rejected configuration makes no request.

#### AR-07 🟡 Remove processing and timestamp distortion from the recorder hot path

- **Severity:** P0 · **Epic:** Capture/sessionizer · **Estimate:** L
- **Risk:** Per-frame VAD and writer awaits can block capture for seconds, while
  timestamps are assigned when buffered bytes are consumed rather than when
  captured; silence, pre-roll, rotation, and health timings can become false.
- **Acceptance:** Capture drains continuously into a bounded pipeline; slow or
  failed VAD/encoding cannot block the microphone reader; overload has an
  explicit observable policy; frame monotonic timestamps preserve capture
  cadence under downstream stalls; part close/fsync/hash runs off the hot path
  without weakening atomic publication.
- **Dependencies:** none.
- **Tests:** Delayed/wedged VAD, pipe backpressure, slow part close, queue
  saturation, encoder early exit, and monotonic timing tests using a fake clock
  rather than sleeps.
- **Implemented offline (2026-08-11):** FFmpeg stdout now has an independent,
  bounded 30-second PCM pump; ingress age and processing lag are reported
  separately; timestamps preserve sample cadence; overload and non-zero child
  exit fail visibly without draining stale audio; stop has a bounded SIGKILL
  fallback; recorder mutations and sleep boundaries are serialized with stream
  epochs. Unit and fake-child integration coverage includes overflow/retry,
  non-zero exit, ignored SIGTERM, buffered stop, discontinuity and a VAD-blocked
  stop. Still yellow until real AVFoundation chunk cadence and lid sleep/wake are
  exercised; the 250 ms discontinuity threshold may need calibration from that
  evidence.

#### AR-15 ⬜ Designate one input owner per Telegram bot token

- **Severity:** P0 · **Epic:** Multi-host Telegram routing · **Estimate:** M
- **Risk:** Two daemons polling `getUpdates` with independent SQLite offsets for
  one bot token race for updates. Either host can consume an update the other
  never sees, so incoming work and acknowledgements have no reliable owner.
- **Acceptance:** Configuration expresses one role per instance. For each bot
  token exactly one designated input worker may poll and enqueue incoming work;
  every other host using that token is send-only. Because instances do not
  share a coordinator, the current `receiveUpdates` role is operator-enforced;
  closing this item still requires shared ownership/conflict detection or an
  equally strong startup check. Every
  outgoing message and acknowledgement identifies daemon host, source and
  request identity. Separate bots remain the documented isolation alternative.
- **Dependencies:** AR-04, UX-05.
- **Tests:** Two configured instances sharing one token prove exclusive update
  ownership once coordination exists; local tests prove send-only hosts never
  poll; role/config validation covers missing and conflicting ownership;
  separate-token instances remain independent.

### Delivery, operations, and observability repairs

#### AR-08 🟡 Make digest and retention scheduling real and timezone-correct

- **Severity:** P1 · **Epic:** Operations/privacy · **Estimate:** M
- **Risk:** The launchd digest command stores but does not deliver; it can race
  the daemon and suppress delivery. The configured timezone is unused, late
  sessions can be omitted, and retention limits are not automatically applied.
- **Acceptance:** Exactly one owner schedules each operation; digest creation
  and outbox enqueue are recoverably linked; configured local day/time and DST
  are honored; late-completing sessions have a documented inclusion policy;
  retention runs on a documented schedule through the existing proof-based
  dry-run/apply boundary, with failures visible to health.
- **Dependencies:** AR-02, AR-09, AR-10.
- **Tests:** Launchd/daemon ownership, missed-window restart, month/year/DST
  boundaries, session finishing after digest time, duplicate scheduler wakeup,
  and scheduled-retention proof tests with undelivered files.

#### AR-09 🟡 Bound Telegram messages and define honest delivery semantics

- **Severity:** P1 · **Epic:** Telegram delivery · **Estimate:** M
- **Risk:** A valid report can greatly exceed 4096 characters and die on a 400;
  global ordinal ordering can starve old transcript/report work; documentation
  promises duplicate-free delivery although the network boundary is
  at-least-once.
- **Acceptance:** Every text request is bounded before enqueue/send; long
  reports use UX-03; fairness prevents later audio from indefinitely starving
  older session output while preserving per-session audio-first ordering;
  every Bot API request and file download has a bounded client-side deadline
  (with long polling given its configured server wait plus transport headroom);
  retries are idempotent where Telegram provides a key and explicitly
  documented as at-least-once otherwise; dead rows remain observable.
- **Dependencies:** AR-02.
- **Tests:** Maximal report, Telegram 400 classification, cross-session sustained
  backlog fairness, crash after accepted HTTP response but before `markSent`,
  retry/deduplication, never-resolving fetch aborts for JSON/upload/download and
  long-poll headroom, and dead-row visibility.

#### AR-10 🟡 Report real worker, queue, outbox, digest, and Keychain health

- **Severity:** P1 · **Epic:** Health · **Estimate:** M
- **Risk:** `workerReady` is inferred from queue size, Ollama is always reported
  ready, dead work is excluded from counts, digest failures are not evaluated,
  and Keychain secrets are never retried after startup.
- **Acceptance:** Readiness comes from real bounded probes; pending and dead
  counts/ages are separate; worker crashes, missing digest, dead outbox/jobs,
  recorder stalls, and unavailable Keychain produce edge-triggered alerts;
  unlocking Keychain recovers delivery without daemon restart.
- **Dependencies:** AR-01, AR-08, AR-09.
- **Tests:** Each unhealthy condition and recovery edge, dead-only queues,
  locked-then-unlocked Keychain, worker crash, stale recorder, missing digest,
  and alert cooldown/deduplication.
- **Current evidence:** Pending/dead counts are separate in local and Telegram
  status; exhausted jobs expose bounded local diagnostics and fingerprinted
  alerts with explicit retry. Recorder/session state is exposed only from a
  fresh heartbeat whose PID and start identity match the live daemon, and
  doctor checks Telegram setup metadata without reading the token. Full live
  Keychain/worker/digest recovery evidence is still outstanding, so the item
  remains yellow.

#### AR-11 ✅ Remove the duplicated session-opening frame

- **Severity:** P1 · **Epic:** Sessionizer · **Estimate:** S
- **Risk:** The threshold-crossing frame is stored in pre-roll and then written
  again after `open_part`, duplicating audio and backdating session start.
- **Acceptance:** Every captured PCM frame appears at most once in a part;
  pre-roll retains the configured history including the correct boundary;
  rotation still receives no pre-roll; sleep/wake clears any uncommitted speech
  candidate so a session cannot span sleep.
- **Dependencies:** AR-07.
- **Tests:** Decode generated part PCM and compare exact sample sequence at the
  open threshold; empty/full pre-roll boundaries, rotation, and sleep during
  `SPEECH_CANDIDATE`.

#### AR-12 🟡 Clean split artifacts and verify every produced upload chunk

- **Severity:** P1 · **Epic:** Delivery/storage · **Estimate:** S
- **Risk:** Lossless split files remain in temp forever, and the size estimate
  does not prove every produced chunk fits Telegram's configured limit.
- **Acceptance:** Every derived split path has durable ownership and cleanup
  after success, rejection, retry exhaustion, and startup recovery; each output
  is measured before enqueue; an oversize output is split again or fails with a
  recoverable explicit state; source FLAC is never deleted by this cleanup.
- **Dependencies:** AR-02, AR-09.
- **Tests:** Success, transient failure, dead delivery, process crash, stale temp
  recovery, underestimated bitrate, and assertions for chunk size/codec/source
  preservation.

### Contract and documentation repairs

#### AR-13 🟡 Remove dead configuration and synchronize CI/docs with runtime

- **Severity:** P1 · **Epic:** Maintenance · **Estimate:** M
- **Risk:** `maxConcurrentIncomingJobs` remains public but is not honored;
  incoming-audio and runtime evidence can drift across config, CI, doctor and
  documentation.
- **Acceptance:** Every public config field is either implemented and tested or
  removed through an explicit migration; incoming attachment/summary behaviour
  matches code; CI, `.nvmrc`, `package.json`, bootstrap, and doctor validate the
  same minimum Node/SQLite versions; one evidence table is authoritative for
  real model, bot, microphone, launchd, and sleep/wake verification. Existing
  backlog statuses change only when their acceptance evidence is rerun.
- **Dependencies:** UX-01 through UX-03 and AR-01 through AR-12 where their
  behaviour is documented.
- **Tests:** Config field usage/round-trip checks, unknown/deprecated key tests,
  incoming UX tests, CI version assertion, doctor fixtures at the exact version
  boundary, documentation link/checklist review, and full repository checks.
- **2026-08-11 evidence:** `runtime-requirements.json` is now the validated
  source for Node, embedded SQLite and pnpm requirements used by bootstrap,
  launchd installation, doctor and the database boundary. Drift tests enforce
  alignment with `.nvmrc`, `package.json` and CI. `digest.timezone` is exercised
  through scheduling/day-boundary/render tests, while the unimplemented
  `telegram.summarizeIncoming` option was removed with an explicit migration
  error and transcript-only docs. `sessionizer.vadFrameMs` was also removed with
  an explicit fixed-32-ms protocol migration error. `maxConcurrentIncomingJobs`
  and the consolidated live-evidence table remain before this item can turn
  green.

#### AR-14 ⬜ Review jurisdiction-specific recording guidance

- **Severity:** P2 · **Epic:** Legal/documentation · **Estimate:** S (engineering
  changes only; legal review external)
- **Risk:** `RECORDING_POLICY.md` makes jurisdiction-specific legal assertions
  without dated primary sources and can be mistaken for current legal advice.
- **Acceptance:** Product docs clearly separate technical safeguards from legal
  advice; jurisdiction claims have dated authoritative sources and qualified
  review, or are replaced with a concise instruction to obtain local advice;
  limitations and user responsibility are visible during onboarding.
- **Dependencies:** Qualified legal review before asserting jurisdiction rules.
- **Tests:** Documentation review for source/date coverage and onboarding-copy
  snapshot; no automated test is presented as legal verification.

---

## P1 — reliable beta

| ID | Item | Value | Acceptance | Risk | Est |
| --- | --- | --- | --- | --- | --- |
| P1-01 | ⬜ Native Swift capture helper | Precise TCC errors, route-change handling, no extra process | AVAudioEngine helper behind `CaptureBackend`; device changes handled without dropping a session | M | L |
| P1-02 | ⬜ Signed bundle identity | Stable TCC grants across rebuilds | Signed with a Developer ID; grant survives a rebuild | M | M |
| P1-03 | ⬜ Improved TCC handling | Fewer confusing permission failures | Denial is distinguished from device-missing; guidance names the launching app | M | M |
| P1-04 | ⬜ Crash recovery for partial parts | No orphaned temp files | Startup reconciles `tmp/` against the database and reports what it found | L | S |
| P1-05 | ⬜ Backup and restore | Migrate to a new Mac | `openmurmur backup` / `restore` round-trips database and audio | L | M |
| P1-06 | ⬜ Model canary tests | Detect a model upgrade regressing quality | A fixed corpus scores above a threshold before a model bump is accepted | M | M |
| P1-07 | ⬜ Thai quality corpus | Thai is a first-class language, not an aspiration | Measured WER on a Thai corpus, published in the repo | M | M |
| P1-08 | ⬜ Audio preview conversion | Faster playback on mobile | Optional Opus preview alongside — never instead of — the FLAC | L | S |
| P1-09 | ⬜ Richer daily digest | A useful end-of-day summary | Cross-session themes, open questions, commitments carried forward | L | M |
| P1-10 | ⬜ Homebrew tap | One-line install | `brew install openmurmur/tap/openmurmur` works | L | M |
| P1-11 | ⬜ Notarized test build | Validate the distribution path | A notarized build runs on a clean Mac without Gatekeeper warnings | M | M |

---

## P2 — product

| ID | Item | Value | Acceptance | Risk | Est |
| --- | --- | --- | --- | --- | --- |
| P2-01 | ⬜ Signed and notarized `.dmg` | Install without a toolchain | Drag-to-Applications install on a clean Mac | M | L |
| P2-02 | ⬜ Updater | Security fixes reach users | Signed update check with user consent; never silent | M | M |
| P2-03 | ⬜ Optional local settings UI | Only if a real need appears | Justified by user reports, not by assumption | L | M |
| P2-04 | ✅ Local Telegram Bot API server | Raises the 20 MB incoming limit | Documented setup; config points at `127.0.0.1`; local `file_path` supported | M | M |
| P2-05 | ✅ Large incoming files | Transcribe long recordings sent to the bot | Local Bot API mode allows `telegram.maxIncomingBytes` up to 2 GB; streaming decode remains bounded | M | M |
| P2-06 | ✅ Optional diarization | "Who said what" | sherpa-onnx, ungated models, capped speaker count, off by default — see [ADR-0008](adr/0008-speaker-diarization.md) | H | L |
| P2-06a | ⬜ Measure diarization against a reference | Know the error rate instead of guessing | Hand-label who spoke in a few real recordings; report DER. Today the output is *plausible*, not *verified* | M | M |
| P2-07 | ⬜ Speaker enrollment | Distinguish the user from others | Local-only voice profiles; explicit opt-in. Would turn "voice 1" into a name, which is exactly why it is separate | H | L |
| P2-07a | ⬜ Speakers survive a part rotation | One person stays one voice across a long session | Cluster embeddings across parts instead of per part; today a 15-minute rotation renumbers everyone | M | M |
| P2-10 | ⬜ Benchmark ASR choices on our own recordings | Public sets are read studio speech; this records rooms | Compare engines on hand-labelled recordings from the owner's environment. FLEURS said Qwen3-ASR wins on Thai ([ADR-0007](adr/0007-thai-asr-engine.md)); nobody has checked that on far-field audio | M | M |
| P2-08 | ⬜ Official paid build | Fund maintenance | See `docs/BUSINESS_MODEL.md` | M | L |
| P2-09 | ⬜ Sponsor tiers | Sustainable maintenance | GitHub Sponsors configured with honest tiers | L | S |

---

## Cross-cutting debt

| Item | Why it matters |
| --- | --- |
| ⬜ Sandbox FFmpeg decode of incoming files | The most plausible RCE path (T3 in the threat model). |
| ⬜ Repeat the real MLX ASR end-to-end on the current revision | P0-11 and P0-06 have historical same-machine smoke evidence, not a post-repair live run. |
| ⬜ Verify live Telegram delivery with a real bot | Closes P0-14, P0-18, P0-20. |
| ⬜ Verify launchd under a real login session | Closes P0-21; TCC under launchd is the known risk. |
| ⬜ Test sleep/wake behaviour | Documented in the README from design intent, not from observation. |
| ✅ Bump SQLite when Node ships ≥ 3.53.4 | Done by pinning Node 26.7.0. |
