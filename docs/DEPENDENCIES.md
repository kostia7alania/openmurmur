# Dependencies

All versions below were **verified on the development machine on 2026-08-09**
(macOS 26.5.2, Apple Silicon), unless the row says otherwise. Anything not
actually executed is marked explicitly rather than assumed.

## Runtime

| Component | Pinned | Verified | Notes |
| --- | --- | --- | --- |
| Node.js | 26.7.0 | ✅ executed | Current, **not yet LTS** — see [ADR-0001](adr/0001-node-26.md). |
| TypeScript | 7.0.2 | ✅ `tsc --noEmit` exits 0 | Ships as `tsc`, not `tsgo`. |
| pnpm | 10.19.0 | ✅ `pnpm install` succeeded | 11.17.0 is the latest published version; 10.19.0 is what is installed here and what `packageManager` pins, so the lockfile matches a manager that was actually run. |
| Biome | 2.5.6 | ✅ `biome check` exits 0 | Replaces ESLint + Prettier — see [ADR-0005](adr/0005-biome-over-eslint.md). |
| `@types/node` | 26.1.2 | ✅ | Latest published. |
| SQLite (`node:sqlite`) | **3.53.4** | ✅ queried at runtime | Compiled into Node 26.7.0 — see [ADR-0004](adr/0004-sqlite-driver.md). |
| FFmpeg / ffprobe | 8.1.2 | ✅ used in integration tests | `brew install ffmpeg`. |
| Python | 3.14.5 | ✅ 36 tests pass | Current project interpreter with wheels across the whole stack. |
| uv | 0.11.14 | ✅ current `uv --version`; `uv sync` succeeded | |

## Node packages

Only three, all dev-only. There are **no runtime npm dependencies**: HTTP is
Node's `fetch`, argument parsing is `node:util.parseArgs`, SQLite is
`node:sqlite`, the test runner is `node:test`.

```json
{
  "@biomejs/biome": "2.5.6",
  "@types/node": "26.1.2",
  "typescript": "7.0.2"
}
```

Exact versions, no ranges. `pnpm-lock.yaml` is committed.

### Isolated no-Corepack bootstrap — 2026-08-12

A fresh disposable checkout ran the production `scripts/bootstrap` with a
private HOME, npm prefix/cache, pnpm store, uv cache and XDG directories. Its
PATH exposed the validated Node 26.7.0 runtime with SQLite 3.53.4 and the real
adjacent npm 11.19.0, plus existing uv and FFmpeg prerequisites; neither pnpm
nor Corepack was available before the run.

Bootstrap invoked the real npm exactly once as
`install --global pnpm@10.19.0`. The installed pnpm metadata and executable
reported 10.19.0 from inside the private prefix, then completed the frozen
Node lockfile and the 20-package CI-safe Python environment. TypeScript 7.0.2,
numpy 2.5.1, onnxruntime 1.28.0 and soundfile 0.14.0 were usable, and the
product CLI reported version 0.1.0. All inspected dependency and environment
symlinks resolved inside the disposable root.

A second invocation forced npm, pnpm and uv offline. It completed with the
Node tree already current and uv checking the same 20 packages; the npm call
log still contained only the original exact pnpm installation. Both the fresh
checkout and the working repository remained clean.

This closes the real exact-pnpm/no-Corepack and idempotent dependency-bootstrap
boundary. It is not a clean-Mac proof: Node, uv and FFmpeg were preinstalled,
and the run did not provision MLX weights, Ollama, native capture permission,
state, Keychain or Telegram. Those remain D004/D101 and the live release gates.

### Homebrew-only Node bootstrap — 2026-08-12

A second private, disposable checkout ran the current production bootstrap with
a `PATH` that initially contained no Node executable. Before any install, the
script used fixed macOS `plutil` to validate every field in the runtime contract.
A scripted Homebrew boundary recorded exactly one `brew install node`, exposed
the real Node 26.7.0/npm pair through `brew --prefix node`, and the ordinary
runtime validator then confirmed embedded SQLite 3.53.4. The contract tuple was
unchanged across the pre-Node and Node phases.

