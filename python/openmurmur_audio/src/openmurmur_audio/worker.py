"""Long-lived NDJSON worker.

Reads requests from stdin, writes responses to stdout, keeps the ASR model
resident in between. Started by the TypeScript daemon via
`uv run --project python/openmurmur_audio openmurmur-audio-worker`.

The worker receives no secrets and makes no network calls of its own beyond the
model download that Hugging Face performs on first load.
"""

from __future__ import annotations

import sys
import time
from dataclasses import asdict
from typing import Any

from openmurmur_audio import __version__
from openmurmur_audio.asr import AsrUnavailableError, QwenAsr
from openmurmur_audio.audio import AudioError, load_mono_16k
from openmurmur_audio.protocol import Request, error, log, ok, write_response
from openmurmur_audio.vad import SileroVad, analyze, total_speech_ms


class Worker:
    def __init__(self) -> None:
        self.asr = QwenAsr()
        self.vad = SileroVad()

    def handle(self, request: Request) -> dict[str, Any]:
        match request.op:
            case "ping":
                return ok(request.id, "ping", worker_version=__version__)
            case "load":
                return self._load(request)
            case "transcribe":
                return self._transcribe(request)
            case "vad":
                return self._vad(request)
            case "shutdown":
                return ok(request.id, "shutdown")
            case _:
                return error(request.id, "bad_request", f'unknown operation "{request.op}"')

    def _load(self, request: Request) -> dict[str, Any]:
        model = request.payload.get("model")
        quantization = request.payload.get("quantization", "8bit")
        if not isinstance(model, str) or not isinstance(quantization, str):
            return error(request.id, "bad_request", "load requires string model and quantization")

        started = time.monotonic()
        try:
            self.asr.load(model, quantization)
        except AsrUnavailableError as exc:
            return error(request.id, "model_load_failed", str(exc))

        elapsed_ms = int((time.monotonic() - started) * 1000)
        log(f"loaded {model} ({quantization}) in {elapsed_ms} ms")
        return ok(request.id, "load", model=model, load_ms=elapsed_ms)

    def _transcribe(self, request: Request) -> dict[str, Any]:
        path = request.payload.get("path")
        if not isinstance(path, str):
            return error(request.id, "bad_request", "transcribe requires a string path")

        hints = _string_list(request.payload.get("language_hints"))
        aligner_languages = _string_list(request.payload.get("aligner_languages"))

        try:
            samples = load_mono_16k(path)
        except AudioError as exc:
            return error(request.id, "audio_unreadable", str(exc))

        try:
            result = self.asr.transcribe(samples, hints, aligner_languages)
        except AsrUnavailableError as exc:
            return error(request.id, "model_not_loaded", str(exc))
        except Exception as exc:  # noqa: BLE001 - reported, never crashes the worker
            return error(request.id, "transcribe_failed", f"{type(exc).__name__}: {exc}")

        return ok(
            request.id,
            "transcribe",
            text=result.text,
            languages=result.languages,
            segments=[asdict(segment) for segment in result.segments],
            model=result.model,
            duration_ms=result.duration_ms,
        )

    def _vad(self, request: Request) -> dict[str, Any]:
        path = request.payload.get("path")
        threshold = request.payload.get("threshold", 0.5)
        if not isinstance(path, str) or not isinstance(threshold, (int, float)):
            return error(request.id, "bad_request", "vad requires a string path and a threshold")

        try:
            samples = load_mono_16k(path)
        except AudioError as exc:
            return error(request.id, "audio_unreadable", str(exc))

        try:
            self.vad.load()
            segments = analyze(samples, self.vad, float(threshold))
        except Exception as exc:  # noqa: BLE001
            return error(request.id, "vad_failed", f"{type(exc).__name__}: {exc}")

        return ok(
            request.id,
            "vad",
            segments=[asdict(segment) for segment in segments],
            speech_ms=total_speech_ms(segments),
        )


def _string_list(value: object) -> list[str]:
    if not isinstance(value, list):
        return []
    return [item for item in value if isinstance(item, str)]


def main() -> int:
    worker = Worker()
    log(f"openmurmur-audio-worker {__version__} ready")

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue

        try:
            request = Request.parse(line)
        except (ValueError, TypeError) as exc:
            # No id to correlate against, so this can only be logged.
            log(f"discarding malformed request: {exc}")
            continue

        try:
            response = worker.handle(request)
        except Exception as exc:  # noqa: BLE001 - one bad request must not kill the worker
            response = error(request.id, "internal", f"{type(exc).__name__}: {exc}")

        write_response(sys.stdout, response)
        if request.op == "shutdown":
            log("shutting down")
            return 0

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
