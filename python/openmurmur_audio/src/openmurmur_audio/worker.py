"""Long-lived NDJSON worker.

Reads requests from stdin, writes responses to stdout, and keeps the ASR model
resident between requests in an active burst. The TypeScript owner retires the
process after bounded idle time. Started by the TypeScript daemon via
`uv run --project python/openmurmur_audio openmurmur-audio-worker`.

The worker receives no secrets and is launched with Hugging Face offline mode
enabled. Model provisioning is a separate, explicit foreground operator step.
"""

from __future__ import annotations

import base64
import binascii
import sys
import time
from dataclasses import asdict
from typing import Any

from openmurmur_audio import __version__
from openmurmur_audio.asr import AsrUnavailableError, QwenAsr
from openmurmur_audio.audio import AudioError, iter_frames, load_mono_16k, pcm16_to_float
from openmurmur_audio.diarization import (
    DEFAULT_MAX_SPEAKERS,
    DEFAULT_MIN_TURN_SECONDS,
    DiarizationUnavailableError,
    Diarizer,
    speaker_count,
)
from openmurmur_audio.protocol import Request, error, log, ok, write_response
from openmurmur_audio.vad import (
    FRAME_SAMPLES,
    SileroModelMissingError,
    SileroVad,
    analyze,
    total_speech_ms,
)


class Worker:
    def __init__(self) -> None:
        self.asr = QwenAsr()
        self.vad = SileroVad()
        # A second instance, because the live microphone stream and the
        # after-the-fact pass over a finished file are two unrelated streams:
        # sharing one LSTM state would let a finished recording corrupt the
        # detector that is deciding, right now, whether someone is speaking.
        self.stream_vad = SileroVad()
        self.diarizer = Diarizer()

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
            case "vad_stream":
                return self._vad_stream(request)
            case "diarize":
                return self._diarize(request)
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
        context = request.payload.get("context", "")
        if not isinstance(context, str):
            return error(request.id, "bad_request", "context must be a string")

        try:
            samples = load_mono_16k(path)
        except AudioError as exc:
            return error(request.id, "audio_unreadable", str(exc))

        try:
            result = self.asr.transcribe(samples, hints, aligner_languages, context)
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

    def _vad_stream(self, request: Request) -> dict[str, Any]:
        """Scores live microphone frames, carrying Silero's state between calls.

        The daemon sends whole 512-sample frames as they leave the capture pipe
        and gets one probability back per frame, in order. `reset` starts a new
        stream: the state from before a gap says nothing about the audio after
        it.
        """
        payload = request.payload.get("pcm")
        if not isinstance(payload, str):
            return error(request.id, "bad_request", "vad_stream requires base64 pcm")

        try:
            raw = base64.b64decode(payload, validate=True)
        except (binascii.Error, ValueError) as exc:
            return error(request.id, "bad_request", f"pcm is not valid base64: {exc}")

        frame_bytes = FRAME_SAMPLES * 2
        if len(raw) == 0 or len(raw) % frame_bytes != 0:
            return error(
                request.id,
                "bad_request",
                f"pcm must be a whole number of {FRAME_SAMPLES}-sample frames "
                f"({frame_bytes} bytes); got {len(raw)}",
            )

        try:
            self.stream_vad.load()
        except SileroModelMissingError as exc:
            return error(request.id, "vad_unavailable", str(exc))

        if request.payload.get("reset") is True:
            self.stream_vad.reset()

        try:
            samples = pcm16_to_float(raw)
            probabilities = [
                self.stream_vad.probability(frame) for frame in iter_frames(samples, FRAME_SAMPLES)
            ]
        except AudioError as exc:
            return error(request.id, "bad_request", str(exc))
        except Exception as exc:  # noqa: BLE001
            return error(request.id, "vad_failed", f"{type(exc).__name__}: {exc}")

        return ok(request.id, "vad_stream", probabilities=probabilities)

    def _diarize(self, request: Request) -> dict[str, Any]:
        """Splits a finished recording into stretches by voice.

        Deliberately independent of the ASR model: a recording is worth
        labelling by voice even when transcription failed, and the daemon
        assigns speakers to transcript segments by overlap afterwards.
        """
        path = request.payload.get("path")
        if not isinstance(path, str):
            return error(request.id, "bad_request", "diarize requires a string path")

        max_speakers = request.payload.get("max_speakers", DEFAULT_MAX_SPEAKERS)
        min_turn = request.payload.get("min_turn_seconds", DEFAULT_MIN_TURN_SECONDS)
        if not isinstance(max_speakers, int) or max_speakers < 1:
            return error(request.id, "bad_request", "max_speakers must be a positive integer")
        if not isinstance(min_turn, (int, float)) or min_turn < 0:
            return error(request.id, "bad_request", "min_turn_seconds must be a number >= 0")

        try:
            samples = load_mono_16k(path)
        except AudioError as exc:
            return error(request.id, "audio_unreadable", str(exc))

        try:
            turns = self.diarizer.diarize(
                samples, max_speakers=max_speakers, min_turn_seconds=float(min_turn)
            )
        except DiarizationUnavailableError as exc:
            return error(request.id, "diarization_unavailable", str(exc))
        except Exception as exc:  # noqa: BLE001
            return error(request.id, "diarization_failed", f"{type(exc).__name__}: {exc}")

        return ok(
            request.id,
            "diarize",
            turns=[asdict(turn) for turn in turns],
            speakers=speaker_count(turns),
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
