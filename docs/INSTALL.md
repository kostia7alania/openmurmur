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

During processing, the default config can load a 27B summarizer (~17 GB)
alongside a 1.7B ASR model (about 4.4 GiB in the verified Hugging Face cache).
They unload after bounded idle time, but the processing peak still does not fit.
Use a smaller summarizer:

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

The first transcription in an active burst loads the already-provisioned
Qwen3-ASR snapshot from disk, so it is slower than later sessions in that burst.
After `asr.workerIdleTimeoutMs` without work, the worker exits and releases the
model memory; the next job starts it again. If the snapshot is missing, the job
fails locally and never starts a background download.

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
non-zero and restore the prior files and loaded-label set. The block uses the
exact Node executable recorded in the installed daemon plist, validates it
against `runtime-requirements.json`, and moves the proved config through a
private adjacent directory. It never overwrites an unexpected config path;
conflicting bytes and rollback evidence are retained for inspection.

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
DAEMON_PLIST="$AGENT_DIR/io.openmurmur.daemon.plist"
RUNTIME_CONTRACT="$PWD/runtime-requirements.json"
WORK_DIR=""
WORK_DIR_ID=""
EVIDENCE_DIR=""
EVIDENCE_DIR_ID=""
MANIFEST_WORK_DIR=""
MANIFEST_WORK_DIR_ID=""
STATE_ROOT_ID=""
HOME_ID=""
AGENT_DIR_ID=""
CONFIG_ID=""
CONFIG_SHA256=""
CONFIG_MODE=""
INVALID_ID=""
INVALID_SHA256=""
INVALID_MODE=""
CONFIG_MUTATION_STARTED=false
CONFIG_RESTORED=true
PRESERVE_WORK_DIR=false
CONFLICT_COUNT=0

directory_identity() {
  /usr/bin/stat -f '%d:%i' "$1"
}

file_identity() {
  /usr/bin/stat -f '%d:%i' "$1"
}

file_sha256() {
  /usr/bin/shasum -a 256 "$1" | /usr/bin/awk '{print $1}'
}

file_mode() {
  /usr/bin/stat -f '%Lp' "$1"
}

require_physical_directory() {
  local path="$1"
  local label="$2"
  local physical
  [ -d "$path" ] && [ ! -L "$path" ] || {
    echo "$label must be a physical directory: $path" >&2
    exit 1
  }
  physical="$(cd "$path" && pwd -P)"
  [ "$physical" = "$path" ] || {
    echo "$label must not contain symlinked or non-canonical components: $path" >&2
    exit 1
  }
  [ "$(/usr/bin/stat -f '%u' "$path")" = "$(id -u)" ] || {
    echo "$label must be owned by the current user: $path" >&2
    exit 1
  }
}

require_physical_directory "$HOME" HOME
require_physical_directory "$HOME/Library" HOME/Library
require_physical_directory "$AGENT_DIR" HOME/Library/LaunchAgents
require_physical_directory "$STATE_ROOT" STATE_ROOT
HOME_ID="$(directory_identity "$HOME")"
STATE_ROOT_ID="$(directory_identity "$STATE_ROOT")"
AGENT_DIR_ID="$(directory_identity "$AGENT_DIR")"

[ -f "$DAEMON_PLIST" ] && [ ! -L "$DAEMON_PLIST" ] || {
  echo "D121 needs a regular installed daemon plist: $DAEMON_PLIST" >&2
  exit 1
}
NODE_BIN="$(/usr/libexec/PlistBuddy -c 'Print :ProgramArguments:0' "$DAEMON_PLIST")"
[ -n "$NODE_BIN" ] && [ "${NODE_BIN#/}" != "$NODE_BIN" ] && [ -x "$NODE_BIN" ] || {
  echo "Installed daemon ProgramArguments:0 is not an absolute executable" >&2
  exit 1
}
[ -f "$RUNTIME_CONTRACT" ] && [ ! -L "$RUNTIME_CONTRACT" ]
"$NODE_BIN" --input-type=module - "$RUNTIME_CONTRACT" "$NODE_BIN" <<'NODE'
import { readFileSync } from 'node:fs';

