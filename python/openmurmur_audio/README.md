# openmurmur-audio

Local audio worker for OpenMurmur: Silero VAD (ONNX) and Qwen3-ASR (MLX),
spoken to over NDJSON on stdin/stdout.

## Why a separate process

MLX and ONNX Runtime are Python-only. Rather than binding them into Node, the
daemon runs this as a long-lived child process and exchanges one JSON object per
line. The ASR model stays resident between requests — loading Qwen3-ASR-1.7B per
file would add tens of seconds to every session.

The worker receives **no secrets**. It only ever sees audio file paths.

## Install

```bash
/usr/bin/env -u UV_PROJECT_ENVIRONMENT uv sync --project python/openmurmur_audio
```

That installs the CI-safe subset (numpy, onnxruntime, soundfile). The MLX stack
is an optional extra because its packages and dependencies use several GB and
need Metal:

```bash
/usr/bin/env -u UV_PROJECT_ENVIRONMENT uv sync --project python/openmurmur_audio --extra mlx
```

The extra installs code only; it does not provision ASR weights. Download the
configured model only with the explicit foreground Hugging Face step in
[the installation guide](../../docs/INSTALL.md#7-the-local-model-stack).

## Protocol

```jsonc
// request
{"id":"...","op":"load","model":"Qwen/Qwen3-ASR-1.7B","quantization":"8bit"}
{"id":"...","op":"transcribe","path":"/abs/path.wav","language_hints":[],"aligner_languages":["ru","en"]}
{"id":"...","op":"vad","path":"/abs/path.wav","threshold":0.5}
{"id":"...","op":"ping"}
{"id":"...","op":"shutdown"}

// response
{"id":"...","ok":true,"op":"transcribe","text":"...","languages":["ru"],"segments":[...]}
{"id":"...","ok":false,"code":"model_load_failed","error":"..."}
```

stdout is protocol-only. Logs go to stderr.

## Timestamps

`timestamp_source` on each segment says where the timing came from:

| Value     | Meaning                                                        |
| --------- | -------------------------------------------------------------- |
| `aligner` | Qwen forced aligner produced word-level timings (RU, EN)        |
| `vad`     | An actual VAD measurement was used to derive the boundaries     |
| `coarse`  | Qwen returned segment offsets without validated aligner/VAD provenance |
| `none`    | No measured timing is available                                |

Thai never gets `aligner`. It gets `coarse` when Qwen supplied offsets and
`none` when it did not. No official aligner supports Thai, and an upstream ASR
offset is never relabelled as VAD merely because the allowlist did not match.

## Tests

```bash
uv run --project python/openmurmur_audio pytest
```

The tests need neither a model nor a microphone.
