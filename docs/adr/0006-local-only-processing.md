# ADR-0006: Local-only processing, Telegram as the sole egress

**Status:** Accepted · **Date:** 2026-07-29

## Context

The product records private speech continuously. Every design decision about
where processing happens is really a decision about who can read that speech.

Cloud ASR (Whisper API, Google, AWS) is more accurate today for some languages,
cheaper to integrate, and needs no local model management. It also means
uploading every word spoken near the microphone to a third party.

## Decision

All processing — VAD, ASR, summarization — happens on the user's machine.
Telegram is the **only** network destination, and only for delivering finished
results to a chat the user configured.

There is no cloud fallback. If the local ASR is unavailable, the user gets a
clear error naming the fix.

## Rationale

A 64 GB Apple Silicon Mac can run Qwen3-ASR-1.7B and a 27B LLM comfortably. The
technical justification for uploading audio has largely disappeared; what
remains is convenience, which is not worth the trade for this product.

More importantly: a fallback that silently uses a cloud service would make the
privacy promise unverifiable. A user could never be sure which path their audio
took. An error is honest; a silent fallback is not.

## Consequences

**Positive.** The privacy claim is structural, not a policy. No API keys, no
per-minute cost, no rate limits, no vendor outage, works offline.

**Negative.**

- Local ASR may be less accurate than the best cloud model, particularly for
  Thai.
- Model downloads are multi-gigabyte.
- Apple Silicon with substantial memory is required, which excludes many users.
- Transcription is slower than a datacenter GPU. Acceptable: sessions are
  processed after they end, not in real time.

**The one honest caveat:** Telegram bot chats are **not end-to-end encrypted**.
Audio and transcripts delivered there are readable by Telegram. This is stated
plainly in the README, `PRIVACY.md` and `docs/TELEGRAM.md` rather than buried,
because "local-first" could otherwise be read as implying more than it does.

## Enforcement

- The LLM has no tools, no filesystem access and no network access.
- The Python worker receives no secrets — only audio file paths.
- Ollama is configured to `127.0.0.1` and validated to be local.
- `telegram.apiBaseUrl` must be the official `https://api.telegram.org` root,
  or an unauthenticated local Bot API root on literal `127.0.0.1`; redirects
  are rejected.
- There is no code path from a transcript to a network request other than the
  outbox, which sends only to the one configured chat.
