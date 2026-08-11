# Setting up OpenMurmur on a headless Mac

A runbook for an agent installing this on a Mac that nobody sits at — kept
awake, on power, reached over SSH, with a virtual display.

Everything in [INSTALL.md](INSTALL.md) still applies. This covers only what is
different without a logged-in human at the keyboard, and it is written to be
followed top to bottom, verifying after each step.

## Read this before starting

**Two things in this process cannot be automated. Do not spend time trying.**

1. **Granting microphone access.** macOS shows the permission dialog only to a
   GUI session. An SSH-launched process is refused outright, with no prompt.
   SIP protects the TCC database, so `tccutil` can reset a permission but never
   add one. A human must click Allow in a Screen Sharing session.
2. **Creating the Telegram bot and entering its token.** The token comes from
   @BotFather in a Telegram client, and `setup telegram` reads it from a hidden
   TTY prompt on purpose — it must never reach argv, a file, an environment
   variable or a log.

Everything else below is scriptable. Reach those two points, then stop and
report what is needed, rather than looking for a way around them.

**Three things fail silently on a headless machine**, and all three are fixed
by enabling automatic login:

- the login Keychain stays locked, so the daemon cannot read the token it
  correctly stored;
- a LaunchAgent has no Aqua session to run in, so nothing starts after reboot;
- there is no GUI session to show the microphone prompt in.

---

## Step 0 — Preflight

```bash
git clone https://github.com/kostia7alania/openmurmur.git ~/openmurmur && cd ~/openmurmur
```

```bash
./scripts/server-preflight
```

Read-only, no sudo, prompts for nothing. It reports hardware, audio input, GUI
session, automatic login, sleep, Screen Sharing, Keychain readability, the
LaunchAgent and disk, then prints exactly what a human still has to do.

Exit 0 means nothing is blocking. Re-run it after each step below.

## Step 1 — Dependencies

Follow [INSTALL.md](INSTALL.md) steps 1–7. All of it works over SSH:
Command Line Tools, Homebrew (**including the two PATH lines it prints**),
FFmpeg, Node 26.7.0 or newer, Ollama, `./scripts/bootstrap`, and then the model stack:

```bash
uv sync --project python/openmurmur_audio --extra mlx
```

Without that last one there is no speech detection and no transcription.

Verify — this starts the real worker and scores an audio frame, so a green tick
means the detector actually loads:

```bash
pnpm openmurmur doctor
```

```bash
pnpm openmurmur doctor --json
```

The JSON form is the one to parse. Every entry has `name`, `level`
(`ok`/`warn`/`fail`/`info`) and `detail`. Proceed when no entry is `fail`.

Two warnings are expected before setup and do not block anything:

- `state_directory ... missing` — until step 2. `sqlite` should be green with
  the pinned Node from `.nvmrc`.
- `telegram_setup ... not found` — until step 4. This is a metadata-only
  Keychain readiness check; it does not read the token or contact Telegram.

## Step 2 — State directory

```bash
pnpm openmurmur setup --yes
```

Creates `~/Library/Application Support/OpenMurmur` — audio, database, config,
logs. Without `--yes` it prints a plan and waits for confirmation.

## Step 3 — Automatic login *(human)*

**System Settings → Users & Groups → Automatic login → the user.**

It cannot be enabled while FileVault is on. That is a real trade to state
plainly to the owner: a machine that boots unattended is one whose disk is
readable by whoever picks it up.

Verify after a reboot:

```bash
stat -f '%Su' /dev/console
```

The username means a GUI session is live. `root` means nobody is logged in and
neither the LaunchAgent nor the Keychain will work.

## Step 4 — Never sleeping

```bash
sudo pmset -a sleep 0 disksleep 0 displaysleep 0 standby 0 powernap 0
```

```bash
pmset -g | grep -E '^ *(sleep|disksleep|standby) '
```

`sleep 0` is what you want. `caffeinate` also works but dies with its shell;
for a machine that must survive a reboot, `pmset` is the setting.

Sleep is not corruption — OpenMurmur detects the gap on wake and closes any open
session so it cannot appear to span it — but the audio while asleep is gone for
good.

**A closed lid still sleeps** unless an external display is attached and the
machine is on power. With a virtual display and `pmset sleep 0` this is handled;
confirm with `pmset -g assertions` rather than assuming.

## Step 5 — Microphone *(human, via Screen Sharing)*

Enable Screen Sharing first (**System Settings → General → Sharing → Screen
Sharing**), then connect from another Mac with ⌘K in Finder:

```
vnc://server.local
```

**Inside that screen-shared session**, open Terminal.app and run:

```bash
cd ~/openmurmur && pnpm openmurmur capture test
```

The dialog appears on the virtual display. A human clicks Allow. From then on
**Terminal.app** holds the grant, and anything it launches inherits it —
including a LaunchAgent installed from that same session.

Verify: re-run the same command. Input levels rather than a permission error
means it stuck.

Do not attempt this over SSH. The failure is not a timeout or a retryable
error; the prompt is never shown.

## Step 6 — Telegram *(human for the token)*

