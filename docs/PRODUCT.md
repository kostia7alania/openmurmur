# Product

## Promise

> OpenMurmur records speech sessions, transcribes them locally, and sends the
> source audio, transcript, summary and operational status to your private
> Telegram chat.

Tagline: **Private ambient journal for Apple Silicon.**

## The problem

People have thoughts, decisions and commitments out loud, and then lose them.
Existing options each fail in a specific way:

- **Meeting bots** only work in meetings, and upload everything to a vendor.
- **Voice memos** require you to decide, in advance, that this moment matters.
- **Always-on cloud assistants** solve the capture problem by making you the
  product.

OpenMurmur is the always-on option that keeps the recording on your machine.
A Mac with 64 GB of unified memory can run a good ASR model and a 27B LLM
locally; there is no technical reason the audio has to leave.

## Who it is for

Someone who works alone or in a small trusted space, owns an Apple Silicon Mac
with enough memory, already lives in Telegram, and wants a searchable record of
what they actually said — without renting that record from anyone.

## What it does

- Runs continuously from the microphone.
- Detects **speech**, not sound, using Silero VAD.
- Opens a session on sustained speech, with 5 seconds of pre-roll.
- Survives pauses; closes after 60 continuous seconds of silence.
- Rotates the physical file every 15 minutes, keeping one logical session.
- Transcribes locally with Qwen3-ASR (RU / EN / TH, mixed-language, automatic
  detection).
- Extracts a structured summary with a local LLM.
- Delivers the **original FLAC**, the full transcript and a short report to one
  Telegram chat.
- Produces a daily digest.
- Reports its own health, and alerts on state changes only.
- Transcribes audio you send the bot.

## What it deliberately does not do

| Not doing | Why |
| --- | --- |
| Cloud ASR or cloud LLM | The entire point. A 64 GB Mac does not need one. |
| An OpenMurmur account | Nothing to sign up for means nothing to breach. |
| Telemetry or analytics | We do not want your usage data. |
| A second consent window | macOS already asks. A second prompt trains people to click through prompts. |
| A custom recording indicator | macOS shows an orange dot. A second indicator is noise; a *replacement* one would be dishonest. |
| A menu bar item or overlay | Same reason. Status lives in Telegram, where you already are. |
| Remote `/stop`, `/pause`, `/delete` | A Telegram message must never be able to stop your recorder or destroy your data. Compromise of the chat would otherwise become compromise of the archive. |
| Speaker diarization (for now) | Doing it badly is worse than not doing it. Tracked as P2. |
| A GUI | Only if a real need appears. A settings window that nobody opens is a liability. |
| Silently degrading to a worse model | If the local ASR is unavailable, you get a clear error, not a quiet downgrade. |

## Design commitments

These are the rules the code is written to keep. They are enforced by tests, not
just intent.

1. **The microphone never blocks on processing.** A slow model, an offline
   Telegram or a full disk must not cost you a recording.
2. **A file in the archive is always complete.** Temp file, fsync, atomic
   rename. A power cut can lose the tail of a recording; it can never corrupt
   the archive or hand Telegram a truncated file.
3. **Nothing is deleted without proof.** Retention is pure SQL over recorded
   facts. If a fact is missing, the file stays.
4. **The LLM has no capabilities.** It converts text to JSON. It cannot run a
   command, choose a destination, change a setting or delete anything —
   because nothing downstream reads its output as anything but strings.
5. **Transcripts are untrusted input.** Whatever someone says near the
   microphone is data, never instruction.
6. **Secrets never leave the Keychain.** Not to argv, not to `.env`, not to a
   plist, not to a log. Redaction happens at the logger boundary so no call
   site has to remember.
7. **Status is never claimed before it is true.** `🟢 Запись включена` is sent
   after a real audio frame arrives, not when the process starts.
8. **Time decisions use a monotonic clock.** An NTP step or a DST change must
   not close a session or stretch one to hours.

## Naming

The slug **`openmurmur`** was available under the authenticated GitHub account
at the time of creation, so it was used. The documented fallbacks —
`openmurmur-mac`, then `sottolog` — were not needed.

"Murmur" is what the product listens to: quiet, ambient, mostly unremarkable
speech. "Open" is the licence and the posture.

## Success criteria for v0.1

- A user reaches their first Telegram status message in 10–15 minutes,
  excluding model downloads.
- A session of ordinary speech produces audio, transcript and report in the
  chat, in that order.
- A television playing in an empty room produces no sessions worth sending.
- Killing the daemon mid-session leaves a valid FLAC on disk.
- `retention dry-run` never lists a file that has not been delivered.

## Non-goals for v1.0

Real-time transcription, multi-device sync, a web UI, team features, and any
hosted service. Each of them changes what this is.
