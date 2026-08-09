# Architecture

## Shape

One TypeScript daemon owns the reusable model clients and worker processes, one
SQLite database holds durable work, and one Telegram chat receives delivery.

```
┌──────────────────────────── openmurmur daemon (Node 26) ────────────────────────────┐
│                                                                                      │
│  ┌────────────┐   PCM     ┌──────────┐  probability  ┌──────────────┐               │
│  │  FFmpeg    │──frames──▶│   VAD    │──────────────▶│ Sessionizer  │ pure, no I/O  │
│  │ AVFound.   │           │ (Silero) │               │ state machine│               │
│  └────────────┘           └──────────┘               └──────┬───────┘               │
│        │                                                    │ intents               │
│        │ 16 kHz mono s16le                                  ▼                       │
│        └───────────────────────────────────────────▶ ┌──────────────┐               │
│                                                      │  Recorder    │               │
│                                                      │ (I/O binding)│               │
│                                                      └──────┬───────┘               │
│                                                             │                       │
│                        ┌────────────────────────────────────┼───────────────┐       │
│                        ▼                                    ▼               ▼       │
│                 FLAC parts on disk                    SQLite (WAL)     job queue    │
│                 (temp → fsync → rename)                                             │
│                                                                                      │
│  ┌────────────┐   ┌─────────────┐   ┌───────────────┐   ┌────────────────────────┐  │
│  │ job workers│   │ outbox      │   │ Telegram poll │   │ health monitor         │  │
│  │ audio ─────┼──▶│ drain       │   │ getUpdates    │   │ checks + edge alerts   │  │
│  │ asr→text   │   │ ready FIFO  │   │ + incoming    │   │                        │  │
│  │   └→sum→report  │             │   │               │   │                        │  │
│  └─────┬──────┘   └──────┬──────┘   └───────┬───────┘   └────────────────────────┘  │
└────────┼─────────────────┼──────────────────┼───────────────────────────────────────┘
         │ NDJSON          │ HTTPS            │ HTTPS
         ▼                 ▼                  ▼
  ┌─────────────┐    ┌──────────────────────────────┐
  │ Python ASR  │    │        Telegram Bot API      │
  │ Qwen3-ASR   │    └──────────────────────────────┘
  └─────────────┘
  ┌─────────────┐    ┌──────────────┐
  │ Python VAD  │    │    Ollama    │ loopback only
  │ Silero      │    │ qwen3.6:27b  │
  └─────────────┘    └──────────────┘
```

## Processes

### 1. The daemon (`openmurmur start`)

A single Node process running cooperating loops. They are independent on
purpose: a wedged post-session model, an offline Telegram or a full outbox slows
its own loop and does not stop capture.

| Loop | Interval | Responsibility |
| --- | --- | --- |
| Recorder | continuous | Consumes capture frames; drives the sessionizer; writes FLAC. |
| Staged job workers | 0.5–1 s | Separate delivery, ASR/incoming, and summary workers claim leased jobs. Audio enqueue is independent of ASR; transcript and report follow their prerequisites. |
| Outbox drain | 1.5 s | Sends ready Telegram rows oldest-first. |
| Telegram poll | 1 s | `getUpdates` long-poll; commands and incoming audio. |
| Health | 5 s | Runs checks, records events, raises edge-triggered alerts. |
| Sleep detector | 2 s | Detects suspend/resume gaps and closes an open session. |
| Digest scheduler | 5 min | Evaluates the configured local/IANA timezone window and transactionally stores and enqueues one daily digest. |
| Retention scheduler | 1 h | Applies only the candidates proven eligible by the retention query. |

The recorder is the only loop that must never fall behind. No model inference or
network request runs during session finalization: it records the state and
enqueues durable jobs, then returns to capture. Lifecycle notifications likewise
enqueue local outbox rows and never wait for Telegram.

### 2. Model backend ownership

`uv run --project python/openmurmur_audio openmurmur-audio-worker`, spoken to
over NDJSON on stdin/stdout. The daemon creates one reusable ASR backend for its
lifetime. Its worker is lazy and long-lived because loading Qwen3-ASR-1.7B per
file would make every transcript arrive minutes late. Streaming VAD has its own
worker so an ASR request cannot hold microphone frames behind it. Both workers
are closed during orderly daemon shutdown.

