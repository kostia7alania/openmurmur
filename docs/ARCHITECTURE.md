# Architecture

## Shape

One TypeScript daemon, one long-lived Python worker, one SQLite database, one
Telegram chat.

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
│  │ job worker │   │ outbox      │   │ Telegram poll │   │ health monitor         │  │
│  │ asr→sum→   │   │ drain       │   │ getUpdates    │   │ checks + edge alerts   │  │
│  │ deliver    │   │ sequential  │   │ + incoming    │   │                        │  │
│  └─────┬──────┘   └──────┬──────┘   └───────┬───────┘   └────────────────────────┘  │
└────────┼─────────────────┼──────────────────┼───────────────────────────────────────┘
         │ NDJSON          │ HTTPS            │ HTTPS
         ▼                 ▼                  ▼
  ┌─────────────┐    ┌──────────────────────────────┐
  │ Python MLX  │    │        Telegram Bot API      │
  │ worker      │    └──────────────────────────────┘
  │ Qwen3-ASR   │
  │ Silero VAD  │    ┌──────────────┐
  └─────────────┘    │    Ollama    │ localhost only
                     │ qwen3.6:27b  │
                     └──────────────┘
```

## Processes

### 1. The daemon (`openmurmur start`)

A single Node process running five cooperating loops. They are independent on
purpose: a wedged model, an offline Telegram or a full outbox slows its own loop
and nothing else.

| Loop | Interval | Responsibility |
| --- | --- | --- |
| Recorder | continuous | Consumes capture frames; drives the sessionizer; writes FLAC. |
| Job worker | 1 s | Claims one job (ASR → summarize → deliver) with a lease. |
| Outbox drain | 1.5 s | Sends queued Telegram messages, strictly in order. |
| Telegram poll | 1 s | `getUpdates` long-poll; commands and incoming audio. |
| Health | 5 s | Runs checks, records events, raises edge-triggered alerts. |

The recorder is the only loop that must never fall behind. Everything it does on
the hot path is bounded: a VAD call, a buffer append, a pipe write. Session
finalization enqueues a job and returns immediately.

### 2. The Python worker

`uv run --project python/openmurmur_audio openmurmur-audio-worker`, spoken to
over NDJSON on stdin/stdout. It is long-lived because loading Qwen3-ASR-1.7B
takes tens of seconds — doing that per file would make every transcript arrive
minutes late.

It receives **no secrets**. It only ever sees audio file paths.

If it dies, every in-flight request is rejected and the next call respawns it.
The cost is one transcription attempt, which the job queue retries; the daemon
itself is unaffected.

Why a separate process rather than bindings: MLX and ONNX Runtime are Python
libraries. Embedding them would mean native modules, a build toolchain and a
much larger blast radius for a crash inside a model.

### 3. Ollama

Reached over `127.0.0.1:11434`. Used for one thing: turning a transcript into a
JSON object matching a fixed schema. Constrained decoding (`format`) makes a
non-conforming response nearly impossible, and `parseSummary` validates and
clamps whatever comes back anyway.

If Ollama is missing, the session still gets its audio and transcript. The
report simply has no summary. This is a *degraded* health state, never a failed
one.

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
directory is therefore always a complete, valid FLAC.

### Transactional outbox

Every Telegram send is a database row with a stable `delivery_part_id`. A crash
between "uploaded" and "marked sent" causes a retry, and the retry is a
primary-key conflict rather than a duplicate message.

### Job leases, not locks

A worker claims a job by taking a time-boxed lease. A crashed worker's job
returns to the pool when the lease expires. There is no lock to leak and no
cleanup that must run for the system to recover.

### One writer

SQLite in WAL mode with `BEGIN IMMEDIATE` for write transactions. Reads (health,
status) never block the recorder. Write transactions are short by construction —
no I/O inside one.

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
| Daemon killed mid-session | `forceFinalize()` closes the part and delivers it. |

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

No test needs a microphone, a model, a network, or a real Telegram token.