The same production run installed pnpm 10.19.0 into a private npm prefix, ran
the frozen Node dependency install and the CI-safe Python sync, with pnpm and uv
forced offline. A second bootstrap with npm also forced offline completed
without another Homebrew or npm install. The checkout's bootstrap and runtime
contract matched the reviewed working-tree snapshot; the original repository
was not mutated.

This closes D004 at the repository bootstrap control-flow boundary: a Mac that
already has Homebrew no longer needs a separately installed Node merely to run
the installer. The scripted Homebrew boundary does not claim a physical clean
Mac download, Command Line Tools, Homebrew itself, model provisioning or final
`doctor` readiness; that complete machine gate remains D101.

## Python packages

| Package | Pinned | Verified | Purpose |
| --- | --- | --- | --- |
| numpy | 2.5.1 | ✅ imported | Array handling. Requires ≥ 3.12. |
| onnxruntime | 1.28.0 | ✅ imported | Silero VAD inference. **Publishes cp311–cp314 only**, which is what caps Python at 3.14. |
| soundfile | 0.14.0 | ✅ imported | Audio file reading. |
| pytest | 9.1.1 | ✅ 36 tests pass | |
| ruff | 0.16.0 | ✅ clean | Lint and format. |
| mypy | 2.3.0 | ✅ strict, clean | |

### Optional `mlx` extra — installed and run on the development machine, never in CI

| Package | Pinned | Status |
| --- | --- | --- |
| mlx | ≥0.32.0,<0.33 | ✅ Installed and run (M4 Max, 36 GB). Wheels cp310–cp314, macOS arm64. |
| mlx-qwen3-asr | ≥0.3.5,<0.4 | ✅ Qwen3-ASR-1.7B loads in ~5 s and stays resident; RU/EN/TH transcribed. Its `context` biasing is used; its built-in `diarize` is not — see below. |
| silero-vad | ≥6.2.1,<7 | ✅ ONNX model run per frame in the live capture path. |
| sherpa-onnx | ≥1.13.4,<2 | ✅ Speaker diarization, run on real recordings. RTF ~0.08. |
| sherpa-onnx-core | ≥1.13.4,<2 | ✅ Named explicitly: resolving the extra installed only the wrapper, and the native module then failed to load its bundled `libonnxruntime`. Carries its own onnxruntime; does not conflict with the pin above. |

Kept as an extra because it pulls several GB (torch and torchaudio come with
`silero-vad`) and MLX needs Metal, so CI must not install it. CI therefore runs
the fake adapters, and the worker's error path for a missing install is what CI
verifies: an actionable `model_load_failed` or `vad_unavailable` naming the
`uv sync --extra mlx` command.

**The extra is not optional in practice.** Without it there is no speech
detection and no transcription — `pnpm openmurmur doctor` reports
`speech_detection` as a failure, because it starts the worker and scores a frame
rather than reading the config back.

Doctor now reports ASR readiness separately as `mlx_readiness`. That check is
metadata-only: it never imports Python packages, loads weights, contacts the
network or writes to the Hugging Face cache. It distinguishes:

- whether the project Python executable is non-empty and the installed
  distribution metadata names exactly `mlx` and `mlx-qwen3-asr`;
- whether the configured model has local snapshot evidence: readable metadata
  and every weight shard named by its index are present, together with the
  `vocab.json` and `merges.txt` files required by the MLX tokenizer;
- whether the cache volume has at least 6 GB free, or its free space could not
  be determined.

