# OpenMurmur

[Краткое руководство на русском](README.ru.md)

**Private ambient journal for Apple Silicon.**

OpenMurmur records speech sessions, transcribes them locally, and sends the
source audio, transcript, summary and operational status to your private
Telegram chat.

It runs continuously on your Mac. When someone speaks, it opens a session; when
the room has been quiet for a minute, it closes it and immediately queues the
lossless FLAC for Telegram while Qwen3-ASR transcribes it on-device. The full
transcript follows when ready, and the local LLM produces a structured report
independently.

No account. No cloud ASR. No telemetry. During normal operation, Telegram is
the only external network destination, and you configure it yourself. ASR
weights are obtained only by the explicit foreground provisioning step below.

> ⚠️ **Recording other people has legal and ethical consequences.** Consent
> requirements for recording conversations vary by country and by state, and in
> many places recording without all-party consent is a criminal offence. Read
> [RECORDING_POLICY.md](RECORDING_POLICY.md) before you run this near anyone
> else.

### Installing

| Situation | Start here |
| --- | --- |
| A Mac you sit at, with Homebrew and Node 26.7.0 already installed | [Quick start](#quick-start), below |
| A Mac with none of that yet | [docs/INSTALL.md](docs/INSTALL.md) — assumes nothing, starts at `xcode-select` |
| A headless Mac reached over SSH, set up by an agent | [docs/SERVER.md](docs/SERVER.md) — and run `./scripts/server-preflight` first |

Two steps can never be automated, on any machine: **clicking Allow on the macOS
microphone prompt**, and **creating the Telegram bot and typing its token**.
Everything else is scriptable. `docs/SERVER.md` says where each one falls.

---

## Status

**v0.1.0 — early MVP.** The control plane, sessionizer, storage, staged
delivery, retention and Telegram integration are implemented and covered by
offline automated tests. Live microphone capture, real model inference, real
Telegram delivery, launchd and sleep/wake remain **unverified in the current
release record** — see [What is verified](#what-is-verified).

## Requirements

| Requirement | Detail |
| --- | --- |
| Hardware | Apple Silicon (M-series). MLX requires Metal; Intel Macs are not supported. |
| Memory | 64 GB recommended. A 27B LLM and resident 1.7B ASR model need substantial unified-memory headroom; 16 GB is expected to struggle, but the current release record does not claim a live model verification. |
| macOS | 14 or newer. |
| Node.js | 26.7.0 or newer (`.nvmrc` included). |
| Python | 3.14, installed automatically by `uv`. |
| FFmpeg | 8.x (`brew install ffmpeg`). |
| Ollama | Optional but recommended, for summaries. |

### Disk and model sizes

| Item | Approx. size |
| --- | --- |
| Qwen3-ASR-1.7B (8-bit MLX) | ~4.4 GiB verified cache footprint; keep at least 6 GB free |
| `qwen3.6:27b` (Q4_K_M) | ~17 GB |
| Silero VAD (ONNX) | ~2 MB |
| Session audio | ~19 MB per hour of recording (16 kHz mono FLAC) |

Audio becomes eligible for proof-based deletion 48 hours after confirmed
delivery by default. The daemon evaluates that retention policy hourly;
transcripts and summaries are kept indefinitely.

## Quick start

This assumes Homebrew, Node 26.7.0 and FFmpeg are already installed. Starting from a
Mac that has none of them? Follow [docs/INSTALL.md](docs/INSTALL.md) instead —
same destination, nothing assumed.

```bash
git clone https://github.com/kostia7alania/openmurmur.git
cd openmurmur
./scripts/bootstrap
```

```bash
/usr/bin/env -u UV_PROJECT_ENVIRONMENT uv sync --project python/openmurmur_audio --extra mlx
```

`bootstrap` deliberately installs only the CI-safe Python subset. The MLX extra
above is required for both Silero speech detection and Qwen transcription.
It installs packages but does not provision the ASR weights. Download the
default public model in this foreground terminal:

```bash
/usr/bin/env -u UV_PROJECT_ENVIRONMENT \
  HF_ENDPOINT=https://huggingface.co HF_HUB_DISABLE_TELEMETRY=1 HF_HUB_DISABLE_IMPLICIT_TOKEN=1 \
  uv run --no-sync --project python/openmurmur_audio \
  hf download Qwen/Qwen3-ASR-1.7B \
  --include '*.json' --include '*.safetensors' --include '*.txt' --include '*.model'
```

This contacts `https://huggingface.co` and storage/CDN hosts selected by it,
and stores about 4.4 GiB in the Hugging Face cache. It discloses the public
model id plus ordinary HTTPS metadata such as your IP and user agent; it sends
no audio, transcript or Telegram secret. See [PRIVACY.md](PRIVACY.md).

```bash
pnpm openmurmur doctor
```

```bash
pnpm openmurmur setup
```

On the one Mac that receives bot updates, first set
`telegram.receiveUpdates=true` in `openmurmur.json`. Other Macs sharing the bot
must use `send-only`; there must be exactly one input owner.

```bash
pnpm openmurmur setup telegram owner
```

```bash
pnpm openmurmur capture test
```

This tests the configured backend and succeeds only after real PCM frames arrive.
The default remains `ffmpeg`, which is the simplest foreground path. Before a
launchd install, use the signed native-helper flow under
[Running in the background](#running-in-the-background).

```bash
pnpm openmurmur start
```

Keep that terminal open. After the log says `first audio frame received`, speak
for more than 3 seconds, then stop and wait for 60 seconds of silence. Telegram
should receive the source FLAC first, then the transcript, then the report.

In another terminal:

```bash
pnpm openmurmur status
```

Budget 10–15 minutes to your first complete session in Telegram after the
explicit model download above finishes.

### Creating the bot

Before `pnpm openmurmur setup telegram owner`, message
[@BotFather](https://t.me/BotFather) on
Telegram, send `/newbot`, and keep the token it gives you. The setup flow
will ask for it with hidden input and store it in the macOS Keychain. It is
never written to the config file, argv, an env var, a launchd plist, or a log.
Setup drains the old update backlog and binds only to a new `/start` from an
identifiable non-bot sender in a private chat. It shows the account, user id and
chat id and requires `y`/`yes` before atomically replacing their single
versioned Keychain item.

## What actually happens

```
microphone ─▶ configured capture backend ─▶ Silero VAD ─▶ sessionizer ─▶ FLAC parts (atomic)
                                                          │
                                      ┌───────────────────┴──────────────────┐
                                      ▼                                      ▼
                              deliver source audio                  Qwen3-ASR (MLX)
                                      │                                      │
                                      │                         transcript revision ─▶ deliver
                                      │                                      │
                                      │                         Ollama ─▶ report ─▶ deliver
                                      └───────────────────┬──────────────────┘
                                                          ▼
                                              durable outbox ─▶ Telegram
```

The daemon creates one reusable ASR backend and one reusable loopback-only LLM
client for its lifetime instead of constructing them per job. Streaming VAD has
its own worker so a long transcription cannot queue microphone frames behind
it; the daemon closes its owned workers during orderly shutdown.

Session lifecycle:

```
IDLE ──speech 500ms──▶ SPEECH_CANDIDATE ──sustained──▶ ACTIVE
  ▲                          │                           │
  │                    speech stops                   silence
  │                          ▼                           ▼
  └──── finalize ──── FINALIZING ◀──60s silence── SILENCE_GRACE
                                                          │
                                            speech returns ┘  (same session)
```

- A **5-second pre-roll** is prepended, so you hear the whole sentence that
  opened the session, not its second half.
- Short noises do not open a session: speech must be sustained for 500 ms.
- Silence means *no speech per VAD*, not a quiet waveform. Room tone, a fan and
  a television do not keep a session alive.
- A session survives pauses. Only 60 continuous seconds without speech ends it.
- Files rotate every 15 minutes; parts share one `session_id`.
- Sessions with under 3 seconds of speech are rejected before delivery. If ASR
  later finds fewer than 5 words, the already queued source audio is preserved,
  but the empty transcript and report are suppressed so the chat stays usable.
- Transcripts stay searchable: `pnpm openmurmur search "встреч"` matches "Встреча",
  because the index is trigram rather than whitespace-tokenized — which is also
  what makes Thai searchable at all.
- Recording never waits for post-session ASR, summarization or Telegram. A new
  session can start while the last one is still transcribing.
- The bot queues `🎙` only after speech has opened a persisted session. When the
  session is durably finalized it queues `⏳` immediately; source audio can
  upload while ASR runs. A rejected short fragment gets its own `ℹ️` notice.

## Recording indicator and permissions

OpenMurmur adds **no** consent window, no menu bar item, no overlay, no coloured
dot and no persistent notification. macOS already handles this and doing it
twice is worse than doing it once:

- `pnpm openmurmur capture authorize` is the only command that deliberately
  opens a GUI microphone-permission flow. It verifies the installed native app
  without opening the microphone, then launches its explicit `--authorize`
  mode. It is never run by setup, start, doctor, capture test or an installer.
- The default FFmpeg backend can still trigger a Terminal/iTerm permission
  prompt when tested interactively. That grant proves the foreground command;
  it is not a reliable permission identity for a launchd daemon.
- macOS shows an **orange dot** near Control Center whenever the microphone is
  open. (Orange = microphone. Green = camera. OpenMurmur never uses the camera.)
- OpenMurmur does not attempt to hide, replace or suppress that indicator.

Recording state is reported explicitly in Telegram instead:

```
🟢 Запись включена
🎙 Услышал речь — запись сессии началась.
⏳ Сессия завершена — загружаю аудио и параллельно расшифровываю локально…
ℹ️ Сессия завершена, но фрагмент слишком короткий — аудио не отправляю.
ℹ️ Аудио сохранено, но в расшифровке слишком мало слов — транскрипт и отчёт не отправляю.
🟡 Запись временно недоступна
🔴 Запись остановлена
🟢 Запись восстановлена
```

`🟢 Запись включена` is sent **only after a real audio frame has arrived** —
never merely because the process started.

The per-session notices are durable, deduplicated outbox rows. They describe a
database transition that has already happened and never block the recorder on a
Telegram request.

### TCC caveats

TCC grants belong to a code identity, not to this repository or config file.
The two supported operating modes therefore have different boundaries:

- **Foreground default:** `audio.captureBackend="ffmpeg"`. Run `capture test`
  interactively; Terminal or iTerm owns any prompt. This is not the supported
  background permission path.
- **launchd:** install the native app at its one permanent path, explicitly run
  `capture authorize` in a GUI login session, configure
  `audio.captureBackend="native"`, then run `capture test`. Native `--stream`
  never requests permission; it exits instead.
- The local installer uses ad-hoc signing by default. That proves the exact
  bundle, entitlement and source digest, but a rebuild can change its TCC
  identity. A distributable stable release requires the same Developer ID,
  bundle ID and designated requirement across updates plus notarization; no
  notarized release is claimed here.

## Sleep and the lid

- **Sleep:** capture stops. macOS suspends the process; no audio is recorded.
  The daemon detects the gap on wake — sleep advances the wall clock while the
  monotonic clock stays frozen, which is a fingerprint nothing else produces —
  closes any open session so it cannot appear to span the gap, and reports
  `🟡 Запись прерывалась: компьютер спал` with the duration.
- **Closed lid:** with an external display and power, the Mac may stay awake and
  recording continues. On battery with the lid closed, the Mac sleeps and
  recording stops.
- **Long sleeps** produce a `🟡` alert on wake if the recorder was stale, and the
  job queue drains any backlog that accumulated.

## Who spoke

Off by default. Switched on, a transcript is labelled by voice:

```
0:02  Голос 1: …
0:19  Голос 2: …
0:34  …
```

```bash
./scripts/fetch-diarization-models
```

then set `diarization.enabled` and restart. 44 MB, no account and no token —
which is most of why sherpa-onnx was chosen over pyannote's own gated weights.

It separates **voices**, not people: voice 1 in one session has nothing to do
with voice 1 in the next, and nothing here knows a name. Lines it cannot
attribute are left unlabelled rather than guessed at.

It is off by default because on far-field room audio the clustering counts
badly — unconstrained it reported between 4 and 15 voices for a two-person
conversation, which is why the speaker count is capped rather than inferred.
Thai attribution is weaker than Russian or English, because no forced aligner
supports Thai and its segment timings are coarser. Reasoning and measurements:
[ADR-0008](docs/adr/0008-speaker-diarization.md).

## Telegram: what leaves your machine

This is the **only** network boundary. Understand it before you start.

- Your **source FLAC audio** is uploaded to Telegram.
- Your **full transcript** is sent as one collapsed quote when short, or as one
  `.md` file when long. It includes detected/reconciled languages and whether
  ASR used automatic identification or one forced language.
- Your **summary** and a short report are sent as collapsed quotes. A long
  report arrives as a compact collapsed summary followed by one
  `<session_id>.report.md` document.
- Telegram bot chats are **not end-to-end encrypted**. Telegram (the company)
  can technically access this content. If that is unacceptable, OpenMurmur is
  not the right tool for you.
- Everything else — VAD, ASR, summarization — happens on your Mac.

### Telegram limits (imposed by Telegram, not by us)

| Limit | Value | Effect |
| --- | --- | --- |
| `sendDocument` upload | 50 MB | Oversize parts are split losslessly (no re-encode). |
| `getFile` download via Cloud Bot API | **20 MB** | Larger files you send the bot are refused with an explanation. |
| `getFile` download via local Bot API server | Configurable, capped at 2 GB by OpenMurmur | Large files are streamed into quarantine with byte-count and ffprobe validation. |
| Message length | 4096 UTF-16 code units | Short transcripts and reports use collapsed quotes; long ones are Markdown documents. |

The 20 MB incoming limit is a hard constraint of the official Cloud Bot API.
OpenMurmur will not work around it with an unsafe external downloader. Large
incoming files are supported through Telegram's official local Bot API server;
see [`docs/TELEGRAM.md`](docs/TELEGRAM.md#local-bot-api-server-for-large-incoming-files).

## Bot commands

| Command | Effect |
| --- | --- |
| `/status` | Full daemon state: recorder, session, backlog, outbox, disk, models. |
| `/health` | One-line `OK` / `WARN` / `ERROR` summary. |
| `/settings` | Select Auto, Thai, Russian, English or Chinese for future ASR jobs on the input-owner Mac. |
| `/help` | Available commands. |

Send the bot a voice message or audio file and it transcribes it locally.
Supported: `.ogg` `.opus` `.mp3` `.m4a` `.aac` `.wav` `.flac`.

The Telegram product UI is intentionally Russian. Code, CLI/log output and the
canonical engineering documentation are English; spoken transcript/summary
content is not translated. Full i18n is deferred until a second real UI locale
exists. With two Macs on one bot token, `/settings` affects only the one host
that owns `getUpdates`; send-only dev output does not show dead buttons.

There is deliberately **no** `/pause`, `/stop`, `/delete`, no shell access, no
config editing and no arbitrary file access. A Telegram message must never be
able to stop your recorder or delete your data.

## CLI

```bash
pnpm openmurmur doctor              # check every dependency (read-only)
pnpm openmurmur setup               # create dirs, config, database (shows a plan first)
pnpm openmurmur setup telegram owner     # connect the one bot input owner
pnpm openmurmur setup telegram send-only # connect an output-only host
pnpm openmurmur capture authorize   # explicitly open native GUI permission flow
pnpm openmurmur capture test        # record 5s and report levels
pnpm openmurmur recover             # report what an unclean shutdown left behind
pnpm openmurmur start               # run the daemon
pnpm openmurmur stop                # stop a running daemon
pnpm openmurmur status              # local status, no network
pnpm openmurmur jobs failed         # show exhausted jobs and their causes
pnpm openmurmur jobs retry JOB_ID   # retry one job after fixing its cause
pnpm openmurmur telegram test       # send a test message
pnpm openmurmur telegram poll       # poll once and show routing decisions
pnpm openmurmur recall QUERY         # recall grounded sessions with provenance
pnpm openmurmur search TEXT         # search every stored transcript
pnpm openmurmur transcribe FILE     # transcribe one file locally
pnpm openmurmur digest 2026-07-29   # build, queue and print a daily digest
pnpm openmurmur retention dry-run   # show what would be deleted, and why not
pnpm openmurmur retention apply     # delete only what dry-run proved eligible
```

## Running in the background

launchd templates are in [`launchd/`](launchd/):

```bash
./scripts/install-capture-app
```

Set `audio.captureBackend` to `"native"` in
`~/Library/Application Support/OpenMurmur/openmurmur.json`, then authorize and
prove that the configured backend emits real PCM:

```bash
pnpm openmurmur capture authorize
pnpm openmurmur capture test
./scripts/install-capture-app --check
```

Only then install the agents:

```bash
./scripts/install-launch-agents
```

The launchd process never tries to surface a TCC prompt. A Terminal FFmpeg grant
is only a foreground proof and is not substituted for the native helper grant.

Only one daemon may own an OpenMurmur data root. SQLite is the atomic ownership
authority; the PID file is only an operator-facing mirror published without
replacing a concurrent generation. `status` and `stop` compare the exact process
birth and ownership generation before acting. A final numeric-PID reuse window
between that check and the signal remains tracked as CS-31. The launchd
templates remain unverified in a real login session.

## Retention

Nothing is deleted unless the database can *prove* it is safe. `retention apply`
executes exactly the plan `retention dry-run` printed. Audio is kept while any
of these is true:

- ASR has not finished
- the checksum was never computed
- the audio part was never finalized
- Telegram never confirmed that exact part
- the transcript was never delivered
- a job still references the session

On 2026-08-12 a disposable state root exercised the production
`retention dry-run` and `retention apply` commands against four finalized old
recordings. The ordinary and post-ASR-rejected files whose complete audio ACK
was older than 48 hours were deleted and marked exactly once; equally old files
with one-hour-old ACKs remained byte-for-byte intact and unmarked. A repeated
dry-run was empty, and SQLite integrity and foreign keys remained clean. The
rehearsal seeded durable ACK facts, so it proves the retention clock and real
filesystem apply, not Telegram transport or ACK latency.

The LLM has no involvement in deletion decisions. Eligibility is pure SQL over
recorded facts. The daemon evaluates and applies this same proof-based plan once
an hour. Daily digest scheduling uses `digest.timezone` (`local` or a valid IANA
zone) with DST-correct local-day bounds. It retries the most recent due date and
waits for sessions already in progress for that date; only `DONE` sessions enter
the automatic snapshot. Storing a digest and enqueueing its stable Telegram row
share one SQLite transaction. A short digest stays inline; a long one is a
trusted `digest-YYYY-MM-DD.md` document. The five-minute launchd fallback reads
the same enabled/time/timezone config and uses the same delivery identity.

The snapshot is a cutoff, not a mutable thread: a new session that starts after
that date's digest was stored is not retroactively appended. Configure
`digest.atLocalTime` near the end of the day; revision delivery for genuinely
late sessions remains tracked in AR-08.

## Development

```bash
pnpm install
pnpm check          # typecheck + lint + tests
```

```bash
uv run --project python/openmurmur_audio pytest
```

Neither needs a microphone, a model, or a network.

## Documentation

| Document | Contents |
| --- | --- |
| [INSTALL.md](docs/INSTALL.md) | Clean Mac to running daemon, assuming nothing |
| [SERVER.md](docs/SERVER.md) | Headless Mac: no GUI session, locked Keychain, TCC over SSH |
| [PRODUCT.md](docs/PRODUCT.md) | What this is and what it refuses to be |
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | Components, processes, data flow |
| [SESSIONIZER.md](docs/SESSIONIZER.md) | The state machine in detail |
| [DATA_MODEL.md](docs/DATA_MODEL.md) | SQLite schema and invariants |
| [TELEGRAM.md](docs/TELEGRAM.md) | Bot protocol, limits, message formats |
| [THREAT_MODEL.md](docs/THREAT_MODEL.md) | What we defend against, and what we do not |
| [BACKLOG.md](docs/BACKLOG.md) | Prioritized work with acceptance criteria |
| [DEPENDENCIES.md](docs/DEPENDENCIES.md) | Pinned versions and verification dates |
| [BUSINESS_MODEL.md](docs/BUSINESS_MODEL.md) | Free vs. possible paid, honestly |
| [PRIVACY.md](PRIVACY.md) | What is stored, where, and for how long |
| [RECORDING_POLICY.md](RECORDING_POLICY.md) | Legal and ethical obligations |
| [SECURITY.md](SECURITY.md) | Reporting vulnerabilities |
| [ADRs](docs/adr/) | Why the significant decisions were made |

## What is verified

Honesty matters more than a green badge, so:

| Evidence level | Current authoritative evidence | Boundary it does **not** cross |
| --- | --- | --- |
| Offline automated | The exact current-revision Node and Python gate is recorded immediately below; every covered guarantee names deterministic repository tests. | No microphone, model weights, Telegram credential, Keychain mutation, launchd login session or sleep/wake cycle is exercised. |
| Dependency smoke | [`docs/DEPENDENCIES.md`](docs/DEPENDENCIES.md) records dated same-machine MLX/Qwen, Silero, diarization and Ollama runs, including real-Qwen CLI transcription, daemon-owned worker reuse, a real worker-death `JobQueue` retry, real-model source-audio-first outbox eligibility, and the RU/EN/TH summary corpus. | The Ollama corpus did not meet its acceptance threshold; these bounded runs are not the complete capture-to-delivery or current-revision live release evidence. |
| Live release | No current-revision end-to-end live run is recorded yet; D120–D122 in [`docs/MVP_123.md`](docs/MVP_123.md) are the required gates. | Until those rows are evidenced, the project does not claim real microphone → models → Telegram, launchd login/reboot or sleep/wake verification. |

**Verified on this revision through offline TypeScript/Python checks and the
stated live rehearsals:**
sessionizer state machine with a fake clock, pre-roll,
60-second close, 15-minute rotation, bounded capture ingress and sleep epochs,
unexpected clean capture-EOF handling,
atomic FLAC and Markdown publication, lossless splitting, ffprobe validation of
real media, real-model source-audio-first outbox eligibility,
delivery-clock retention proofs,
lifecycle-status ordering, transcript revisions, job leases, real daemon-owned
MLX reuse and worker death/retry, worker timeout recycling and a three-boundary
real-SIGKILL recovery matrix, actionable
failed-job diagnostics and retry,
outbox idempotency, 429 handling, Telegram endpoint confinement, metadata-only
Keychain readiness, fail-closed local status heartbeats, daemon PID birth
identity, launchd drift/readiness/rollback checks, crash recovery after a
published-part database fault, proof-based stale split cleanup, incoming
artifact ownership cleanup, crash-convergent atomic incoming downloads and the
incoming fault matrix, transcript-ACK retention clocks, explicit operator-audited
remote ACK reconciliation, revision-scoped summary retry and delivery,
bounded revision-grounded long-session summaries, the deterministic RU/EN/TH
summary acceptance corpus, stable Russian failure boundaries, HTML entity-aware
Telegram limits, Unicode splitting, grounded recall with session/time/source-audio
provenance, path traversal, chat allowlisting, update deduplication, secret
redaction, prompt-injection fencing, health deduplication and migrations.
Model-facing automated tests use fake adapters and do not download weights.

On 2026-08-12 a private-root production `Daemon` with real local Silero VAD
received a synthetic 16 kHz PCM flood. Its processing-lag guard terminated the
capture path in 900 ms before silently dropping audio, reaped the child, stored
one bounded failure status without the raw cause or path, and released daemon
ownership and leases. This proves the overload terminal/alert boundary without
opening a microphone. The rehearsal used a null Telegram provider and opened
no speech session, so live failure-message delivery, device cadence and
open-session finalization remain separate gates.

[`docs/DEPENDENCIES.md`](docs/DEPENDENCIES.md) records same-machine smoke runs of
the pinned MLX/Qwen, Silero and Ollama dependencies. On this revision the real
Qwen CLI path recognized local synthetic speech, and a killed Python worker
converged through the production ASR job lease/failure/retry path without a
stale transcript, outbox row, downstream job or duplicate revision. A bounded
live `Daemon` also processed two real Qwen jobs on one observed Python
generation and reaped it on stop. The real single-language Ollama corpus also
exposed an output-language defect and verified its narrow RU/EN/TH prompt fix,
but remains below its summary acceptance target.
That is useful bounded product evidence, but it is not the complete daemon
service. **Still not verified end-to-end on this revision:** live microphone
capture through the long-running daemon, real Telegram delivery, launchd under
a login session, and sleep/wake behaviour.

See [docs/BACKLOG.md](docs/BACKLOG.md) for what closes these gaps.

## License

[Apache-2.0](LICENSE).
