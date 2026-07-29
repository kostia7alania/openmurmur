"""Segment assembly from VAD probabilities. Pure logic — no ONNX model needed."""

from __future__ import annotations

from openmurmur_audio.vad import FRAME_MS, segments_from_probabilities, total_speech_ms


def test_no_speech_produces_no_segments() -> None:
    assert segments_from_probabilities([0.0] * 50, threshold=0.5) == []


def test_one_continuous_run_becomes_one_segment() -> None:
    probabilities = [0.0] * 10 + [0.9] * 20 + [0.0] * 30
    segments = segments_from_probabilities(probabilities, threshold=0.5)

    assert len(segments) == 1
    assert segments[0].start_ms == 10 * FRAME_MS
    assert segments[0].end_ms == 30 * FRAME_MS


def test_a_short_gap_inside_a_sentence_does_not_split_it() -> None:
    """A pause between words is one utterance, not two."""
    # 2 frames of silence = 64 ms, under the 300 ms bridge.
    probabilities = [0.9] * 10 + [0.1] * 2 + [0.9] * 10 + [0.0] * 40
    segments = segments_from_probabilities(probabilities, threshold=0.5)
    assert len(segments) == 1


def test_a_long_gap_does_split() -> None:
    # 20 frames = 640 ms, comfortably over the bridge.
    probabilities = [0.9] * 10 + [0.0] * 20 + [0.9] * 10 + [0.0] * 20
    segments = segments_from_probabilities(probabilities, threshold=0.5)
    assert len(segments) == 2


def test_speech_running_to_the_end_is_closed_at_the_end() -> None:
    segments = segments_from_probabilities([0.0] * 5 + [0.9] * 15, threshold=0.5)
    assert len(segments) == 1
    assert segments[0].end_ms == 20 * FRAME_MS


def test_threshold_is_respected() -> None:
    probabilities = [0.6] * 20
    assert segments_from_probabilities(probabilities, threshold=0.5) != []
    assert segments_from_probabilities(probabilities, threshold=0.7) == []


def test_total_speech_sums_segment_durations() -> None:
    probabilities = [0.9] * 10 + [0.0] * 20 + [0.9] * 10 + [0.0] * 20
    segments = segments_from_probabilities(probabilities, threshold=0.5)
    assert total_speech_ms(segments) == sum(s.end_ms - s.start_ms for s in segments)