const contract = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const expectedExecutable = process.argv[3];
const versionPattern = /^\d+\.\d+\.\d+$/;
const keys = ['nodeMinimum', 'sqliteMinimum', 'pnpmExact'];
if (contract.schemaVersion !== 1 || keys.some((key) => !versionPattern.test(contract[key]))) {
  throw new Error('invalid runtime requirements contract');
}
if (process.execPath !== expectedExecutable) {
  throw new Error(`installed Node resolved to ${process.execPath}, expected ${expectedExecutable}`);
}
function compare(left, right) {
  const a = left.split('.').map(Number);
  const b = right.split('.').map(Number);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const delta = (a[index] ?? 0) - (b[index] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
}
const sqlite = process.versions.sqlite ?? '0.0.0';
if (
  compare(process.versions.node, contract.nodeMinimum) < 0 ||
  compare(sqlite, contract.sqliteMinimum) < 0
) {
  throw new Error(
    `installed runtime is incompatible: Node ${process.versions.node}, SQLite ${sqlite}`,
  );
}
NODE

evidence_directory_unchanged() {
  local physical
  [ -n "$EVIDENCE_DIR" ] && [ -d "$EVIDENCE_DIR" ] && [ ! -L "$EVIDENCE_DIR" ] && \
    physical="$(cd "$EVIDENCE_DIR" 2>/dev/null && pwd -P)" && \
    [ "$physical" = "$EVIDENCE_DIR" ] && \
    [ "$(/usr/bin/stat -f '%u' "$EVIDENCE_DIR")" = "$(id -u)" ] && \
    [ "$(file_mode "$EVIDENCE_DIR")" = "700" ] && \
    [ "$(directory_identity "$EVIDENCE_DIR")" = "$EVIDENCE_DIR_ID" ]
}

boundaries_unchanged() {
  local agents_physical
  local home_physical
  local state_physical
  [ -d "$HOME" ] && [ ! -L "$HOME" ] && \
    home_physical="$(cd "$HOME" 2>/dev/null && pwd -P)" && \
    [ "$home_physical" = "$HOME" ] && \
    [ "$(directory_identity "$HOME")" = "$HOME_ID" ] && \
    [ -d "$AGENT_DIR" ] && [ ! -L "$AGENT_DIR" ] && \
    agents_physical="$(cd "$AGENT_DIR" 2>/dev/null && pwd -P)" && \
    [ "$agents_physical" = "$AGENT_DIR" ] && \
    [ "$(directory_identity "$AGENT_DIR")" = "$AGENT_DIR_ID" ] && \
    [ -d "$STATE_ROOT" ] && [ ! -L "$STATE_ROOT" ] && \
    state_physical="$(cd "$STATE_ROOT" 2>/dev/null && pwd -P)" && \
    [ "$state_physical" = "$STATE_ROOT" ] && \
    [ "$(directory_identity "$STATE_ROOT")" = "$STATE_ROOT_ID" ] && \
    { [ -z "$EVIDENCE_DIR" ] || evidence_directory_unchanged; }
}

work_directory_unchanged() {
  local physical
  [ -n "$WORK_DIR" ] && [ -d "$WORK_DIR" ] && [ ! -L "$WORK_DIR" ] && \
    physical="$(cd "$WORK_DIR" 2>/dev/null && pwd -P)" && \
    [ "$physical" = "$WORK_DIR" ] && \
    [ "$(directory_identity "$WORK_DIR")" = "$WORK_DIR_ID" ]
}

manifest_work_directory_unchanged() {
  local physical
  [ -n "$MANIFEST_WORK_DIR" ] && [ -d "$MANIFEST_WORK_DIR" ] && \
    [ ! -L "$MANIFEST_WORK_DIR" ] && \
    physical="$(cd "$MANIFEST_WORK_DIR" 2>/dev/null && pwd -P)" && \
    [ "$physical" = "$MANIFEST_WORK_DIR" ] && \
    [ "$(/usr/bin/stat -f '%u' "$MANIFEST_WORK_DIR")" = "$(id -u)" ] && \
    [ "$(file_mode "$MANIFEST_WORK_DIR")" = "700" ] && \
    [ "$(directory_identity "$MANIFEST_WORK_DIR")" = "$MANIFEST_WORK_DIR_ID" ]
}

config_is_original() {
  boundaries_unchanged && [ -f "$CONFIG_FILE" ] && [ ! -L "$CONFIG_FILE" ] && \
    [ "$(file_identity "$CONFIG_FILE")" = "$CONFIG_ID" ] && \
    [ "$(file_sha256 "$CONFIG_FILE")" = "$CONFIG_SHA256" ] && \
    [ "$(file_mode "$CONFIG_FILE")" = "$CONFIG_MODE" ]
}

config_is_invalid() {
  boundaries_unchanged && [ -f "$CONFIG_FILE" ] && [ ! -L "$CONFIG_FILE" ] && \
    [ "$(file_identity "$CONFIG_FILE")" = "$INVALID_ID" ] && \
    [ "$(file_sha256 "$CONFIG_FILE")" = "$INVALID_SHA256" ] && \
    [ "$(file_mode "$CONFIG_FILE")" = "$INVALID_MODE" ]
}

preserve_current_config() {
  local conflict
  boundaries_unchanged && work_directory_unchanged || return 1
  if [ ! -e "$CONFIG_FILE" ] && [ ! -L "$CONFIG_FILE" ]; then return 0; fi
  CONFLICT_COUNT=$((CONFLICT_COUNT + 1))
  conflict="$WORK_DIR/openmurmur.json.conflict.$CONFLICT_COUNT"
  [ ! -e "$conflict" ] && [ ! -L "$conflict" ] || return 1
  /bin/mv "$CONFIG_FILE" "$conflict" || return 1
  PRESERVE_WORK_DIR=true
}

preserve_work_path_as_conflict() {
  local source="$1"
  local conflict
  boundaries_unchanged && work_directory_unchanged || return 1
  [ -e "$source" ] || [ -L "$source" ] || return 1
  CONFLICT_COUNT=$((CONFLICT_COUNT + 1))
  conflict="$WORK_DIR/openmurmur.json.conflict.$CONFLICT_COUNT"
  [ ! -e "$conflict" ] && [ ! -L "$conflict" ] || return 1
  /bin/mv "$source" "$conflict" || return 1
  PRESERVE_WORK_DIR=true
}

restore_config() {
  local live_copy="$WORK_DIR/openmurmur.json.invalid.live"
  local conflict_found=false
  if config_is_original; then
    CONFIG_RESTORED=true
    return 0
  fi
  boundaries_unchanged && work_directory_unchanged || {
    PRESERVE_WORK_DIR=true
    return 1
  }
  [ -f "$WORK_DIR/openmurmur.json.snapshot" ] && \
    [ ! -L "$WORK_DIR/openmurmur.json.snapshot" ] && \
    [ "$(file_identity "$WORK_DIR/openmurmur.json.snapshot")" = "$CONFIG_ID" ] && \
    [ "$(file_sha256 "$WORK_DIR/openmurmur.json.snapshot")" = "$CONFIG_SHA256" ] && \
    [ "$(file_mode "$WORK_DIR/openmurmur.json.snapshot")" = "$CONFIG_MODE" ] || {
      PRESERVE_WORK_DIR=true
      return 1
    }

  if config_is_invalid; then
    [ ! -e "$live_copy" ] && [ ! -L "$live_copy" ] && \
      /bin/mv "$CONFIG_FILE" "$live_copy" || {
        PRESERVE_WORK_DIR=true
        return 1
      }
    [ "$(file_identity "$live_copy")" = "$INVALID_ID" ] && \
      [ "$(file_sha256 "$live_copy")" = "$INVALID_SHA256" ] && \
      [ "$(file_mode "$live_copy")" = "$INVALID_MODE" ] || {
      preserve_work_path_as_conflict "$live_copy" || true
      PRESERVE_WORK_DIR=true
      return 1
    }
  elif [ -e "$CONFIG_FILE" ] || [ -L "$CONFIG_FILE" ]; then
    preserve_current_config || {
      PRESERVE_WORK_DIR=true
      return 1
    }
    conflict_found=true
  fi

  boundaries_unchanged && work_directory_unchanged && \
    [ ! -e "$CONFIG_FILE" ] && [ ! -L "$CONFIG_FILE" ] && \
    /bin/ln "$WORK_DIR/openmurmur.json.snapshot" "$CONFIG_FILE" || {
      if [ -e "$CONFIG_FILE" ] || [ -L "$CONFIG_FILE" ]; then
        preserve_current_config || true
      fi
      PRESERVE_WORK_DIR=true
      return 1
    }
  config_is_original || {
    PRESERVE_WORK_DIR=true
    return 1
  }
  CONFIG_RESTORED=true
  [ "$conflict_found" = false ]
}

finish_rehearsal() {
  local status=$?
  trap - EXIT HUP INT TERM
  if [ "$CONFIG_MUTATION_STARTED" = true ] && [ "$CONFIG_RESTORED" != true ]; then
    if ! restore_config; then status=1; fi
  fi
  if [ -n "$WORK_DIR" ]; then
    if [ "$PRESERVE_WORK_DIR" = true ]; then
      echo "D121 config transaction evidence preserved at $WORK_DIR" >&2
    elif boundaries_unchanged && work_directory_unchanged; then
      /bin/rm -rf "$WORK_DIR"
    else
      echo "D121 config transaction directory preserved after an identity change: $WORK_DIR" >&2
      status=1
    fi
  fi
  if [ -n "$MANIFEST_WORK_DIR" ]; then
    echo "D121 manifest staging evidence preserved at $MANIFEST_WORK_DIR" >&2
    status=1
  fi
  exit "$status"
}

EVIDENCE_DIR="$(mktemp -d "$HOME/.openmurmur-d121.XXXXXX")"
chmod 0700 "$EVIDENCE_DIR"
EVIDENCE_DIR_ID="$(directory_identity "$EVIDENCE_DIR")"
WORK_DIR="$(mktemp -d "$STATE_ROOT/.openmurmur-d121.XXXXXX")"
chmod 0700 "$WORK_DIR"
WORK_DIR_ID="$(directory_identity "$WORK_DIR")"
boundaries_unchanged && work_directory_unchanged
trap finish_rehearsal EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

./scripts/install-capture-app --check
[ -f "$CONFIG_FILE" ] && [ ! -L "$CONFIG_FILE" ]
for label in io.openmurmur.daemon io.openmurmur.digest; do
  [ -f "$AGENT_DIR/$label.plist" ] || {
    echo "D121 needs an existing installed-agent baseline: $label.plist is missing" >&2
    exit 1
  }
done

CONFIG_ID="$(file_identity "$CONFIG_FILE")"
CONFIG_SHA256="$(file_sha256 "$CONFIG_FILE")"
CONFIG_MODE="$(file_mode "$CONFIG_FILE")"
printf 'identity=%s\nsha256=%s\nmode=%s\n' \
  "$CONFIG_ID" "$CONFIG_SHA256" "$CONFIG_MODE" \
  > "$EVIDENCE_DIR/openmurmur.json.before.identity"
/bin/ln "$CONFIG_FILE" "$WORK_DIR/openmurmur.json.snapshot"
cp -p "$CONFIG_FILE" "$EVIDENCE_DIR/openmurmur.json.before"
chmod 0600 "$EVIDENCE_DIR/openmurmur.json.before"
config_is_original
[ "$(file_identity "$WORK_DIR/openmurmur.json.snapshot")" = "$CONFIG_ID" ]
[ "$(file_sha256 "$WORK_DIR/openmurmur.json.snapshot")" = "$CONFIG_SHA256" ]
[ "$(file_mode "$WORK_DIR/openmurmur.json.snapshot")" = "$CONFIG_MODE" ]
[ "$(file_sha256 "$EVIDENCE_DIR/openmurmur.json.before")" = "$CONFIG_SHA256" ]
/usr/bin/shasum -a 256 \
  "$AGENT_DIR/io.openmurmur.daemon.plist" \
  "$AGENT_DIR/io.openmurmur.digest.plist" \
  > "$EVIDENCE_DIR/plists.before.sha256"

snapshot_launchd() {
  local phase="$1"
  local label
  local registration
  boundaries_unchanged
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

wait_for_restored_daemon() {
  local phase="$1"
  local attempt=1
  local max_attempts=60
  local output
  local validation
  boundaries_unchanged
  while [ "$attempt" -le "$max_attempts" ]; do
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
    boundaries_unchanged
    printf '%s\n' "${validation:-$output}" > "$EVIDENCE_DIR/restored-status.$phase.last-error"
    attempt=$((attempt + 1))
    [ "$attempt" -le "$max_attempts" ] && sleep 1
  done
  echo "Restored daemon did not return to a fresh real-frame heartbeat; inspect $EVIDENCE_DIR" >&2
  return 1
}

snapshot_launchd before
wait_for_restored_daemon before

"$NODE_BIN" --input-type=module - "$CONFIG_FILE" "$WORK_DIR/openmurmur.json.invalid" <<'NODE'
import { readFileSync, writeFileSync } from 'node:fs';

const configFile = process.argv[2];
const invalidFile = process.argv[3];
const config = JSON.parse(readFileSync(configFile, 'utf8'));
if (config?.audio?.captureBackend !== 'native') {
  throw new Error('D121 rehearsal requires audio.captureBackend="native"');
}
config.logLevel = '__d121_readiness_failure__';
writeFileSync(invalidFile, `${JSON.stringify(config, null, 2)}\n`, {
  flag: 'wx',
  mode: 0o600,
});
NODE
chmod "$CONFIG_MODE" "$WORK_DIR/openmurmur.json.invalid"
INVALID_ID="$(file_identity "$WORK_DIR/openmurmur.json.invalid")"
INVALID_SHA256="$(file_sha256 "$WORK_DIR/openmurmur.json.invalid")"
INVALID_MODE="$(file_mode "$WORK_DIR/openmurmur.json.invalid")"

CONFIG_MUTATION_STARTED=true
CONFIG_RESTORED=false
boundaries_unchanged && work_directory_unchanged && config_is_original
/bin/mv "$CONFIG_FILE" "$WORK_DIR/openmurmur.json.original"
  [ "$(file_identity "$WORK_DIR/openmurmur.json.original")" = "$CONFIG_ID" ] && \
  [ "$(file_sha256 "$WORK_DIR/openmurmur.json.original")" = "$CONFIG_SHA256" ] && \
  [ "$(file_mode "$WORK_DIR/openmurmur.json.original")" = "$CONFIG_MODE" ] || {
    PRESERVE_WORK_DIR=true
    preserve_work_path_as_conflict "$WORK_DIR/openmurmur.json.original" || true
    restore_config
    exit 1
  }
boundaries_unchanged && work_directory_unchanged && \
  [ ! -e "$CONFIG_FILE" ] && [ ! -L "$CONFIG_FILE" ] && \
  /bin/ln "$WORK_DIR/openmurmur.json.invalid" "$CONFIG_FILE" || {
    if [ -e "$CONFIG_FILE" ] || [ -L "$CONFIG_FILE" ]; then
      preserve_current_config || true
    fi
    PRESERVE_WORK_DIR=true
    restore_config
    exit 1
  }
config_is_invalid || {
  PRESERVE_WORK_DIR=true
  restore_config
  exit 1
}

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

restore_config
cmp "$EVIDENCE_DIR/openmurmur.json.before" "$CONFIG_FILE"
if [ "$INSTALL_EXIT" -eq 0 ] || \
  ! /usr/bin/grep -Fq "Daemon readiness failed after registration" \
    "$EVIDENCE_DIR/installer.stderr"; then
  echo "Installer did not reach the expected readiness rollback; inspect $EVIDENCE_DIR" >&2
  exit 1
fi

/usr/bin/shasum -a 256 -c "$EVIDENCE_DIR/plists.before.sha256"
snapshot_launchd after
cmp "$EVIDENCE_DIR/labels.before" "$EVIDENCE_DIR/labels.after"
wait_for_restored_daemon after

D121_HEAD="$(git rev-parse --verify HEAD)"
[ -z "$(git status --porcelain --untracked-files=all)" ] || {
  echo "D121 evidence must be recorded from a clean checkout" >&2
  exit 1
}
MANIFEST_WORK_DIR="$(mktemp -d "$HOME/.openmurmur-d121-manifest.XXXXXX")"
chmod 0700 "$MANIFEST_WORK_DIR"
MANIFEST_WORK_DIR_ID="$(directory_identity "$MANIFEST_WORK_DIR")"
D121_MANIFEST_STAGE="$MANIFEST_WORK_DIR/D121.evidence-manifest.json"
D121_MANIFEST="$EVIDENCE_DIR/D121.evidence-manifest.json"
boundaries_unchanged && work_directory_unchanged && manifest_work_directory_unchanged
"$NODE_BIN" --input-type=module - \
  "$EVIDENCE_DIR" "$D121_MANIFEST_STAGE" "$D121_HEAD" <<'NODE'
import {
  closeSync,
  constants,
  fsyncSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

const [evidenceDirectory, output, repositoryCommit] = process.argv.slice(2);
const files = readdirSync(evidenceDirectory).sort().map((name) => {
  const path = join(evidenceDirectory, name);
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`D121 evidence contains a non-regular entry: ${name}`);
  }
  const bytes = readFileSync(path);
  return {
    path: name,
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
});
const payload = {
  schemaVersion: 1,
  kind: 'openmurmur-d121-evidence',
  repositoryCommit,
  evidenceDirectory,
  files,
};
writeFileSync(output, `${JSON.stringify(payload, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
const fd = openSync(output, constants.O_RDONLY);
try {
  fsyncSync(fd);
} finally {
  closeSync(fd);
}
NODE
boundaries_unchanged && work_directory_unchanged && manifest_work_directory_unchanged && \
  [ ! -e "$D121_MANIFEST" ] && [ ! -L "$D121_MANIFEST" ] && \
  /bin/ln "$D121_MANIFEST_STAGE" "$D121_MANIFEST"
"$NODE_BIN" --input-type=module - "$EVIDENCE_DIR" <<'NODE'
import { closeSync, constants, fsyncSync, openSync } from 'node:fs';
const fd = openSync(process.argv[2], constants.O_RDONLY);
try {
  fsyncSync(fd);
} finally {
  closeSync(fd);
}
NODE
boundaries_unchanged
D121_MANIFEST_SHA256="$(file_sha256 "$D121_MANIFEST")"
manifest_work_directory_unchanged && /bin/rm -rf "$MANIFEST_WORK_DIR" || {
  echo "D121 manifest staging directory preserved after an identity change: $MANIFEST_WORK_DIR" >&2
  exit 1
}
MANIFEST_WORK_DIR=""
trap - EXIT HUP INT TERM
if [ "$PRESERVE_WORK_DIR" = true ]; then
  echo "D121 config transaction evidence preserved at $WORK_DIR" >&2
  exit 1
elif boundaries_unchanged && work_directory_unchanged; then
  /bin/rm -rf "$WORK_DIR"
  WORK_DIR=""
else
  echo "D121 config transaction directory preserved after an identity change: $WORK_DIR" >&2
  exit 1
fi
echo "D121 rollback restored the exact config inode/mode, plist bytes, registration set and live audio readiness."
echo "Evidence: $EVIDENCE_DIR"
echo "Evidence manifest: $D121_MANIFEST"
echo "Evidence manifest SHA-256: $D121_MANIFEST_SHA256"
)
```

The evidence path is intentionally under the physical current user's HOME, not
`/private/tmp`, because D122 reboots the Mac before the final D123 audit. Keep
the printed directory unchanged and export it later as `D121_EVIDENCE_DIR`.

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

### Attended reboot and lid-sleep evidence (D070/D122)

Run the block below as `before-reboot`, reboot and log back into the same GUI
account, then run it as `after-reboot`. Run the sleep pair as `before-sleep`,
close the lid, wake and log in, then run `after-sleep`. Keep the same printed
persistent `EVIDENCE_DIR` across all four invocations. A failed phase can be
retried: only an atomically published facts link counts. The block reads the
exact Node, CLI and state root from the installed plists. It reads no Keychain
value, requests no TCC prompt and makes no direct config or domain-database
edit. The installed production agents continue their ordinary writes, and the
status command may open the database normally while collecting evidence.

```bash
# The first invocation creates EVIDENCE_DIR and defaults to before-reboot.
# Later invocations preserve an exported EVIDENCE_DIR and PHASE.
if [ -z "${EVIDENCE_DIR:-}" ]; then
  [ -d "$HOME" ] && [ ! -L "$HOME" ] && \
    [ "$(cd "$HOME" && pwd -P)" = "$HOME" ] && \
    [ "$(stat -f '%u' "$HOME")" = "$(id -u)" ] || {
    echo "HOME must be a physical canonical directory owned by this user" >&2
    exit 1
  }
  export EVIDENCE_DIR="$(mktemp -d "$HOME/.openmurmur-lifecycle.XXXXXX")"
  chmod 0700 "$EVIDENCE_DIR"
fi
export PHASE="${PHASE:-before-reboot}"
(
set -euo pipefail
umask 077
: "${EVIDENCE_DIR:?restore the original evidence directory path}"
: "${PHASE:?use before-reboot, after-reboot, before-sleep or after-sleep}"
case "$PHASE" in
  before-reboot|after-reboot|before-sleep|after-sleep) ;;
  *) echo "invalid lifecycle phase: $PHASE" >&2; exit 1 ;;
esac
case "$EVIDENCE_DIR" in
  "$HOME"/.openmurmur-lifecycle.*) ;;
  *) echo "restore the exact lifecycle evidence path under HOME" >&2; exit 1 ;;
esac

directory_id() { /usr/bin/stat -f '%d:%i' "$1"; }
file_id() { /usr/bin/stat -f '%d:%i' "$1"; }
file_sha256() { /usr/bin/shasum -a 256 "$1" | /usr/bin/awk '{print $1}'; }
require_physical_directory() {
  local path="$1"
  [ -d "$path" ] && [ ! -L "$path" ] && \
    [ "$(cd "$path" && pwd -P)" = "$path" ] || {
    echo "not a physical canonical directory: $path" >&2
    exit 1
  }
}

require_physical_directory "$HOME"
[ "$(/usr/bin/stat -f '%u' "$HOME")" = "$(id -u)" ]
require_physical_directory "$HOME/Library"
AGENT_DIR="$HOME/Library/LaunchAgents"
require_physical_directory "$AGENT_DIR"
require_physical_directory "$EVIDENCE_DIR"
[ "$(dirname "$EVIDENCE_DIR")" = "$HOME" ]
[ "$(/usr/bin/stat -f '%u' "$EVIDENCE_DIR")" = "$(id -u)" ]
[ "$(/usr/bin/stat -f '%Lp' "$EVIDENCE_DIR")" = 700 ]
HOME_ID="$(directory_id "$HOME")"
LIBRARY_ID="$(directory_id "$HOME/Library")"
AGENT_DIR_ID="$(directory_id "$AGENT_DIR")"
EVIDENCE_ID="$(directory_id "$EVIDENCE_DIR")"

DAEMON_PLIST="$AGENT_DIR/io.openmurmur.daemon.plist"
DIGEST_PLIST="$AGENT_DIR/io.openmurmur.digest.plist"
UID_VALUE="$(id -u)"
for plist in "$DAEMON_PLIST" "$DIGEST_PLIST"; do
  [ -f "$plist" ] && [ ! -L "$plist" ] || { echo "missing safe plist: $plist" >&2; exit 1; }
done
DAEMON_PLIST_ID="$(file_id "$DAEMON_PLIST")"
DIGEST_PLIST_ID="$(file_id "$DIGEST_PLIST")"
DAEMON_PLIST_SHA="$(file_sha256 "$DAEMON_PLIST")"
DIGEST_PLIST_SHA="$(file_sha256 "$DIGEST_PLIST")"
NODE_BIN="$(/usr/libexec/PlistBuddy -c 'Print :ProgramArguments:0' "$DAEMON_PLIST")"
CLI_ENTRY="$(/usr/libexec/PlistBuddy -c 'Print :ProgramArguments:1' "$DAEMON_PLIST")"
STATE_ROOT="$(/usr/libexec/PlistBuddy -c 'Print :ProgramArguments:4' "$DAEMON_PLIST")"
[ "$NODE_BIN" = "$(/usr/libexec/PlistBuddy -c 'Print :ProgramArguments:0' "$DIGEST_PLIST")" ]
[ "$CLI_ENTRY" = "$(/usr/libexec/PlistBuddy -c 'Print :ProgramArguments:1' "$DIGEST_PLIST")" ]
[ "$STATE_ROOT" = "$(/usr/libexec/PlistBuddy -c 'Print :ProgramArguments:5' "$DIGEST_PLIST")" ]
[ "${NODE_BIN#/}" != "$NODE_BIN" ] && [ -f "$NODE_BIN" ] && [ ! -L "$NODE_BIN" ] && [ -x "$NODE_BIN" ]
require_physical_directory "$(dirname "$NODE_BIN")"
[ "${CLI_ENTRY#/}" != "$CLI_ENTRY" ] && [ -f "$CLI_ENTRY" ] && [ ! -L "$CLI_ENTRY" ]
require_physical_directory "$(dirname "$CLI_ENTRY")"
[ "${STATE_ROOT#/}" != "$STATE_ROOT" ]
require_physical_directory "$STATE_ROOT"
[ "$(/usr/bin/stat -f '%u' "$STATE_ROOT")" = "$(id -u)" ]
NODE_ID="$(file_id "$NODE_BIN")"
CLI_ID="$(file_id "$CLI_ENTRY")"
STATE_ROOT_ID="$(directory_id "$STATE_ROOT")"
REPO_ROOT="$(cd "$(dirname "$CLI_ENTRY")/../.." && pwd -P)"
[ "$CLI_ENTRY" = "$REPO_ROOT/src/cli/main.ts" ]
[ -f "$REPO_ROOT/scripts/install-launch-agents" ] && \
  [ ! -L "$REPO_ROOT/scripts/install-launch-agents" ]

paths_unchanged() {
  [ -d "$HOME" ] && [ ! -L "$HOME" ] && [ "$(cd "$HOME" 2>/dev/null && pwd -P)" = "$HOME" ] && \
    [ "$(directory_id "$HOME")" = "$HOME_ID" ] && \
    [ -d "$HOME/Library" ] && [ ! -L "$HOME/Library" ] && \
    [ "$(cd "$HOME/Library" 2>/dev/null && pwd -P)" = "$HOME/Library" ] && \
    [ "$(directory_id "$HOME/Library")" = "$LIBRARY_ID" ] && \
    [ -d "$AGENT_DIR" ] && [ ! -L "$AGENT_DIR" ] && \
    [ "$(cd "$AGENT_DIR" 2>/dev/null && pwd -P)" = "$AGENT_DIR" ] && \
    [ "$(directory_id "$AGENT_DIR")" = "$AGENT_DIR_ID" ] && \
    [ -d "$EVIDENCE_DIR" ] && [ ! -L "$EVIDENCE_DIR" ] && \
    [ "$(cd "$EVIDENCE_DIR" 2>/dev/null && pwd -P)" = "$EVIDENCE_DIR" ] && \
    [ "$(directory_id "$EVIDENCE_DIR")" = "$EVIDENCE_ID" ] && \
    [ -d "$STATE_ROOT" ] && [ ! -L "$STATE_ROOT" ] && \
    [ "$(cd "$STATE_ROOT" 2>/dev/null && pwd -P)" = "$STATE_ROOT" ] && \
    [ "$(directory_id "$STATE_ROOT")" = "$STATE_ROOT_ID" ] && \
    [ -f "$DAEMON_PLIST" ] && [ ! -L "$DAEMON_PLIST" ] && \
    [ "$(file_id "$DAEMON_PLIST")" = "$DAEMON_PLIST_ID" ] && \
    [ "$(file_sha256 "$DAEMON_PLIST")" = "$DAEMON_PLIST_SHA" ] && \
    [ -f "$DIGEST_PLIST" ] && [ ! -L "$DIGEST_PLIST" ] && \
    [ "$(file_id "$DIGEST_PLIST")" = "$DIGEST_PLIST_ID" ] && \
    [ "$(file_sha256 "$DIGEST_PLIST")" = "$DIGEST_PLIST_SHA" ] && \
    [ -f "$NODE_BIN" ] && [ ! -L "$NODE_BIN" ] && [ "$(file_id "$NODE_BIN")" = "$NODE_ID" ] && \
    [ "$(cd "$(dirname "$NODE_BIN")" 2>/dev/null && pwd -P)/$(basename "$NODE_BIN")" = "$NODE_BIN" ] && \
    [ -f "$CLI_ENTRY" ] && [ ! -L "$CLI_ENTRY" ] && [ "$(file_id "$CLI_ENTRY")" = "$CLI_ID" ] && \
    [ "$(cd "$(dirname "$CLI_ENTRY")" 2>/dev/null && pwd -P)/$(basename "$CLI_ENTRY")" = "$CLI_ENTRY" ]
}

paths_unchanged
"$REPO_ROOT/scripts/install-launch-agents" --check --node "$NODE_BIN" --root "$STATE_ROOT" >/dev/null
paths_unchanged

PHASE_FACTS="$EVIDENCE_DIR/$PHASE.accepted.json"
[ ! -e "$PHASE_FACTS" ] && [ ! -L "$PHASE_FACTS" ] || {
  echo "$PHASE was already published; choose the correct next phase" >&2
  exit 1
}
PHASE_STAGE="$(mktemp -d "$EVIDENCE_DIR/.$PHASE.XXXXXX")"
chmod 0700 "$PHASE_STAGE"
PHASE_STAGE_ID="$(directory_id "$PHASE_STAGE")"
stage_unchanged() {
  paths_unchanged && [ -d "$PHASE_STAGE" ] && [ ! -L "$PHASE_STAGE" ] && \
    [ "$(cd "$PHASE_STAGE" 2>/dev/null && pwd -P)" = "$PHASE_STAGE" ] && \
    [ "$(dirname "$PHASE_STAGE")" = "$EVIDENCE_DIR" ] && \
    [ "$(directory_id "$PHASE_STAGE")" = "$PHASE_STAGE_ID" ]
}
cleanup_phase() {
  local status=$?
  trap - EXIT HUP INT TERM
  if [ -n "${PHASE_STAGE:-}" ]; then
    if stage_unchanged; then
      /bin/rm -rf "$PHASE_STAGE"
    else
      echo "phase staging evidence was preserved after an identity change: $PHASE_STAGE" >&2
      status=1
    fi
  fi
  exit "$status"
}
trap cleanup_phase EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

case "$PHASE" in
  after-reboot) PREVIOUS_PHASE=before-reboot ;;
  after-sleep) PREVIOUS_PHASE=before-sleep ;;
  *) PREVIOUS_PHASE= ;;
esac
if [ -n "$PREVIOUS_PHASE" ]; then
  PREVIOUS_FACTS="$EVIDENCE_DIR/$PREVIOUS_PHASE.accepted.json"
  [ -f "$PREVIOUS_FACTS" ] && [ ! -L "$PREVIOUS_FACTS" ] || {
    echo "missing accepted $PREVIOUS_PHASE evidence" >&2
    exit 1
  }
fi

if [ "$PHASE" = after-reboot ] || [ "$PHASE" = after-sleep ]; then
  [ "$(stat -f '%Su' /dev/console)" = "$(id -un)" ] || {
    echo "the expected GUI user is not logged in" >&2
    exit 1
  }
  MINIMUM_DIGEST_RUNS=0
  WAKE_DIGEST_RUNS=-1
  if [ "$PHASE" = after-sleep ]; then
    BEFORE_SLEEP_DIGEST_RUNS="$("$NODE_BIN" -e \
      'console.log(JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).digestRuns)' \
      "$PREVIOUS_FACTS")"
    wake_digest_print="$(launchctl print "gui/$UID_VALUE/io.openmurmur.digest")"
    WAKE_DIGEST_RUNS="$(printf '%s\n' "$wake_digest_print" | \
      awk '$1 == "runs" && $2 == "=" { print $3; exit }')"
    [ "${BEFORE_SLEEP_DIGEST_RUNS:-}" -ge 0 ] 2>/dev/null
    [ "${WAKE_DIGEST_RUNS:-}" -ge 0 ] 2>/dev/null
    if [ "$WAKE_DIGEST_RUNS" -gt "$BEFORE_SLEEP_DIGEST_RUNS" ]; then
      MINIMUM_DIGEST_RUNS="$WAKE_DIGEST_RUNS"
    else
      MINIMUM_DIGEST_RUNS="$BEFORE_SLEEP_DIGEST_RUNS"
    fi
  fi
  attempt=0
  until digest_print="$(launchctl print "gui/$UID_VALUE/io.openmurmur.digest" 2>&1)" &&
    runs="$(printf '%s\n' "$digest_print" | awk '$1 == "runs" && $2 == "=" { print $3; exit }')" &&
    [ "${runs:-0}" -gt "$MINIMUM_DIGEST_RUNS" ] 2>/dev/null &&
    printf '%s\n' "$digest_print" | grep -Eq 'last exit code = 0'; do
    attempt=$((attempt + 1))
    [ "$attempt" -lt 72 ] || { echo "digest agent did not complete cleanly within six minutes" >&2; exit 1; }
    sleep 5
  done
fi

STATUS_FILE="$PHASE_STAGE/status.json"
if [ -n "$PREVIOUS_PHASE" ]; then
  attempt=0
  while :; do
    paths_unchanged
    if "$NODE_BIN" "$CLI_ENTRY" status --root "$STATE_ROOT" --json > "$STATUS_FILE" && \
      "$NODE_BIN" --input-type=module - \
        "$STATE_ROOT/openmurmur.db" "$STATUS_FILE" "$PREVIOUS_FACTS" <<'NODE'
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const [databaseFile, statusFile, previousFile] = process.argv.slice(2);
const status = JSON.parse(readFileSync(statusFile, 'utf8'));
const previous = JSON.parse(readFileSync(previousFile, 'utf8'));
if (
  status.daemon !== 'running' || status.heartbeatStatus !== 'fresh' ||
  status.recorderRunning !== true || !Number.isFinite(status.lastSourceFrameAgeMs) ||
  status.lastSourceFrameAgeMs < 0
) process.exit(1);
const db = new DatabaseSync(databaseFile, { readOnly: true });
const ownership = db.prepare(
  `SELECT daemon_started_at, process_birth FROM daemon_ownership WHERE ownership_id = 1`,
).get();
db.close();
if (
  ownership === undefined ||
  ownership.daemon_started_at === previous.ownership.daemon_started_at ||
  ownership.process_birth === previous.ownership.process_birth
) process.exit(1);
NODE
    then
      break
    fi
    attempt=$((attempt + 1))
    [ "$attempt" -lt 72 ] || {
      echo "new launchd generation did not reach fresh real-frame readiness within six minutes" >&2
      exit 1
    }
    sleep 5
  done
else
  paths_unchanged
  "$NODE_BIN" "$CLI_ENTRY" status --root "$STATE_ROOT" --json > "$STATUS_FILE"
fi

for label in io.openmurmur.daemon io.openmurmur.digest; do
  paths_unchanged
  launchctl print "gui/$UID_VALUE/$label" > "$PHASE_STAGE/$label.print"
done
DIGEST_RUNS="$(awk '$1 == "runs" && $2 == "=" { print $3; exit }' \
  "$PHASE_STAGE/io.openmurmur.digest.print")"
[ "${DIGEST_RUNS:-}" -ge 0 ] 2>/dev/null

"$NODE_BIN" --input-type=module - \
  "$PHASE" "$STATE_ROOT/openmurmur.db" "$STATUS_FILE" "$EVIDENCE_DIR" \
  "$PHASE_STAGE/facts.json" "$DIGEST_RUNS" "${WAKE_DIGEST_RUNS:--1}" <<'NODE'
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';

const [phase, databaseFile, statusFile, evidenceDir, outputFile, digestRunsText, wakeRunsText] = process.argv.slice(2);
const status = JSON.parse(readFileSync(statusFile, 'utf8'));
if (
  status.daemon !== 'running' || status.heartbeatStatus !== 'fresh' ||
  status.recorderRunning !== true || !Number.isFinite(status.lastSourceFrameAgeMs) ||
  status.lastSourceFrameAgeMs < 0
) throw new Error(`${phase}: daemon has no fresh real-frame readiness proof`);

const db = new DatabaseSync(databaseFile, { readOnly: true });
const rows = (sql, ...args) => db.prepare(sql).all(...args).map((row) => ({ ...row }));
const one = (sql, ...args) => {
  const row = db.prepare(sql).get(...args);
  return row === undefined ? null : { ...row };
};
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const previousPhase = phase === 'after-reboot' ? 'before-reboot'
  : phase === 'after-sleep' ? 'before-sleep' : null;
const previous = previousPhase === null
  ? null
  : JSON.parse(readFileSync(join(evidenceDir, `${previousPhase}.accepted.json`), 'utf8'));
const facts = {
  phase,
  evidenceStage: outputFile.slice(0, outputFile.lastIndexOf('/')).split('/').at(-1),
  digestRuns: Number(digestRunsText),
  wakeDigestRuns: Number(wakeRunsText) < 0 ? null : Number(wakeRunsText),
  ownership: one(`SELECT daemon_pid, daemon_started_at, process_birth, claimed_at
                    FROM daemon_ownership WHERE ownership_id = 1`),
  digests: rows(`SELECT digest_id, digest_date, created_at FROM digests ORDER BY digest_date`),
  digestOutbox: rows(`SELECT outbox_id, delivery_part_id, payload FROM telegram_outbox
                       WHERE kind = 'digest' ORDER BY delivery_part_id`)
    .map((row) => ({
      outboxId: row.outbox_id,
      deliveryPartId: row.delivery_part_id,
      payloadSha256: sha256(row.payload),
    })),
  sleepNotices: rows(`SELECT outbox_id, delivery_part_id, state FROM telegram_outbox
                       WHERE delivery_part_id GLOB 'sleep:*' ORDER BY delivery_part_id`),
};
if (facts.ownership === null) throw new Error(`${phase}: daemon ownership is missing`);
if (!Number.isSafeInteger(facts.digestRuns) || facts.digestRuns < 0)
  throw new Error(`${phase}: launchd digest run count is invalid`);
if (new Set(facts.digests.map((row) => row.digest_date)).size !== facts.digests.length)
  throw new Error(`${phase}: duplicate digest dates`);
if (new Set(facts.digestOutbox.map((row) => row.deliveryPartId)).size !== facts.digestOutbox.length)
  throw new Error(`${phase}: duplicate digest delivery identities`);

if (previousPhase !== null) {
  if (
    previous.ownership.daemon_started_at === facts.ownership.daemon_started_at ||
    previous.ownership.process_birth === facts.ownership.process_birth
  ) throw new Error(`${phase}: launchd did not establish a new exact daemon generation`);
  if (phase === 'after-reboot' && facts.digestRuns < 1)
    throw new Error('after-reboot: digest agent did not run');
  if (
    phase === 'after-sleep' &&
    (facts.wakeDigestRuns === null || facts.digestRuns <= previous.digestRuns ||
      facts.digestRuns <= facts.wakeDigestRuns)
  ) throw new Error('after-sleep: digest agent did not run after the wake baseline');
  for (const old of previous.digests) {
    const current = facts.digests.find((row) => row.digest_date === old.digest_date);
    if (current?.digest_id !== old.digest_id) throw new Error(`${phase}: digest identity changed`);
  }
  for (const old of previous.digestOutbox) {
    const current = facts.digestOutbox.find((row) => row.deliveryPartId === old.deliveryPartId);
    if (current?.outboxId !== old.outboxId || current.payloadSha256 !== old.payloadSha256)
      throw new Error(`${phase}: digest outbox identity changed`);
  }
  if (phase === 'after-sleep') {
    const noticeId = `sleep:${previous.ownership.daemon_started_at}`;
    if (facts.sleepNotices.filter((row) => row.delivery_part_id === noticeId).length !== 1)
      throw new Error('after-sleep: exact generation-scoped sleep notice is missing or duplicated');
  }
}
db.close();
writeFileSync(outputFile, `${JSON.stringify(facts, null, 2)}\n`, {
  flag: 'wx', mode: 0o600,
});
NODE
paths_unchanged
stage_unchanged
/bin/ln "$PHASE_STAGE/facts.json" "$PHASE_FACTS"
PHASE_STAGE=""
trap - EXIT HUP INT TERM
echo "$PHASE evidence accepted at $EVIDENCE_DIR"
)
```

This evidence proves only the installed launchd generations, scheduled digest
execution, real-frame restart and the exact generation-scoped sleep notice. It
does not prove D115 post-wake session attribution, calibrate D014 AVFoundation
cadence or discontinuity, exercise a D116 rotation, prove Telegram remote ACK,
or complete the models and Telegram golden path in D120.

### Bind live evidence to one release revision (D123)

First complete the D121 rollback rehearsal above, then its valid apply/check.
Those operations legitimately replace installed plist inodes. Only after D121
succeeds, create one persistent private evidence directory and freeze that
installed source/runtime boundary before D120 and D122. `--prepare` requires the
exact configured Node and pnpm, records the exact uv executable, and runs the
repository gates as `pnpm install --offline --frozen-lockfile`, `pnpm run check`
and `/usr/bin/env -u UV_PROJECT_ENVIRONMENT uv run --offline --no-sync --project
python/openmurmur_audio pytest`. The
offline install may refresh ignored dependency files, but none of the gates may
download packages. Any failing gate publishes neither a receipt nor a manifest.
After all three pass, `--prepare` publishes a private verification receipt and
provenance manifest, fsyncs both directory entries, then atomically commits the
exact set with a final create-if-absent marker and a second directory fsync. A
receipt or manifest without that marker is invalid. A rerun reuses markerless
evidence only when a unique preserved private staging directory proves the
exact inode, bytes, commit and current runtime boundary; ambiguous paths are
left untouched. If an interruption leaves all three exact files visible before
the marker directory entry was fsynced, rerunning `--prepare` verifies the full
current boundary twice and fsyncs the evidence directory before accepting it.
Neither mode calls
`launchctl`, opens the microphone, reads Keychain values or uses the network;
both use only the native helper's signed non-prompting checks.

```bash
[ -d "$HOME" ] && [ ! -L "$HOME" ] && [ "$(cd "$HOME" && pwd -P)" = "$HOME" ] || exit 1
umask 077
export RELEASE_EVIDENCE_DIR="$(mktemp -d "$HOME/.openmurmur-release.XXXXXX")"
chmod 0700 "$RELEASE_EVIDENCE_DIR"
./scripts/release-signoff --prepare --evidence-dir "$RELEASE_EVIDENCE_DIR"
```

Index the earlier persistent D121 evidence without copying or weakening it.
This creates the exact reference path declared by the release manifest and
binds the readable evidence manifest bytes; the final human audit must still
inspect the referenced files before D123 can be marked done. The reference is
staged and fsynced in a private adjacent directory, published create-if-absent,
and committed by fsyncing the release evidence directory. A rerun accepts and
re-fsyncs only the exact canonical bytes for the same frozen artifacts; any
foreign path or artifact drift is preserved and fails closed:

```bash
: "${D121_EVIDENCE_DIR:?export the persistent D121 evidence directory printed above}"
D121_MANIFEST="$D121_EVIDENCE_DIR/D121.evidence-manifest.json"
DAEMON_PLIST="$HOME/Library/LaunchAgents/io.openmurmur.daemon.plist"
NODE_BIN="$(/usr/libexec/PlistBuddy -c 'Print :ProgramArguments:0' "$DAEMON_PLIST")"
"$NODE_BIN" --input-type=module - \
  "$D121_MANIFEST" "$RELEASE_EVIDENCE_DIR/D121.reference.json" \
  "$RELEASE_EVIDENCE_DIR" <<'NODE'
import {
  chmodSync,
  closeSync,
  constants,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

const [manifestPath, output, evidenceDirectory] = process.argv.slice(2);
const manifestStat = lstatSync(manifestPath);
const evidenceStat = lstatSync(evidenceDirectory);
const outputParent = realpathSync(evidenceDirectory);
if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) {
  throw new Error('D121 evidence manifest must be a regular non-symlink file');
}
if (
  manifestStat.uid !== process.getuid() ||
  (manifestStat.mode & 0o777) !== 0o600 ||
  !evidenceStat.isDirectory() ||
  evidenceStat.isSymbolicLink() ||
  evidenceStat.uid !== process.getuid() ||
  (evidenceStat.mode & 0o777) !== 0o700 ||
  outputParent !== evidenceDirectory
) {
  throw new Error('release evidence directory must remain physical and canonical');
}
const manifestBytes = readFileSync(manifestPath);
const manifest = JSON.parse(manifestBytes.toString('utf8'));
if (typeof manifest.evidenceDirectory !== 'string') {
  throw new Error('D121 evidence manifest directory is invalid');
}
const d121EvidenceStat = lstatSync(manifest.evidenceDirectory);
if (
  manifest.schemaVersion !== 1 ||
  manifest.kind !== 'openmurmur-d121-evidence' ||
  !d121EvidenceStat.isDirectory() ||
  d121EvidenceStat.isSymbolicLink() ||
  d121EvidenceStat.uid !== process.getuid() ||
  (d121EvidenceStat.mode & 0o777) !== 0o700 ||
  manifest.evidenceDirectory !== realpathSync(manifest.evidenceDirectory) ||
  manifestPath !== `${manifest.evidenceDirectory}/D121.evidence-manifest.json`
) {
  throw new Error('D121 evidence manifest identity is invalid');
}
if (!Array.isArray(manifest.files) || !/^[0-9a-f]{40}$/.test(manifest.repositoryCommit)) {
  throw new Error('D121 evidence manifest contents are invalid');
}
const seen = new Set();
const artifacts = [];
for (const entry of manifest.files) {
  if (
    typeof entry?.path !== 'string' ||
    entry.path.length === 0 ||
    entry.path.includes('/') ||
    seen.has(entry.path) ||
    !Number.isSafeInteger(entry.bytes) ||
    entry.bytes < 0 ||
    !/^[0-9a-f]{64}$/.test(entry.sha256)
  ) {
    throw new Error('D121 evidence manifest contains an invalid file entry');
  }
  seen.add(entry.path);
  const artifactPath = join(manifest.evidenceDirectory, entry.path);
  const artifactStat = lstatSync(artifactPath);
  const artifactBytes = readFileSync(artifactPath);
  if (
    !artifactStat.isFile() ||
    artifactStat.isSymbolicLink() ||
    artifactStat.uid !== process.getuid() ||
    artifactBytes.length !== entry.bytes ||
    createHash('sha256').update(artifactBytes).digest('hex') !== entry.sha256
  ) {
    throw new Error(`D121 evidence artifact drifted: ${entry.path}`);
  }
  artifacts.push({
    path: artifactPath,
    name: entry.path,
    dev: artifactStat.dev,
    ino: artifactStat.ino,
    mode: artifactStat.mode & 0o777,
    bytes: entry.bytes,
    sha256: entry.sha256,
  });
}
const releaseManifestPath = join(evidenceDirectory, 'release-signoff-v2.json');
const releaseManifestStat = lstatSync(releaseManifestPath);
const releaseManifestBytes = readFileSync(releaseManifestPath);
const releaseManifest = JSON.parse(releaseManifestBytes.toString('utf8'));
if (
  !releaseManifestStat.isFile() ||
  releaseManifestStat.isSymbolicLink() ||
  releaseManifestStat.uid !== process.getuid() ||
  (releaseManifestStat.mode & 0o777) !== 0o600 ||
  releaseManifest.releaseCommit !== manifest.repositoryCommit ||
  releaseManifest.requiredLiveEvidenceReferences?.D121 !== output
) {
  throw new Error('D121 evidence does not match the frozen release manifest');
}
const reference = {
  schemaVersion: 1,
  kind: 'openmurmur-d121-reference',
  repositoryCommit: manifest.repositoryCommit,
  evidenceManifest: {
    path: manifestPath,
    bytes: manifestBytes.length,
    sha256: createHash('sha256').update(manifestBytes).digest('hex'),
  },
};
const referenceBytes = Buffer.from(`${JSON.stringify(reference, null, 2)}\n`);

function fsyncPath(path) {
  const fd = openSync(path, constants.O_RDONLY);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function assertArtifactsUnchanged() {
  for (const artifact of artifacts) {
    const stat = lstatSync(artifact.path);
    const bytes = readFileSync(artifact.path);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.uid !== process.getuid() ||
      stat.dev !== artifact.dev ||
      stat.ino !== artifact.ino ||
      (stat.mode & 0o777) !== artifact.mode ||
      bytes.length !== artifact.bytes ||
      createHash('sha256').update(bytes).digest('hex') !== artifact.sha256
    ) {
      throw new Error(`D121 evidence artifact changed during inspection: ${artifact.name}`);
    }
  }
}

function assertInputsUnchanged() {
  const finalD121EvidenceStat = lstatSync(manifest.evidenceDirectory);
  const finalManifestStat = lstatSync(manifestPath);
  const finalReleaseEvidenceStat = lstatSync(evidenceDirectory);
  const finalReleaseManifestStat = lstatSync(releaseManifestPath);
  const finalManifestBytes = readFileSync(manifestPath);
  const finalReleaseManifestBytes = readFileSync(releaseManifestPath);
  if (
    !finalD121EvidenceStat.isDirectory() ||
    finalD121EvidenceStat.isSymbolicLink() ||
    finalD121EvidenceStat.uid !== process.getuid() ||
    (finalD121EvidenceStat.mode & 0o777) !== 0o700 ||
    finalD121EvidenceStat.dev !== d121EvidenceStat.dev ||
    finalD121EvidenceStat.ino !== d121EvidenceStat.ino ||
    !finalManifestStat.isFile() ||
    finalManifestStat.isSymbolicLink() ||
    finalManifestStat.dev !== manifestStat.dev ||
    finalManifestStat.ino !== manifestStat.ino ||
    finalManifestStat.size !== manifestStat.size ||
    !finalManifestBytes.equals(manifestBytes) ||
    !finalReleaseEvidenceStat.isDirectory() ||
    finalReleaseEvidenceStat.isSymbolicLink() ||
    finalReleaseEvidenceStat.uid !== process.getuid() ||
    (finalReleaseEvidenceStat.mode & 0o777) !== 0o700 ||
    finalReleaseEvidenceStat.dev !== evidenceStat.dev ||
    finalReleaseEvidenceStat.ino !== evidenceStat.ino ||
    !finalReleaseManifestStat.isFile() ||
    finalReleaseManifestStat.isSymbolicLink() ||
    finalReleaseManifestStat.dev !== releaseManifestStat.dev ||
    finalReleaseManifestStat.ino !== releaseManifestStat.ino ||
    finalReleaseManifestStat.size !== releaseManifestStat.size ||
    !finalReleaseManifestBytes.equals(releaseManifestBytes)
  ) {
    throw new Error('D121 evidence changed during reference inspection');
  }
  assertArtifactsUnchanged();
}

function inspectReference() {
  let stat;
  try {
    stat = lstatSync(output);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  const bytes = readFileSync(output);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid() ||
    (stat.mode & 0o777) !== 0o600 ||
    !bytes.equals(referenceBytes)
  ) {
    throw new Error('existing D121 reference conflicts with the frozen evidence');
  }
  return { stat, bytes };
}

function acceptExistingReference() {
  assertInputsUnchanged();
  const before = inspectReference();
  if (before === null) return false;
  fsyncPath(output);
  fsyncPath(evidenceDirectory);
  assertInputsUnchanged();
  const after = inspectReference();
  if (
    after === null ||
    after.stat.dev !== before.stat.dev ||
    after.stat.ino !== before.stat.ino ||
    !after.bytes.equals(before.bytes)
  ) {
    throw new Error('D121 reference changed while proving durability');
  }
  return true;
}

if (!acceptExistingReference()) {
  assertInputsUnchanged();
  const stageDirectory = mkdtempSync(join(evidenceDirectory, '.D121-reference.'));
  chmodSync(stageDirectory, 0o700);
  const stageDirectoryStat = lstatSync(stageDirectory);
  const stagePath = join(stageDirectory, 'D121.reference.json');
  let stageStat;
  let published = false;
  try {
    if (
      !stageDirectoryStat.isDirectory() ||
      stageDirectoryStat.isSymbolicLink() ||
      stageDirectoryStat.uid !== process.getuid() ||
      (stageDirectoryStat.mode & 0o777) !== 0o700 ||
      realpathSync(stageDirectory) !== stageDirectory
    ) {
      throw new Error('D121 reference staging directory is unsafe');
    }
    writeFileSync(stagePath, referenceBytes, { flag: 'wx', mode: 0o600 });
    fsyncPath(stagePath);
    stageStat = lstatSync(stagePath);
    if (
      !stageStat.isFile() ||
      stageStat.isSymbolicLink() ||
      stageStat.uid !== process.getuid() ||
      (stageStat.mode & 0o777) !== 0o600 ||
      !readFileSync(stagePath).equals(referenceBytes)
    ) {
      throw new Error('D121 reference staging file changed before publication');
    }
    assertInputsUnchanged();
    try {
      linkSync(stagePath, output);
      published = true;
    } catch (error) {
      if (error?.code !== 'EEXIST' || !acceptExistingReference()) throw error;
    }
    if (published) {
      fsyncPath(evidenceDirectory);
      assertInputsUnchanged();
      const finalReference = inspectReference();
      if (
        finalReference === null ||
        finalReference.stat.dev !== stageStat.dev ||
        finalReference.stat.ino !== stageStat.ino
      ) {
        throw new Error('published D121 reference changed before durability proof');
      }
    }
  } finally {
    const finalStageDirectoryStat = lstatSync(stageDirectory);
    if (
      !finalStageDirectoryStat.isDirectory() ||
      finalStageDirectoryStat.isSymbolicLink() ||
      finalStageDirectoryStat.dev !== stageDirectoryStat.dev ||
      finalStageDirectoryStat.ino !== stageDirectoryStat.ino
    ) {
      throw new Error(`preserving untrusted D121 reference stage: ${stageDirectory}`);
    }
    if (stageStat !== undefined) {
      const finalStageStat = lstatSync(stagePath);
      const finalStageBytes = readFileSync(stagePath);
      if (
        !finalStageStat.isFile() ||
        finalStageStat.isSymbolicLink() ||
        finalStageStat.uid !== process.getuid() ||
        finalStageStat.dev !== stageStat.dev ||
        finalStageStat.ino !== stageStat.ino ||
        (finalStageStat.mode & 0o777) !== 0o600 ||
        !finalStageBytes.equals(referenceBytes)
      ) {
        throw new Error(`preserving changed D121 reference stage: ${stageDirectory}`);
      }
      unlinkSync(stagePath);
    }
    rmdirSync(stageDirectory);
    fsyncPath(evidenceDirectory);
  }
  assertInputsUnchanged();
  const cleanedReference = inspectReference();
  if (
    cleanedReference === null ||
    (published &&
      (cleanedReference.stat.dev !== stageStat.dev ||
        cleanedReference.stat.ino !== stageStat.ino))
  ) {
    throw new Error('D121 reference changed during staging cleanup');
  }
}
NODE
```

For a custom state root, add the same canonical `--root DIR` to prepare and
check. The final `--check` does not rerun the repository gates. It verifies the
receipt and exact tool, commit, installation and manifest identities after the
attended evidence is complete:

```bash
./scripts/release-signoff --check --evidence-dir "$RELEASE_EVIDENCE_DIR"
```

The strict receipt records the full clean commit, exact Node/SQLite, pnpm and uv
identities and versions, exact gate commands, exit codes and SHA-256 digests of
each gate's stdout and stderr. The final marker binds the exact receipt and
manifest identities, hashes and commit; `--check` rejects an absent or changed
marker without rerunning gates. The manifest binds the receipt's exact bytes to
the physical installed CLI, state root, plist bytes and signed authorized
capture helper. It also declares fixed reference-file paths for D120, D121 and
D122 so the final human audit has one evidence index; the D121 reference may
index the earlier rollback/apply evidence. A reference file's presence is not
itself proof: D123 stays `live` until those three attended artifacts and every
README verified/unverified claim are reviewed against the same manifest.

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
