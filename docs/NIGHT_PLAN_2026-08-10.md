# OpenMurmur night plan — 2026-08-10

This is the consolidated execution queue from the correctness/storage,
runtime/operations and product/ASR/Telegram audits. It describes the current
`eff3dc1` snapshot plus the two research documents prepared on 2026-08-10.

Status meanings: `confirmed` is an evidence-backed defect or contract to lock;
`gap` is missing implementation or proof; `verify-live` needs real hardware,
services or Telegram; `fixed-in-eff3dc1` was implemented and passed the offline
checks recorded with that local commit, but is not live release evidence.

**Priority and sequence.** Work P0 before P1 before P2. Inside one priority,
follow the numbered workstreams: first protect state, audio, recovery, delivery
and retention; then runtime and local recovery; then multi-host/product UX; and
finish with automated and live evidence. A fix that crosses a safety gate stays
blocked even if its task appears earlier.

**Safety gates.**

- Keep the microphone hot path free of slow or fallible processing.
- Publish files atomically and delete only from persisted eligibility proof.
- Never let transcripts, stored errors or model output select commands or paths.
- Keep secrets in Keychain and technical paths/errors in local diagnostics.
- Never install, start, stop, retry or delete from Telegram; repair is local and
  explicitly consented.
- Exactly one host may poll a Telegram token; every other host is send-only.
- Default diagnostics must be side-effect-free and must not sync/download models.
- Offline fake-adapter checks and live mic/model/Telegram/launchd checks are
  separate gates; documentation may claim only what actually ran.

## 1. Session state machine and monotonic lifecycle

- [ ] **CS-01 · P0 · confirmed** — Prevent replay delivery from regressing `DONE` to `DELIVERING`. Evidence: `src/jobs/delivery.ts:383,465` and `src/jobs/pipeline.ts:522-539`. Accept: transitions are monotonic/CAS-protected and a replay reconciliation test leaves a delivered session `DONE`.
- [ ] **CS-03 · P1 · gap** — Encode the allowed session-transition table in types and repository CAS operations. Evidence: `src/database/repository.ts:65-68` accepts arbitrary state strings. Accept: illegal transitions fail without mutating the row; smallest test exercises every allowed edge and one forbidden edge.
- [ ] **CS-05 · P2 · confirmed** — Reconcile the documented incoming `validated` state with persistence. Evidence: `docs/DATA_MODEL.md:199-200` names it while `src/cli/daemon.ts:856-906` skips it. Accept: either persist the state and test it or remove it from the canonical model.
- [ ] **CS-06 · P2 · gap** — Make `FINALIZING` a real durable state or remove the promise. Evidence: schema/docs allow it but the recorder never writes it. Accept: crash recovery has one tested, documented interpretation of every persisted state.
- [ ] **CS-12 · P1 · confirmed** — Add an explicit ASR rerun/revision operation instead of colliding with `asr:<sessionId>` idempotency. Evidence: docs promise revisions while the current key only permits retry. Accept: rerun appends an immutable revision, preserves the current revision pointer and has a duplicate-click test.
- [ ] **CS-17 · P1 · gap** — Recover sessions stranded in `PROCESSING` or `DELIVERING`, not only active capture states. Evidence: `src/capture/recovery.ts:183-190`. Accept: startup reconciles missing/present jobs and outbox facts without inventing delivery; smallest test covers both states after simulated crash.

## 2. Recorder hot path and atomic audio publication

- [ ] **CS-02 · P0 · confirmed** — Remove encoder close/fsync/hash work from the recorder hot path. Evidence: `src/sessionizer/recorder.ts:174-185,383-412` and `src/capture/writer.ts:108-133`. Accept: finalization hands off to a bounded storage worker and a delayed-close test proves subsequent frames are accepted without blocking.
- [ ] **CS-13 · P1 · confirmed** — Cleanly abort a writer if the audio-part DB insert fails. Evidence: `src/sessionizer/recorder.ts:350-370` starts the writer first. Accept: injected insert failure leaves no child, temp file or unpublished row.
- [ ] **CS-32 · P2 · gap** — Await encoder termination during `PartWriter.abort`. Evidence: abort signals the child but does not await `close`. Accept: abort resolves only after bounded SIGTERM/SIGKILL completion and no process remains in a regression test.

## 3. Crash recovery and media integrity

