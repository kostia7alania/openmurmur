# Telegram

Telegram is the **only** network destination OpenMurmur has, and you configure
it yourself. This document describes exactly what crosses that boundary.

## Setup

```bash
openmurmur setup telegram
```

1. Create a bot: message [@BotFather](https://t.me/BotFather), send `/newbot`.
2. The CLI asks for the token with **hidden input** (raw terminal mode, no echo,
   not even a mask character — the length should not leak either).
3. The token is verified with `getMe`.
4. You send the bot `/start`.
5. The CLI finds your chat ID via `getUpdates` and shows it.
6. Token and chat ID go into the **macOS Keychain** (service `io.openmurmur`).
7. The `getUpdates` offset is persisted so the `/start` is not replayed.
8. A test message confirms the whole path.

### Where the token is never allowed

| Channel | Why not |
| --- | --- |
| `argv` | `ps` shows another user's arguments on macOS. |
| `.env` | Ends up in backups, editors, and eventually a repository. |
| launchd plist | World-readable, and synced by some backup tools. |
| Config file | Same, plus it invites pasting. |
| Shell history | Persists indefinitely in plain text. |
| Logs | Redaction exists precisely because this is the most common leak. |

The token is passed to `security` on **stdin**, never as an argument.

Log redaction happens at the logger boundary, not at call sites, so no
individual `logger.info` has to remember. It covers bare tokens, tokens inside
`/bot<token>/` API URLs, tokens inside `/file/bot<token>/` download URLs, values
under sensitive-looking keys, and tokens embedded in `Error.stack` — which
matters because `fetch` puts the URL (and therefore the token) into its network
errors.

## Access control

Exactly **one** chat ID is allowed. Every other chat is ignored **silently** —
replying "you are not authorized" would confirm the bot exists to anyone who
found its username.

## Limits (Telegram's, not ours)

| Operation | Limit | Our behaviour |
| --- | --- | --- |
| `sendDocument` | 50 MB | Size re-checked against the live file immediately before upload. Oversize parts are split losslessly with `-c copy` — never re-encoded to a lossy format. |
| `getFile` | **20 MB** | Larger files are refused with an explanation naming Telegram as the source of the limit. |
| Message text | 4096 chars | Long transcripts split into numbered messages plus a `.md` attachment. |
| Rate limiting | HTTP 429 | `retry_after` honoured exactly; the drain stops rather than hammering; no attempt is burned. |

The 20 MB incoming limit is a hard constraint of the official Cloud Bot API.
OpenMurmur will not work around it with an unsafe external downloader. A
self-hosted Bot API server raises it and is tracked as **P2-04**.

## Delivery order

Each session's messages are queued with an `ordinal` and sent strictly in order:

| Ordinal | Content |
| --- | --- |
| 0 | Original FLAC parts, via `sendDocument` |
| 1 | Status notices |
| 5 | Health alerts |
| 10 | Transcript messages (and `.md` when long) |
| 20 | Structured report |
| 30 | Daily digest |

**The source FLAC is sent, never a derived MP3/M4A.** A lossy preview copy may
be added later, but the lossless source is what is stored and what is delivered.

## Message formats

### Session report

```
🎙 Сессия завершена

Время: 14:02–14:18
Продолжительность: 16 мин
Речь: 9 мин 42 сек
Языки: русский, английский
Частей аудио: 2

Кратко:
Обсуждались сроки запуска проекта и настройка Telegram-бота.

Решения:
• Выпустить публичный MVP.
• Не использовать облачный ASR.

Задачи:
• Настроить GitHub Actions.
• Проверить TCC после перезагрузки.

Неуверенность:
• Имя одного из участников распознано ненадёжно.

Session ID: 01J...
```

Empty sections are omitted rather than printed as empty headings.

### Transcript

Under `transcriptInlineLimit` (default 3500) characters: one message.

Over it: numbered HTML messages (`📝 Transcript 2/5`), each carrying the
`session_id`, plus the whole transcript as a `.md` attachment so there is one
searchable artefact.

### Status messages

```
🟢 Запись включена          — sent only after a real audio frame arrives
🟡 Запись временно недоступна
🔴 Запись остановлена
🟢 Запись восстановлена
```

## HTML escaping

All messages use `parse_mode: HTML`, and **every interpolated value that can
originate from speech is escaped**: the summary, every list item, language
names, session ids.

This is not optional politeness. A transcript containing `<b>` would corrupt the
message and Telegram would reject it with a 400 — turning someone's spoken words
into a permanently failed delivery.

Escaping order matters: `&` first, then `<`, `>`, `"`. Reversed, you get
`&amp;lt;`.

## Unicode splitting

Messages are split on **grapheme clusters** via `Intl.Segmenter`, never on
UTF-16 code units.

A naive `slice(0, 4096)` can land inside a surrogate pair and emit a lone
surrogate — which Telegram rejects. This affects emoji and much of the
supplementary plane. Grapheme-aware splitting additionally keeps combining marks
attached to their base characters, which matters for Thai and for accented
Cyrillic.

Line boundaries are preferred where possible so a transcript reads naturally
across messages.

## Commands

| Command | Effect |
| --- | --- |
| `/status` | Recorder state, last frame age, current session, ASR backlog, outbox depth, last delivery, free disk, model status, version. |
| `/health` | `OK`, or one `WARN:`/`ERROR:` line per unhealthy component. |
| `/help` | Available commands. |
| `/start` | Same as `/help`. |

The `@botname` suffix Telegram adds in groups is stripped.

### Commands that deliberately do not exist

`/pause`, `/resume`, `/stop`, `/delete`, shell access, config editing, arbitrary
file retrieval.

A Telegram account compromise must not become an archive compromise. If someone
gains access to the chat, the worst they can do is read what was already sent —
not stop your recorder or destroy your data. Recording is controlled from the
machine doing the recording.

Unknown commands get the help text, not an error.

## Incoming audio

Send the bot a voice message or audio file and it is transcribed locally.

Accepted: Telegram `voice`, `audio`, `video_note`, and documents with a
supported extension or an `audio/*` MIME type. Formats: `.ogg` `.opus` `.mp3`
`.m4a` `.aac` `.wav` `.flac`.

### Pipeline

1. Verify the chat ID.
2. Verify the message type.
3. Check the **declared** size against 20 MB (avoids a pointless round trip).
4. `getFile`.
5. Stream the download into quarantine, **counting bytes and aborting** if the
   real size exceeds the limit — a server that lies about `file_size`, or a
   decompression bomb, is cut off mid-stream.
6. Generate our own UUID filename. Telegram's `file_path` and the claimed
   `file_name` never reach the filesystem.
7. Verify the actual on-disk size.
8. Validate the **real** container with `ffprobe`, ignoring what it claimed to
   be. A `.pdf` claiming `audio/mpeg` is refused; so is a text file named
   `.mp3`.
9. Enforce the duration limit on the probed duration, not the declared one.
10. Normalize to 16 kHz mono WAV.
11. Transcribe with the local ASR.
12. Send the transcript (with a `.md` attachment when long).
13. Optionally summarize.
14. Delete after the retention window.

### Path traversal

Structurally impossible rather than filtered. The filename is
`<our-uuid><whitelisted-extension>`, so `../../../.ssh/authorized_keys`,
absolute paths, NUL bytes, backslash separators and Unicode lookalikes have
nothing to act on. `assertContained()` re-verifies the resolved path as defence
in depth.

Nine hostile filenames are covered by tests.

### Other protections

- Only the allowlisted chat ID.
- Bounded concurrent jobs (`maxConcurrentIncomingJobs`).
- Duration and post-decode size limits.
- Timeouts on `ffprobe` and `ffmpeg`, with bounded `-probesize`/`-analyzeduration`
  so a crafted file cannot make ffprobe read gigabytes.
- Quarantine directory, mode `0600`.
- **No command is ever taken from a transcript.** Audio and transcripts are
  untrusted data throughout.

## Reliability

Every send is a row in `telegram_outbox` with a unique `delivery_part_id`.
Network delivery is at-least-once; the uniqueness constraint makes the *effect*
exactly-once. A crash between "uploaded" and "marked sent" causes a retry, and
that retry is a primary-key conflict rather than a duplicate message.

| Failure | Behaviour |
| --- | --- |
| 429 | Deferred by `retry_after`; drain stops; attempt not burned. |
| 5xx / network | Retried with exponential backoff, capped at 10 minutes. |
| 4xx (not 429) | Marked `dead` immediately — a malformed message will never succeed. |
| Crash mid-send | Row recovered from `sending` to `pending` at startup. |
| Oversize file | Rejected before any network call. |

## Privacy summary

**Leaves your machine:** source FLAC audio, full transcripts, summaries, health
status — all to the one chat you configured.

**Never leaves:** anything else. VAD, ASR and summarization run locally.

**Important:** Telegram bot chats are **not** end-to-end encrypted. Telegram the
company can technically access this content. If that is unacceptable,
OpenMurmur is not the right tool for you.
