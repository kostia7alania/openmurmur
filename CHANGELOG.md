# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Speaker diarization** — transcripts can say which voice spoke each block.
  sherpa-onnx (pyannote segmentation + 3D-Speaker embeddings, 44 MB, ungated,
  no torch, RTF ~0.08). **Off by default**, with a hard cap on the speaker
  count: left to count for itself the clustering reported between 4 and 15
  voices for a two-person conversation, and a transcript that invents
  participants is worse than one with no labels. See
  [ADR-0008](docs/adr/0008-speaker-diarization.md).
- `./scripts/fetch-diarization-models`, and a `diarization` check in `doctor`.
- `asr.context` — biasing terms for recognition: names, places, jargon, the
  English words that recur inside Thai speech. Empty by default, and worth
  treating carefully: priming a recording with terms that were not in it made
  the transcript worse, not better, which is why nothing is inferred
  automatically from previous transcripts.

### Fixed

- **A mixed-language transcript reported only one language.** A real
  Thai-English conversation — 108 Thai characters, 195 Latin — was stored and
  indexed as `["th"]`. The transcription was right; the label was not, and the
  label is what the report, the digest and search are built on. Declared
  languages are now reconciled against the scripts actually present, adding
  only what nothing declared already covers.
- Scripts that no detected language accounts for are now logged. Chinese
  characters in a Thai transcript are the model drifting, not code-switching.
  Reported, never edited out: silently rewriting a transcript would be worse
  than an odd one.
- Pinned Node to `26.7.0`, the first verified runtime here with
  `node:sqlite` 3.53.4, and made bootstrap reject older embedded SQLite
  runtimes instead of leaving the fix to `doctor`.
- **The daemon now really uses Silero VAD to decide what a speech session is.**
  It was wired to `EnergyVad` — the loudness gate the source itself documents as
  "explicitly not a substitute" — while the docs claimed the daemon path used
  Silero. In practice any loud sound opened a session and quiet speech could be
  missed. Measured over the new streaming path: a 440 Hz tone and white noise
  score 0.000 and 0.007 with Silero and 1.000 with the gate; real Russian and
  English speech score 0.927.
- Session transcripts are sent as timestamped blocks rather than one wall of
  text. The formatter existed and worked — it was wired to incoming Telegram
  audio, while recorded sessions, the whole point of the product, got the flat
  blob.


- Streaming VAD (`vad_stream`) in the Python worker: whole 512-sample frames in,
  one probability out per frame, Silero's LSTM state carried between calls.
  About 0.2 ms per frame against a 32 ms budget.
- The live detector runs in its own worker process, so a transcription in flight
  cannot hold up the frames deciding whether someone is speaking.
- `sessionizer.vadBackend` (`silero` by default, `energy` to opt out).
- If the Silero worker stops answering, the recorder continues on the energy
  gate and the daemon says so (🟡), retries once a minute, and reports recovery
  (🟢). It never degrades silently.
- `openmurmur doctor` gained a `speech_detection` check that starts the worker
  and scores a frame, rather than reporting what the config claims.

## [0.1.0] — 2026-07-29

Initial public MVP.

### Added

**Capture and sessionizing**
- Continuous microphone capture via FFmpeg + AVFoundation, behind a
  `CaptureBackend` interface.
- Pure session state machine: IDLE → SPEECH_CANDIDATE → ACTIVE → SILENCE_GRACE
  → FINALIZING, with all duration decisions on a monotonic clock.
- 5-second pre-roll, so a session begins before the words that opened it.
- 500 ms sustained-speech requirement, so short noises do not open a session.
- 60-second silence close; speech returning at any point before that continues
  the same session.
- 15-minute physical rotation with a shared `session_id`.
- Minimum-speech (3 s) and minimum-word (5) rejection gates, with the reason
  recorded.
- Atomic FLAC publication: temp file, fsync, rename, directory fsync, SHA-256.

**Transcription and summarization**
- Persistent Python MLX worker over an NDJSON protocol, keeping Qwen3-ASR
  resident between requests.
- Streaming Silero VAD (ONNX) with segment assembly that bridges in-sentence
  pauses.
- RU / EN / TH with automatic detection; aligner timestamps for RU/EN only, and
  VAD-derived timings for Thai rather than invented ones.
- Immutable transcript revisions.
- Structured extraction via Ollama with JSON Schema constrained decoding.
- Fake ASR and LLM adapters so CI needs no model.

**Telegram**
- Onboarding with a hidden token prompt; secrets stored only in the macOS
  Keychain.
- Ordered delivery: source FLAC parts, then transcript, then structured report.
- Lossless splitting of parts over the 50 MB limit — never a lossy re-encode.
- Transcript splitting on grapheme clusters, with a `.md` attachment when long.
- Transactional outbox with stable delivery ids, 429 `retry_after` handling, and
  backoff.
- `/status`, `/health`, `/help`.
- Incoming audio transcription with UUID filenames, streamed size limits, real
  container validation, and a codec allowlist.
- Single-chat allowlist; every other chat silently ignored.

**Storage and operations**
- SQLite with WAL, foreign keys, FTS5 trigram, and idempotent migrations.
- Job queue with leases and crash recovery.
- Retention requiring database-proven eligibility, with `dry-run` reporting why
  each retained file is being kept.
- Edge-triggered health alerts with cooldown and deduplication.
- Daily digest.
- CLI: `doctor`, `setup`, `setup telegram`, `capture test`, `start`, `stop`,
  `status`, `telegram test|poll`, `transcribe`, `digest`, `retention`.
- launchd templates and install/uninstall scripts.

### Known limitations

- Qwen3-ASR inference has not been run against real model weights in this
  repository; the MLX extra is not installed in CI.
- Silero VAD's ONNX model has not been executed; only its segment-assembly
  logic is tested.
- Ollama was not installed on the development machine.
- Live microphone capture, real Telegram delivery, launchd under a login
  session, and sleep/wake behaviour are unverified.

[Unreleased]: https://github.com/kostia7alania/openmurmur/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/kostia7alania/openmurmur/releases/tag/v0.1.0
