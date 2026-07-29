## What and why

<!-- What does this change, and what problem does it solve? -->

## How it was verified

<!-- Not "it should work". What did you actually run? -->

- [ ] `pnpm run check` passes (typecheck + lint + tests)
- [ ] `uv run --project python/openmurmur_audio pytest` passes (if Python changed)
- [ ] Tested on real hardware — describe what you observed:

## Checklist

- [ ] New behaviour has tests, and they fail without the change
- [ ] No secret can reach a log, argv, a config file, or a plist
- [ ] No new runtime dependency (or the PR explains why one is necessary)
- [ ] Docs updated if behaviour or configuration changed
- [ ] `docs/DEPENDENCIES.md` updated if a version changed, with the date verified

## If this touches recording, retention, or Telegram

- [ ] It does not make covert recording easier (see `RECORDING_POLICY.md`)
- [ ] It does not weaken the retention eligibility proof
- [ ] It does not give the LLM any capability beyond text → JSON
- [ ] It does not add a Telegram command that can stop recording or delete data

## Anything unfinished

<!-- State it plainly. An honest "this part is unverified" is worth more than
     a green checklist. -->
