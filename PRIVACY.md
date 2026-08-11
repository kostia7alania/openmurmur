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
| `transcripts/` | `.md` exports of long transcripts, long reports (`<session_id>.report.md`) and long daily digests (`digest-YYYY-MM-DD.md`) |
| `quarantine/` | Files sent to the bot, before validation |
| `logs/` | NDJSON logs, with secrets redacted |
| `tmp/` | In-progress writes |

The bot token and chat ID are in the **macOS Keychain**, service `io.openmurmur`
— never in a file.

## What leaves your machine

**Only to the Telegram chat you configured:**

- Source FLAC audio of each session
- Full transcripts
- Structured summaries: short reports inline, long reports as one `.report.md`
- Daily digests: short digests inline, long digests as one
  `digest-YYYY-MM-DD.md`
- Health and status messages
- Transcripts of audio you send the bot

**Nothing else, to nowhere else.** VAD and ASR run entirely on your Mac. The LLM
endpoint is validated as loopback-only before transcript content can be sent to
it. There is no telemetry, no analytics, no crash reporting, no update check,
and no OpenMurmur server — there is no OpenMurmur server to have.

## The Telegram caveat, stated plainly

Telegram bot chats are **not end-to-end encrypted**. Telegram the company can
technically access everything OpenMurmur sends there.

"Local-first" describes where *processing* happens. It does not mean your audio
stays on your device — you are explicitly choosing to send it to Telegram, and
you configure that yourself.

If Telegram having access is unacceptable to you, OpenMurmur is not the right
tool, and no configuration changes that.

## How long it is kept

| Data | Default retention eligibility threshold |
| --- | --- |
| Session audio | 48 hours after the last confirmed upload for that exact part |
| Transcripts | Indefinitely |
| Summaries | Indefinitely |
| Rejected before delivery (`insufficient_speech`) | 6 hours after session end |
| Rejected after audio delivery | 48 hours after the last confirmed upload for that exact part |
| Incoming Telegram audio | 24 hours after confirmed transcript delivery |
| Quarantined/failed files | 7 days |
| Logs | Until you delete them |

All configurable in `openmurmur.json`. These values are eligibility thresholds,
not permission to delete without proof. The running daemon evaluates the same
proof-based retention plan hourly.

Audio is deleted only when the database can prove it is safe: finalized,
checksummed, delivered at a known time, transcript delivered, no pending work.
The delivery clock is the final Telegram acknowledgement for one exact direct or
split manifest, never the earlier session end. Legacy or ambiguous delivery
records have no proven clock and remain on disk. `pnpm openmurmur retention
dry-run` shows exactly what would go and why anything is being kept.

`pnpm openmurmur delivery reconcile` reports those legacy holds without changing
them. Releasing one requires the explicit `apply` action, a selected part or
session, an exact UTC acknowledgement, operator id, evidence reference and
confirmation. OpenMurmur does not guess the acknowledgement from an older local
timestamp; the supplied fact and audit metadata are stored immutably.

## Deleting everything

```bash
pnpm openmurmur stop
```

```bash
rm -rf ~/"Library/Application Support/OpenMurmur"
```

```bash
security delete-generic-password -s io.openmurmur -a telegram-secrets-v1
security delete-generic-password -s io.openmurmur -a telegram-bot-token
security delete-generic-password -s io.openmurmur -a telegram-chat-id
```

Messages already delivered to Telegram must be deleted in Telegram. OpenMurmur
cannot and does not delete them for you.

Telegram delivery is at-least-once. If the daemon crashes after Telegram accepts
a message but before local SQLite records that acknowledgement, retry can create
a visible duplicate. Stable local ids prevent duplicate enqueue but cannot make
Telegram and SQLite one transaction.

## Other people

OpenMurmur cannot tell who is in the room. It will record anyone within range of
your microphone. That is your responsibility, and in many jurisdictions your
legal liability. See [RECORDING_POLICY.md](RECORDING_POLICY.md).

## Children

Not intended for use by anyone under 16, and not designed to record them.
