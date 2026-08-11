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
The repository default model tag, mixed-language summaries and unknown language
labels were not live-quality-tested by this corpus.

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
