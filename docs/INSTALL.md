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
model (~2 GB). That does not fit. It still works — use a smaller summarizer:

```bash
ollama pull qwen3.6:8b
```

and set `llm.model` to `qwen3.6:8b` in the config (step 7). Recording,
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
ollama pull qwen3.6:27b
```

## 6. The repository

```bash
git clone https://github.com/kostia7alania/openmurmur.git ~/openmurmur && cd ~/openmurmur
```

```bash
./scripts/bootstrap
```

`bootstrap` installs pnpm (via corepack), `uv`, the Node dependencies and the
CI-safe Python subset. It is idempotent — re-run it whenever something looks
wrong. It deliberately installs **no models**, preserves an already-installed
local model stack, and never touches the Keychain.

## 7. The local model stack

This is the part `bootstrap` leaves to you, because it is several gigabytes and
pulls PyTorch:

```bash
uv sync --project python/openmurmur_audio --extra mlx
```

Without this extra there is **no speech detection and no transcription** — the
daemon starts, but `doctor` reports `speech_detection` as failed. The MLX ASR
runtime, and Silero VAD, both live here.

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
✅ speech_detection   Silero VAD answered in 1291 ms
✅ ollama             qwen3.6:27b available at http://127.0.0.1:11434
⚠️  state_directory    ... (missing or not writable)
```

`speech_detection` really starts the worker and scores a frame, so a green tick
there means Silero loads on your machine, not that the config says it should.

`state_directory` is expected to warn before step 9. `sqlite` should be green
with the pinned Node from `.nvmrc`; if it is not, run `nvm install && nvm use`
and check [ADR 0004](adr/0004-sqlite-driver.md).

## 9. Create the state directory

```bash
pnpm openmurmur setup
```

It prints a plan and does nothing until you confirm. Everything lives in
`~/Library/Application Support/OpenMurmur` — audio, database, config, logs.

## 10. Microphone permission

**Do this from a terminal, while you are at the keyboard.**

```bash
pnpm openmurmur capture test
```

macOS shows the microphone prompt. Grant it, and watch the input levels it
prints while you speak.

The grant belongs to the app that *launches* the process — Terminal, iTerm, or
later the launchd agent — not to OpenMurmur. Switching terminals means a new
prompt. A launchd agent may not be able to show a prompt at all, which is why
this step comes before step 12.

While the microphone is open macOS shows an **orange dot** near Control Center.
OpenMurmur adds no indicator of its own and does not try to hide that one.

## 11. Telegram

Message [@BotFather](https://t.me/BotFather), send `/newbot`, follow the
prompts, and keep the token.

```bash
pnpm openmurmur setup telegram
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

Speak. Within a second or two the log says `session started`; stop talking and
60 seconds later the session closes, is transcribed, summarized and delivered.
`Ctrl-C` stops it and finalizes whatever was recording.

The first transcription is slow — it downloads Qwen3-ASR-1.7B (~2 GB) and loads
it. After that the model stays resident and a session is transcribed in a
fraction of its duration.

### Then in the background

Only after the microphone permission is granted (step 10):

```bash
./scripts/install-launch-agents
```

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
| `speech_detection` fails in `doctor` | Step 7 was skipped: `uv sync --project python/openmurmur_audio --extra mlx` |
| `macOS denied microphone access` | Step 10, from a terminal. System Settings → Privacy & Security → Microphone must list the terminal you launch from. |
| Nothing recorded, no error | Genuinely no speech: Silero rejects a fan, traffic and music by design, and a session under 3 seconds of speech is dropped as noise. `pnpm openmurmur status` shows the rejected count. |
| `ollama` warns in `doctor` | Run `brew services start ollama`, then pull the configured model. Audio and transcripts are still delivered; only summaries stop. |
| Node version errors | `node -v` must be 26+. See step 4. |
| Telegram silent | `pnpm openmurmur telegram test`. Undelivered messages queue in the outbox and are retried; nothing is lost while it is offline. |
| It stopped recording after a macOS update | Major updates can reset TCC. Re-run step 10. |

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
