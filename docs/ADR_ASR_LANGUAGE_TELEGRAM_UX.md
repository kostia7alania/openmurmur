# ADR: ASR language controls and Telegram output UX

**Status:** Accepted for staged MVP
**Date:** 2026-08-10

## Context

OpenMurmur primarily hears Thai, with occasional Russian, English and Chinese.
Its Telegram chat is also shared by a production Mac and a development Mac.
The product therefore needs compact reports, honest language metadata and an
unambiguous answer to which host processed each recording.

These are separate concerns that must not be collapsed into one language
selector:

- Qwen3-ASR can identify a language automatically or receive one forced language
  for an input.
- Text can visibly contain more than one writing system even when the model
  returns one language label.
- A user may know that automatic recognition chose the wrong language and ask
  for a new transcription.
- Telegram formatting can hide detail, but it does not remove message, caption
  and file-size limits.

The UX must expose those facts without inventing model capabilities or allowing
a Telegram update to control processes on a Mac.

## Decision

### 1. Recognition mode is Auto or one forced language

`Auto` is the default and is recommended for ambient or mixed speech. A forced
language is appropriate only when the recording is known to be monolingual.
The first MVP choices are Thai, Russian, English and Chinese.

The setting is a radio choice, not a priority list or allowlist. Qwen's public
inference API accepts automatic detection or one language for each audio input;
an array in its batch API supplies one value per audio item, not several
priorities for one item. The UI must not describe multiple selected languages as
decoder bias, fallback order or a constrained detection set.

Every ASR job snapshots the effective mode. A later settings change cannot
alter an already queued, leased or retried job. The resulting transcript
revision stores the same mode as immutable evidence.

### 2. Detected language, observed script and user override stay distinct

Telegram output uses three separate labels when the corresponding fact exists:

- **Model language:** the language label returned by ASR in Auto mode.
- **Observed writing systems:** scripts demonstrably present in the transcript,
  such as Thai, Cyrillic, Latin or Han.
- **Recognition mode:** `автоматически` or `только <язык>` from the job snapshot.

An observed script is not a detected language. In particular, Latin script does
not prove English; it can also be Malay, Vietnamese, Dutch or another language.
A forced result must not claim that automatic language identification ran.

Changing the default below a delivered transcript affects only future work. If
the retained source should be corrected, the eventual action is explicitly
`Перераспознать эту запись`: it creates a new immutable transcript revision with
Auto or one forced language. It does not rewrite the old revision or edit
language metadata in place. If the source is missing or belongs to the other
host, the bot says so instead of pretending to reprocess it.

### 3. Telegram stays compact without losing the complete artefact

Short transcripts are one HTML `<blockquote expandable>` message. Short reports
contain separate expandable `Кратко` and `Отчёт` quotes. A nested spoiler is not
added: it creates a second disclosure step without adding a capability.

`telegram.transcriptInlineLimit` remains a conservative product threshold
(currently 3500) below Telegram's hard 4096-character message limit. Rendering
must also respect the 1024-character caption limit after entities are parsed.

When the inline threshold is exceeded:

- a transcript is sent only as one UTF-8 `<session-id>.md` document;
- a report is sent as one bounded expandable summary followed by one complete
  `<session-id>.report.md` document;
- the same long text is not repeated as a sequence of chat messages;
- filenames use only trusted date, host/instance and stable local identity, never
  transcript content or a Telegram-supplied path.

Incoming results should reply to the originating Telegram message or its durable
acknowledgement when possible. A missing reply target falls back to an ordinary
message without losing provenance.

### 4. The source FLAC is a document; playback preview is optional

Live capture produces a lossless FLAC source. Telegram's `sendAudio` contract is
for MP3 or M4A, while `sendVoice` supports OGG/Opus, MP3 or M4A. The FLAC is
therefore sent through `sendDocument`, labelled `Исходник`, with host, capture
time and session identity in its bounded caption.

An Opus, MP3 or M4A mobile preview may be added later, but only as a separately
labelled derived artefact. It never replaces the FLAC, changes retention proof
or makes source delivery wait for re-encoding.

### 5. Thai timings and speaker labels are deliberately limited

Qwen3-ASR supports Thai recognition, but the official forced aligner supports
11 languages and Thai is not one of them. Thai output must not present invented
word-level timestamps. It may show coarse boundaries only when those boundaries
come from an identified source such as VAD; otherwise timing is marked
unavailable. A timestamp produced by an unknown upstream path must not be
renamed `vad` merely because the forced aligner language allowlist did not match.

Optional diarization may attach `Голос N` within one recording when a local
diarizer actually attributed the segment. It does not identify people, infer
names or assign semantic roles. Speaker identity does not survive a recording
or physical-part boundary unless a separately measured speaker-continuity design
is implemented. Unattributed speech remains unlabelled. Diarization stays off by
default until it is measured against hand-labelled recordings from the real
environment.

### 6. One Telegram token has one input owner

For one bot token, exactly one daemon owns `getUpdates` and incoming callbacks.
Other Macs using that token are send-only. Independent SQLite offsets on two
polling daemons do not coordinate ownership and can split updates unpredictably.

The input-owner host is the only host that exposes actionable `/settings` or
re-transcription callbacks. Send-only hosts may publish results and health, but
do not attach dead keyboards. Every acknowledgement and artefact identifies a
persisted host name, optional human instance label such as `prod` or `dev`,
source kind, original time and stable request/session identity.

