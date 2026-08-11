# ADR-0007: Keep Qwen3-ASR for Thai rather than adding a specialized model

**Status:** Accepted · **Date:** 2026-08-06

## Context

Thai is one of the three languages this product claims to handle, and it is the
one most likely to be badly served: it is lower-resource than Russian or
English, it is tonal, and it is written without spaces between words. It is also
the language where OpenMurmur already accepts a known limitation — no forced
aligner supports Thai. Qwen-supplied Thai offsets are therefore retained only
as coarse ASR boundaries, never relabelled as VAD or word timings (see
[ARCHITECTURE.md](../ARCHITECTURE.md)).

Thai-specialized open models exist and are actively developed, so the question
is whether one of them should replace or supplement Qwen3-ASR-1.7B.

**Published numbers cannot answer it.** The Qwen3-ASR report gives Thai as WER;
the Typhoon report gives CER and states outright that WER is not meaningful for
a script with no word delimiters, since "words" are whatever the tokenizer says
they are. Two papers, two metrics, two normalization schemes, no comparison.

## Decision

Keep **Qwen3-ASR-1.7B**. Add no Thai-specific model and no language routing.

## Rationale

Measured on this machine rather than argued from papers: FLEURS `th_th` dev, 40
utterances, 8.1 minutes of speech, one metric for every system — CER after
identical normalization (NFC, Thai digits mapped to Arabic, spaces stripped from
both reference and hypothesis, because spacing in Thai is the model's rendering
choice rather than content).

| Engine | corpus CER | median CER | exact / 40 | RTF |
| --- | ---: | ---: | ---: | ---: |
| **Qwen3-ASR-1.7B** (8-bit MLX, `language=th`) | **6.46%** | **2.56%** | **14** | 1.09 |
| Qwen3-ASR-1.7B (8-bit MLX, auto-detect) | 7.65% | 3.53% | 13 | 1.15 |
| Typhoon Whisper Turbo 0.8B (Thai fine-tune) | 11.98% | 6.92% | 7 | 0.24 |
| Typhoon Whisper Large-v3 2B (Thai fine-tune) | 12.56% | 6.81% | 10 | 1.42 |
| Whisper large-v3-turbo (unmodified base) | 13.19% | 10.36% | 1 | 0.28 |

The Thai fine-tuning clearly works — Typhoon cuts its own base model's median
error by a third and quadruples the number of utterances it gets exactly right.
It simply does not catch a newer multilingual model. Replacing Qwen3-ASR with
the specialized model would roughly **double** the character error rate and cost
a second engine, a second dependency, and language routing to keep Russian and
English working, since the Typhoon models are Thai-only.

Scaling the specialized model up does not close the gap either: the 2B
Large-v3 is no better than the 0.8B Turbo on this set — marginally better
median, marginally worse corpus, a much worse tail — while costing 6× the
inference time. Whatever separates Qwen3-ASR here is not model capacity.

The cheapest available option is also the best one. That is the entire decision.

## Consequences

**Positive.** No new dependency, no routing logic, no second resident model
competing for unified memory, and one engine to reason about for all three
languages.

**Negative, and worth stating plainly.**

- **Auto-detection costs about one CER point.** The shipped config leaves
  `asr.languageHints` empty, which is correct for an ambient journal — nobody
  announces which language they are about to speak. Qwen accepts at most one
  forced language for one audio input; this is not a priority list. The
  measurement above shows a fixed price for it. `/settings` therefore lets the
  input-owner choose forced Thai for future known-monolingual jobs. An automatic
  detect-then-retranscribe pass would roughly double ASR cost for a ~1-point
  gain and is still not taken; revisit it only with a measured far-field corpus.
- **Speed is the one place the specialized model wins outright**: RTF 0.24
  against 1.09. Qwen3-ASR is slower than real time on short utterances, where
  per-call overhead dominates. If the ASR queue ever falls behind, Typhoon
  Whisper Turbo is the escape hatch, and it is a Whisper checkpoint so it runs
  through `mlx-whisper` or `whisper.cpp` with no new runtime.

## What would overturn this

- **FLEURS is read studio speech.** This product records rooms. The Typhoon
  paper's own results show the ranking between Thai models changing between
  clean and in-the-wild sets, and its in-the-wild set (TVSpeech) is not public.
  Ten real Thai sessions recorded through the actual microphone would be worth
  more than another public benchmark.
- **The Typhoon authors dispute FLEURS orthography**, reporting normalized
  figures materially better than the raw ones. On their normalization the gap
  narrows, though not enough on these numbers to change the ranking.
- **Contamination is unquantified.** FLEURS appears as an evaluation set in both
  papers; neither publishes a decontamination audit.

## Alternatives considered

| Model | License | Why not |
| --- | --- | --- |
| [Typhoon Whisper Large-v3](https://huggingface.co/typhoon-ai/typhoon-whisper-large-v3) (2B) | MIT | Measured above: double the error, 6× the inference time, and no better than its own 0.8B sibling |
| [Typhoon Whisper Turbo](https://huggingface.co/typhoon-ai/typhoon-whisper-turbo) (0.8B) | MIT | Measured above: roughly double the error. The best of the Thai-specific options, and the one to revisit if speed ever forces the question |
| [Typhoon ASR Realtime](https://huggingface.co/scb10x/typhoon-asr-realtime) (115M) | CC-BY-4.0 | Streaming and very cheap, but pulls NeMo and torch, and is less accurate than the offline models |
| [Pathumma Whisper Large-v3](https://huggingface.co/nectec/Pathumma-whisper-th-large-v3) (2B) | Apache-2.0 | Better on clean speech than Typhoon per its paper, notably worse on in-the-wild audio — the wrong trade for this product |
| [Thonburian Whisper](https://github.com/biodatlab/thonburian-whisper) | MIT | Older; worst Thai result in the Typhoon comparison |

## References

- [Qwen3-ASR official inference API and language forcing](https://github.com/QwenLM/Qwen3-ASR/blob/main/qwen_asr/inference/qwen3_asr.py)
- [Qwen3-ASR model card: forcing one language and context/hotwords](https://huggingface.co/Qwen/Qwen3-ASR-1.7B-hf)
- [Typhoon ASR Real-time: FastConformer-Transducer for Thai ASR](https://arxiv.org/html/2601.13044v1)
- [Qwen3-ASR Technical Report](https://arxiv.org/html/2601.21337v1)
