"""Qwen3-ASR via MLX, kept resident across an active request burst.

Loading Qwen3-ASR-1.7B takes tens of seconds. Doing that per file would make
every session's transcript arrive minutes late, so the worker reuses it within
a burst and is retired after bounded idle time by its TypeScript owner.

Language handling:
  * Detection is automatic and multiple languages may appear in one recording.
  * Word-level timestamps come from the Qwen forced aligner for RU and EN.
  * Other languages may carry coarse segment boundaries returned by Qwen. They
    are not relabelled as VAD: this code did not measure them with VAD.
  * Missing boundaries stay missing. An audio duration is not a measured
    transcript timestamp.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal

from openmurmur_audio.audio import FloatArray, duration_ms

TimestampSource = Literal["aligner", "vad", "coarse", "none"]


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


def resolve_dtype(quantization: str) -> Any:
    """Maps our config value onto an MLX dtype.

    Weight quantization and compute dtype are separate axes in mlx-qwen3-asr:
    `Session` takes a `dtype`, while 8-/4-bit weights come from an already
    quantized Hugging Face repo. So "8bit" and "4bit" select float16 compute
    and are expected to be paired with a quantized `asr.model` repo id; the
    worker logs which combination it actually used rather than pretending.
    """
    import mlx.core as mx

    return {
        "fp32": mx.float32,
        "fp16": mx.float16,
        "bf16": mx.bfloat16,
        "8bit": mx.float16,
        "4bit": mx.float16,
    }.get(quantization, mx.float16)


class QwenAsr:
    """Persistent Qwen3-ASR session.

    `mlx_qwen3_asr.Session` keeps the model resident, which is the whole point
    of running this worker as a long-lived process.
    """

    def __init__(self) -> None:
        self._session: Any = None
        self._model_name: str = ""
        self._quantization: str = ""

    @property
    def loaded(self) -> bool:
        return self._session is not None

    @property
    def model_name(self) -> str:
        return self._model_name

    def load(self, model: str, quantization: str) -> None:
        if self._session is not None and self._model_name == model:
            return
        try:
            from mlx_qwen3_asr import Session
        except ImportError as exc:
            raise AsrUnavailableError(
                "mlx-qwen3-asr is not installed.\n"
                "Install the local model stack:\n"
                "  /usr/bin/env -u UV_PROJECT_ENVIRONMENT \\\n"
                "    uv sync --project python/openmurmur_audio --extra mlx\n"
                "OpenMurmur transcribes on-device only and has no cloud fallback."
            ) from exc

        try:
            self._session = Session(model, dtype=resolve_dtype(quantization))
        except Exception as exc:  # any load failure is surfaced verbatim to the user
            raise AsrUnavailableError(f"could not load {model} ({quantization}): {exc}") from exc

        self._model_name = model
        self._quantization = quantization

    def transcribe(
        self,
        samples: FloatArray,
        language_hints: list[str],
        aligner_languages: list[str],
        context: str = "",
    ) -> Transcription:
        """Transcribes one recording.

        `context` is Qwen3-ASR's biasing input: terms placed in the system
        prompt that tilt the decoder's probabilities toward them. It is a nudge,
        not an instruction — the model can still ignore it — and it is the one
        accuracy lever available without changing models, which matters most
        for names, jargon and the English words that appear inside Thai speech.
        """
        if self._session is None:
            raise AsrUnavailableError("model is not loaded")

        result = self._session.transcribe(
            samples,
            language=language_hints[0] if language_hints else None,
            context=context,
            return_timestamps=True,
        )
        return normalize_result(result, self._model_name, aligner_languages, duration_ms(samples))


# Qwen3-ASR reports languages as English display names ("Russian", "Thai"),
# but every consumer — the aligner allowlist, the report renderer, the database
# — speaks ISO 639-1. Normalizing here keeps that mismatch in one place.
#
# Found by running the real model: without this the aligner allowlist never
# matched, so RU and EN silently lost their word-level timestamps.
_LANGUAGE_CODES: dict[str, str] = {
    "english": "en",
    "russian": "ru",
    "thai": "th",
    "chinese": "zh",
    "mandarin": "zh",
    "german": "de",
    "french": "fr",
    "spanish": "es",
    "italian": "it",
    "portuguese": "pt",
    "japanese": "ja",
    "korean": "ko",
    "arabic": "ar",
    "hindi": "hi",
    "vietnamese": "vi",
    "indonesian": "id",
    "dutch": "nl",
    "polish": "pl",
    "turkish": "tr",
    "ukrainian": "uk",
}

# A caller allowlist is configuration, not capability evidence. This is the
# subset verified for the bundled Qwen/MLX path; an upstream offset outside it
# remains coarse even if stale or invalid config names that language.
_SUPPORTED_FORCED_ALIGNER_LANGUAGES = frozenset({"ru", "en"})


def normalize_language(value: object) -> str | None:
    """Maps a model language label onto an ISO 639-1 code.

    Accepts a display name ("Russian"), an existing code ("ru"), or a tagged
    form ("ru-RU"). Unknown labels are lowercased and passed through rather
    than dropped, so an unmapped language still reaches the transcript.
    """
    if not isinstance(value, str):
        return None
    text = value.strip()
    if not text:
        return None

    mapped = _LANGUAGE_CODES.get(text.lower())
    if mapped is not None:
        return mapped

    # "ru-RU" / "en_US" -> "ru" / "en"
    head = text.replace("_", "-").split("-")[0].lower()
    return head if head else None


def normalize_result(
    raw: Any,
    model_name: str,
    aligner_languages: list[str],
    audio_duration_ms: int,
) -> Transcription:
    """Maps a model result onto our schema.

    Kept separate from `QwenAsr` so it can be unit-tested without MLX, and so a
    change to the upstream result shape is one function to fix.

    Accepts three shapes: a plain string, a mapping, and the real
    `mlx_qwen3_asr.TranscriptionResult` dataclass (attributes rather than keys,
    with `language` as a single string).
    """
    if not isinstance(raw, str | dict) and hasattr(raw, "text"):
        raw = {
            "text": getattr(raw, "text", ""),
            "language": getattr(raw, "language", None),
            "segments": getattr(raw, "segments", None) or getattr(raw, "chunks", None) or [],
        }

    if isinstance(raw, str):
        return Transcription(
            text=raw.strip(),
            languages=[],
            segments=[
                Segment(
                    text=raw.strip(),
                    start_ms=None,
                    end_ms=None,
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
    segments: list[Segment] = []

    # The model reports the detected language once, at the top level; the
    # per-segment entries are word chunks carrying only text and timings. A
    # segment therefore inherits the recording's language unless it overrides
    # it, which is what makes the aligner allowlist apply at all.
    detected = normalize_language(raw.get("language"))
    languages: list[str] = [detected] if detected is not None else []

    for item in raw_segments:
        language = normalize_language(item.get("language")) or detected
        if language is not None and language not in languages:
            languages.append(language)

        has_word_times = item.get("start") is not None and item.get("end") is not None
        aligner_supported = (
            language is not None
            and language in aligner_languages
            and language in _SUPPORTED_FORCED_ALIGNER_LANGUAGES
        )

        if has_word_times and aligner_supported:
            source: TimestampSource = "aligner"
            start_ms: int | None = int(float(item["start"]) * 1000)
            end_ms: int | None = int(float(item["end"]) * 1000)
        elif has_word_times:
            # The upstream ASR returned boundaries, but there is no validated
            # forced aligner for this language. Preserve the useful coarse
            # offsets without inventing a VAD measurement that never ran.
            source = "coarse"
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
                language=language,
            )
        )

    if not segments and text:
        segments.append(
            Segment(
                text=text,
                start_ms=None,
                end_ms=None,
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