- [ ] **CS-04 · P1 · confirmed** — Reconstruct recovered duration/timing instead of storing null and treating it as zero. Evidence: `src/capture/recovery.ts:77-83,203-208` and pipeline `duration ?? 0`. Accept: ffprobe or trusted frame facts restore duration; recovered ASR offsets match a normal session in the smallest fixture.
- [ ] **CS-14 · P1 · confirmed** — Surface directory permission failures during recovery. Evidence: broad catches around `readdir`/`stat` in `src/capture/recovery.ts:109-114,142-147`. Accept: `EACCES` produces an actionable local failure, while genuine missing files remain a distinct case.
- [ ] **CS-15 · P2 · confirmed** — Detect orphan atomic Markdown temp files. Evidence: `src/util/atomic-file.ts:6-20` writes `.tmp`; recovery scans only final report paths. Accept: startup safely classifies/removes or preserves an interrupted temp artifact with a crash fixture.
- [ ] **CS-16 · P1 · confirmed** — Validate recovered audio before marking it finalized. Evidence: `src/capture/recovery.ts:67-83` currently hashes arbitrary regular bytes despite the valid-FLAC invariant in `docs/DATA_MODEL.md:226-227`. Accept: invalid media is quarantined/failed and a real generated FLAC is recovered.

## 4. Job queue, leases and manual retry

- [x] **CS-09 · P1 · fixed-in-eff3dc1** — Refuse manual retry for job kinds the daemon cannot claim. Evidence: `src/jobs/queue.ts` in `eff3dc1` adds `canRetryDeadJob`; its CLI integration test covers a legacy retention job. Accept: unsupported rows remain dead and the command exits non-zero.
- [x] **CS-10 · P1 · fixed-current** — Unique claim generations fence complete/fail/release and every durable handler mutation by the live lease token. Evidence: `src/jobs/queue.ts`, `tests/unit/job-lease.test.ts`. Accept: an expired worker cannot complete or fail a job reclaimed by another worker; the two-generation regression passes.
- [x] **CS-30 · P1 · fixed-offline** — Every daemon job family runs under a renewable heartbeat; deliberately slow fake handlers remain singly owned. Real model soak remains D090. Evidence: `src/cli/daemon.ts`, `tests/unit/job-lease.test.ts`. Accept: heartbeat prevents concurrent claims under a deliberately slow handler.
- [x] **RO-04 · P0 · fixed-current** — Active local generations are renewed before global stale recovery after suspension, and stale generations cannot publish DB, outbox or artifact facts. Evidence: `src/cli/daemon.ts`, `tests/integration/delivery.test.ts`, `tests/integration/incoming-fault-matrix.test.ts`. Accept: a long ASR cannot be double-claimed after the lease boundary.
- [x] **RO-05 · P0 · fixed-in-eff3dc1** — Align retryable kinds with daemon workers. Evidence: `src/jobs/queue.ts` in `eff3dc1` rejects `digest`/`retention`; `src/cli/daemon.ts:274-280` claims only supported kinds. Accept: CLI never reports an unserviceable row as requeued.
- [ ] **RO-06 · P1 · confirmed** — Make retry output explicitly distinguish queued, daemon-running and backend-ready. Evidence: `src/cli/main.ts` only reports that the row was requeued. Accept: local output is truthful and host-scoped without promising execution or success.

## 5. Outbox state, idempotency and terminal recovery

- [x] **CS-07 · P0 · fixed-in-eff3dc1** — Commit alert-state edges and durable outbox creation atomically. Evidence: `src/health/alerts.ts` in `eff3dc1` runs the enqueue callback inside the evaluation transaction; regression rolls back on enqueue failure. Accept: a failed insert cannot consume a notification edge.
- [x] **CS-11 · P1 · fixed-current** — Every outbox claim increments a monotonic generation; sent/dead/retry/defer and delivery callbacks require the exact live sending generation. Evidence: `src/telegram/outbox.ts`, `tests/unit/outbox.test.ts`. Accept: the A→recover→B→late-A regression leaves B authoritative.
- [ ] **CS-18 · P1 · verify-live** — Bound the Telegram send/SQLite-ack duplicate window. Evidence: `src/telegram/outbox.ts` recovers `sending`; `docs/DATA_MODEL.md:145-149` admits at-least-once delivery. Accept: fault injection documents the exact duplicate contract and stable idempotency/correlation data.
- [ ] **RO-16 · P0 · gap** — Add inspectable, proof-safe recovery for dead outbox rows. Evidence: `src/telegram/outbox.ts:194-199` exposes only a count. Accept: operator can inspect cause/artifact and retry or regenerate the identical delivery without retry-all.
- [ ] **RO-23 · P0 · confirmed** — Preserve or regenerate terminal ephemeral deliveries. Evidence: `src/telegram/outbox.ts:284-331` deletes terminal ephemeral rows while `src/jobs/delivery.ts:169-183,225-254` treats dead as no-op. Accept: retry reconstructs the same payload exactly once or retains the artifact until acknowledged.

