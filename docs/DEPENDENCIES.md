# Dependencies

All versions below were **verified on the development machine on 2026-07-29**
(macOS 26.5.2, Apple Silicon) unless the row says otherwise. Anything not
actually executed is marked explicitly rather than assumed.

## Runtime

| Component | Pinned | Verified | Notes |
| --- | --- | --- | --- |
| Node.js | 26.5.0 | ✅ executed | Current, **not yet LTS** — see [ADR-0001](adr/0001-node-26.md). |
| TypeScript | 7.0.2 | ✅ `tsc --noEmit` exits 0 | Ships as `tsc`, not `tsgo`. |
| pnpm | 10.19.0 | ✅ `pnpm install` succeeded | 11.17.0 is the latest published version; 10.19.0 is what is installed here and what `packageManager` pins, so the lockfile matches a manager that was actually run. |
| Biome | 2.5.6 | ✅ `biome check` exits 0 | Replaces ESLint + Prettier — see [ADR-0005](adr/0005-biome-over-eslint.md). |
| `@types/node` | 26.1.2 | ✅ | Latest published. |
| SQLite (`node:sqlite`) | **3.53.3** | ✅ queried at runtime | Below the 3.53.4 target — see [ADR-0004](adr/0004-sqlite-driver.md). |
| FFmpeg / ffprobe | 8.1.1 | ✅ used in integration tests | `brew install ffmpeg`. |
| Python | 3.14.5 | ✅ 26 tests pass | Newest with wheels across the whole stack. |
| uv | 0.11.14 | ✅ `uv sync` succeeded | |

## Node packages

Only three, all dev-only. There are **no runtime npm dependencies**: HTTP is
Node's `fetch`, argument parsing is `node:util.parseArgs`, SQLite is
`node:sqlite`, the test runner is `node:test`.

```json
{
  "@biomejs/biome": "2.5.6",
  "@types/node": "26.1.2",
  "typescript": "7.0.2"
}
```

Exact versions, no ranges. `pnpm-lock.yaml` is committed.

## Python packages

| Package | Pinned | Verified | Purpose |
| --- | --- | --- | --- |
| numpy | 2.5.1 | ✅ imported | Array handling. Requires ≥ 3.12. |
| onnxruntime | 1.28.0 | ✅ imported | Silero VAD inference. **Publishes cp311–cp314 only**, which is what caps Python at 3.14. |
| soundfile | 0.14.0 | ✅ imported | Audio file reading. |
| pytest | 9.1.1 | ✅ 26 tests pass | |
| ruff | 0.16.0 | ✅ clean | Lint and format. |
| mypy | 2.3.0 | ✅ strict, clean | |

### Optional `mlx` extra — **not installed or executed here**

| Package | Pinned | Status |
| --- | --- | --- |
| mlx | ≥0.32.0,<0.33 | ⚠️ Not installed. Latest published is 0.32.0 (wheels cp310–cp314, macOS arm64). |
| mlx-qwen3-asr | ≥0.3.5,<0.4 | ⚠️ Not installed. Latest published is 0.3.5 (pure Python, requires ≥3.10). |

Kept as an extra because it pulls several GB of weights and needs Metal, so CI
must not install it. **Consequence: Qwen3-ASR inference is unverified in this
repository.** The worker's error path for a missing MLX install *is* verified —
it returns an actionable `model_load_failed` naming the `uv sync --extra mlx`
command.

### Silero VAD — **not installed or executed here**

`silero-vad` 6.2.1 is the intended version. It is not in the CI-installed
subset, so the ONNX model has not been run. The **segment-assembly logic** on
top of it is fully tested (7 Python tests) because it is pure and takes a list
of probabilities.

## External services

| Service | Version | Verified | Notes |
| --- | --- | --- | --- |
| Ollama | `qwen3.6:27b` (Q4_K_M) | ⚠️ **not installed** | Optional. Its absence degrades the report; it never blocks delivery. `doctor` reports it as a warning with the install command. |
| Telegram Bot API | Cloud, official | ⚠️ **no live calls made** | Response shapes are exercised with a scripted `fetch`. |

## How Python 3.14 was chosen

Not by version number. By what actually has wheels:

```
onnxruntime 1.28.0 → cp311, cp312, cp313, cp314   ← the binding constraint
mlx         0.32.0 → cp310..cp314, macOS arm64
numpy       2.5.1  → requires ≥ 3.12
```

Python 3.15.0b1 exists and `uv` can install it, but onnxruntime publishes no
cp315 wheels, so it would mean a source build of a large C++ project on every
developer's machine. 3.14.5 is the newest version the whole stack actually
supports. See [ADR-0002](adr/0002-python-runtime.md).

## Deliberately not used

| Rejected | Why |
| --- | --- |
| Node 18 / 20 | Below the project's stated floor. |
| TypeScript 5 | Superseded. |
| Express, NestJS | No HTTP server is needed. |
| Electron | A menu-bar app would triple the install size for no capability. |
| Telegraf, grammY | Six Bot API methods are needed, with strict control over retry and rate limiting, and no third-party code touching the token. |
| `request`, `axios`, `node-fetch` | Node has `fetch`. |
| Moment.js | Deprecated; `Intl` and `Date` suffice. |
| `cron` (the npm package) | launchd is the correct scheduler on macOS. |
| Docker | Cannot access AVFoundation or Metal from a Linux container on macOS. |
| `typescript-eslint` | Requires the TypeScript compiler API, which TS 7 does not expose stably. Downgrading TypeScript for a linter is the wrong trade — see [ADR-0005](adr/0005-biome-over-eslint.md). |
| CommonJS | ESM only. |

## Update policy

1. `dependabot.yml` proposes updates weekly.
2. CI must be green.
3. A model version change additionally requires the P1-06 canary corpus before
   it is accepted — a silent quality regression in ASR is much worse than a
   build failure.
4. Update this file with the new version **and the date it was verified**.

## Re-verification

```bash
pnpm run check
```

```bash
uv run --project python/openmurmur_audio pytest
```

```bash
pnpm openmurmur doctor
```
