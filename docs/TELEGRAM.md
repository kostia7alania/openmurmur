# Telegram

Telegram is the **only** network destination OpenMurmur has, and you configure
it yourself. This document describes exactly what crosses that boundary.

## Setup

Choose the role while creating the fresh config. Configuration defaults to
send-only, so a second host cannot silently start consuming the same bot's
updates. On the one input owner, run:

```bash
pnpm openmurmur setup --telegram-role owner
```

This writes `telegram.receiveUpdates: true` only when the config is first
created. Setup never rewrites an existing config; an existing host must change
that field intentionally before rebinding its role.

Then, from the repository checkout, run:

```bash
pnpm openmurmur setup telegram owner
```

1. Create a bot: message [@BotFather](https://t.me/BotFather), send `/newbot`.
2. The CLI asks for the token with **hidden input** (raw terminal mode, no echo,
   not even a mask character — the length should not leak either).
3. The token is verified with `getMe`.
4. The CLI drains the existing update backlog and establishes a fresh offset.
5. You send the bot a new `/start` from a **private** chat. Historical messages,
   group messages, bot senders and arbitrary private text are not accepted for
   binding.
6. The CLI shows the sender account, user id and chat id and requires an explicit
   `y`/`yes` confirmation.
7. The matching `getUpdates` offset is persisted under a non-secret SHA-256
   credential fingerprint so the `/start` cannot be replayed.
8. Only after that cursor is durable do token and chat ID go into one atomically
   replaced, versioned **macOS Keychain** item (service `io.openmurmur`).
9. A test message confirms the whole path.

Every other host using that token selects `--telegram-role send-only` during
fresh setup, then runs:

```bash
pnpm openmurmur setup telegram send-only
```

Send-only setup asks for the positive private chat ID printed by the owner
setup. It verifies the token with `getMe` and the recipient with `sendMessage`,
but makes **zero** `getUpdates` calls and creates no update cursor. Bare
`setup telegram` is rejected: the role must agree exactly with
`telegram.receiveUpdates`. The diagnostic `telegram poll` command is likewise
rejected before contacting Telegram on a send-only host.

SQLite and Keychain cannot share one transaction, so publication order is the
privacy boundary: a hard death before step 8 leaves only inactive, non-secret
cursor metadata; a hard death after step 8 leaves the complete pair with its
matching cursor. Startup refuses to poll a concrete credential fingerprint when
that cursor is absent; it never guesses by polling from zero.

Owner setup also refuses an already configured identical bot token **before**
constructing the Telegram client or making `getMe`/`getUpdates` calls. An
in-place same-token rebind could consume the old owner's queued updates before
the new Keychain pair is durable. Create a separate bot with @BotFather for a
new owner binding. Reusing the token on a `send-only` host remains supported
because that role never consumes updates. All setup roles share one exclusive
per-user temporary lock across state roots, so another OpenMurmur setup cannot
publish credentials between the read-only preflight and the owner handshake.
An interrupted stale lock makes the next setup fail closed with an explicit
cleanup instruction; it never falls through to Keychain or Telegram.

Credential setup and the diagnostic `telegram poll` are exclusive with the
daemon that owns the same state root. The CLI refuses them before reading the
Keychain or contacting Telegram while that daemon is running: otherwise a
credential change would leave its resident client on the old bot, and a second
`getUpdates` request could interrupt the production long poll. From the
repository checkout, stop the daemon, run the exact setup or diagnostic, then
restart it. Keep the same exact state root on every command (replace the sample
value once):

```bash
STATE_ROOT="/absolute/path/to/openmurmur-state"
pnpm openmurmur --root "$STATE_ROOT" stop
pnpm openmurmur --root "$STATE_ROOT" setup telegram owner
pnpm openmurmur --root "$STATE_ROOT" start
```

On a send-only host, use
`pnpm openmurmur --root "$STATE_ROOT" setup telegram send-only` as the middle
command instead.

```bash
pnpm openmurmur --root "$STATE_ROOT" stop
pnpm openmurmur --root "$STATE_ROOT" telegram poll
pnpm openmurmur --root "$STATE_ROOT" start
```

Setup and poll hold a renewable local maintenance claim for that exact root.
Daemon startup is blocked until the action releases it; if the CLI is killed,
the next operation recovers the claim only after proving that exact process is
gone. If process birth identity cannot be established, maintenance fails before
reading credentials or contacting Telegram.

### Where the token is never allowed

| Channel | Why not |
| --- | --- |
| `argv` | `ps` shows another user's arguments on macOS. |
| `.env` | Ends up in backups, editors, and eventually a repository. |
| launchd plist | World-readable, and synced by some backup tools. |
| Config file | Same, plus it invites pasting. |
| Shell history | Persists indefinitely in plain text. |
| Logs | Redaction exists precisely because this is the most common leak. |

The credential pair enters an `expect`-owned private terminal from **stdin**;
`/usr/bin/security` receives it through its interactive prompt, never argv,
environment variables or a file.

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

Exactly one daemon may receive updates for a bot token. This is currently an
operator-enforced ownership rule: the fail-closed default is
`telegram.receiveUpdates: false`; set it to `true` only on the designated input
host, and run setup with the matching explicit role. Independent polling hosts
keep independent SQLite offsets and can consume each other's updates;
OpenMurmur cannot detect that cross-host conflict without a shared coordinator.
Separate bots are the stronger isolation option.
Within one data root, update ids, offsets, acknowledgement keys and incoming
jobs are credential-scoped, so switching bots cannot collide with the previous
bot's history. That protects rebinding; it does not coordinate two live hosts.

```json
{
  "telegram": {
    "receiveUpdates": false
  }
}
```

## Limits (Telegram's, not ours)

| Operation | Limit | Our behaviour |
| --- | --- | --- |
| `sendDocument` | 50 MB | Size re-checked against the live file immediately before upload. Oversize parts are split losslessly with `-c copy` — never re-encoded to a lossy format. |
| `getFile` via Cloud Bot API | **20 MB** | Larger files are refused with an explanation naming Telegram as the source of the limit. |
| `getFile` via local Bot API server | Configured by `telegram.maxIncomingBytes`, capped at 2 GB by OpenMurmur | Large files are streamed into quarantine with the same byte-count and ffprobe validation. |
| Message text | 4096 UTF-16 code units | Short transcripts and reports use collapsed expandable quotes. Long transcripts and reports become one Markdown document. |
| Rate limiting | HTTP 429 | `retry_after` honoured exactly; the drain stops rather than hammering; no attempt is burned. |

The 20 MB incoming limit is a hard constraint of the official Cloud Bot API.
OpenMurmur will not work around it with an unsafe external downloader. A local
Telegram Bot API server is the supported escape hatch: point `telegram.apiBaseUrl`
at `http://127.0.0.1:<port>` and raise `telegram.maxIncomingBytes`.

Incoming audio produces a transcript, not a summary. The former
`telegram.summarizeIncoming` option was removed because it was never honored;
remove it from existing config files before starting the daemon.

## Delivery stages and queue order

Session finalization creates independent durable `deliver_audio` and `asr` jobs.
The outbox can upload source audio while ASR runs. Successful ASR schedules
transcript delivery immediately and summarization separately; the report follows
the summary when it is ready:

```
finalized ─┬─▶ deliver_audio ─────────────────────────▶ outbox
           └─▶ ASR ─┬─▶ deliver_transcript ──────────▶ outbox
                    └─▶ summarize ─▶ deliver_report ─▶ outbox
```

Ready outbox rows are sent FIFO by creation/insertion order. `run_after` keeps a
backoff row ineligible until its retry time without allowing newly created audio
to starve older ready transcript/report rows. Stable `delivery_part_id` values
deduplicate enqueue for audio, lifecycle status, transcript, report, alert and
digest units.

**The source FLAC is sent, never a derived MP3/M4A.** A lossy preview copy may
be added later, but the lossless source is what is stored and what is delivered.

## Message formats

### Provenance on every recording output

Source audio captions, transcripts, reports and incoming-file acknowledgements
are self-identifying. A live session shows `фоновая запись OpenMurmur`, the
persisted daemon hostname and capture IANA timezone, original wall date/time and
session UID. Telegram-supplied audio shows whether it was sent directly or
forwarded, attachment type, claiming daemon, original forwarded time when
Telegram supplies one, the later bot-chat message time, update/message ids,
original claimed filename when present, and the stable OpenMurmur file UID.

Daily digests identify themselves as a local OpenMurmur roll-up and snapshot the
processing hostname in both the stored digest payload and the Telegram output.
The same hostname is retained when an outbox delivery is retried; it is not
reconstructed from whichever daemon later retries the send. Re-running
`pnpm openmurmur digest DATE` prints that exact stored snapshot and does not
rewrite its Markdown artifact or enqueue a replacement.

Forward provenance uses the official `forward_origin.date`; it is never confused
with `message.date`, which is when the forwarded copy reached the bot. Legacy
rows say that missing host/timezone/request facts are unknown. Claimed filenames
are bounded and escaped for display; they never become a command or routing
decision.

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

Every non-empty summary claim is labelled either with the segment reference
selected by the model or with `ссылка модели: не указана`. When a referenced
immutable transcript segment is available, the label also carries a bounded
source excerpt on the following line so the owner can check modality and
wording without searching the full report; only display whitespace is
normalized. The excerpt is source text, while the association itself is still
a model claim, not independent verification. The complete numbered source
segments remain in the report below.

Reports at or below `transcriptInlineLimit` (default 3500) are sent as one HTML
message: the short summary and the detailed report are separate collapsed
expandable quotes. A longer report is sent as a compact collapsed summary plus
one UTF-8 `<session_id>.report.md` document with a bounded trusted caption,
rather than a wall of messages. The document includes the timed transcript and
`Голос N` labels only when diarization actually attributed speakers. It never
infers names or roles, and transcript content is never used in a filename or
path.

### Transcript

Under `transcriptInlineLimit` (default 3500) characters: one collapsed
expandable quote carrying the `session_id`.

Over it: one `.md` attachment, without duplicate numbered chat messages, so
the chat stays compact and the transcript remains a searchable artefact. The
file labels each persisted timestamp source: `aligner`, actual `VAD`, or
approximate `ASR`; segments with `none` say that time is unavailable. `Голос N`
appears only when diarization supplied a speaker label.

### Status messages

```
🟢 Запись включена          — recorder capability, only after a real frame
🎙 Услышал речь — запись сессии началась.
⏳ Сессия завершена — загружаю аудио и параллельно расшифровываю локально…
⚠️ Сессия завершена не полностью — загружаю сохранившиеся части аудио и расшифровываю локально…
🔴 Сессию не удалось сохранить: финализация аудио завершилась ошибкой. Аудио не загружаю.
ℹ️ Сессия завершена, но фрагмент слишком короткий — аудио не отправляю.
ℹ️ Аудио сохранено, но в расшифровке слишком мало слов — транскрипт и отчёт не отправляю.
🟡 Запись временно недоступна
🔴 Запись остановлена
🟢 Запись восстановлена
```

Recorder lifecycle rows use stable ids derived from session id and stage
(`started`, `finalized`, `rejected`, `failed`). Partial finalization retains the
`finalized` stage with honest wording; total finalization failure uses `failed`
and queues neither audio nor ASR. The post-ASR rejection uses its own stable
`asr-rejected` id. Each row is queued only after the corresponding database
transition is true. Queueing is local and does not wait for Telegram; retries
and restarts cannot enqueue a second copy of the same stage.

The short-fragment notice is the pre-delivery speech-duration gate. The
post-ASR word-count gate runs after source audio became independently eligible,
so it suppresses only an empty transcript and report; it does not retract audio
that may already be uploading or delivered.

## HTML escaping

Inline formatted messages use `parse_mode: HTML`, and **every interpolated value
that can originate from speech is escaped**: the summary, every list item,
language names, session ids. Markdown document contents are escaped separately;
their filenames and captions come only from trusted session/date metadata.

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
| `/status` | Daemon host name, recorder state, last frame age, current session, ASR backlog, outbox depth, last delivery, free disk, model status, version. |
| `/health` | `✅ Всё в порядке`, or one Russian `ВНИМАНИЕ:`/`ОШИБКА:` line per unhealthy component. Raw adapter and process errors stay in the local log. |
| `/settings` | Shows this daemon host and selects Auto, Thai, Russian, English, or Chinese for future ASR jobs. |
| `/help` | Available commands. |
| `/start` | Same as `/help`. |

The `@botname` suffix Telegram adds in groups is stripped.

`/settings` is a radio choice, not a language allowlist. Qwen accepts either
automatic identification or one forced language for one audio input. The
choice is snapshotted into new jobs on this Mac. Transcript buttons change the
same future default; they do not rewrite the transcript above them.

Only the daemon with `telegram.receiveUpdates: true` can receive callback
queries, so send-only development instances do not attach dead buttons to
their output. With two Macs on one bot token, settings affect the input-owner
host shown in the panel, not the other Mac.

The implementation follows the official Bot API callback contract:
`callback_data` stays below 64 bytes, every accepted press calls
`answerCallbackQuery`, and the existing keyboard is edited rather than adding a
new settings message. See [InlineKeyboardButton](https://core.telegram.org/bots/api#inlinekeyboardbutton),
[CallbackQuery](https://core.telegram.org/bots/api#callbackquery), and
[answerCallbackQuery](https://core.telegram.org/bots/api#answercallbackquery).

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
3. Check the **declared** size against `telegram.maxIncomingBytes` (avoids a
   pointless round trip).
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
10. Normalize to 16 kHz mono WAV through a private temporary file, then fsync
    and atomically rename it. A crash cannot leave a partial deterministic WAV
    that poisons every retry.
11. Transcribe with the local ASR.
12. Send the transcript (with a `.md` attachment when long).
13. Delete after the retention window.

Safe validation failures produce stable Russian messages with the configured
size or duration limit. ffmpeg, ffprobe, filesystem and Telegram API errors are
kept in the redacted local log and never copied into chat. If processing still
fails after all retries, one durable Russian failure notice is sent with the
file provenance.

### Path traversal

Structurally impossible rather than filtered. The filename is
`<our-uuid><whitelisted-extension>`, so `../../../.ssh/authorized_keys`,
absolute paths, NUL bytes, backslash separators and Unicode lookalikes have
nothing to act on. `assertContained()` re-verifies the resolved path as defence
in depth.

Nine hostile filenames are covered by tests.

### Other protections

- Only the allowlisted chat ID.
- One leased incoming-audio job at a time in the current daemon.
- Duration and post-decode size limits.
- Timeouts on `ffprobe` and `ffmpeg`, with bounded
  `-probesize`/`-analyzeduration` so a crafted file cannot make ffprobe read
  gigabytes.
- Quarantine directory, mode `0600`.
- **No command is ever taken from a transcript.** Audio and transcripts are
  untrusted data throughout.

## Local Bot API server for large incoming files

Use this when users need to send long recordings to the bot. It replaces the
Cloud Bot API endpoint with Telegram's official local server; OpenMurmur still
validates every file as untrusted input.

Human prerequisite: create a Telegram app at `https://my.telegram.org/apps` and
copy its `api_id` and `api_hash`.

Build/install the server:

```bash
brew install cmake gperf openssl
git clone --recursive https://github.com/tdlib/telegram-bot-api.git /tmp/telegram-bot-api
cd /tmp/telegram-bot-api
cmake -B build -DCMAKE_BUILD_TYPE=Release -DOPENSSL_ROOT_DIR="$(brew --prefix openssl)"
cmake --build build --target telegram-bot-api -j"$(sysctl -n hw.ncpu)"
mkdir -p "$HOME/.local/bin"
install -m 0755 build/telegram-bot-api "$HOME/.local/bin/telegram-bot-api"
```

Run it locally:

```bash
mkdir -p "$HOME/Library/Application Support/OpenMurmur/telegram-bot-api"
telegram-bot-api \
  --api-id <api_id> \
  --api-hash <api_hash> \
  --local \
  --http-port 8081 \
  --dir "$HOME/Library/Application Support/OpenMurmur/telegram-bot-api"
```

Then update `~/Library/Application Support/OpenMurmur/openmurmur.json`:

```json
{
  "telegram": {
    "apiBaseUrl": "http://127.0.0.1:8081",
    "maxIncomingBytes": 2147483648
  }
}
```

Restart the daemon:

```bash
pnpm openmurmur stop
launchctl kickstart -k gui/$(id -u)/io.openmurmur.daemon
pnpm openmurmur doctor
```

## Reliability

Every send is a row in `telegram_outbox` with a unique `delivery_part_id`.
The uniqueness constraint prevents duplicate **enqueue**, not duplicate network
effect. A crash after Telegram accepted a request but before SQLite committed
`sent` causes a retry and may visibly duplicate the message because Telegram's
Bot API does not accept an idempotency key. Delivery is at-least-once across
that unavoidable acknowledgement window.

| Failure | Behaviour |
| --- | --- |
| 429 | Deferred by `retry_after`; drain stops; attempt not burned. |
| 5xx / network | Retried with exponential backoff, capped at 10 minutes. |
| Local request deadline / daemon shutdown | JSON is bounded at 30 seconds, long polling gets its requested wait plus 10 seconds of transport headroom, and file transfer is bounded at 10 minutes. Abort returns the row to `pending` without burning an attempt; shutdown cancels immediately. |
| 4xx (not 429) | Marked `dead` immediately — a malformed message will never succeed. |
| Crash mid-send | Row recovered from `sending` to `pending` at startup. |
| Oversize file | Rejected before any network call. |

### Reconciling one independently proven remote acknowledgement

Telegram does not provide this outbox with a post-hoc `getMessage` lookup or an
idempotency key. A local `pending`, `sending` or attempted row therefore proves
only local state — never that Telegram accepted or rejected it. The default
operator command is report-only and labels the remote result as unknown:

```bash
pnpm openmurmur delivery reconcile-remote report \
  --delivery-part 'report:SESSION_ID'
```

The report includes the exact `delivery_part_id`, a control-character-safe
preview of the visible text/caption/filename and SHA-256 of the complete stored
request payload. Stop the daemon, then compare those visible fields with
independent Telegram evidence such as a Telegram Desktop JSON export. If and
only if the same remote message is visible, record its exact positive Telegram
message id, its exact UTC message time, the operator identity and a short
evidence reference:

```bash
pnpm openmurmur delivery reconcile-remote apply \
  --delivery-part 'report:SESSION_ID' \
  --telegram-message-id 501 \
  --ack-at '2026-08-11T10:05:00.000Z' \
  --operator 'operator@example' \
  --evidence 'Telegram Desktop JSON export message 501 matched the reported payload' \
  --yes
```

Apply handles exactly one delivery row. It aborts if no local send attempt was
recorded, the preview changed, the ACK predates the durable outbox request, the
daemon may still be running, or the row cannot be matched to its durable audio,
session or incoming-transcript owner. The outbox state, Telegram message id,
exact ACK clock, applicable domain transition and immutable operator audit are
one SQLite transaction. Repeating the exact same evidence is idempotent;
different evidence for an already reconciled row is rejected.

This workflow does not eliminate the acknowledgement window. Without the
independent message identity it deliberately leaves the row pending and keeps
at-least-once retry semantics, including the possibility of a visible
duplicate. No timestamp, attempt count or payload similarity is promoted into
a fabricated remote ACK.

Health alerts do not amplify an outage. A `telegram_delivery` failure is kept
in the local log and `/health` while Telegram is delayed; putting that warning
into the unavailable channel would only deliver a stale warning after recovery
and grow the backlog it describes. The recovery edge is sent once. For other
health checks, a newer pending state supersedes the older unsent alert instead
of accumulating cooldown reminders. Prior-run `notice:*` rows are retired at
startup, while durable `session-status:*` rows are preserved.

The setup flow is intentionally narrower than normal bot routing: only a fresh
private `/start` from an identifiable non-bot sender, observed after setup
established its baseline and explicitly confirmed by the user, can become the
allowlisted chat.

Daily digests follow the same text bound as reports: a short digest is one HTML
message; a long one is one trusted content-addressed
`digest-YYYY-MM-DD-<sha256>.md` document. Decisions, tasks, questions and
per-session summaries are visibly labelled as model drafts. Each new snapshot
keeps its exact summary/current-transcript revision, session/time attribution,
model-reported segment indexes and one bounded localized excerpt (or an
explicit missing/unlocalized label). A legacy snapshot is not reconstructed
from newer transcript state and says that its claim source was not retained.
The first complete snapshot wins atomically with the stable `digest:<date>`
delivery id, shared by daemon scheduling and the digest CLI safety net. Only
that durable payload publishes or reconstructs the content-addressed file; a
concurrent loser creates no artifact. New digest documents carry an exact byte
count and SHA-256, and the verified bytes—not a later path read—are uploaded on
every retry. The launchd fallback checks the real enabled/time/timezone config
every five minutes; automatic snapshots wait for already-running sessions and
include only `DONE` sessions. They are not revised for a session that starts
after the date's digest was already delivered (tracked in AR-08).

## Privacy summary

**Leaves your machine:** source FLAC audio, full transcripts, summaries, health
status — all to the one chat you configured.

**Never leaves:** anything else. VAD, ASR and summarization run locally.

**Important:** Telegram bot chats are **not** end-to-end encrypted. Telegram the
company can technically access this content. If that is unacceptable,
OpenMurmur is not the right tool for you.