## 6. Telegram transport, polling and callback resilience

- [ ] **RO-21 · P1 · confirmed** — Add a Telegram channel circuit breaker and jitter. Evidence: `src/telegram/outbox.ts:294-317` continues draining after generic transport failure. Accept: one outage pauses the batch, honors backoff and avoids synchronized host retries.
- [ ] **RO-22 · P1 · confirmed** — Classify permanent local/API errors separately from retryable transport failures. Evidence: `src/telegram/client.ts:21-25` treats every non-API error as retryable. Accept: invalid local payloads die with a typed cause; timeouts/5xx retry with bounded policy.
- [ ] **RO-24 · P1 · confirmed** — Make callback answers durable/deferred and honor `retry_after`. Evidence: `src/cli/daemon.ts:747-790` writes settings then calls Telegram directly and rethrows. Accept: the preference commit is idempotent, callback acknowledgement retries safely, and rate limits do not crash the loop.
- [ ] **RO-25 · P1 · confirmed** — Add capped jittered backoff and edge-only logs to update polling. Evidence: `src/cli/daemon.ts:496-519` uses fixed polling and logs every failure. Accept: a 30-second timeout is normal, outages log one edge plus bounded reminders, and recovery logs once.
- [ ] **PX-05 · P1 · gap** — Edit one durable incoming status instead of adding acknowledgement rows. Evidence: `src/cli/daemon.ts:1606-1615` creates a new status delivery. Accept: one message moves idempotently through received, processing, done/failed with fallback if edit is impossible.
- [ ] **PX-06 · P1 · gap** — Thread results to the originating Telegram message. Evidence: incoming `messageId` is stored but the client has no `reply_parameters`. Accept: output replies to request/ack; a missing-target 400 falls back exactly once without losing delivery.

## 7. Retention proof and data-loss prevention

- [ ] **CS-19 · P1 · confirmed** — Handle two persisted incoming paths without false deletion or leaks. Evidence: `src/retention/policy.ts:223-233,295-323` shares one `file_uid`. Accept: both files are independently proven/deleted and `deleted_at` is set only after all required unlinks succeed.
- [ ] **CS-20 · P0 · confirmed** — Revalidate retention eligibility at apply time. Evidence: `src/retention/policy.ts:45-49,295-307` separates plan from deletion. Accept: a new reference/job/outbox fact between plan and apply prevents deletion in a race test.
- [ ] **CS-21 · P0 · gap** — Protect incoming source files while linked work is pending, leased or dead. Evidence: retention eligibility does not join the incoming job lifecycle in `src/retention/policy.ts:237-245`; ingestion is `src/cli/daemon.ts:915-939`. Accept: source survives until every dependent delivery/transcription fact is terminal and proven.
- [ ] **CS-22 · P2 · confirmed** — Stop double-counting incoming bytes. Evidence: retention sums both quarantine and normalized `actual_bytes` for the same logical source. Accept: plan totals equal filesystem bytes in a two-path fixture.
- [ ] **CS-23 · P2 · confirmed** — Do not report bytes freed when `rm(force)` finds no file. Evidence: `src/retention/policy.ts:300-310` counts historical size after a missing path. Accept: result distinguishes already-missing from deleted-now and totals only confirmed unlinks.
- [ ] **CS-24 · P2 · confirmed** — Derive blocked-retention reasons from real facts. Evidence: fallback copy does not query the actual job/outbox/transcript blocker. Accept: every reported reason is backed by a row and the test covers each blocker.

## 8. Schema migrations and upgrade compatibility

- [x] **CS-25 · P1 · fixed-in-eff3dc1** — Exercise a real previous-schema upgrade. Evidence: `tests/unit/database.test.ts` in `eff3dc1` builds a migration-005 database, applies migration 006 and verifies alert/outbox reconciliation. Accept: fixture remains data-preserving and idempotent.
- [ ] **CS-26 · P2 · gap** — Record and verify migration SQL checksums. Evidence: `src/database/db.ts:82-109` stores only migration names. Accept: modified applied SQL fails with an actionable integrity error; unchanged history opens normally.
- [x] **CS-27 · P1 · fixed-current** — A read-only ledger guard runs before WAL and migrations and requires the canonical ledger shape plus an exact contiguous local prefix, refusing malformed values, gaps and unknown/future names with an upgrade/downgrade explanation. Evidence: `src/database/db.ts`, `tests/unit/database.test.ts`.
- [ ] **CS-28 · P1 · verify-live** — Define pre-migration integrity and backup policy. Evidence: `openDatabase` migrates immediately. Accept: documented backup/integrity gate is atomic enough for SQLite and failure recovery is tested on a copied fixture.
- [x] **CS-29 · P1 · fixed-current** — Partial unique indexes protect both session and incoming current pointers; migration 014 repairs legacy duplicates by keeping the highest revision without deleting history. Evidence: `src/database/migrations/014_current_transcript_uniqueness.sql`, `tests/unit/database.test.ts`.
- [x] **RO-19 · P1 · fixed-in-eff3dc1** — Retire legacy ASR-backlog alert state during the fingerprint migration. Evidence: `eff3dc1` migration 006 resets `asr_backlog` and fails pending legacy alert rows; its upgrade test covers it. Accept: upgrade emits neither false recovery nor stale warning.

