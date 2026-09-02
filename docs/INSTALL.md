# Installing OpenMurmur on a clean Mac

From a Mac out of the box to a daemon that records, transcribes, summarizes and
delivers to Telegram. Every command below was run on the machine this project
was built on, and the failure modes described are ones actually hit rather than
ones imagined.

The [README quick start](../README.md#quick-start) assumes Node, pnpm and
Homebrew are already installed. This one assumes nothing.

**Budget:** 20 minutes of your attention, plus 30–60 minutes of downloads you
can walk away from. About 25 GB of disk.

---

## Before you start: will it run on your Mac?

| | Requirement | Why |
| --- | --- | --- |
| Chip | **Apple Silicon** (M1 or newer) | MLX needs Metal. Intel Macs cannot run the ASR model at all. |
| macOS | 14 or newer | |
| Memory | **36 GB comfortably, 16 GB with changes** | See below. |
| Disk | ~25 GB free | Models are most of it. |

Check the first two:

```bash
uname -m && sw_vers -productVersion
```

`arm64` and `14.0` or higher means you are fine.

### If you have 16 GB or 24 GB

The default config loads a 27B summarizer (~17 GB) alongside a resident 1.7B ASR
model (about 4.4 GiB in the verified Hugging Face cache). That does not fit. It
still works — use a smaller summarizer:

```bash
ollama pull qwen3.5:9b
```

and set `llm.model` to `qwen3.5:9b` in the config (step 7). Recording,
transcription and delivery are unaffected; only summary quality drops.

---

## 1. Command Line Tools

A clean Mac has no `git`. Asking for it installs the tools:

```bash
xcode-select --install
```

A dialog appears — click **Install** and wait. Already installed? You get
`command line tools are already installed`, which is the answer you wanted.

## 2. Homebrew

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

It asks for your password (it writes to `/opt/homebrew`) and prints two lines to
add Homebrew to your `PATH` at the end. **Run them** — on a clean Mac this step
is easy to skip and then nothing else is found. On Apple Silicon they are:

```bash
echo >> ~/.zprofile && echo 'eval "$(/opt/homebrew/bin/brew shellenv)"' >> ~/.zprofile && eval "$(/opt/homebrew/bin/brew shellenv)"
```

## 3. FFmpeg

Capture and every audio conversion go through it.

```bash
brew install ffmpeg
```

## 4. Node 26.7.0

OpenMurmur runs TypeScript directly, with no build step — that needs Node 26.7.0
or newer. Node 24 will not start it, and earlier Node 26 builds embed an older
`node:sqlite` than the project target.

```bash
brew install node
```

Check:

```bash
node -v
```

If Homebrew gives you something older than v26, use a version manager instead —
the repo pins the version in `.nvmrc`:

```bash
brew install nvm && mkdir -p ~/.nvm && echo 'export NVM_DIR="$HOME/.nvm"; . "$(brew --prefix nvm)/nvm.sh"' >> ~/.zprofile && source ~/.zprofile
```

then, after cloning in step 6:

```bash
nvm install && nvm use
```

## 5. Ollama, for summaries

Optional but you want it — without it you get audio and transcripts, no summary.

```bash
brew install ollama
```

Start the Homebrew service so it keeps running after this terminal closes:

```bash
brew services start ollama
```

Then pull the model. **~17 GB — start it now and continue reading.**

```bash
ollama pull qwen3.8:27b
```

## 6. The repository

```bash
git clone https://github.com/kostia7alania/openmurmur.git ~/openmurmur && cd ~/openmurmur
```

```bash
./scripts/bootstrap
```

`bootstrap` installs the pinned pnpm via npm, `uv`, the Node dependencies and the
CI-safe Python subset. It is idempotent — re-run it whenever something looks
wrong. It deliberately installs **no models**, preserves an already-installed
local model stack, and never touches the Keychain.

This source checkout does not install a global `openmurmur` binary. Run the
commands below from the repository as `pnpm openmurmur ...`.

## 7. The local model stack

This is the part `bootstrap` leaves to you, because it is several gigabytes and
pulls PyTorch:

```bash
/usr/bin/env -u UV_PROJECT_ENVIRONMENT uv sync --project python/openmurmur_audio --extra mlx
```

Clearing `UV_PROJECT_ENVIRONMENT` is intentional. The daemon, launchd and
`doctor` all use the checkout's fixed `python/openmurmur_audio/.venv`; an
interactive-shell-only environment would make readiness lie about the
background runtime.

Without this extra there is **no speech detection and no transcription** — the
daemon starts, but `doctor` reports `speech_detection` as failed. The MLX ASR
runtime, and Silero VAD, both live here.

Package installation does not provision the ASR weights. Download the default
public model explicitly, in this foreground terminal:

```bash
/usr/bin/env -u UV_PROJECT_ENVIRONMENT \
  HF_ENDPOINT=https://huggingface.co HF_HUB_DISABLE_TELEMETRY=1 HF_HUB_DISABLE_IMPLICIT_TOKEN=1 \
  uv run --no-sync --project python/openmurmur_audio \
  hf download Qwen/Qwen3-ASR-1.7B \
  --include '*.json' --include '*.safetensors' --include '*.txt' --include '*.model'
```

The verified snapshot occupies about 4.4 GiB; keep at least 6 GB free on the
cache volume. The command contacts `https://huggingface.co` and storage/CDN
hosts selected by it. Hugging Face sees the public model id and ordinary HTTPS
metadata such as your IP and user agent. It receives no audio, transcript or
Telegram secret, and the command disables telemetry and use of a cached Hub
token. The cache is selected by `HF_HUB_CACHE`, `HUGGINGFACE_HUB_CACHE` or
`HF_HOME` and otherwise defaults to `~/.cache/huggingface/hub`. See
[PRIVACY.md](../PRIVACY.md) for the complete boundary.

The daemon and `doctor` always launch the worker with Hugging Face offline mode
and uv offline mode enabled. They never install Python, sync packages or
download a missing model; `mlx_readiness` fails with this step as the fix
instead. If you changed `asr.model`, replace the default repository id in the
foreground command with the configured public model.

## 8. Check everything

```bash
pnpm openmurmur doctor
```

Read the output. It is the difference between "it should work" and "it does":

```
✅ platform           darwin/arm64
✅ node               v26.7.0
✅ sqlite             node:sqlite runtime 3.53.4 (target >= 3.53.4)
✅ ffmpeg             ffmpeg version 8.1.2
✅ audio_devices      [0] MacBook Pro Microphone
✅ uv                 uv 0.11.14
✅ mlx_readiness      configured model snapshot evidence present; 183 GB free on cache volume
✅ speech_detection   Silero VAD answered in 1291 ms
✅ ollama             qwen3.8:27b available at http://127.0.0.1:11434
⚠️  state_directory    ... (missing or not writable)
⚠️  telegram_setup    no Telegram credential items found in the macOS Keychain
```

`speech_detection` really starts the worker and scores a frame, so a green tick
there means Silero loads on your machine, not that the config says it should.

`state_directory` and `telegram_setup` are expected to warn before steps 9 and
10. The Telegram check reads item metadata only: it never reads the token or
contacts Telegram. `sqlite` should be green with the pinned Node from `.nvmrc`;
if it is not, run `nvm install && nvm use` and check
[ADR 0004](adr/0004-sqlite-driver.md).

## 9. Create the state directory

```bash
pnpm openmurmur setup
```

It prints a plan and does nothing until you confirm. Everything lives in
`~/Library/Application Support/OpenMurmur` — audio, database, config, logs.

## 10. Microphone permission

The default `audio.captureBackend` is `"ffmpeg"`. It is the simplest foreground
path and remains useful for development:

```bash
pnpm openmurmur capture test
```

This command succeeds only after real PCM frames arrive. On first use macOS may
ask Terminal or iTerm for microphone access. That grant proves this foreground
command only; do not assume a launchd process can reuse it.

For reliable background capture, install the native app while logged into the
GUI session:

```bash
./scripts/install-capture-app
```

Set this field in
`~/Library/Application Support/OpenMurmur/openmurmur.json`:

```json
{
  "audio": {
    "captureBackend": "native"
  }
}
```

Then run the one command that deliberately opens the GUI permission flow:

```bash
pnpm openmurmur capture authorize
```

It first verifies the app at its permanent path, strict code signature, audio
entitlement and signed source digest without opening the microphone. Only then
does it launch `--authorize`. No setup, doctor, installer, test or daemon command
runs this automatically. Native `--stream` never prompts.

Prove that the configured native backend produces real PCM, then check the
installed identity and read-only authorization status:

```bash
pnpm openmurmur capture test
./scripts/install-capture-app --check
```

The default installer signature is ad-hoc: it proves the local bundle but a
rebuild can change the TCC identity. A stable distributable release needs a
consistent Developer ID identity and notarization. This checkout does not claim
that a notarized release has been verified.

While the microphone is open macOS shows an **orange dot** near Control Center.
OpenMurmur adds no indicator of its own and does not try to hide that one.

## 11. Telegram

Message [@BotFather](https://t.me/BotFather), send `/newbot`, follow the
prompts, and keep the token.

This Mac is the input owner, so first set `telegram.receiveUpdates=true` in
`openmurmur.json`. Any other Mac sharing the bot must use `setup telegram
send-only`; exactly one host may receive updates.

```bash
pnpm openmurmur setup telegram owner
```

It asks for the token with **hidden input** and stores the complete token/chat
pair in one versioned macOS Keychain item. The value enters
`/usr/bin/security` through its private interactive prompt and is never written
to the config file, argv, an environment variable, a launchd plist, or a log.
Then send the bot a fresh `/start`; setup shows the selected account and asks
for confirmation before binding it.

```bash
pnpm openmurmur telegram test
```

A test message in your chat means the last piece works.

## 12. Run it

Foreground first, so you can see what it does:

```bash
pnpm openmurmur start
```

Wait until the log says `first audio frame received`, then speak for more than
3 seconds. Stop talking and wait for 60 seconds of silence. Telegram should
receive the source FLAC first, then the transcript, then the report. `Ctrl-C`
stops the daemon and finalizes whatever was recording.

The first transcription loads the already-provisioned Qwen3-ASR snapshot from
disk, so it is slower than later sessions. The model then stays resident and a
session is transcribed in a fraction of its duration. If the snapshot is
missing, the job fails locally and never starts a background download.

### Then in the background

Only after the **native** backend passes both checks in step 10:

```bash
./scripts/install-launch-agents --check
```

The first check is read-only and exits non-zero when the installed runtime,
state root, plist content or launchd registration differs from this checkout.
A fresh machine reports the agents and labels as missing, which is expected.
Then install them:

```bash
./scripts/install-launch-agents
```

If you keep state outside the default directory, pass the same canonical root
to both commands with `--root DIR`. The installer persists it in the daemon and
digest arguments; the background service does not depend on an interactive
shell's `OPENMURMUR_HOME`.

Installation commits only after launchd reports both labels registered and the
daemon's local `status --json` shows a fresh heartbeat, a running recorder and
at least one real audio frame. The probe is bounded to 20 seconds and reads no
Keychain value or network service. If readiness never becomes true, both plist
files and the previously loaded service set are restored where possible.

```bash
pnpm openmurmur status
```

```bash
tail -f ~/Library/Application\ Support/OpenMurmur/logs/daemon.err.log
```

---

## When it does not work

| Symptom | Cause and fix |
| --- | --- |
| `speech_detection` fails in `doctor` | Step 7 was skipped: `/usr/bin/env -u UV_PROJECT_ENVIRONMENT uv sync --project python/openmurmur_audio --extra mlx` |
| Native helper reports that microphone authorization is required | From a GUI login session, run step 10's `pnpm openmurmur capture authorize`; it is the only intentional prompt path. |
| FFmpeg works in Terminal but launchd has no frames | A Terminal FFmpeg grant is foreground-only proof. Install, configure and authorize the native helper in step 10. |
| Nothing recorded, no error | Genuinely no speech: Silero rejects a fan, traffic and music by design, and a session under 3 seconds of speech is dropped as noise. `pnpm openmurmur status` shows the rejected count. |
| `ollama` warns in `doctor` | Run `brew services start ollama`, then pull the configured model. Audio and transcripts are still delivered; only summaries stop. |
| Node version errors | `node -v` must be 26+. See step 4. |
| Telegram silent | `pnpm openmurmur telegram test`. Undelivered messages queue in the outbox and are retried; nothing is lost while it is offline. |
| It stopped recording after a macOS update | Major updates can reset TCC. Re-run the explicit native authorization and PCM checks in step 10. |

## Removing it

```bash
./scripts/uninstall-launch-agents
```

```bash
rm -rf ~/Library/Application\ Support/OpenMurmur
```

The Keychain item is separate and deliberately survives, so an accidental
`rm -rf` does not lose your bot token. It lives under the service
`io.openmurmur` — find it in Keychain Access by searching for `OpenMurmur`, or
delete it directly. The last two commands remove legacy compatibility items if
an older setup left them behind:

```bash
security delete-generic-password -s io.openmurmur -a telegram-secrets-v1
security delete-generic-password -s io.openmurmur -a telegram-bot-token
security delete-generic-password -s io.openmurmur -a telegram-chat-id
```