The Python workers receive **no secrets**. ASR receives trusted local audio
paths and streaming VAD receives PCM frames; neither receives Telegram or
Keychain data.

If the ASR worker dies, every in-flight request is rejected and the next call
through the same backend respawns it. The cost is one transcription attempt,
which the job queue retries; the daemon itself is unaffected.

Why a separate process rather than bindings: MLX and ONNX Runtime are Python
libraries. Embedding them would mean native modules, a build toolchain and a
much larger blast radius for a crash inside a model.

### 3. Ollama

The daemon also creates one reusable LLM client for its lifetime. It can reach
only a validated loopback URL (normally `127.0.0.1:11434`) and is used for one
thing: turning a transcript into a JSON object matching a fixed schema.
Constrained decoding (`format`) makes a non-conforming response nearly
impossible, and `parseSummary` validates and clamps whatever comes back anyway.

If Ollama is missing, the session still gets its audio and transcript. The
report simply has no summary. This is a *degraded* health state, never a failed
one.

### 4. Post-session pipeline

Finalization commits the session state together with two idempotent jobs:

```
deliver_audio ───────────────────────────────▶ outbox
asr ──▶ deliver_transcript ─────────────────▶ outbox
  └───▶ summarize ──▶ deliver_report ───────▶ outbox
```

The outbox loop can therefore upload the source audio while the job loop runs
ASR. Transcript delivery does not wait for the optional summary. Short reports
are text; reports over the inline threshold are one trusted
`<session_id>.report.md` document.

Digest day boundaries come from `digest.timezone` (`local` or a valid IANA
zone), including DST transitions. Storing a digest and enqueueing its stable
`digest:<date>` row are one SQLite transaction. The CLI/launchd digest path uses
the same identity as a safety net. Short digests are HTML text; long ones are
trusted `digest-YYYY-MM-DD.md` documents. Automatic snapshots contain only
`DONE` sessions and wait while that date has active/processing/delivering work;
before today's configured time, the scheduler retries the previous due date.
The launchd fallback wakes every five minutes and evaluates the same configured
timezone and time. A session starting after its date's snapshot is not revised
into that already delivered digest; AR-08 tracks that late-session policy gap.
Launchd itself has not been verified in a live login session.

## Layering

```
src/
├── util/clock.ts        Monotonic vs wall time. Injectable for tests.
├── config/              Schema, validation, paths. No secrets, by construction.
├── logging/             NDJSON logger with redaction at the boundary.
├── capture/             CaptureBackend interface, FFmpeg impl, FLAC writer, ffprobe.
├── sessionizer/         Pure state machine + VAD + Recorder (the I/O binding).
├── database/            Migrations, connection, repositories.
├── jobs/                Queue with leases; ASR/summarize/deliver handlers.
├── asr/                 Backend interface, NDJSON protocol, MLX bridge, fakes.
├── llm/                 Extraction schema, Ollama client, fake.
├── telegram/            Client, keychain, router, outbox, incoming, formatting.
├── health/              Checks and edge-triggered alerting.
├── retention/           Eligibility proof and deletion.
├── digest/              Daily roll-up.
└── cli/                 Argument parsing, doctor, setup, daemon wiring.
```

The dependency direction is strictly downward. `sessionizer/machine.ts` imports
only types and config — it has no filesystem, database or network dependency at
all, which is what makes the 60-second and 15-minute rules testable in
microseconds.

## Key decisions

### The sessionizer is pure

It consumes `VadFrame` values and emits `SessionIntent` values. It never touches
the disk. The `Recorder` performs the intents.

This split is the single most valuable structural decision in the codebase:
every timing rule in the product is decided in one file that can be exhaustively
tested with a fake clock, and an I/O failure cannot corrupt state-machine state.

### Monotonic time for durations, wall time for records

`Date.now()` moves when NTP corrects the clock, when the machine wakes from
sleep, and at DST boundaries. A sessionizer that trusted it could close a live
session or extend one to hours. Every duration decision uses
`process.hrtime.bigint()`; wall time is recorded only for display and storage.

