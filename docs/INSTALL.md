# Installing OpenMurmur on a clean Mac

From a Mac out of the box to a daemon that records, transcribes, summarizes and
delivers to Telegram. Every command below was run on the machine this project
was built on, and the failure modes described are ones actually hit rather than
ones imagined.

The [README quick start](../README.md#quick-start) assumes Homebrew is already
installed and on `PATH`; bootstrap provisions the remaining repository
dependencies. This guide assumes nothing and makes each prerequisite explicit.

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

`bootstrap` installs Node and FFmpeg through Homebrew when they are missing,
then installs the pinned pnpm via npm, `uv`, the Node dependencies and the
CI-safe Python subset. It is idempotent — re-run it whenever something looks
wrong. It deliberately installs **no models**, preserves an already-installed
local model stack, and never touches the Keychain. The explicit steps above are
still useful because they make clean-machine failures easier to diagnose.

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
✅ ollama             qwen3.6:27b available at http://127.0.0.1:11434
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
pnpm openmurmur setup --telegram-role owner
```

It prints a plan and does nothing until you confirm. Everything lives in
`~/Library/Application Support/OpenMurmur` — audio, database, config, logs.
Use `--telegram-role send-only` on every other Mac sharing the same bot. Setup
sets this role only while creating a fresh config and never rewrites an existing
one.

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
does it inspect the non-prompting authorization status. `not_determined` opens
the GUI flow and waits at most 30 seconds for a decision; `denied` directs you to
the System Settings toggle (and a scoped `tccutil` reset if it is stuck);
`restricted` requires the Mac administrator or MDM policy owner. Re-running the
GUI command cannot make macOS prompt after a denial. No setup, doctor, installer,
test or daemon command requests permission automatically. Native `--stream`
never prompts.

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

The fresh setup above selected this Mac as the input owner. Any other Mac
sharing the bot must use both `--telegram-role send-only` during fresh setup and
`setup telegram send-only`; exactly one host may receive updates.

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
receive the source FLAC first, then the transcript, then the report on the
no-retry happy path. A delayed audio retry does not block a transcript or report
that is already ready. `Ctrl-C` stops the daemon and finalizes whatever was
recording.

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

#### Attended upgrade rollback rehearsal

An ordinary successful upgrade does not prove rollback. Use this D121 rehearsal
only when both agents are already installed, from the logged-in GUI account,
with the native helper already authorized. It saves the exact plist hashes,
registration set and full read-only `launchctl print` output in a private
directory. It then makes `logLevel` invalid temporarily: the installer's native
and TCC preflight still passes, but the daemon and the same `status` readiness
probe reject the config before capture opens. The installer must return
non-zero and restore the prior files and loaded-label set.

This deliberately changes launchd state and therefore needs explicit operator
approval. After the config is restored, the previous daemon is required to
start again: normal startup may read its Keychain credentials and reopen the
already-authorized microphone. The rehearsal requests no new TCC prompt. If
the installed agents use a non-default state root, change both `STATE_ROOT`
assignments below to that exact root before running anything.

```bash
(
set -euo pipefail

STATE_ROOT="$HOME/Library/Application Support/OpenMurmur"
CONFIG_FILE="$STATE_ROOT/openmurmur.json"
AGENT_DIR="$HOME/Library/LaunchAgents"
NODE_BIN="$(command -v node)"
EVIDENCE_DIR="$(mktemp -d /private/tmp/openmurmur-d121.XXXXXX)"
chmod 0700 "$EVIDENCE_DIR"

./scripts/install-capture-app --check
[ -n "$NODE_BIN" ] && [ -x "$NODE_BIN" ]
[ -f "$CONFIG_FILE" ] && [ ! -L "$CONFIG_FILE" ]
for label in io.openmurmur.daemon io.openmurmur.digest; do
  [ -f "$AGENT_DIR/$label.plist" ] || {
    echo "D121 needs an existing installed-agent baseline: $label.plist is missing" >&2
    exit 1
  }
done

cp -p "$CONFIG_FILE" "$EVIDENCE_DIR/openmurmur.json.before"
chmod 0600 "$EVIDENCE_DIR/openmurmur.json.before"
/usr/bin/shasum -a 256 \
  "$AGENT_DIR/io.openmurmur.daemon.plist" \
  "$AGENT_DIR/io.openmurmur.digest.plist" \
  > "$EVIDENCE_DIR/plists.before.sha256"

snapshot_launchd() {
  local phase="$1"
  local label
  local registration
  : > "$EVIDENCE_DIR/labels.$phase"
  for label in io.openmurmur.daemon io.openmurmur.digest; do
    if launchctl print "gui/$(id -u)/$label" \
      > "$EVIDENCE_DIR/$label.$phase.print" 2>&1; then
      registration=registered
    else
      registration=absent
    fi
    printf '%s %s\n' "$label" "$registration" >> "$EVIDENCE_DIR/labels.$phase"
  done
}

restore_config() {
  local staged="$CONFIG_FILE.d121-restore.$$"
  [ ! -e "$staged" ] && [ ! -L "$staged" ]
  cp -p "$EVIDENCE_DIR/openmurmur.json.before" "$staged"
  chmod 0600 "$staged"
  mv -f "$staged" "$CONFIG_FILE"
}

wait_for_restored_daemon() {
  local phase="$1"
  local attempt=1
  local output
  local validation
  while [ "$attempt" -le 20 ]; do
    validation=""
    if output="$("$NODE_BIN" src/cli/main.ts status --root "$STATE_ROOT" --json 2>&1)" && \
      validation="$("$NODE_BIN" --input-type=module - "$output" 2>&1 <<'NODE'
const status = JSON.parse(process.argv[2]);
if (
  status.daemon !== 'running' ||
  status.heartbeatStatus !== 'fresh' ||
  status.recorderRunning !== true ||
  typeof status.lastSourceFrameAgeMs !== 'number' ||
  !Number.isFinite(status.lastSourceFrameAgeMs) ||
  status.lastSourceFrameAgeMs < 0
) {
  process.exit(1);
}
NODE
      )"; then
      printf '%s\n' "$output" > "$EVIDENCE_DIR/restored-status.$phase.json"
      return 0
    fi
    printf '%s\n' "${validation:-$output}" > "$EVIDENCE_DIR/restored-status.$phase.last-error"
    attempt=$((attempt + 1))
    [ "$attempt" -le 20 ] && sleep 1
  done
  echo "Restored daemon did not return to a fresh real-frame heartbeat; inspect $EVIDENCE_DIR" >&2
  return 1
}

snapshot_launchd before
wait_for_restored_daemon before
trap restore_config EXIT
trap 'exit 130' HUP INT TERM

"$NODE_BIN" --input-type=module - "$CONFIG_FILE" <<'NODE'
import { readFileSync, renameSync, writeFileSync } from 'node:fs';

const configFile = process.argv[2];
const config = JSON.parse(readFileSync(configFile, 'utf8'));
if (config?.audio?.captureBackend !== 'native') {
  throw new Error('D121 rehearsal requires audio.captureBackend="native"');
}
config.logLevel = '__d121_readiness_failure__';
const staged = `${configFile}.d121-${process.pid}`;
writeFileSync(staged, `${JSON.stringify(config, null, 2)}\n`, {
  flag: 'wx',
  mode: 0o600,
});
renameSync(staged, configFile);
NODE

if "$NODE_BIN" src/cli/main.ts status --root "$STATE_ROOT" --json \
  > "$EVIDENCE_DIR/invalid-status.stdout" \
  2> "$EVIDENCE_DIR/invalid-status.stderr"; then
  echo "Refusing rehearsal: the invalid config did not fail the readiness command" >&2
  exit 1
fi

set +e
./scripts/install-launch-agents --yes --node "$NODE_BIN" --root "$STATE_ROOT" \
  > "$EVIDENCE_DIR/installer.stdout" \
  2> "$EVIDENCE_DIR/installer.stderr"
INSTALL_EXIT=$?
set -e

if [ "$INSTALL_EXIT" -eq 0 ] || \
  ! /usr/bin/grep -Fq "Daemon readiness failed after registration" \
    "$EVIDENCE_DIR/installer.stderr"; then
  echo "Installer did not reach the expected readiness rollback; inspect $EVIDENCE_DIR" >&2
  exit 1
fi

restore_config
cmp "$EVIDENCE_DIR/openmurmur.json.before" "$CONFIG_FILE"
trap - EXIT HUP INT TERM
/usr/bin/shasum -a 256 -c "$EVIDENCE_DIR/plists.before.sha256"
snapshot_launchd after
cmp "$EVIDENCE_DIR/labels.before" "$EVIDENCE_DIR/labels.after"
wait_for_restored_daemon after
echo "D121 rollback restored exact plist bytes, registration set and live audio readiness."
echo "Evidence: $EVIDENCE_DIR"
)
```

Only after that rollback proof, run the real PCM check and the valid D069
upgrade. These commands are the live gate; this document does not claim their
success before they are run:

```bash
STATE_ROOT="$HOME/Library/Application Support/OpenMurmur"
pnpm openmurmur --root "$STATE_ROOT" capture test
./scripts/install-launch-agents --root "$STATE_ROOT"
./scripts/install-launch-agents --check --root "$STATE_ROOT"
pnpm openmurmur --root "$STATE_ROOT" status
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
| `speech_detection` fails in `doctor` | Step 7 was skipped: `/usr/bin/env -u UV_PROJECT_ENVIRONMENT uv sync --project python/openmurmur_audio --extra mlx` |
| Native helper reports `not_determined` | From a GUI login session, run step 10's `pnpm openmurmur capture authorize`; it is the only intentional prompt path. |
| Native helper reports `denied` | macOS will not prompt again. Enable **OpenMurmur Capture** in System Settings → Privacy & Security → Microphone. If the entry is absent or stuck, run `/usr/bin/tccutil reset Microphone io.openmurmur.capture`, then authorize again from the GUI. |
| Native helper reports `restricted` | A system policy, Screen Time or MDM owns the restriction. Ask the Mac administrator; repeated authorization cannot override it. |
| FFmpeg works in Terminal but launchd has no frames | A Terminal FFmpeg grant is foreground-only proof. Install, configure and authorize the native helper in step 10. |
| Nothing recorded, no error | Genuinely no speech: Silero rejects a fan, traffic and music by design, and a session under 3 seconds of speech is dropped as noise. `pnpm openmurmur status` shows the rejected count. |
| `ollama` warns in `doctor` | Run `brew services start ollama`, then pull the configured model. Audio and transcripts are still delivered; only summaries stop. |
| Node version errors | `node -v` must be 26+. See step 4. |
| Telegram silent | `pnpm openmurmur telegram test`. Undelivered messages queue in the outbox and are retried; nothing is lost while it is offline. |
| It stopped recording after a macOS update | Inspect the status with `./scripts/install-capture-app --check`, follow the status-specific `not_determined`/`denied`/`restricted` recovery above, then repeat the real PCM check. |

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
