# Security policy

## Supported versions

| Version | Supported |
| --- | --- |
| 0.1.x | ✅ |

This is pre-1.0 software. Only the latest release receives fixes.

## Reporting a vulnerability

**Do not open a public issue for a security vulnerability.**

Use GitHub's private reporting:
**Security → Advisories → Report a vulnerability** on this repository.

Please include: what the issue is, how to reproduce it, what an attacker gains,
and the versions of OpenMurmur, macOS, Node and FFmpeg you tested.

**Response targets** (best effort — this is a volunteer project):
acknowledgement within 5 days, assessment within 14, a fix for critical issues
as soon as practical.

You will be credited unless you prefer otherwise.

## What is in scope

Anything that could expose a user's audio, transcripts or bot token:

- **Bot token disclosure** — in logs, error messages, process arguments, files,
  or any artefact. Redaction happens at the logger boundary; a bypass is a
  valid report.
- **Path traversal via incoming files** — filenames are our own UUIDs, but a
  bypass is high severity.
- **Code execution via incoming media** — FFmpeg is not sandboxed. A crafted
  file reaching a decoder in a harmful way is the most plausible RCE path and is
  in scope.
- **Improper deletion** — anything that deletes audio without the full
  eligibility proof, or that lets a Telegram message trigger deletion.
- **Chat allowlist bypass** — anything letting a non-allowlisted chat issue
  commands or send files that get processed.
- **Prompt injection with real effect** — the LLM has no capabilities by
  design; a path from transcript text to an actual action is high severity.
- **Update replay or duplicate processing** — bypassing `update_id`
  deduplication or the persisted offset.
- **Local privilege issues** — file modes, Keychain handling, temp-file races.

## What is out of scope

| Not a vulnerability | Why |
| --- | --- |
| Telegram can read your data | Inherent and documented. Bot chats are not E2E encrypted. |
| Physical access to an unlocked Mac | Outside any application's control. |
| Root or kernel compromise | Same. |
| Recording without consent | A legal and operational issue — see `RECORDING_POLICY.md`. |
| A user configuring a malicious `apiBaseUrl` | Self-inflicted; validation restricts it to https or localhost. |
| Vulnerabilities in FFmpeg, Ollama or model weights | Report upstream. Tell us if OpenMurmur's usage makes it materially worse. |
| Denial of service against your own daemon | Not a meaningful threat for a single-user local tool. |

## Design notes for reviewers

Where the defences are, so you can attack the right places:

- Secret redaction: `src/logging/redact.ts` — applied at the logger boundary so
  no call site can forget. Covers bare tokens, `/bot<token>/` and
  `/file/bot<token>/` URLs, sensitive keys, and `Error.stack`.
- Incoming file handling: `src/telegram/incoming.ts` — UUID filenames,
  whitelisted extensions, `assertContained`, streamed byte counting, real
  container validation.
- Chat allowlist: `src/telegram/router.ts` — silent drop, no confirmation of the
  bot's existence.
- Prompt fencing: `src/llm/ollama.ts` — delimiters, delimiter stripping, and a
  model that has no capabilities.
- Retention: `src/retention/policy.ts` — pure SQL eligibility proof, no LLM.
- Keychain: `src/telegram/keychain.ts` — secrets to `security` on stdin, never
  argv.

The threat model is in [`docs/THREAT_MODEL.md`](docs/THREAT_MODEL.md), including
a "known weaknesses" section that names the current gaps.
