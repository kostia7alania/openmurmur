# Privacy

Plain statement of what OpenMurmur stores, where, and who can read it.

## What is recorded

Audio from your Mac's microphone, continuously, whenever the daemon runs.
macOS shows an **orange dot** near Control Center while the microphone is open.
OpenMurmur does not hide, replace or suppress that indicator.

Audio is only *persisted* once speech is detected and sustained for 500 ms. A
5-second rolling buffer exists in memory before that and is discarded unless a
session opens.

## Where it is stored

Everything lives under `~/Library/Application Support/OpenMurmur/`, mode `0700`:

| Path | Contents |
| --- | --- |
| `audio/YYYY-MM-DD/` | Session FLAC files |
| `openmurmur.db` | Transcripts, summaries, session metadata, job and delivery state |
| `transcripts/` | `.md` exports of long transcripts |
| `quarantine/` | Files sent to the bot, before validation |
| `logs/` | NDJSON logs, with secrets redacted |
| `tmp/` | In-progress writes |

The bot token and chat ID are in the **macOS Keychain**, service `io.openmurmur`
— never in a file.

## What leaves your machine

**Only to the Telegram chat you configured:**

- Source FLAC audio of each session
- Full transcripts
- Structured summaries
- Health and status messages
- Transcripts of audio you send the bot

**Nothing else, to nowhere else.** VAD, ASR and summarization run entirely on
your Mac. There is no telemetry, no analytics, no crash reporting, no update
check, and no OpenMurmur server — there is no OpenMurmur server to have.

## The Telegram caveat, stated plainly

Telegram bot chats are **not end-to-end encrypted**. Telegram the company can
technically access everything OpenMurmur sends there.

"Local-first" describes where *processing* happens. It does not mean your audio
stays on your device — you are explicitly choosing to send it to Telegram, and
you configure that yourself.

If Telegram having access is unacceptable to you, OpenMurmur is not the right
tool, and no configuration changes that.

## How long it is kept

| Data | Default retention |
| --- | --- |
| Session audio | 48 hours after confirmed delivery |
| Transcripts | Indefinitely |
| Summaries | Indefinitely |
| Rejected-session audio | 6 hours |
| Incoming Telegram audio | 24 hours after transcription |
| Quarantined/failed files | 7 days |
| Logs | Until you delete them |

All configurable in `openmurmur.json`.

Audio is deleted only when the database can prove it is safe: finalized,
checksummed, delivered, transcript delivered, no pending work. `openmurmur
retention dry-run` shows exactly what would go and why anything is being kept.

## Deleting everything

```bash
openmurmur stop
```

```bash
rm -rf ~/"Library/Application Support/OpenMurmur"
```

```bash
security delete-generic-password -s io.openmurmur -a telegram-bot-token
security delete-generic-password -s io.openmurmur -a telegram-chat-id
```

Messages already delivered to Telegram must be deleted in Telegram. OpenMurmur
cannot and does not delete them for you.

## Other people

OpenMurmur cannot tell who is in the room. It will record anyone within range of
your microphone. That is your responsibility, and in many jurisdictions your
legal liability. See [RECORDING_POLICY.md](RECORDING_POLICY.md).

## Children

Not intended for use by anyone under 16, and not designed to record them.
