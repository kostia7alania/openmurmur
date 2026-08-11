# AGENTS.md

Instructions for AI coding agents working in this repository. Humans should
read `CONTRIBUTING.md` — this file covers what an agent is likely to get wrong.

## Verification gates

```bash
pnpm install
pnpm run check
uv run --project python/openmurmur_audio pytest
```

These are full-repository release and hand-off gates. Run them before a release,
after a cross-cutting change, or when the affected boundary is unclear. For a
bounded MVP iteration, run the smallest relevant checks first; do not repeatedly
run the whole suite after every small hunk. None of the full gates needs a
microphone, a model, a network, or a Telegram token.

## MVP test budget

OpenMurmur is still discovering its MVP. Optimize for shipped user value and
fast learning, not test count, coverage percentage, or TDD ceremony.

- Do not create tests, test tasks, matrices, fixtures, or abstractions merely to
  increase coverage or make CI look comprehensive.
- Do not use TDD by default while behavior and product requirements are still
  exploratory. Build the thinnest real vertical slice, validate the actual user
  flow, then automate only the proof justified by what was learned.
- Add or expand an automated test only when it protects a concrete expensive
  risk: a non-negotiable invariant, money, user data, deletion, migration,
  security/privacy, concurrency/idempotency, a reproduced bug, or a stable
  user-visible contract.
- Prefer one high-signal regression, contract, or integration test over broad
  duplicate unit coverage. Remove or simplify obsolete tests when the product
  decision changes.
- Every testing task must name the shipping decision or failure risk it buys
  down. If neither is concrete, spend the time on implementation, live
  validation, or user feedback instead.
- Existing relevant checks still run before hand-off, and no one may weaken the
  safety invariants below or claim verification that did not happen.

Revisit broader regression coverage and stronger CI gates after revenue/product
fit, or earlier only when the owner explicitly asks for it.

## Non-negotiable invariants

Breaking any of these is a bug even if every test passes.

1. **The microphone never blocks on processing.** Nothing slow or fallible goes
   on the recorder's hot path. Session finalization enqueues a job and returns.
2. **`src/sessionizer/machine.ts` stays pure.** No filesystem, no database, no
   network, no `Date.now()`. It takes frames and returns intents. This is what
   makes every timing rule testable in microseconds.
3. **Durations use monotonic time.** `frame.monotonicMs`, never `wallMs`. Wall
   time is for display and storage only.
4. **Files are published atomically.** Temp path → fsync → rename → fsync the
   directory. Never write directly into `audio/`.
5. **Nothing is deleted without proof.** Retention is pure SQL over recorded
   facts. Do not add a heuristic, a timestamp shortcut, or an LLM.
6. **The LLM has no capabilities.** It converts text to JSON. Do not give it a
   tool, a file path, a shell, or a say in any decision.
7. **Transcripts are untrusted input.** Never let transcript content reach a
   command, a path, or a control-flow decision.
8. **Secrets stay in the Keychain.** Never argv, env, config, plist, or log.
   Redaction lives in `src/logging/redact.ts` at the logger boundary.
9. **Status is never claimed before it is true.** `🟢 Запись включена` is sent
   after a real audio frame arrives.
10. **No new runtime dependencies.** There are zero, deliberately. Node provides
    fetch, SQLite, arg parsing and the test runner.

## Verify, do not assume

This project's documentation states, per feature, whether it was actually run.
Maintain that.

- Do not write "should work" — run it.
- Do not mark something verified because its tests pass; say which tests.
- If you cannot verify something (no model, no bot token, no microphone), say
  so explicitly in the PR and in `docs/BACKLOG.md`.
- `README.md` has a "What is verified" section. Keep it accurate.

Checking real versions rather than assuming them has already caught: `gh` on
PATH being an unrelated npm package, TypeScript 7 shipping `tsc` rather than
`tsgo`, older Node 26 builds bundling SQLite 3.53.3 rather than 3.53.4, and
onnxruntime capping Python at 3.14.

## Gotchas that have already bitten

- **`erasableSyntaxOnly`** forbids TypeScript parameter properties
  (`constructor(private x: T)`). Use explicit `#private` fields.
- **`noPropertyAccessFromIndexSignature`** requires `obj['key']`. Biome's
  `useLiteralKeys` is disabled for this reason; do not re-enable it.
- **ffmpeg cannot infer a muxer from `.part`.** Any temp output path needs an
  explicit `-f <format>`.
- **`node:sqlite` `.all()`/`.get()`** return `Record<string, SQLOutputValue>`;
  cast via `as unknown as T`.
- **grep's `-I` skips "binary" files.** One stray control byte hides a whole
  file from the secret scan. The CI scan uses `--binary-files=text`.
- **`??` binds looser than `>`.** `x?.length ?? 0 > 0` is not what it looks
  like. Biome's `noSelfCompare` catches this one.

## Testing rules

- Sessionizer tests use `FakeClock`. Never `setTimeout` to wait out a timeout.
- Audio fixtures are generated with ffmpeg at test time. Do not commit binary
  audio.
- ASR and LLM use the fake adapters. CI must never download a model.
- Telegram uses a scripted `fetch` returning real Bot API response shapes.
- A test that fails should name the guarantee that broke, not just the value.

## Style

Match the surrounding code. Comments explain **why**, not what — particularly
where a subtle constraint drove the design. Do not add comments that restate the
code.

## Things that will be rejected

- Anything making covert recording easier: hiding the macOS indicator,
  disguising the process, removing status reporting, remote activation.
- A cloud fallback for ASR or summarization.
- A Telegram command that stops recording or deletes data.
- Weakening the retention eligibility proof.
- Claiming something works without having run it.
