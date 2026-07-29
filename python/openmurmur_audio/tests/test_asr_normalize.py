"""Result normalization, especially the language/timestamp policy.

These run without MLX: `normalize_result` is deliberately independent of the
model so the Thai timestamp rule is testable in CI.
"""

from __future__ import annotations

from openmurmur_audio.asr import normalize_result

ALIGNER = ["ru", "en"]


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
