"""Segment assembly from VAD probabilities. Pure logic — no ONNX model needed."""

from __future__ import annotations

import importlib.util

import pytest

from openmurmur_audio.vad import FRAME_MS, segments_from_probabilities, total_speech_ms

# The tests below need the optional `mlx` extra (real model weights / ONNX).
# CI deliberately installs only the CI-safe subset, so they skip there rather
# than failing — see docs/adr/0002-python-runtime.md.
requires_local_models = pytest.mark.skipif(
    importlib.util.find_spec("silero_vad") is None,
    reason="requires the optional `mlx` extra: uv sync --extra mlx",
)


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


@requires_local_models
def test_model_path_points_at_a_real_onnx_file() -> None:
    """The silero_vad package exposes no path helper, so we resolve it ourselves.

    Written after `get_model_path` turned out not to exist in silero-vad 6.2.1.
    """
    from openmurmur_audio.vad import find_model_path

    path = find_model_path()
    assert path.is_file()
    assert path.suffix == ".onnx"


@requires_local_models
def test_real_silero_model_rejects_noise_and_tones() -> None:
    """The distinction an energy gate cannot make, verified against the model."""
    import numpy as np

    from openmurmur_audio.vad import FRAME_SAMPLES, SileroVad

    vad = SileroVad()
    vad.load()

    def mean_probability(signal: np.ndarray) -> float:
        vad.reset()
        frames = len(signal) // FRAME_SAMPLES
        return float(
            np.mean(
                [
                    vad.probability(signal[i * FRAME_SAMPLES : (i + 1) * FRAME_SAMPLES])
                    for i in range(frames)
                ]
            )
        )

    n = 16_000
    rng = np.random.default_rng(0)
    silence = np.zeros(n, dtype=np.float32)
    noise = (rng.standard_normal(n) * 0.05).astype(np.float32)
    tone = (np.sin(2 * np.pi * 440 * np.arange(n) / 16_000) * 0.4).astype(np.float32)

    for label, signal in (("silence", silence), ("noise", noise), ("tone", tone)):
        assert mean_probability(signal) < 0.2, f"{label} was classified as speech"
