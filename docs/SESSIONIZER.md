# Sessionizer

The sessionizer decides what a "session" is. It is the piece of OpenMurmur most
likely to be wrong in a way users notice, so it is pure, fully specified here,
and covered by 43 tests driven from a fake clock.

Implementation: [`src/sessionizer/machine.ts`](../src/sessionizer/machine.ts).

## Why VAD, not volume

A room is never silent. A refrigerator, a fan, traffic, a laptop, a television —
all produce continuous sound well above the noise floor. A sessionizer built on
waveform amplitude would either record continuously (threshold too low) or miss
quiet speech (threshold too high), and no single threshold works in both a
bedroom and a café.

"Silence" in OpenMurmur means **no speech according to Silero VAD**, which
classifies the *character* of the sound rather than its level. A television at
conversational volume keeps VAD active — which is a genuine limitation, not a
bug, and is why the minimum-speech and minimum-word gates exist downstream.

`EnergyVad` in the TypeScript source is **not** a substitute. It is an energy
gate used for `capture test` and for tests, where the point is proving the audio
path works, not classifying sound.

## States

```
                     speech ≥ 500ms sustained
        ┌──────────────────────────────────────────────┐
        │                                              ▼
   ┌─────────┐   speech    ┌───────────────────┐   ┌────────┐
   │  IDLE   │────────────▶│ SPEECH_CANDIDATE  │   │ ACTIVE │
   └─────────┘             └───────────────────┘   └────────┘
        ▲                            │                 │  ▲
        │      speech stops early    │                 │  │ speech returns
        └────────────────────────────┘        speech   │  │
        │                                     stops    ▼  │
        │                                    ┌────────────────┐
        │                                    │ SILENCE_GRACE  │
        │                                    └────────────────┘
        │                                              │
        │              60s without speech              │
        │                                              ▼
        │                                      ┌──────────────┐
        └──────────────────────────────────────│  FINALIZING  │
                                               └──────────────┘
                                                       │
                              PROCESSING → DELIVERING → DONE
                              (tracked in SQLite, not in this machine)
```

`FINALIZING` is transient inside `push()`: the machine emits its intents and
returns to `IDLE` in the same call. The next frame can therefore open a new
session while the previous one is still being transcribed.

`PROCESSING`, `DELIVERING` and `DONE` are pipeline states stored per-session in
`audio_sessions.state`. They are listed in the `SessionState` type for
completeness, but the machine never rests in them — calling `push()` in one is a
programming error and throws.

### IDLE

- A ring buffer holds the last `preRollSeconds` (default 5) of frames.
- Nothing is written to disk.
- One speech frame moves to `SPEECH_CANDIDATE`.

### SPEECH_CANDIDATE

- Speech must be **continuous** for `speechCandidateMs` (default 500).
- Any non-speech frame returns to `IDLE` and discards the candidate.
- The ring buffer keeps filling, so the candidate audio is itself part of the
  pre-roll when the session does open.

This is what stops a door slam, a cough or one loud keystroke from creating a
session.

### ACTIVE

- Lossless FLAC is written.
- Every speech frame resets the silence timer.
- The session has a UUID, a wall-clock start and a monotonic start.
- Rotation is evaluated here (see below).

### SILENCE_GRACE

- Entered the moment speech stops.
- Speech returning at **any** point before the timeout continues the *same*
  session — same UUID, same file.
- After `silenceTimeoutSeconds` (default 60) of continuous non-speech, the
  session finalizes.

The distinction that matters: 59 seconds of silence followed by speech is one
session. 61 seconds is two.

## Pre-roll

When a session opens, the buffered frames are prepended so the recording starts
*before* the words that triggered it. Without this, every session would begin
mid-word.

The session's reported start time is backdated by the pre-roll length, so the
timestamp in the Telegram report matches the audio you actually hear.

Parts created by **rotation** get no pre-roll — they continue seamlessly from
the previous part.

## Rotation

A single conversation, or a television left on all evening, must not produce one
enormous file.