## 9. Health signals, alerts and bounded observability

- [x] **CS-08 · P2 · fixed-in-eff3dc1** — Fingerprint ASR/LLM alert causes instead of one outage constant. Evidence: `eff3dc1` daemon uses stable cause categories/model identity. Accept: unchanged cause stays quiet and a materially changed cause produces one `changed` edge.
- [x] **CS-34 · P1 · fixed-current** — `health_events` stores status edges and hourly problem samples, prunes after 30 days and enforces a 5,000-row hard cap. Evidence: `src/health/monitor.ts`, `tests/unit/health-monitor.test.ts`.
- [x] **CS-35 · P1 · fixed-current** — Disk probe failure is explicit unhealthy state; SQLite writability uses a rolled-back main-database insert. Evidence: `src/health/monitor.ts`, `tests/unit/health-monitor.test.ts`.
- [x] **RO-13 · P1 · fixed-current** — A day-long unchanged outage produces bounded hourly samples plus exact raised/recovered status edges. Evidence: `tests/unit/health-monitor.test.ts`.
- [x] **RO-14 · P1 · fixed-current** — `statfs` failure renders a stable failure in `/health`, status and proactive alert copy, never infinite free space. Evidence: `tests/unit/health-monitor.test.ts`, `tests/unit/health-boundary.test.ts`.
- [x] **RO-15 · P1 · fixed-current** — The SQLite probe writes inside a savepoint and rolls back; query-only storage fails without persistent mutation. Evidence: `tests/unit/health-monitor.test.ts`.
- [x] **RO-18 · P1 · fixed-in-eff3dc1** — Make ASR/LLM alert fingerprints cause-sensitive. Evidence: `src/cli/daemon.ts` in `eff3dc1` fingerprints typed categories and configured model. Accept: one ongoing outage changes notification only when its actionable cause changes.
- [x] **PX-35 · P0 · fixed-in-eff3dc1** — Fingerprint dead-job generations, not only row identity. Evidence: `src/jobs/diagnostics.ts` in `eff3dc1` hashes job id, update time and last error. Accept: retry then failure before a clear edge alerts once as changed.
- [x] **PX-40 · P1 · fixed-in-eff3dc1** — Separate pending/dead jobs and dead outbox in local and Telegram status. Evidence: `src/cli/daemon.ts` in `eff3dc1`, `src/cli/main.ts` and `src/telegram/report.ts`. Accept: mixed failures are never mislabeled as ASR backlog and local detail command is shown.

## 10. Worker process lifecycle and wake races

- [x] **RO-01 · P0 · fixed-in-eff3dc1** — Fence and retire a worker after request timeout. Evidence: `src/asr/worker-process.ts` in `eff3dc1` retires the exact child and rejects all pending work; regression starts a fresh generation. Accept: stale handlers are no-ops and the next request uses a new process.
- [ ] **RO-02 · P1 · confirmed** — Wait for a real spawn handshake before resolving startup. Evidence: `src/asr/worker-process.ts:52-104` can resolve before asynchronous `ENOENT`. Accept: missing executable returns `missingWorkerHint` deterministically.
- [ ] **RO-03 · P1 · confirmed** — Await bounded worker exit with SIGKILL escalation. Evidence: `src/asr/worker-process.ts:132-143` sends termination without awaiting close. Accept: shutdown resolves only after exit or a tested hard-kill deadline.
- [ ] **RO-11 · P0 · verify-live** — Close the sleep/wake capture race. Evidence: sleep detection and capture loop are independent in `src/cli/daemon.ts:292-295,1017-1033`. Accept: a wake barrier is established before post-wake frames and a real sleep/wake drill loses no first speech.

## 11. launchd installation, shutdown and log lifecycle

