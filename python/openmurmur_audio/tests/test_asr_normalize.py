"""Result normalization, especially the language/timestamp policy.

These run without MLX: `normalize_result` is deliberately independent of the
model so the Thai timestamp rule is testable in CI.
"""

from __future__ import annotations

import importlib.util

import pytest

from openmurmur_audio.asr import normalize_result

ALIGNER = ["ru", "en"]

# The tests below need the optional `mlx` extra (real model weights / ONNX).
# CI deliberately installs only the CI-safe subset, so they skip there rather
# than failing — see docs/adr/0002-python-runtime.md.
requires_local_models = pytest.mark.skipif(
    importlib.util.find_spec("mlx") is None,
    reason="requires the optional `mlx` extra: uv sync --extra mlx",
)


def test_plain_string_result_is_accepted() -> None:
    result = normalize_result("привет мир", "Qwen/Qwen3-ASR-1.7B", ALIGNER, 3000)
    assert result.text == "привет мир"
    assert len(result.segments) == 1
    assert result.segments[0].timestamp_source == "none"


def test_empty_string_yields_no_segments() -> None:
    result = normalize_result("   ", "m", ALIGNER, 1000)
    assert result.text == ""
    assert result.segments == []


def test_russian_word_timings_are_labelled_aligner() -> None:
    raw = {
        "text": "привет",
        "segments": [{"text": "привет", "language": "ru", "start": 0.5, "end": 1.25}],
    }
    result = normalize_result(raw, "m", ALIGNER, 2000)

    assert result.segments[0].timestamp_source == "aligner"
    assert result.segments[0].start_ms == 500
    assert result.segments[0].end_ms == 1250


def test_thai_timings_are_never_labelled_aligner() -> None:
    """No official aligner supports Thai; timings must not claim word accuracy."""
    raw = {
        "text": "สวัสดี",
        "segments": [{"text": "สวัสดี", "language": "th", "start": 0.0, "end": 1.0}],
    }
    result = normalize_result(raw, "m", ALIGNER, 1000)

    assert result.segments[0].language == "th"
    assert result.segments[0].timestamp_source == "vad"


def test_segment_without_timings_is_labelled_none() -> None:
    raw = {"text": "hello", "segments": [{"text": "hello", "language": "en"}]}
    result = normalize_result(raw, "m", ALIGNER, 1000)
    assert result.segments[0].timestamp_source == "none"
    assert result.segments[0].start_ms is None


def test_mixed_language_recording_reports_every_language() -> None:
    raw = {
        "text": "привет hello สวัสดี",
        "segments": [
            {"text": "привет", "language": "ru", "start": 0.0, "end": 1.0},
            {"text": "hello", "language": "en", "start": 1.0, "end": 2.0},
            {"text": "สวัสดี", "language": "th", "start": 2.0, "end": 3.0},
        ],
    }
    result = normalize_result(raw, "m", ALIGNER, 3000)

    assert set(result.languages) == {"ru", "en", "th"}
    sources = {s.language: s.timestamp_source for s in result.segments}
    assert sources["ru"] == "aligner"
    assert sources["en"] == "aligner"
    assert sources["th"] == "vad"


def test_top_level_language_is_included() -> None:
    raw = {"text": "hi", "language": "en", "segments": []}
    assert normalize_result(raw, "m", ALIGNER, 500).languages == ["en"]


class _FakeTranscriptionResult:
    """Mirrors mlx_qwen3_asr.TranscriptionResult: attributes, not keys."""

    def __init__(self, text: str, language: str | None, segments: list[dict] | None) -> None:
        self.text = text
        self.language = language
        self.segments = segments
        self.chunks = None


def test_accepts_the_real_dataclass_shape() -> None:
    """The upstream result is an object with a single `language` string.

    Written after the real API turned out to differ from the dict shape this
    function was first built against.
    """
    raw = _FakeTranscriptionResult(
        text="привет мир",
        language="ru",
        segments=[{"text": "привет мир", "language": "ru", "start": 0.0, "end": 1.5}],
    )
    result = normalize_result(raw, "Qwen/Qwen3-ASR-1.7B", ALIGNER, 1500)

    assert result.text == "привет мир"
    assert "ru" in result.languages
    assert result.segments[0].timestamp_source == "aligner"
    assert result.segments[0].end_ms == 1500


