# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
- Node 26 bundles SQLite 3.53.3, one patch below the 3.53.4 target. Surfaced by
  `doctor`; see `docs/adr/0004-sqlite-driver.md`.

[Unreleased]: https://github.com/kostia7alania/openmurmur/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/kostia7alania/openmurmur/releases/tag/v0.1.0