This boundary is operator-enforced until a real cross-host coordinator exists.
For independent interactive development, a separate development bot token is
the preferred isolation boundary.

### 7. The product surface is Russian without premature full i18n

Bot-authored Telegram text, attached report chrome and the owner onboarding
README are Russian. Commands remain short Latin Bot API commands. Transcript and
summary content remains in the spoken language; filenames, hostnames and model
names are not translated.

Code, CLI diagnostics, logs and canonical engineering documentation remain
English. A small catalogue of stable user-facing states and error codes is
appropriate; an i18n framework is deferred until a second real interface locale
is required. Raw internal exceptions are never used as end-user copy.

### 8. Telegram recommends local repair but never performs it

The bot may report which Mac and pipeline stage failed, a bounded redacted cause
and exact commands to run locally. It must not execute a shell, start or stop a
service, install a package, pull a multi-gigabyte model, activate recording or
retry all failed work remotely.

Recovery remains explicit:

1. On the named Mac, run `pnpm openmurmur doctor`.
2. Apply the local repair it reports.
3. Retry one selected exhausted job with
   `pnpm openmurmur jobs retry <job-id>`.

For a Homebrew Ollama installation, the non-blocking service command is
`brew services start ollama`; `ollama serve` is a foreground server and must not
be placed before `ollama pull` in a chained command. Readiness is probed before a
model is pulled. Installation and model download remain operator-consented
because models may consume substantial disk and network resources.

## Staged MVP acceptance plan

### Stage A: Lock the offline message contract

- Renderer tests cover HTML escaping, Thai/Cyrillic/Latin/Han text, emoji and
  grapheme boundaries.
- Short transcript/report output contains expandable quotes and no nested
  spoiler.
- Boundary fixtures below, at and above the inline limit produce either one
  bounded message or one complete Markdown artefact, never duplicate chunks.
- Source FLAC is enqueued as a document and remains byte-identical.

### Stage B: Make language evidence explicit

- Auto and one forced language are the only stored settings states.
- Job and transcript-revision tests prove settings are snapshotted.
- Model language, observed scripts and forced mode render as different fields.
- Latin script is never automatically labelled English without model or user
  evidence.
- Timing-source tests prove unsupported alignment is not relabelled as VAD.

### Stage C: Make two-host output unambiguous

- Fixtures cover live capture, direct upload and every supported forwarded
  origin, including unknown legacy values.
- All outputs retain source host/instance, source kind, original time and stable
  correlation identity across retry.
- Send-only configurations never poll and never attach actionable callbacks.
- Documentation recommends a separate dev bot for independent interactive
  debugging until input ownership can be coordinated.

### Stage D: Add safe correction and recovery

- Re-transcription appends one new revision and delivery chain for one retained
  local source; callback replay is idempotent.
- Missing and other-host sources return truthful errors.
- Failed-job diagnostics redact and bound causes, name the host and retry only
  one selected job.
- Tests prove no Telegram route invokes process execution, package installation,
  service control, model download or recorder control.

### Stage E: Run live gates separately

- A real Telegram Bot API check verifies expandable-quote appearance, document
  captions, replies and Russian bot profile text on the clients actually used.
- Real Qwen/MLX recordings cover Auto and forced Thai/Russian/English/Chinese,
  mixed Thai-Latin speech and a deliberately wrong Auto result.
- Thai output is inspected for timing honesty; diarization is evaluated against
  hand-labelled speakers before any default changes.
- Production input-owner and development send-only Macs are run together to
  prove request ownership and visible provenance.
- These live checks are recorded separately from fake-adapter and renderer
  tests; neither kind of evidence is substituted for the other.

## Consequences

The MVP stays small: one local model path, one settings radio group, one compact
Telegram presentation and one explicit input owner. Users can understand which
Mac and which source produced a result without being offered controls that the
model or deployment cannot honour.

The trade-off is that correcting one transcript requires a new ASR revision,
speaker names remain unavailable, Thai timing remains coarse or absent, and
interactive development on the production bot is intentionally limited.

## Primary sources checked on 2026-08-10

- [Telegram Bot API formatting options](https://core.telegram.org/bots/api#formatting-options)
- [Telegram `sendMessage`](https://core.telegram.org/bots/api#sendmessage)
- [Telegram `sendDocument`](https://core.telegram.org/bots/api#senddocument)
- [Telegram `sendAudio`](https://core.telegram.org/bots/api#sendaudio)
- [Telegram `sendVoice`](https://core.telegram.org/bots/api#sendvoice)
- [Telegram `getFile`](https://core.telegram.org/bots/api#getfile)
- [Telegram local Bot API server](https://core.telegram.org/bots/api#using-a-local-bot-api-server)
- [Qwen3-ASR official repository and inference examples](https://github.com/QwenLM/Qwen3-ASR)
- [Qwen3-ASR official inference implementation](https://github.com/QwenLM/Qwen3-ASR/blob/main/qwen_asr/inference/qwen3_asr.py)
- [`mlx-qwen3-asr` 0.3.5 package documentation](https://pypi.org/project/mlx-qwen3-asr/)
- [Ollama macOS documentation](https://docs.ollama.com/macos)
- [Ollama list-models API](https://docs.ollama.com/api/tags)
- [Ollama pull-model API](https://docs.ollama.com/api/pull)
- [Homebrew Ollama formula](https://formulae.brew.sh/formula/ollama)
- [Homebrew Ollama service definition](https://raw.githubusercontent.com/Homebrew/homebrew-core/HEAD/Formula/o/ollama.rb)