### Atomic file publication

Parts are written to `<tempDir>/<name>.flac.part`, fsynced, then renamed into
the audio directory, and the directory is fsynced too. Anything under the audio
directory is therefore always a complete, valid FLAC. Startup recovery also
reconciles the narrow crash window after that rename but before `finalized`,
size, and SHA-256 were recorded in SQLite; it hashes the published archive file
and completes the database facts before recovering the session jobs.

### Transactional outbox

Every Telegram send is a database row with a stable `delivery_part_id`. A crash
before a network attempt is recovered from the row. A crash after Telegram
accepted a request but before SQLite recorded `sent` causes a retry and can
produce a duplicate Telegram message: the database prevents duplicate enqueue,
but Telegram provides no idempotency key for this boundary. Network delivery is
therefore honestly at-least-once.

The drain considers only ready rows (`run_after <= now`) and claims them FIFO by
creation/insertion order. A later audio row cannot continually jump ahead of an
older ready transcript or report.

### Job leases, not locks

A worker claims a job by taking a time-boxed lease. A crashed worker's job
returns to the pool when the lease expires. There is no lock to leak and no
cleanup that must run for the system to recover.

### One writer

SQLite in WAL mode with `BEGIN IMMEDIATE` for write transactions. Reads (health,
status) never block the recorder. Write transactions are short by construction —
no I/O inside one.

### One daemon per data root

Startup claims the PID file atomically and refuses to replace it while the PID
is alive. The record includes the OpenMurmur root and process start metadata;
`status` and `stop` verify that the PID still belongs to a recognizable
OpenMurmur daemon before trusting or signalling it. Stale dead PID records are
reclaimed, while an ambiguous live PID is left untouched.

## Failure behaviour

| Failure | Behaviour |
| --- | --- |
| Microphone permission denied | Clear actionable error naming System Settings; `🔴` to Telegram. |
| Audio device disappears | Capture throws; `🔴` sent; open session finalized so the file survives. |
| Python worker crashes | In-flight ASR rejected; job retried with backoff; worker respawned. |
| Model weights missing | Explicit error naming the `uv sync --extra mlx` command. Never a silent fallback. |
| Ollama down | Report delivered without a summary. Health degraded, not failed. |
| Telegram 429 | `retry_after` honoured exactly; drain stops; no attempt burned. |
| Telegram 400 | Marked dead immediately — retrying a malformed message is pointless. |
| Disk full | Log writes fail silently; health reports disk pressure; alert raised once. |
| Power loss mid-part | Temp file discarded on next start; archive unaffected. |
| Power loss after archive rename | Startup hashes the complete published FLAC, restores its database facts, and re-enqueues the session's audio and ASR work. |
| Orderly daemon stop mid-session | `forceFinalize()` closes the part; audio and ASR jobs remain durable. |
| Hard kill mid-session | Startup reconciles published parts and stalled session jobs; incomplete temp files are never uploaded. |

## Capture backends

`CaptureBackend` exists so a native helper can replace FFmpeg without touching
anything else. The MVP ships FFmpeg + AVFoundation because it needs no Apple
Developer certificate — which keeps the project installable by anyone with
Homebrew.

The trade-offs are real and documented in
[`native/OpenMurmurCapture/README.md`](../native/OpenMurmurCapture/README.md):
FFmpeg gives a less precise TCC error, no route-change notifications, and an
extra process. A Swift `AVAudioEngine` helper is **P1-01**.

## Testing strategy

| Layer | Approach |
| --- | --- |
| Sessionizer | Fake clock, scripted VAD probabilities. Zero I/O, zero sleeping. |
| Storage | Real SQLite in a temp directory. |
| Audio | Real ffmpeg, synthetic sine/silence fixtures generated at test time. |
| ASR / LLM | Fake adapters. CI never downloads a model. |
| Telegram | Scripted `fetch` returning real Bot API response shapes. |
| Capture | Argument construction is asserted; the device itself is not opened in CI. |

No automated test needs a microphone, model weights, a network, a real Telegram
token, or launchd. Those live paths are not claimed as verified here.