A human creates the bot: message [@BotFather](https://t.me/BotFather), send
`/newbot`, follow the prompts, keep the token.

```bash
pnpm openmurmur setup telegram
```

In order, it:

1. reads the token from a **hidden prompt** — never argv, a file, or a log;
2. verifies it with `getMe` and prints the bot's username;
3. **waits for `/start`** — a human must send it from a Telegram client now.
   The chat that answers becomes the only chat the bot will ever accept;
4. stores the token and chat ID in the Keychain under service `io.openmurmur`;
5. sends a confirmation message.

Verify:

```bash
pnpm openmurmur telegram test
```

### If it later says Telegram is not configured

Find out which case applies before acting. The current credential pair is one
versioned item:

```bash
security find-generic-password -s io.openmurmur -a telegram-secrets-v1 -w > /dev/null; echo "exit $?"
```

| Exit | Meaning | Action |
| --- | --- | --- |
| 0 | Stored and readable | Something else is wrong; `server-preflight` also detects an empty value |
| 44 | Genuinely not stored | Run `setup telegram` |
| anything else | **Locked Keychain** — the token is intact | Enable automatic login (step 3), or `security unlock-keychain ~/Library/Keychains/login.keychain-db` |

Older installations may still have `telegram-bot-token` and
`telegram-chat-id`; the next successful load migrates a complete non-empty
legacy pair. Do not re-create the bot on a locked Keychain. The daemon
distinguishes these cases in its logs for exactly this reason.

## Step 7 — Start on boot

Only after step 5. The LaunchAgent cannot show a permission prompt, so it must
inherit a grant that already exists.

Run this **from the Screen Sharing session**, not over SSH, so the agent
inherits Terminal.app's microphone grant:

```bash
cd ~/openmurmur && ./scripts/install-launch-agents
```

```bash
launchctl print gui/$(id -u)/io.openmurmur.daemon | head -20
```

```bash
pnpm openmurmur status
```

### Optional — large incoming Telegram files

The Cloud Bot API cannot give a bot files larger than 20 MB. For long recordings
sent *to* the bot, run Telegram's official local Bot API server on the same Mac.

Human prerequisite: create a Telegram app at `https://my.telegram.org/apps` and
copy its `api_id` and `api_hash`.

```bash
brew install cmake gperf openssl
git clone --recursive https://github.com/tdlib/telegram-bot-api.git /tmp/telegram-bot-api
cd /tmp/telegram-bot-api
cmake -B build -DCMAKE_BUILD_TYPE=Release -DOPENSSL_ROOT_DIR="$(brew --prefix openssl)"
cmake --build build --target telegram-bot-api -j"$(sysctl -n hw.ncpu)"
mkdir -p "$HOME/.local/bin"
install -m 0755 build/telegram-bot-api "$HOME/.local/bin/telegram-bot-api"
```

Run it in a separate terminal first:

```bash
mkdir -p "$HOME/Library/Application Support/OpenMurmur/telegram-bot-api"
telegram-bot-api \
  --api-id <api_id> \
  --api-hash <api_hash> \
  --local \
  --http-port 8081 \
  --dir "$HOME/Library/Application Support/OpenMurmur/telegram-bot-api"
```

Then edit `~/Library/Application Support/OpenMurmur/openmurmur.json`:

```json
{
  "telegram": {
    "apiBaseUrl": "http://127.0.0.1:8081",
    "maxIncomingBytes": 2147483648
  }
}
```

Restart OpenMurmur:

```bash
pnpm openmurmur stop
launchctl kickstart -k gui/$(id -u)/io.openmurmur.daemon
```

This changes only incoming files. Microphone sessions are already local and do
not use `getFile`.

## Step 8 — Verify end to end

Speak near the machine for **more than 3 seconds**, using **more than 5 words** —
those are the two rejection gates, applied in that order, and a session must
pass both. Then stay quiet for 60 seconds so the session closes.

```bash
tail -f "$HOME/Library/Application Support/OpenMurmur/logs/daemon.err.log"
```

The full path, in order:

```
session started → audio part closed → session finalized → final VAD pass stored
→ transcript stored → delivery enqueued → session fully delivered
```

Measured on the development machine: about 100 seconds from the session closing
to delivery, most of it the summarizer.

`session rejected  insufficient_speech` means the speech was too short. That is
the noise filter working, not a fault.

---

## Everyday operation

Neither of these needs SSH — message the bot:

```
/status
/health
```

Over SSH:

```bash
ssh you@server 'cd ~/openmurmur && pnpm openmurmur status'
```

```bash
ssh you@server 'cd ~/openmurmur && ./scripts/server-preflight'
```

## Headless-specific failures

| Symptom | Cause |
| --- | --- |
| `macOS denied microphone access`, no dialog ever appears | Run over SSH. Step 5 — it must be a GUI session. |
| Telegram "not configured" although it was set up | Locked Keychain. Step 6, check the exit code. |
| Works until reboot, then nothing | No automatic login, so no GUI session for the agent. Step 3. |
| `🔴 Запись остановлена` at every start | No usable audio input device. Check `./scripts/server-preflight`. |
| Recording stops at night | Sleep. Step 4, confirm with `pmset -g assertions`. |
| Stopped working after a macOS update | Updates can reset TCC. Repeat step 5. |
| Grant lapsed after moving the repo or updating Node | For an unsigned binary macOS keys the grant to the executable's path and contents. Repeat step 5. |

That last row is the sharp edge worth knowing about in advance: a Node upgrade
can silently invalidate microphone access. `pnpm openmurmur doctor` after any
system or Node update is the cheap check. A signed helper would fix it properly
and is on the roadmap ([BACKLOG.md](BACKLOG.md)).

## Memory, on a 64 GB machine

The defaults assume this much: a 27B summarizer (~17 GB) and a resident
Qwen3-ASR-1.7B (~2 GB) coexist comfortably.

**Do not run anything else heavy on the GPU at the same time.** Ollama, MLX and
PyTorch all allocate from the same unified pool, and three large models at once
will wedge the machine rather than degrade gracefully. This is not theoretical —
it is how the 36 GB development machine was hard-locked during testing.

On less memory, use `qwen3.6:8b` for `llm.model` instead. Recording and
transcription are unaffected; only summary quality drops.
