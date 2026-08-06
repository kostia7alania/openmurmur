# ADR-0008: Speaker diarization with sherpa-onnx, off by default

**Status:** Accepted · **Date:** 2026-08-07

## Context

A delivered transcript was one undifferentiated block of text. Two separate
problems were behind that: it was not broken into timestamped blocks (fixed
separately, and the formatter for it already existed but was wired to the wrong
path), and nothing recorded who spoke.

The ask was "like Krisp". That comparison needs correcting before choosing
anything: in a meeting, Krisp receives a **separate audio stream per
participant** from the conferencing app. Labelling those is per-channel
bookkeeping and is right by construction. An ambient microphone in a room
produces one mixed mono stream, and separating voices out of it is a genuinely
harder problem whose accuracy is materially lower.

## Decision

Diarization via **sherpa-onnx** — pyannote segmentation ONNX plus a 3D-Speaker
embedding extractor, clustered with a **hard cap on the speaker count**.
**Off by default.**

Labels are "Голос 1", "Голос 2": voices within one recording, never people.

## Rationale

Three options were compared.

| | Integration | Dependency | Gated | Verifiable tonight |
| --- | --- | --- | --- | --- |
| **sherpa-onnx** | a worker op | onnxruntime, **already a dependency** | no | **yes** |
| `mlx-qwen3-asr`'s built-in `diarize=True` | one flag | pyannote.audio + torch | **yes** | no |
| pyannote.audio directly | moderate | pyannote.audio + torch | **yes** | no |

The second is worth dwelling on, because it was nearly chosen: the library
already installed for ASR has `diarize=True`, `diarization_max_speakers` and a
`speaker_segments` field on its result. That is a five-line integration and it
uses `pyannote/speaker-diarization-community-1`, the better model.

It is **gated**. Using it requires a human to accept a licence on Hugging Face
and supply a token — the same class of blocker as the Telegram bot token, on a
product where one such blocker is already the thing standing between this and
working end to end. sherpa-onnx's models are ungated, 44 MB, need no account,
and run on the onnxruntime that Silero VAD already pulls in. No torch.

The gap in model quality is real and is the price paid. It is recoverable: the
worker op is one function, so switching to pyannote later is a contained change
for anyone willing to accept the licence.

## Why the speaker count is capped, and why it is off by default

Measured on real recordings from the owner's environment — a shop, far-field,
background noise:

| Setting | Voices found | Turns | Speaker changes |
| --- | ---: | ---: | ---: |
| auto, threshold 0.5 | 15 | 33 | — |
| auto, threshold 0.8 | 7 | 32 | — |
| auto, threshold 1.0 | 4 | 32 | — |
| **capped at 3** | **3** | 19 | **3** |
| capped at 2 | 2 | 19 | 3 |

On a two-person conversation. Left to count for itself the clustering is not
merely imprecise, it is unusable, and the answer swings with a threshold that
has no principled value. Capping fixes it, and dropping turns under a second
removes the fragments where the over-counting lived.

The segmentation was never the problem. Where the audio is clean the result is
good: a 38-second English recording produced voice 1, then voice 2, then an
unattributed stretch, matching the turns exactly.

It ships **off** because a transcript labelled with the wrong number of people
is worse than one with no labels: it invents participants in a private
conversation. Switching it on is a deliberate act, and `doctor` says plainly
when it is off.

## Consequences

- **44 MB, RTF ~0.08.** About 13× faster than real time; a two-minute session is
  diarized in ten seconds. Negligible next to transcription.
- **Thai attribution is weaker than RU/EN.** No forced aligner supports Thai, so
  its segments carry coarse VAD timings and overlap the wrong turn more often.
  Measured: 44 of 55 segments attributed on Thai audio, and most collapsed onto
  the dominant voice.
- **Unattributed lines are shown unlabelled.** A segment falling in a gap
  between turns gets no speaker rather than the nearest guess.
- **Speakers do not survive a part rotation.** Each part is diarized alone, so
  voices are renumbered per part into a session-wide space. A session that
  rotated mid-conversation reports more voices than were in the room. Parts
  rotate every 15 minutes, so this is rare and visible — better than silently
  merging two strangers into one.
- **Nothing here identifies people.** Voice 1 in one session has no relation to
  voice 1 in the next. The column is an integer, so there is no field to
  quietly start putting names in. Voice enrolment stays a backlog item
  ([BACKLOG.md](../BACKLOG.md) P2-07) precisely because it changes that.

## What would overturn this

Real measurement against a reference. These numbers say the output is
*plausible*, not that it is *right* — nobody has labelled who actually spoke in
these recordings, so the diarization error rate here is unknown. That is filed
as a backlog item rather than a blocker, because an unmeasured feature that is
off by default cannot mislead anyone who did not switch it on.
