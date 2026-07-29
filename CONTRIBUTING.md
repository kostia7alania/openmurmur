# Contributing

Thanks for considering it. This is a small project with strong opinions; this
document explains them so your time is not wasted.

## Setup

```bash
git clone https://github.com/kostia7alania/openmurmur.git
cd openmurmur
./scripts/bootstrap
```

```bash
pnpm run check
```

`check` runs typecheck, lint and the full test suite. It needs no microphone, no
model, no network and no Telegram token. If it is not green, fix that first.

## Before you open a PR

```bash
pnpm run check
```

```bash
uv run --project python/openmurmur_audio pytest
uv run --project python/openmurmur_audio ruff check .
uv run --project python/openmurmur_audio mypy src
```

## What makes a good PR here

**Say what you actually verified.** This project documents, per feature, whether
it was run on real hardware or only tested with fakes. "It should work" is not
a status. "Tests pass; I could not verify X because I have no Y" is.

**Add a test that fails without your change.** For the sessionizer, use
`FakeClock` — never `setTimeout`.

**Explain why in comments, not what.** The code says what it does. A comment
should capture the constraint that made it look this way.

## Design constraints

These are not preferences. A PR that breaks one will be rejected regardless of
how good the code is. The reasoning is in `docs/PRODUCT.md` and `AGENTS.md`.

1. Recording never blocks on processing.
2. The sessionizer stays pure — no I/O, no `Date.now()`.
3. Durations use monotonic time.
4. Files are published atomically.
5. Nothing is deleted without a database-proven eligibility check.
6. The LLM has no capabilities beyond text → JSON.
7. Transcripts are untrusted input.
8. Secrets live only in the Keychain.
9. No new runtime dependencies. There are currently zero.

## Specifically not wanted

- **Anything that makes covert recording easier.** Hiding or suppressing the
  macOS orange indicator, disguising the process, removing status reporting,
  remote activation. See `RECORDING_POLICY.md`.
- **A cloud fallback.** If local ASR is unavailable the user gets an error, not
  a silent upload of their speech to a third party.
- **Remote destructive commands.** No `/stop`, `/delete`, `/pause`. A Telegram
  compromise must not become an archive compromise.
- **New runtime dependencies** without a strong argument.
- **Large refactors without a preceding discussion.** Open a Discussion first.

## Good first contributions

- Documentation gaps — especially anywhere the docs and the code disagree.
- Test coverage for an untested path.
- Better error messages, particularly around macOS permissions.
- Language quality reports (see the issue template).
- Verifying something currently marked unverified in `README.md`, and saying
  what you observed.

## Reporting bugs

Use the issue templates. **Never paste a bot token, a transcript, or recorded
audio into a public issue.**

Security vulnerabilities go through GitHub's private reporting, not issues. See
`SECURITY.md`.

## Commits

Conventional Commits (`feat:`, `fix:`, `docs:`, `test:`, `chore:`). One logical
change per commit.

## Review

This is a volunteer project; reviews are best-effort. Expect questions about
what you verified — that is the culture here, not distrust.

## Licence

Contributions are licensed under Apache-2.0, matching the project.