- [ ] **CS-31 · P1 · gap** — Strengthen daemon PID identity beyond a command substring. Evidence: `src/cli/daemon.ts:1462-1516` and `src/cli/main.ts:364-390`. Accept: PID reuse cannot signal another OpenMurmur process; identity includes start time/executable or launchd ownership.
- [ ] **CS-33 · P1 · verify-live** — Prove bounded shutdown across encoder, ASR worker and Telegram loop. Evidence: components have independent waits. Accept: one deadline escalates stuck children, persists recoverable state and exits predictably in an injected-wedge test.
- [ ] **RO-07 · P1 · gap** — Add a real local launchd readiness preflight. Evidence: `scripts/install-launch-agents:17-30` only prompts. Accept: Node, paths, config, permissions and plist tools are checked before mutation.
- [ ] **RO-08 · P1 · confirmed** — Install plists atomically with rollback. Evidence: `scripts/install-launch-agents:40-51` overwrites before lint. Accept: temp file passes `plutil` before rename; failed bootstrap restores the previous service.
- [ ] **RO-09 · P1 · confirmed** — Detect stale absolute Node/repository paths in installed plists. Evidence: `scripts/install-launch-agents:9-12,43-46`. Accept: status names the mismatch and offers an explicit local reinstall.
- [ ] **RO-10 · P1 · gap** — Bound launchd stdout/stderr logs. Evidence: plist log paths and `PRIVACY.md:70` have no rotation. Accept: size/count policy prevents unbounded private local logs and is documented.
- [ ] **RO-12 · P1 · gap** — Add local service status/start/stop/restart with crash-loop diagnosis. Evidence: a successful intentional stop remains down under current plist semantics. Accept: commands are local-only, truthful and distinguish stopped, crashed and restart-throttled.

## 12. Side-effect-free doctor and local dependency recovery

- [x] **CS-40 · P0 · fixed-in-eff3dc1** — Keep speech detection in `doctor` offline/read-only. Evidence: `src/cli/backends.ts` in `eff3dc1` adds `uv run --no-sync` and doctor reuses those args. Accept: missing environment produces guidance without creating/syncing one.
- [x] **RO-30 · P0 · fixed-in-eff3dc1** — Prevent daemon worker startup from implicit uv sync. Evidence: `src/cli/backends.ts` in `eff3dc1` uses `--no-sync`. Accept: runtime never downloads or mutates dependencies; provisioning is a separate explicit command.
- [x] **RO-31 · P0 · fixed-in-eff3dc1** — Make the default doctor match its read-only/no-download claim. Evidence: `src/cli/doctor.ts` in `eff3dc1` reuses offline worker args. Accept: filesystem/network trace shows no package sync, model pull or repair write.
- [ ] **RO-32 · P0 · gap** — Diagnose MLX package/model cache/disk without loading or downloading the model. Evidence: `src/cli/doctor.ts:136-202` checks VAD only. Accept: default mode is side-effect-free; an explicitly requested deep mode is separately labelled.
- [ ] **RO-33 · P1 · confirmed** — Add timeouts and termination escalation to doctor subprocesses. Evidence: `src/cli/doctor.ts:24-37,410-424`. Accept: wedged ffmpeg/uv/ollama cannot hang doctor indefinitely.
- [ ] **RO-34 · P1 · confirmed** — Split bootstrap into local plan/apply with explicit consent. Evidence: bootstrap auto-installs and uses `curl | sh` around `src/cli/doctor.ts:47-79`. Accept: plan is read-only, apply lists every mutation, and neither is bot-triggerable.
- [x] **RO-35 · P1 · fixed-in-eff3dc1** — Base recovery guidance on the stored failure cause, not only the job kind. Evidence: `src/jobs/diagnostics.ts` in `eff3dc1` classifies dependency, transport, missing-source, timeout, disk and internal failures. Accept: corrupt/missing audio never suggests reinstalling ASR, and dependency advice is shown only for the matching category.
- [ ] **RO-36 · P1 · gap** — Add a no-send/no-offset Telegram diagnostic. Evidence: doctor Keychain check is generic while `telegram test` sends and poll mutates. Accept: local command checks Keychain readability and `getMe` only, with explicit network disclosure.
- [x] **PX-38 · P0 · fixed-in-eff3dc1** — Replace the blocking `ollama serve && ollama pull` recovery chain. Evidence: `eff3dc1` doctor/install docs use `brew services start ollama`, then pull. Accept: install, service start and model pull are separate, copyable, readiness-aware steps.

## 13. Privacy, safe diagnostics and repair boundaries

