# ADR-0002: Python 3.14 for the MLX worker

**Status:** Accepted · **Date:** 2026-07-29

## Context

MLX, ONNX Runtime and Silero are Python libraries with no usable Node bindings.
A Python worker is unavoidable. The question is which interpreter.

The brief says to use the newest Python the stack actually supports, and that
compatibility outranks version novelty. Checking what exists rather than what
sounds newest:

| Package | Latest | Python wheels |
| --- | --- | --- |
| onnxruntime | 1.29.0 | cp311, cp312, cp313, **cp314** |
| mlx | 0.32.2 | cp310–cp314, macOS arm64 |
| mlx-qwen3-asr | 0.3.5 | pure Python, requires ≥ 3.10 |
| numpy | 2.5.2 | requires ≥ 3.12 |

Python 3.15.0b1 exists and `uv` will install it. onnxruntime publishes no cp315
wheels.

## Decision

Pin `requires-python = ">=3.14,<3.15"`. Use `uv` for resolution, installation
and a committed lockfile.

## Consequences

**Positive.** Every dependency installs from a binary wheel. `uv sync` takes
seconds and needs no C++ toolchain. `uv` also installs the interpreter itself,
so a contributor needs nothing beyond `uv`.

**Negative.** Not the absolute newest interpreter. Pinning to a single minor
version means an explicit decision to move to 3.15, which is the intended
behaviour — a silent interpreter bump could change model numerics.

**Revisit** when onnxruntime publishes cp315 wheels.

## Alternatives

**Python 3.15.0b1.** Rejected: a source build of onnxruntime on every machine,
for a beta interpreter, in exchange for a larger version number.

**Python 3.12/3.13.** Would work. Rejected because 3.14 is supported by
everything and the brief asks for the newest that genuinely works.

**Avoid Python entirely.** There is no MLX equivalent in Node. Rejected.

## Why a separate process rather than bindings

The worker is spawned and spoken to over NDJSON. Embedding Python in Node would
mean native modules and a much larger blast radius for a crash inside a model.
As a separate process, a worker crash costs one transcription attempt, which the
job queue retries.
