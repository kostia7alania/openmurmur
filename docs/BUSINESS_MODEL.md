# Business model

## Position

OpenMurmur is Apache-2.0 licensed and will stay that way. The core — recording,
local transcription, local summarization, Telegram delivery — is free, and no
feature will be removed from it to create a paid tier.

There is no SaaS, and building one is not planned. A hosted service would
require sending audio somewhere, which is the exact thing this project exists to
avoid.

## Free forever

Everything below is in this repository and always will be:

- Full source.
- The CLI and daemon.
- Local ASR (Qwen3-ASR via MLX).
- Local LLM summarization (Ollama).
- Telegram delivery of audio, transcripts, reports and health.
- Incoming audio transcription.
- launchd templates.
- Self-build from source.

## Possible paid product

Not built. Listed so the intent is on the record rather than discovered later.

| Item | What it would add | Why someone would pay |
| --- | --- | --- |
| Signed, notarized `.dmg` | Install without Homebrew, Node or a toolchain | Removes the largest adoption barrier; requires a $99/year Apple Developer account |
| Automatic updates | Signed update checks with consent | Security fixes actually reach users |
| Native capture helper | Precise TCC errors, device-change handling | Fewer confusing permission failures |
| Simple installer / uninstaller | One-click setup and clean removal | Convenience |
| Premium support | Direct help, prioritized fixes | Time is the scarce resource |
| Optional encrypted status relay | Health monitoring when Telegram is unavailable | Reliability for people who depend on it |

**Constraints that apply to any paid offering:**

1. No mandatory cloud upload of audio, ever.
2. No feature is removed from the free version to create demand.
3. The paid build is compiled from this same public source.
4. Anything that would send audio anywhere is opt-in, encrypted, and off by
   default.

## Funding today

**GitHub Sponsors is not configured** for the authoring account, so
`.github/FUNDING.yml` is **not** committed. A placeholder
`.github/FUNDING.yml.example` is included instead.

Inventing a payment account that does not exist would put a broken donate button
on the repository, which is worse than having none.

To enable it: configure GitHub Sponsors (or Ko-fi / Buy Me a Coffee), then copy
the example to `.github/FUNDING.yml` and fill in the real handles.

## What the money would be for

Honest accounting, in priority order:

1. Apple Developer Program — $99/year, the hard blocker for signing and
   notarization.
2. Maintenance time — dependency updates, macOS releases, model upgrades.
3. Test hardware — different Apple Silicon generations and memory sizes.
4. Language quality work — particularly the Thai corpus (P1-07), which needs
   native-speaker review that cannot be automated.

## Why not other models

| Model | Why not |
| --- | --- |
| Open-core with a crippled free tier | The free version must be genuinely useful, or the licence is theatre. |
| Ads | In a private audio journal. No. |
| Selling data | The premise of the project is that your speech is yours. |
| Cloud subscription | Requires uploading audio. That is the thing we refuse to do. |
| Dual licensing | Adds CLA friction to contributions for little benefit at this scale. |

## Licence choice

Apache-2.0 over MIT for the explicit patent grant, and over GPL because a
permissive licence lowers the barrier to contribution and adoption for a tool
people run on their own machine. The patent grant matters here because audio
processing is a patent-dense area.