The human-readable result never prints the environment or cache path. A missing
snapshot is blocking because unattended work must not obtain multi-gigabyte
weights. Provision it only with the explicit foreground `hf download` command
in [INSTALL.md](INSTALL.md#7-the-local-model-stack), then rerun doctor. The
default snapshot occupied about 4.4 GiB when measured on the development
machine; the readiness threshold keeps at least 6 GB free. `speech_detection`
remains the separate live, local Silero frame probe; it does not load the ASR
model.

Every Python worker gets `UV_OFFLINE=1`, `HF_HUB_OFFLINE=1`, telemetry and
implicit-token use disabled, and only the cache-location variables it needs.
`uv run --no-sync` does not sync packages. A missing environment or cache
therefore fails locally instead of turning daemon startup, `doctor` or a job
retry into a network operation.

The runtime environment is fixed at `python/openmurmur_audio/.venv`.
`UV_PROJECT_ENVIRONMENT` is deliberately not inherited by `doctor`, daemon or
launchd: installing the extra elsewhere must fail readiness instead of making
an interactive shell and the background runtime inspect different packages.

### Real Silero startup gate — 2026-08-12

A private-root production `Daemon` used the real cached Silero/ONNX worker and
a synthetic local PCM capture helper. The helper was constructed to refuse to
start unless the daemon had already recorded both readiness milestones. The
resulting exact order was `speech detection ready` → `daemon started` → capture
helper spawn → first PCM frame. The real warm-up frame completed in 791.2 ms,
inside the production scorer's five-second timeout; the first source frame
arrived 881.9 ms after startup began.

Only after that frame did the daemon durably enqueue the single truthful
`🟢 Запись включена` status. Orderly stop reaped the capture process and the
observed VAD worker tree, removed the PID mirror and SQLite ownership, and left
no sessions, parts, journal rows, jobs or leases. SQLite integrity was `ok`
with zero foreign-key violations.

This closes the real local readiness and causal startup boundary, not
microphone/TCC/native-helper behavior, live device cadence, timeout fallback,
Telegram delivery or launchd.

### Real source-gap isolation — 2026-08-12

A private 0700 root drove the production `ProcessPcmCapture`, `Recorder`,
SQLite repositories and real FFmpeg encoder from one synthetic OS child. The
child emitted distinguishable A, C and D PCM values around two real source
pauses of 871 ms and 519 ms. Delayed VAD kept pre-gap PCM queued while the
capture pump advanced independently.

Only 8 of 12 A frames reached the first finalized lossless FLAC; the queued
tail was discarded when the first gap advanced the stream epoch. One C frame
entered the fresh speech candidate, then the second gap reset that candidate
before D arrived. Independent FFmpeg decoding found exactly 4,096 samples, all
`+12000`, in the first artifact and exactly 6,144 samples, all `-12000`, in the
second. No C sample and no A sample crossed into the D session.

SQLite contained exactly two non-overlapping, exact-timing `PROCESSING`
sessions with one finalized hash/byte-matching part each, two ASR plus two audio
delivery jobs and the expected start/finalized lifecycle statuses. Leases,
finalization journal and temp directory were empty; the source child was reaped
and SQLite integrity/foreign-key checks were clean.

This closes D012 once the current source-gap heuristic fires. It does not prove
that the 250 ms threshold matches real AVFoundation chunk cadence; that live
microphone calibration remains D014.

### Current-revision Qwen smoke — 2026-08-11

Revision `fd333d0` ran the existing `transcribe` CLI through the production
`MlxAsr` and `WorkerProcess` against 4.510 seconds of locally synthesized English
speech. The cached `Qwen/Qwen3-ASR-1.7B` model returned the sentence exactly,
language `en`, and 11 word-level `aligner` segments in 3.63 seconds. macOS
`/usr/bin/time -l` reported 6,159,007,744 bytes (about 5.74 GiB) maximum RSS.
The worker used the enforced uv and Hugging Face offline settings; no
provisioning command ran.

This proves the current local package, cache, tokenizer, aligner and real-model
CLI path. It does **not** prove microphone capture, daemon job scheduling,
Telegram delivery or the complete release path.

### Current Qwen readiness and worker-reuse smoke — 2026-08-11

With the same offline package and cache, the production `MlxAsr.ready()` path
transitioned from explicit `recovering` to exact loaded readiness in 823 ms;
the model load acknowledgement reported 635 ms. Health inspection itself did
not start the worker. A separate process-fault run completed one real
transcription, killed the owned Python worker, observed the explicit failed
health state, and then completed four more real transcriptions through one
replacement worker generation. Those four calls took 2.506 s, 1.392 s,
1.388 s and 1.424 s. After the first replacement call, the measured worker-tree
RSS stayed near 867 MiB with 432 KiB growth across the remaining warm calls.
Every observed worker process was gone after `close()`.

This proves bounded real-model readiness, replacement-worker recovery and a
bounded warm RSS profile for the production backend.

### Real worker death inside queued ASR — 2026-08-12

An external disposable harness drove the production `JobQueue`, renewable
lease wrapper, `handleJob` ASR pipeline and one reusable `MlxAsr` against two
locally synthesized English FLAC sessions with the enforced offline worker
environment. After readiness completed in 777 ms, the harness sent `SIGKILL`
to the actual Python PID 75 ms after the first leased `transcribe` began. The
handler failed with worker exit code 137; the exact job returned to `pending`
at attempt 1 with no transcript revision, downstream job or Telegram outbox
fact.

While that row was in its ordinary backoff, the next queued ASR job spawned one
replacement MLX generation and completed in 3.255 s. The original row then
retried once on the same replacement generation and completed in 1.658 s. The
final ASR rows were `done` at attempts 2 and 1; each session had exactly one
current transcript revision, the four expected downstream jobs existed once,
no lease remained, both source FLAC SHA-256 values were unchanged, SQLite
integrity was `ok` with zero foreign-key violations, and both observed worker
trees were gone after close.

This closes the real worker-death `JobQueue` failure/retry boundary without a
permanent test fixture or network, microphone, Telegram credential or user
recording. It does **not** prove the complete long-running daemon service,
capture-to-delivery path or release gates D120–D122.

### Real daemon-owned worker reuse — 2026-08-12

A second private-root rehearsal instantiated the production `Daemon` itself,
not only its exported pipeline components. The recorder stayed alive on local
synthetic silence through the explicit energy VAD, Telegram secrets were a
null injected provider, the LLM was the explicit fake backend, and two
pre-seeded finalized sessions contained only locally synthesized English
speech. The ASR backend remained real MLX/Qwen with the same enforced offline
environment.

The daemon acquired its SQLite singleton ownership and PID mirror, then its
ordinary ASR timer claimed both jobs eight seconds apart. Each completed at
attempt 1 with exactly one non-empty current revision. The same Python PID was
observed after both jobs, proving the daemon reused its one loaded worker
generation instead of constructing a backend per job. Both source hashes were
unchanged. Orderly `Daemon.stop()` reaped the worker, cleared all leases,
released the exact SQLite ownership row and removed its PID mirror; SQLite
integrity remained `ok` with zero foreign-key violations.

This closes D039 and D086 at their daemon-owned real-model boundary. The
rehearsal did not use a microphone, Telegram, network, launchd, login/reboot or
sleep/wake, and it did not turn the synthetic capture stream into the seeded
sessions. Those complete capture-to-delivery and release gates remain live.

### Real-model source-audio-first eligibility — 2026-08-12

A separate private-root rehearsal ran the production `Daemon` with the real
offline MLX/Qwen backend, a null Telegram provider and one pre-seeded finalized
session containing locally synthesized English speech. Its independent 500 ms
delivery loop completed `deliver_audio` once and durably created the exact
pending source-audio outbox row while the independent ASR loop already held a
live lease and no transcript revision existed. The source part was finalized,
undeleted and still matched its recorded path and SHA-256 at that snapshot.

Real ASR then completed once and created exactly one current revision. The
audio-outbox `created_at` preceded the revision by about 2.85 seconds; the
source hash remained unchanged. Orderly shutdown left no leases, daemon
ownership or PID mirror, and SQLite integrity remained `ok` with zero
foreign-key violations.

This closes D032 only at the durable upload/outbox-eligibility boundary. The
outbox remained pending and the source part remained undelivered, so the run
does not claim a Telegram request or ACK, retention eligibility/deletion,
Recorder or microphone enqueue, oversized splitting, backlog fairness or
launchd behavior.

### Fresh-process scheduled digest — 2026-08-12

The exact production command rendered into the digest LaunchAgent — Node 26.7
running `src/cli/main.ts digest scheduled --root <root>` — was executed twice
as separate processes against one private disposable state root. No daemon,
launchctl, Telegram client, Keychain, microphone or network service participated.
The host calendar date was 2026-08-12 while the configured
`America/Los_Angeles` date was still 2026-08-11; the enabled schedule was due at
00:00 in that zone.

The first process selected 2026-08-11 and rolled one pre-seeded `DONE` session
into exactly one stored digest plus one pending `digest:2026-08-11` outbox row.
The snapshot retained the processing host, the one session, 420,000 ms of speech
and its stored summary/decision/task/question. The second fresh process exited
successfully with no output and left both rows' IDs, timestamps, serialized
payload bytes and SHA-256 values unchanged. No daemon ownership, PID mirror or
leased job appeared; SQLite quick/integrity checks were `ok` with zero
foreign-key violations.

This closes D071 at the independent production scheduler-command, timezone,
atomic enqueue and replay boundary. It does not prove a real launchd wake,
login/reboot scheduling or Telegram delivery; those remain D070, D098 and D122.

### Current-revision Ollama corpus — 2026-08-11

The production `OllamaLlm` ran the checked-in single-language RU/EN/TH
acceptance transcripts against the locally configured `qwen3.6:latest`
(digest `07d35212591fc27746f0a317c975a6d68754fb38e9053d82e25f06057af28522`)
with cloud access disabled. A
first run exposed a real language-control defect: the English transcript was
summarized in Italian. After making the required output language explicit in
the prompt contract, all three single-language summaries used the requested
language, carried bounded source-segment references and hit none of the corpus's forbidden facts.
The final three calls took 10.129 s, 9.026 s and 7.762 s.

The model still did **not** meet the checked-in exact-claim acceptance threshold.
A fresh run after adding a single-home field contract produced 50% exact recall,
50% exact precision, zero forbidden facts and 0/3 passing cases; the three calls
took 7.627 s, 8.134 s and 7.889 s. In that run every list fact used its intended
semantic field without task/commitment duplication or treating Acme as a place,
and EN/TH carried claim-level source references. Most exact misses were grounded
paraphrases or punctuation differences, but the RU summary also strengthened an
assigned task into a promise. A further RU-only repeat varied wording and again
classified budget context as a decision. The taxonomy prompt improves the common
shape but is not a stable proof of the 80% recall/100% precision target. D108
therefore remains partial rather than being presented as accepted model quality.

A bounded follow-up on 2026-08-12 held the checked-in corpus, production JSON
schema and adapter, model digest, `temperature=0` and `contextTokens=32768`
fixed, while enabling `think=true`. It ran sequentially as RU → EN → TH → RU
repeat, with each complete transcript exposed as source segment 0 and
`durationMs=0`. The three-case result remained 50% exact recall, 50% exact
precision, zero forbidden hits and 0/3 passing cases; the RU repeat was also
50%/50% with the same structured output. Calls took 76.741 s, 71.863 s,
67.189 s and 70.701 s, averaging about 71.6 s versus about 7.9 s for the prior
non-thinking three-case run. Because bounded thinking added roughly 9× latency
without improving the frozen gate, the production `think=false` default was not
changed. This is not a byte-identical A/B comparison: the older disposable
runner did not preserve its exact segment and duration inputs, and the tested
`qwen3.6:latest` tag is not the repository's `qwen3.6:27b` default.

The repository default model tag, mixed-language summaries and unknown language
labels were not live-quality-tested by this corpus.

On 2026-08-12 the corpus scorer was corrected before any further prompt change.
The fixture had always validated per-fact grounded `terms`, but the scorer then
ignored them and required the model to reproduce the complete canonical wording;
grounded paraphrases and punctuation changes therefore counted as both a miss
and an invention. The corrected scorer matches output claims one-to-one within
the exact semantic field only when every grounded term is present. Duplicate
output occurrences remain in the precision denominator, ambiguous gold term
signatures are rejected, and the zero-forbidden-fact boundary is unchanged.

With that frozen scorer, cloud-disabled Ollama and the same
`qwen3.6:latest` digest, one fresh non-thinking RU → EN → TH run plus one RU
repeat produced 18/18 grounded facts, 18/19 matched output claims, 94.7% claim
precision, zero forbidden hits and 2/3 passing cases. EN and TH each passed at
6/6 recall and 100% precision. Both RU calls were byte-identical at the
structured-fact level and failed at 6/7 precision because the model added
`Утвержден бюджет запуска — 50 000 рублей` to decisions even though the source
only states the budget amount. Manual review also found strengthened wording in
the RU synthesis (`Анна обязалась`, `Утвержден бюджет`), so the semantic scorer
is not being treated as a substitute for modality review. Calls took 16.711 s
(including cold load), 8.742 s, 8.322 s and 7.601 s with `temperature=0`,
`think=false`, `contextTokens=32768` and one complete source segment. D108 stays
partial: the corrected measurement removed test wording noise but preserved the
real repeatable model defect.

Silero's **segment-assembly logic** is separately covered by pure Python tests,
which take a list of probabilities and need no model.

**Diarization models are not pip packages.** Two ONNX files, ~44 MB, fetched by
`./scripts/fetch-diarization-models` from sherpa-onnx's GitHub releases. Chosen
over pyannote's own weights, which are better but **gated** behind an accepted
licence and a Hugging Face token — see [ADR-0008](adr/0008-speaker-diarization.md).

## External services

| Service | Version | Verified | Notes |
| --- | --- | --- | --- |
| Ollama | configured `qwen3.6:latest` (36B, Q4_K_M; digest above) | ⚠️ real single-language RU/EN/TH corpus executed; acceptance not met | Optional. Its absence degrades the report; it never blocks delivery. The repository default model tag remains unverified. |
| Telegram Bot API | Cloud, official | ⚠️ **no live calls made** | Response shapes are exercised with a scripted `fetch`. Blocked on a bot token, which only the owner can create. |

## How Python 3.14 was chosen

Not by version number. By what actually has wheels:

```
onnxruntime 1.28.0 → cp311, cp312, cp313, cp314   ← the binding constraint
mlx         0.32.0 → cp310..cp314, macOS arm64
numpy       2.5.1  → requires ≥ 3.12
```

Python 3.15.0b1 exists and `uv` can install it, but onnxruntime publishes no
cp315 wheels, so it would mean a source build of a large C++ project on every
developer's machine. 3.14.5 is the newest version the whole stack actually
supports. See [ADR-0002](adr/0002-python-runtime.md).

## Deliberately not used

| Rejected | Why |
| --- | --- |
| Node 18 / 20 | Below the project's stated floor. |
| TypeScript 5 | Superseded. |
| Express, NestJS | No HTTP server is needed. |
| Electron | A menu-bar app would triple the install size for no capability. |
| Telegraf, grammY | Six Bot API methods are needed, with strict control over retry and rate limiting, and no third-party code touching the token. |
| `request`, `axios`, `node-fetch` | Node has `fetch`. |
| Moment.js | Deprecated; `Intl` and `Date` suffice. |
| `cron` (the npm package) | launchd is the correct scheduler on macOS. |
| Docker | Cannot access AVFoundation or Metal from a Linux container on macOS. |
| `typescript-eslint` | Requires the TypeScript compiler API, which TS 7 does not expose stably. Downgrading TypeScript for a linter is the wrong trade — see [ADR-0005](adr/0005-biome-over-eslint.md). |
| CommonJS | ESM only. |

## Update policy

1. `dependabot.yml` proposes updates weekly.
2. CI must be green.
3. A model version change additionally requires the P1-06 canary corpus before
   it is accepted — a silent quality regression in ASR is much worse than a
   build failure.
4. Update this file with the new version **and the date it was verified**.

## Re-verification

```bash
pnpm run check
```

```bash
uv run --project python/openmurmur_audio pytest
```

```bash
pnpm openmurmur doctor
```
