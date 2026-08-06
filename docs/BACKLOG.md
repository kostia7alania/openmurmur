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
- **Tests:** 14 config tests including a walk proving no field can hold a secret.

### P0-04 ✅ SQLite migrations

- **Epic:** Storage
- **User value:** Data survives upgrades and crashes.
- **Scope:** 14 tables, WAL, foreign keys, busy timeout, FTS5 trigram,
  idempotent filename-ordered migrations, runtime version check.
- **Non-goals:** Down-migrations (a rollback on a database holding the user's
  only transcript is worse than the problem).
- **Acceptance:** Re-running migrations applies nothing and loses nothing; the
  actual SQLite runtime version is reported, not assumed.
- **Dependencies:** P0-02 · **Risk:** medium (Node bundles 3.53.3, below the
  3.53.4 target — see ADR-0004) · **Estimate:** M
- **Tests:** 13 database tests including idempotency and FK enforcement.

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
- **Tests:** Segment assembly fully tested in Python (7 tests). **The ONNX model
  itself has not been run** — `silero-vad` is not in the CI-installed subset.

### P0-07 ✅ Sessionizer state machine

- **Epic:** Sessionizer
- **User value:** Recordings correspond to things that were actually said.
- **Scope:** Pure state machine emitting intents; monotonic-clock durations.
- **Non-goals:** Any I/O inside the machine.
- **Acceptance:** All transitions behave per `docs/SESSIONIZER.md`; a wall-clock
  jump cannot open or close a session.
- **Dependencies:** P0-03 · **Risk:** low · **Estimate:** M
- **Tests:** 43 tests with a fake clock.

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
- **Tests:** 6 tests, including 5 consecutive near-timeout cycles.

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
  26 Python tests, all without MLX. **Inference itself is unverified.**

### P0-12 ✅ Transcript revisions

- **Epic:** ASR
- **User value:** A model upgrade that turns out worse is recoverable.
- **Scope:** Append-only revisions, `is_current` pointer, per-segment timestamp
  provenance.
- **Acceptance:** A second ASR run appends rather than overwrites; the original
  text is still readable.
- **Dependencies:** P0-04 · **Risk:** low · **Estimate:** S
- **Tests:** 3 revision tests.

### P0-13 🟡 Ollama structured summary

- **Epic:** LLM
- **User value:** A short report instead of a wall of text.
- **Scope:** JSON Schema constrained decoding, `temperature = 0`, `think=false`,
  localhost only, validation and clamping of the result.
- **Non-goals:** Any capability beyond text→JSON.
- **Acceptance:** A real transcript yields a useful summary; Ollama being absent
  degrades the report without blocking delivery.
- **Dependencies:** P0-12 · **Risk:** medium · **Estimate:** M
- **Tests:** Schema parsing, clamping and injection fencing tested with the fake
  backend. **Ollama was not installed on the development machine.**

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
- **Scope:** Inline under 3500 chars; numbered HTML messages plus a `.md`
  attachment above it; HTML escaping; grapheme-safe splitting.
- **Acceptance:** No message exceeds 4096 chars; no surrogate pair is split;
  every part carries the session id.
- **Dependencies:** P0-12 · **Risk:** low · **Estimate:** M
- **Tests:** 10 formatting tests including emoji, Thai and combining marks.

### P0-17 ✅ Structured report delivery

- **Epic:** Telegram
- **User value:** Decisions and tasks at a glance.
- **Scope:** The documented report format; empty sections omitted; every
  speech-derived value escaped.
- **Dependencies:** P0-13 · **Risk:** low · **Estimate:** S
- **Tests:** 3 report tests including HTML injection through summary fields.

### P0-18 ✅ `/status`

- **Epic:** Telegram · **Estimate:** S · **Risk:** low
- **Scope:** Recorder state, last frame age, current session, ASR backlog,
  outbox depth, last delivery, free disk, model status, version.
- **Acceptance:** Output matches the documented format.
- **Dependencies:** P0-14 · **Tests:** Renderer tested; live command not run.

### P0-19 ✅ `/health`

- **Epic:** Health · **Estimate:** S · **Risk:** low
- **Scope:** `OK`, or one `WARN:`/`ERROR:` line per unhealthy component.
- **Acceptance:** A healthy system returns exactly `OK`.
- **Dependencies:** P0-23 · **Tests:** 8 health tests.

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
- **Acceptance:** Undelivered audio is never listed; every retained file has a
  stated reason.
- **Dependencies:** P0-15 · **Risk:** high (irreversible) · **Estimate:** M
- **Tests:** 8 "must never delete" cases plus dry-run/apply agreement.

### P0-23 ✅ Health transitions

- **Epic:** Health
- **User value:** Told when recording breaks — once, not 720 times an hour.
- **Scope:** Edge-triggered alerts, stable alert ids, cooldown, deduplication,
  recovery messages.
- **Acceptance:** A condition true for an hour produces at most one message per
  cooldown; clearing produces exactly one recovery message.
- **Dependencies:** P0-04 · **Risk:** low · **Estimate:** M
- **Tests:** 6 alert-deduplication tests.

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
- **User value:** First Telegram message within 10–15 minutes.
- **Scope:** README with requirements, model sizes, disk usage, TCC, the orange
  indicator, sleep behaviour, the Telegram boundary and limits, and the legal
  warning.
- **Acceptance:** A new user follows it without reading source.
- **Dependencies:** all P0 · **Risk:** low · **Estimate:** S

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
| P2-06 | ⬜ Optional diarization | "Who said what" | Only if quality is good enough to be worth the ambiguity it adds | H | L |
| P2-07 | ⬜ Speaker enrollment | Distinguish the user from others | Local-only voice profiles; explicit opt-in | H | L |
| P2-08 | ⬜ Official paid build | Fund maintenance | See `docs/BUSINESS_MODEL.md` | M | L |
| P2-09 | ⬜ Sponsor tiers | Sustainable maintenance | GitHub Sponsors configured with honest tiers | L | S |

---

## Cross-cutting debt

| Item | Why it matters |
| --- | --- |
| ⬜ Sandbox FFmpeg decode of incoming files | The most plausible RCE path (T3 in the threat model). |
| ⬜ Run the real MLX ASR end-to-end | P0-11 and P0-06 are the two largest unverified areas. |
| ⬜ Verify live Telegram delivery with a real bot | Closes P0-14, P0-18, P0-20. |
| ⬜ Verify launchd under a real login session | Closes P0-21; TCC under launchd is the known risk. |
| ⬜ Test sleep/wake behaviour | Documented in the README from design intent, not from observation. |
| ⬜ Bump SQLite when Node ships ≥ 3.53.4 | Removes the ADR-0004 gap. |