- [ ] **RO-17 · P1 · gap** — Expose host-local Keychain states without leaking secrets. Evidence: `src/cli/daemon.ts:1251-1297` only logs failures. Accept: status distinguishes missing, locked, denied and readable with local repair guidance.
- [x] **RO-26 · P1 · fixed-in-eff3dc1** — Keep raw stored errors and paths out of Telegram. Evidence: `src/jobs/diagnostics.ts` in `eff3dc1` emits typed public causes and bounded/redacted text; technical detail is local CLI only. Accept: token/path/control-byte fixtures never reach chat.
- [x] **RO-27 · P1 · fixed-in-eff3dc1** — Validate configured Ollama identifiers before rendering a copyable command. Evidence: `eff3dc1` diagnostics allowlist the model syntax. Accept: unsafe value produces a non-executable correction message.
- [ ] **RO-28 · P1 · confirmed** — Audit and explicitly repair existing directory permissions. Evidence: `src/config/load.ts:33-37` sets mode only on creation. Accept: existing broad modes are reported; consented repair sets owner-only access without touching unrelated paths.
- [ ] **RO-29 · P0 · confirmed** — Document Hugging Face/model provisioning network access truthfully. Evidence: `PRIVACY.md:31-46` names only Telegram while Python/MLX code can download models. Accept: default runtime stays offline; explicit prefetch describes endpoints, cache, size and privacy.
- [x] **PX-37 · P0 · fixed-in-eff3dc1** — Send only classified, bounded job causes plus host/kind/action. Evidence: `eff3dc1` diagnostics and tests separate Telegram-safe reason from local technical detail. Accept: no secret or absolute path leaks in chat.
- [x] **PX-39 · P0 · fixed-in-eff3dc1** — Preserve the local-only repair boundary. Evidence: `eff3dc1` diagnostics and `README.ru.md` recommend local commands and explicitly deny bot execution. Accept: no Telegram route spawns shell, installs, starts services, pulls models or controls recording.

## 14. Multi-host Telegram ownership and fleet identity

- [ ] **CS-41 · P0 · confirmed** — Make `telegram poll` peek-only by default. Evidence: `src/cli/main.ts:647-659` writes the next offset despite “show what would be handled”. Accept: diagnostics cannot consume production updates; any destructive advance is explicit and owner-only.
- [ ] **RO-20 · P0 · confirmed** — Refuse offset mutation from shared/send-only diagnostics. Evidence: the poll command persists offset. Accept: dev inspection on a shared token cannot steal input from production.
- [ ] **RO-37 · P0 · gap** — Require an explicit input-owner or send-only role. Evidence: `src/config/schema.ts:223-233` defaults `receiveUpdates` true while `docs/TELEGRAM.md:55-63` relies on operator discipline. Accept: ambiguous configuration fails closed.
- [ ] **RO-38 · P0 · confirmed** — Keep send-only Telegram setup free of `getUpdates`. Evidence: `src/cli/setup.ts:124-163` drains/waits and CLI ignores role. Accept: send-only setup validates send capability with zero polling calls.
- [ ] **RO-39 · P1 · gap** — Label operational messages with instance label, host and role. Evidence: daemon/sleep notices are hostless. Accept: every fleet-relevant alert identifies the exact Mac and whether it owns input.
- [ ] **RO-40 · P1 · gap** — Make `/status`, `/health` and `/settings` explicitly host-local. Evidence: `docs/TELEGRAM.md:245-253` has owner-only settings but no fleet selector. Accept: UI copy cannot imply aggregate fleet state; send-only keyboards are absent.
- [ ] **RO-41 · P0 · verify-live** — Run the real two-Mac ownership drill. Evidence: coordination is documented but unverified. Accept: one token has one consumer, dev is send-only, outputs are labelled and no host can remotely control/install on another.
- [ ] **PX-10 · P1 · gap** — Add a trusted optional instance label such as prod/dev. Evidence: only system hostname is persisted. Accept: label is config-derived, display-only, stored with provenance and never comes from transcript/user filename.
- [ ] **PX-13 · P0 · confirmed** — Show source kind and processing host on every output. Evidence: `live_capture`/`telegram_audio` exist in `src/telegram/provenance.ts`. Accept: live, direct and forwarded input are unambiguous across both Macs.
- [ ] **PX-14 · P0 · gap** — Productize single-owner token configuration and recommend a separate dev bot. Evidence: `docs/BACKLOG.md` leaves ownership operator-only. Accept: setup enforces one owner, send-only siblings and a documented low-friction dev-bot path.

## 15. Compact Telegram transcript, report and audio UX