- A part closes after `maxPartSeconds` (default 900 = 15 minutes).
- The current FLAC is closed atomically and the next part opens immediately.
- All parts share one `session_id` and are numbered `p000`, `p001`, ...
- The **logical** session stays open. Processing and delivery start only after
  the final 60 seconds of silence.

**Rotation is evaluated only while `ACTIVE`.** Rotating during `SILENCE_GRACE`
could emit a part containing nothing but trailing silence. The cost is that a
part may overrun by at most `silenceTimeoutSeconds`:

```
worst-case part = maxPartSeconds + silenceTimeoutSeconds = 960 s
16 kHz mono 16-bit ≈ 32 kB/s raw, ≈ 19 kB/s as FLAC on speech
960 s × 19 kB/s ≈ 18 MB
```

Comfortably inside Telegram's 50 MB limit — and the delivery path re-checks the
real file size anyway and splits losslessly if needed, so a pathological
configuration cannot produce a failed upload.

## Minimum useful session

Two gates, applied at different times, keep the chat usable.

| Gate | When | Threshold | Rejection reason |
| --- | --- | --- | --- |
| Speech duration | At finalize, in the machine | `minSpeechSeconds` (3) | `insufficient_speech` |
| Word count | After ASR, in the job | `minTranscriptWords` (5) | `insufficient_words` / `asr_empty` |

Both are configurable. Both record the reason in `audio_sessions.rejection_reason`.

A rejected session **still gets its audio part closed properly** — the file is
valid on disk and kept for `rejectedSessionHours` (default 6) so you can check
what was discarded, before retention removes it.

Word counting handles Thai, which is written without spaces: a plain
space-delimited count would reject every Thai session. See `countWords` in
[`src/database/repository.ts`](../src/database/repository.ts).

## Time

Every duration decision uses **monotonic** milliseconds carried on each frame.
Wall-clock time is recorded for display and storage only.

This matters concretely:

- An NTP step of +1 hour during a pause must not close a live session.
- A DST transition must not create a 1-hour "session".
- Waking from sleep must not make a session appear to have run all night.

Two tests assert exactly this by moving the fake clock's wall time without
moving its monotonic time.

## Configuration

```jsonc
{
  "sessionizer": {
    "preRollSeconds": 5,          // audio kept before speech starts
    "speechCandidateMs": 500,     // sustained speech needed to open a session
    "silenceTimeoutSeconds": 60,  // silence needed to close one
    "maxPartSeconds": 900,        // physical file rotation
    "minSpeechSeconds": 3,        // reject below this much speech
    "minTranscriptWords": 5,      // ...unless ASR found this many words
    "vadThreshold": 0.5,          // Silero probability above which a frame is speech
    "vadFrameMs": 32              // 512 samples at 16 kHz; Silero requires this
  }
}
```

`maxPartSeconds` must exceed `silenceTimeoutSeconds`; the config validator
rejects a configuration where a session could rotate before it could close.

## Tuning

| Symptom | Change |
| --- | --- |
| Sessions open on noise | Raise `vadThreshold` to 0.6–0.7, or `speechCandidateMs` to 800. |
| Quiet speech is missed | Lower `vadThreshold` to 0.35–0.4. |
| One conversation splits into several sessions | Raise `silenceTimeoutSeconds`. |
| Sessions run far too long | Lower `silenceTimeoutSeconds`; check for a television or radio. |
| Too many rejected sessions | Lower `minSpeechSeconds` / `minTranscriptWords`. |
| Files too large for comfort | Lower `maxPartSeconds`. |

## Test coverage

[`tests/unit/sessionizer.test.ts`](../tests/unit/sessionizer.test.ts) — 43 tests,
no sleeping, no I/O:

opening and false candidates; candidate re-arming; configurable thresholds;
pre-roll length, backdating and absence on rotation; grace entry; speech
returning at 59 s; finalize at 60 s; repeated silence-timer resets; wall-clock
jumps forward and backward; rotation without ending the session; shared session
id across parts; consecutive part numbering; part counts; no rotation during
grace; both rejection gates; audio still closed for rejected sessions; immediate
readiness for a new session; force-finalize on shutdown; snapshot accuracy.
