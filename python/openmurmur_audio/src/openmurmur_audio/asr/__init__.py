"""Qwen3-ASR via MLX, kept resident across requests.

Loading Qwen3-ASR-1.7B takes tens of seconds. Doing that per file would make
every session's transcript arrive minutes late, so the worker is a long-lived
process and the model stays in unified memory between requests.

Language handling:
  * Detection is automatic and multiple languages may appear in one recording.
  * Word-level timestamps come from the Qwen forced aligner for RU and EN.
  * Thai gets segment timings derived from VAD boundaries instead. No official
    aligner supports Thai, and emitting invented word timings would present a
    guess as measurement.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal

from openmurmur_audio.audio import FloatArray, duration_ms

TimestampSource = Literal["aligner", "vad", "none"]


@dataclass(frozen=True, slots=True)
class Segment:
    text: str
    start_ms: int | None
    end_ms: int | None
    timestamp_source: TimestampSource
    language: str | None


@dataclass(slots=True)
class Transcription:
    text: str
    languages: list[str] = field(default_factory=list)
    segments: list[Segment] = field(default_factory=list)
    model: str = ""
    duration_ms: int = 0


class AsrUnavailableError(Exception):
    """Raised when the MLX stack or the model weights are not installed."""


class QwenAsr:
    """Persistent Qwen3-ASR session."""

    def __init__(self) -> None:
        self._model: Any = None
        self._model_name: str = ""
        self._quantization: str = ""

    @property
    def loaded(self) -> bool:
        return self._model is not None

    @property
    def model_name(self) -> str:
        return self._model_name

    def load(self, model: str, quantization: str) -> None:
        if self._model is not None and self._model_name == model:
            return
        try:
            from mlx_qwen3_asr import load_model
        except ImportError as exc:
            raise AsrUnavailableError(
                "mlx-qwen3-asr is not installed.\n"
                "Install the MLX extra:\n"
                "  uv sync --project python/openmurmur_audio --extra mlx\n"
                "OpenMurmur transcribes on-device only and has no cloud fallback."
            ) from exc

        try:
            self._model = load_model(model, quantization=quantization)
        except Exception as exc:  # any load failure is surfaced verbatim to the user
            raise AsrUnavailableError(f"could not load {model} ({quantization}): {exc}") from exc

        self._model_name = model
        self._quantization = quantization

    def transcribe(
        self,
        samples: FloatArray,
        language_hints: list[str],
        aligner_languages: list[str],
    ) -> Transcription:
        if self._model is None:
            raise AsrUnavailableError("model is not loaded")

        result = self._model.transcribe(
            samples,
            language=language_hints[0] if language_hints else None,
        )
        return normalize_result(result, self._model_name, aligner_languages, duration_ms(samples))


def normalize_result(
    raw: Any,
    model_name: str,
    aligner_languages: list[str],
    audio_duration_ms: int,
) -> Transcription:
    """Maps a model result onto our schema.

    Kept separate from `QwenAsr` so it can be unit-tested without MLX, and so a
    change to the upstream result shape is one function to fix.
    """
    if isinstance(raw, str):
        return Transcription(
            text=raw.strip(),
            languages=[],
            segments=[
                Segment(
                    text=raw.strip(),
                    start_ms=0,
                    end_ms=audio_duration_ms,
                    timestamp_source="none",
                    language=None,
                )
            ]
            if raw.strip()
            else [],
            model=model_name,
            duration_ms=audio_duration_ms,
        )

    text = str(raw.get("text", "")).strip()
    raw_segments = raw.get("segments") or []
    languages: list[str] = []
    segments: list[Segment] = []

    for item in raw_segments:
        language = item.get("language")
        if isinstance(language, str) and language not in languages:
            languages.append(language)

        has_word_times = item.get("start") is not None and item.get("end") is not None
        aligner_supported = isinstance(language, str) and language in aligner_languages

        if has_word_times and aligner_supported:
            source: TimestampSource = "aligner"
            start_ms: int | None = int(float(item["start"]) * 1000)
            end_ms: int | None = int(float(item["end"]) * 1000)
        elif has_word_times:
            # Timings exist but no validated aligner for this language: keep
            # them, and label them as VAD-grade so downstream code does not
            # present them as word-accurate.
            source = "vad"
            start_ms = int(float(item["start"]) * 1000)
            end_ms = int(float(item["end"]) * 1000)
        else:
            source = "none"
            start_ms = None
            end_ms = None

        segments.append(
            Segment(
                text=str(item.get("text", "")).strip(),
                start_ms=start_ms,
                end_ms=end_ms,
                timestamp_source=source,
                language=language if isinstance(language, str) else None,
            )
        )

    top_language = raw.get("language")
    if isinstance(top_language, str) and top_language not in languages:
        languages.insert(0, top_language)

    if not segments and text:
        segments.append(
            Segment(
                text=text,
                start_ms=0,
                end_ms=audio_duration_ms,
                timestamp_source="none",
                language=languages[0] if languages else None,
            )
        )

    return Transcription(
        text=text,
        languages=languages,
        segments=segments,
        model=model_name,
        duration_ms=audio_duration_ms,
    )
