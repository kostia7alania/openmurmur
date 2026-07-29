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
uv sync --project python/openmurmur_audio
```

That installs the CI-safe subset (numpy, onnxruntime, soundfile). The MLX stack
is an optional extra because it pulls several GB of weights and needs Metal:

```bash
uv sync --project python/openmurmur_audio --extra mlx
```

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

| Value     | Meaning                                                     |
| --------- | ----------------------------------------------------------- |
| `aligner` | Qwen forced aligner produced word-level timings (RU, EN)     |
| `vad`     | Timing derived from VAD/segment boundaries (Thai, and others)|
| `none`    | No timing available                                          |

Thai never gets `aligner`. No official aligner supports it, and presenting a
guess as a measurement would be worse than admitting the gap.

## Tests

```bash
uv run --project python/openmurmur_audio pytest
```

The tests need neither a model nor a microphone.