- [ ] **PX-01 · P1 · verify-live** — Verify expandable blockquotes on real Telegram clients. Evidence: `src/telegram/format.ts:134-152` renders them. Accept: short Russian, Thai and CJK text starts collapsed and opens in one tap without nested spoiler breakage.
- [ ] **PX-02 · P1 · confirmed** — Lock long-transcript delivery to one complete document. Evidence: `src/jobs/delivery.ts:339-380`. Accept: content above the limit yields exactly one `.md`, no chat chunks and no truncation.
- [ ] **PX-03 · P1 · confirmed** — Lock long-report delivery to one bounded preview plus one complete artifact. Evidence: `src/jobs/delivery.ts:424-462`. Accept: chat stays compact and `.report.md` contains the full timed/role-aware report.
- [ ] **PX-04 · P0 · confirmed** — Preserve independent audio-first delivery. Evidence: `src/jobs/delivery.ts:30-71`. Accept: blocked ASR/LLM never delays eligibility or upload of source audio.
- [ ] **PX-07 · P1 · gap** — Offer an optional labelled mobile playback preview without replacing the source. Evidence: FLAC is sent as a document in `src/jobs/delivery.ts:121-162`. Accept: original bytes remain downloadable; derived preview is optional, clearly marked and independently retryable.

## 16. Provenance, filenames and cross-message correlation

- [ ] **PX-08 · P1 · confirmed** — Preserve live capture host, timezone, wall time and UID through retry/migration. Evidence: `src/telegram/provenance.ts:4-40,80-88`. Accept: rendered provenance is identical after retry and legacy unknowns remain unknown.
- [ ] **PX-09 · P1 · confirmed** — Keep original, forwarded and bot-received dates distinct. Evidence: ingestion persists filename/IDs and `forward_origin.date` separately in `src/cli/daemon.ts:1555-1586`. Accept: no renderer conflates them or substitutes current time/host.
- [ ] **PX-11 · P2 · gap** — Generate a trusted readable output filename. Evidence: current output uses raw `basename(part.path)`. Accept: filename contains capture date, instance label and short UID, with no transcript or untrusted source path input.
- [ ] **PX-12 · P1 · gap** — Add one compact correlation tag across artifacts. Evidence: chat exposes full UUIDs inconsistently. Accept: audio, transcript, report and status share a short collision-safe tag while full UID remains in provenance/file metadata.

## 17. ASR language controls and detection semantics

- [ ] **PX-15 · P1 · confirmed** — Preserve the real Qwen control surface: Auto or one forced language. Evidence: `src/telegram/settings.ts:40-86` and config validation. Accept: only Auto/TH/RU/EN/ZH states exist; no multi-select or priority-order claim.
- [ ] **PX-16 · P1 · gap** — Separate model-reported language from observed script. Evidence: `src/asr/languages.ts:1-76` maps Latin to English despite acknowledged ambiguity. Accept: Latin script is not presented as proven English and conflicting evidence is visible.
- [ ] **PX-17 · P1 · confirmed** — Remove priority-list/allowlist promises from UI and docs. Evidence: current Qwen API supports auto or one forced language. Accept: copy accurately explains the override and its future-job scope.
- [ ] **PX-18 · P1 · gap** — Add safe retranscription of retained source as an immutable revision. Evidence: `docs/BACKLOG.md` leaves this in UX-07. Accept: one callback creates a revision chain, keeps old output and handles missing/other-host source truthfully.
- [ ] **PX-19 · P0 · confirmed** — Preserve language-setting snapshot per job/revision. Evidence: `src/sessionizer/recorder.ts:43,269` and `src/cli/daemon.ts:868-913`. Accept: changing settings after enqueue cannot alter retry behavior.
- [ ] **PX-20 · P2 · gap** — Label settings controls as future-only. Evidence: current hint carries the semantics but keyboard labels do not. Accept: “Для следующих” is explicit; “Перераспознать эту” is a separate future action.
- [ ] **PX-21 · P2 · gap** — Support a bounded per-host vocabulary snapshot only after corpus evidence. Evidence: context exists only in config schema. Accept: no transcript-driven automatic learning; a RU/TH/EN/zh corpus A/B demonstrates measurable benefit before defaulting it.

## 18. Timestamp and diarization truth