def test_dataclass_without_segments_still_yields_one_segment() -> None:
    raw = _FakeTranscriptionResult(text="hello", language="en", segments=None)
    result = normalize_result(raw, "m", ALIGNER, 900)

    assert result.text == "hello"
    assert len(result.segments) == 1
    assert result.languages == ["en"]


def test_thai_from_the_dataclass_is_still_never_aligner() -> None:
    raw = _FakeTranscriptionResult(
        text="สวัสดี",
        language="th",
        segments=[{"text": "สวัสดี", "language": "th", "start": 0.0, "end": 1.0}],
    )
    result = normalize_result(raw, "m", ALIGNER, 1000)
    assert result.segments[0].timestamp_source == "vad"


@requires_local_models
def test_dtype_mapping_covers_every_configured_quantization() -> None:
    """resolve_dtype must never raise for a value the config schema allows."""
    import mlx.core as mx

    from openmurmur_audio.asr import resolve_dtype

    assert resolve_dtype("fp16") is mx.float16
    assert resolve_dtype("bf16") is mx.bfloat16
    # 8-bit/4-bit are weight quantizations carried by the repo, not dtypes.
    assert resolve_dtype("8bit") is mx.float16
    assert resolve_dtype("4bit") is mx.float16
    assert resolve_dtype("nonsense-value") is mx.float16


def test_display_names_are_mapped_to_iso_codes() -> None:
    """Qwen3-ASR returns "Russian", not "ru".

    Found by running the real model: the aligner allowlist is keyed on ISO
    codes, so without this mapping RU and EN silently lost their word-level
    timestamps and the report printed "English" instead of "английский".
    """
    from openmurmur_audio.asr import normalize_language

    assert normalize_language("English") == "en"
    assert normalize_language("Russian") == "ru"
    assert normalize_language("Thai") == "th"
    # Already-normalized and locale-tagged values pass through.
    assert normalize_language("ru") == "ru"
    assert normalize_language("en-US") == "en"
    assert normalize_language("ru_RU") == "ru"
    # Unknown languages are kept, not dropped.
    assert normalize_language("Klingon") == "klingon"
    assert normalize_language("") is None
    assert normalize_language(None) is None


def test_segments_inherit_the_detected_language() -> None:
    """Word chunks carry timings but no language of their own.

    The aligner allowlist can only apply if a segment knows its language, so a
    segment inherits the recording's detected language unless it overrides it.
    """
    raw = _FakeTranscriptionResult(
        text="Let's ship it",
        language="English",
        segments=[
            {"text": "Let's", "start": 0.0, "end": 0.24},
            {"text": "ship", "start": 0.24, "end": 0.56},
        ],
    )
    result = normalize_result(raw, "m", ALIGNER, 800)

    assert result.languages == ["en"]
    assert all(s.language == "en" for s in result.segments)
    assert all(s.timestamp_source == "aligner" for s in result.segments)


def test_thai_display_name_still_never_gets_aligner() -> None:
    """The Thai policy must survive the display-name mapping."""
    raw = _FakeTranscriptionResult(
        text="สวัสดีครับ",
        language="Thai",
        segments=[{"text": "สวัสดีครับ", "start": 0.0, "end": 1.36}],
    )
    result = normalize_result(raw, "m", ALIGNER, 1360)

    assert result.languages == ["th"]
    assert result.segments[0].timestamp_source == "vad"


def test_a_segment_may_override_the_detected_language() -> None:
    """Mixed-language speech: a segment's own label wins over the default."""
    raw = _FakeTranscriptionResult(
        text="привет hello",
        language="Russian",
        segments=[
            {"text": "привет", "start": 0.0, "end": 1.0},
            {"text": "สวัสดี", "language": "Thai", "start": 1.0, "end": 2.0},
        ],
    )
    result = normalize_result(raw, "m", ALIGNER, 2000)

    sources = {s.language: s.timestamp_source for s in result.segments}
    assert sources["ru"] == "aligner"
    assert sources["th"] == "vad"
    assert set(result.languages) == {"ru", "th"}
