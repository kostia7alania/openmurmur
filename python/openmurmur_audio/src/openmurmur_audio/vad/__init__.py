"""Streaming Silero VAD.

Silero is what separates *speech* from a fan, traffic, music or a television —
the distinction the whole sessionizer depends on. An energy gate cannot make it,
which is why the TypeScript `EnergyVad` is only ever used for `capture test`.

The model is stateful across frames (it carries an LSTM hidden state), so a
single instance must be reset between unrelated audio streams.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np

from openmurmur_audio.audio import SAMPLE_RATE, FloatArray, iter_frames

# Silero v5+ requires exactly 512 samples at 16 kHz (32 ms).
FRAME_SAMPLES = 512
FRAME_MS = FRAME_SAMPLES * 1000 // SAMPLE_RATE


@dataclass(frozen=True, slots=True)
class SpeechSegment:
    start_ms: int
    end_ms: int
    mean_probability: float


class SileroModelMissingError(Exception):
    """Raised when the Silero ONNX model is not installed."""


def find_model_path() -> Path:
    """Locates the Silero ONNX model shipped inside the `silero_vad` package.

    The package exposes no path helper, so the file is resolved from the
    package directory. We deliberately load the ONNX graph with onnxruntime
    rather than going through `silero_vad`'s own loader, which would drag in
    torch on every call.
    """
    try:
        import silero_vad
    except ImportError as exc:
        raise SileroModelMissingError(
            "silero-vad is not installed.\n"
            "Install the local model stack:\n"
            "  /usr/bin/env -u UV_PROJECT_ENVIRONMENT \\\n"
            "    uv sync --project python/openmurmur_audio --extra mlx\n"
            "Without it the daemon can still run with the fake adapters, but it "
            "cannot detect speech."
        ) from exc

    data_dir = Path(silero_vad.__file__).parent / "data"
    # Prefer the 16 kHz-specific graph; fall back to the general one.
    for name in ("silero_vad_16k_op15.onnx", "silero_vad.onnx"):
        candidate = data_dir / name
        if candidate.is_file():
            return candidate

    raise SileroModelMissingError(
        f"silero-vad is installed but no ONNX model was found in {data_dir}. "
        "Reinstall it with: /usr/bin/env -u UV_PROJECT_ENVIRONMENT "
        "uv sync --project python/openmurmur_audio --extra mlx"
    )


class SileroVad:
    """Thin wrapper over the Silero ONNX model with explicit state handling."""

    def __init__(self) -> None:
        self._state: np.ndarray | None = None
        self._context: np.ndarray | None = None
        # onnxruntime ships no precise public type for a session.
        self._session: Any = None

    def load(self) -> None:
        if self._session is not None:
            return
        import onnxruntime as ort

        model_path = find_model_path()

        options = ort.SessionOptions()
        # One thread: the daemon may run several jobs, and oversubscribing the
        # CPU here starves the recorder, which must never fall behind.
        options.inter_op_num_threads = 1
        options.intra_op_num_threads = 1
        self._session = ort.InferenceSession(
            str(model_path), sess_options=options, providers=["CPUExecutionProvider"]
        )
        self.reset()

    def reset(self) -> None:
        self._state = np.zeros((2, 1, 128), dtype=np.float32)
        self._context = np.zeros((1, 64), dtype=np.float32)

    def probability(self, frame: FloatArray) -> float:
        if self._session is None:
            raise RuntimeError("SileroVad.load() must be called first")
        if len(frame) != FRAME_SAMPLES:
            raise ValueError(f"expected {FRAME_SAMPLES} samples, got {len(frame)}")

        assert self._state is not None
        assert self._context is not None

        # Silero v5 prepends 64 samples of context from the previous frame.
        chunk = np.concatenate([self._context, frame.reshape(1, -1)], axis=1).astype(np.float32)
        outputs = self._session.run(
            None,
            {
                "input": chunk,
                "state": self._state,
                "sr": np.array(SAMPLE_RATE, dtype=np.int64),
            },
        )
        probability = float(outputs[0].item())
        self._state = outputs[1]
        self._context = frame.reshape(1, -1)[:, -64:]
        return probability


def segments_from_probabilities(
    probabilities: list[float],
    threshold: float,
    frame_ms: int = FRAME_MS,
    min_silence_ms: int = 300,
) -> list[SpeechSegment]:
    """Collapses per-frame probabilities into speech segments.

    `min_silence_ms` bridges the natural gaps inside a sentence so that ordinary
    pauses between words do not shred one utterance into a dozen segments.
    """
    segments: list[SpeechSegment] = []
    start: int | None = None
    run: list[float] = []
    silence_run = 0
    bridge_frames = max(1, min_silence_ms // frame_ms)

    for index, probability in enumerate(probabilities):
        if probability >= threshold:
            if start is None:
                start = index
                run = []
            run.append(probability)
            silence_run = 0
            continue

        if start is None:
            continue

        silence_run += 1
        if silence_run < bridge_frames:
            run.append(probability)
            continue

        end = index - silence_run + 1
        segments.append(
            SpeechSegment(
                start_ms=start * frame_ms,
                end_ms=end * frame_ms,
                mean_probability=float(np.mean(run)) if run else 0.0,
            )
        )
        start = None
        silence_run = 0
        run = []

    if start is not None:
        segments.append(
            SpeechSegment(
                start_ms=start * frame_ms,
                end_ms=len(probabilities) * frame_ms,
                mean_probability=float(np.mean(run)) if run else 0.0,
            )
        )
    return segments


def analyze(samples: FloatArray, vad: SileroVad, threshold: float) -> list[SpeechSegment]:
    vad.reset()
    probabilities = [vad.probability(frame) for frame in iter_frames(samples, FRAME_SAMPLES)]
    return segments_from_probabilities(probabilities, threshold)


def total_speech_ms(segments: list[SpeechSegment]) -> int:
    return sum(segment.end_ms - segment.start_ms for segment in segments)