- [ ] **PX-22 · P1 · gap** — Render persisted timestamp provenance. Evidence: `timestampSource` is stored but omitted from reports. Accept: user sees aligner, coarse or none; no precision is implied beyond the source.
- [ ] **PX-23 · P0 · gap** — Stop labelling unsupported upstream timestamps as VAD. Evidence: `python/openmurmur_audio/src/openmurmur_audio/asr/__init__.py:244-259` relabels without VAD facts. Accept: `vad` appears only with real VAD boundaries; otherwise store coarse/none.
- [ ] **PX-24 · P1 · gap** — Correct Thai timing claims. Evidence: official aligner excludes Thai while docs imply VAD-derived timing. Accept: no Thai word-time claim; coarse segment boundaries appear only with an identified source.
- [ ] **PX-25 · P1 · confirmed** — Keep diarization identity-free. Evidence: `docs/adr/0008-speaker-diarization.md` specifies `Голос N` and no identity. Accept: no names or semantic roles are inferred; unattributed speech stays unlabelled.
- [ ] **PX-26 · P2 · gap** — Add a persisted technical-quality block to reports. Evidence: reports list languages but omit model/mode/timing/diarization facts. Accept: block uses stored facts only and never invents confidence percentages.
- [ ] **PX-27 · P1 · verify-live** — Measure diarization before enabling it by default. Evidence: ADR calls current behavior plausible but unmeasured. Accept: hand-labelled real RU/TH/EN room corpus publishes DER and failure cases.
- [ ] **PX-28 · P2 · gap** — Make per-part speaker renumbering explicit. Evidence: ADR notes speakers reset across physical parts. Accept: current UI says so; cross-part continuity requires a measured embedding design before implementation.

## 19. Russian product surface and stable public copy

- [ ] **PX-29 · P1 · confirmed** — Keep user-facing Telegram/report chrome consistently Russian while canonical engineering docs/code stay English. Evidence: Russian bot/owner README and `README.md:305-309`. Accept: inline and `.md` labels do not switch language; user content is never auto-translated.
- [ ] **PX-30 · P1 · gap** — Finish stable Russian rejection/health copy. Evidence: `docs/BACKLOG.md` UX-08 remains incomplete. Accept: each public cause has a stable code/message; raw exception stays local.
- [ ] **PX-31 · P2 · gap** — Localize all official Qwen language labels. Evidence: TypeScript labels cover only a subset of the model's languages. Accept: every supported code has a canonical Russian label and unknown is explicit.
- [ ] **PX-32 · P2 · gap** — Configure the Russian Telegram bot profile and scoped commands. Evidence: client sets commands but not localized name/description/empty-chat onboarding. Accept: Bot API profile is configured and visually verified without changing user content.
- [ ] **PX-33 · P2 · confirmed** — Keep `README.ru.md` as a curated owner guide, not a fragile full mirror. Evidence: it already exists and links canonical docs. Accept: quickstart/privacy/two-host/recovery remain current and links are checked.
- [ ] **PX-34 · P2 · gap** — Centralize a small stable public-copy catalogue without a full i18n framework. Evidence: user strings are distributed and no second locale is required. Accept: high-risk status/error labels have snapshots and one source of truth.

## 20. Automated evidence, documentation truth and live release gates

- [x] **CS-36 · P1 · fixed-in-eff3dc1** — Add process-level failed-job CLI coverage. Evidence: `tests/integration/cli-jobs.test.ts` in `eff3dc1` exercises list, selected retry and unsupported kind. Accept: test runs in the normal offline suite and asserts exit codes/output/state.
- [x] **CS-37 · P2 · fixed-in-eff3dc1** — Remove or mechanically derive brittle README test counts. Evidence: `README.md` now names the offline suites without a hand-maintained total. Accept: exact command/result remains revision evidence rather than drifting product copy.
- [x] **CS-38 · P2 · fixed-in-eff3dc1** — Align backlog completion icons with verification truth. Evidence: UX-09 remains yellow until live Telegram/dependency recovery is verified. Accept: the legend distinguishes implemented-offline from live-verified.
- [x] **CS-39 · P2 · fixed-in-eff3dc1** — Update the canonical data model for actual job failure and fingerprint transitions. Evidence: `docs/DATA_MODEL.md` now documents pending retry, dead/manual retry and atomic fingerprinted alert edges. Accept: schema, state diagram and tests describe the same lifecycle.
- [x] **PX-36 · P0 · fixed-in-eff3dc1** — Provide selected local retry and failed-job inspection. Evidence: `eff3dc1` CLI/queue add `jobs failed` and `jobs retry JOB_ID`, refuse unsupported kinds and revive ASR state. Accept: no retry-all and retry happens only after operator repair.
- [ ] **PX-41 · P1 · gap** — Make the verification matrix and test evidence non-drifting. Evidence: README uses manual counts and mixes offline/live statements. Accept: automated offline evidence is revision-bound; mic/Qwen/Telegram/launchd/two-Mac gates are separately dated and never inferred from fakes.
