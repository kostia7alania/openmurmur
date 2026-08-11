"""Speaker diarization — separating voices, not identifying people.

Two ONNX models, both free of gating and together about 44 MB: pyannote
segmentation (who is speaking when) and a 3D-Speaker embedding extractor (which
of those stretches sound like the same voice), clustered into speakers.

Everything runs through onnxruntime, which is already a dependency because
Silero VAD uses it. No torch, no Hugging Face token, nothing to accept.

**Why the speaker count is capped.** Left to decide for itself on real
far-field room audio, the clustering over-counts badly — measured on a
two-minute recording of a two-person conversation it reported anywhere from 4
to 15 distinct speakers depending on the threshold. Capping the number of
clusters fixes it: the same recording at a cap of 3 produced three voices and
three speaker changes, against five voices and eight changes unconstrained.
The segmentation was never the problem; the clustering was.

That is also why the labels are "voice 1", "voice 2". This tells apart *voices*
in one recording, and says nothing about who they belong to, or whether voice 1
in this session is voice 1 in the next.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from openmurmur_audio.audio import SAMPLE_RATE, FloatArray

SEGMENTATION_FILENAME = "sherpa-onnx-pyannote-segmentation-3-0/model.onnx"
EMBEDDING_FILENAME = "3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx"

# Tuned on real room audio; see the module docstring.
DEFAULT_MAX_SPEAKERS = 3
DEFAULT_MIN_TURN_SECONDS = 1.0
DEFAULT_THRESHOLD = 0.8


@dataclass(frozen=True, slots=True)
class SpeakerTurn:
    start_ms: int
    end_ms: int
    speaker: int


class DiarizationUnavailableError(Exception):
    """Raised when sherpa-onnx or the ONNX models are not installed."""


def models_dir() -> Path:
    """Where the models live.

    `OPENMURMUR_MODELS_DIR` wins so the daemon can point the worker at its own
    state directory; otherwise the conventional location is used.
    """
    override = os.environ.get("OPENMURMUR_MODELS_DIR")
    if override:
        return Path(override)
    return Path.home() / "Library" / "Application Support" / "OpenMurmur" / "models"


def find_models() -> tuple[Path, Path]:
    base = models_dir()
    segmentation = base / SEGMENTATION_FILENAME
    embedding = base / EMBEDDING_FILENAME

    missing = [p for p in (segmentation, embedding) if not p.is_file()]
    if missing:
        raise DiarizationUnavailableError(
            "The speaker diarization models are not installed.\n"
            f"Missing: {', '.join(str(p) for p in missing)}\n"
            "Fetch them once (about 44 MB, no account or token needed):\n"
            "  ./scripts/fetch-diarization-models\n"
            "Or turn it off with diarization.enabled = false in the config."
        )
    return segmentation, embedding


class Diarizer:
    """Holds the loaded ONNX pipeline for one clustering configuration.

    sherpa-onnx bakes the cluster count into the config, so a different cap
    means a different pipeline. Recordings vary, so the instance is cached per
    cap rather than per process.
    """

    def __init__(self) -> None:
        self._cache: dict[tuple[int, float, float], Any] = {}

    def _pipeline(self, max_speakers: int, min_turn_seconds: float, threshold: float) -> Any:
        key = (max_speakers, min_turn_seconds, threshold)
        cached = self._cache.get(key)
        if cached is not None:
            return cached

        try:
            import sherpa_onnx
        except ImportError as exc:
            raise DiarizationUnavailableError(
                "sherpa-onnx is not installed.\n"
                "Install the local model stack:\n"
                "  /usr/bin/env -u UV_PROJECT_ENVIRONMENT \\\n"
                "    uv sync --project python/openmurmur_audio --extra mlx"
            ) from exc

        segmentation, embedding = find_models()
        config = sherpa_onnx.OfflineSpeakerDiarizationConfig(
            segmentation=sherpa_onnx.OfflineSpeakerSegmentationModelConfig(
                pyannote=sherpa_onnx.OfflineSpeakerSegmentationPyannoteModelConfig(
                    model=str(segmentation)
                ),
            ),
            embedding=sherpa_onnx.SpeakerEmbeddingExtractorConfig(model=str(embedding)),
            # A positive cluster count caps the speakers; the threshold only
            # applies when the count is left free, which we never do.
            clustering=sherpa_onnx.FastClusteringConfig(
                num_clusters=max_speakers, threshold=threshold
            ),
            min_duration_on=min_turn_seconds,
            min_duration_off=0.5,
        )
        if not config.validate():
            raise DiarizationUnavailableError(
                "sherpa-onnx rejected the diarization configuration; "
                "the model files are probably corrupt. Re-run "
                "./scripts/fetch-diarization-models"
            )

        pipeline = sherpa_onnx.OfflineSpeakerDiarization(config)
        if pipeline.sample_rate != SAMPLE_RATE:
            raise DiarizationUnavailableError(
                f"the segmentation model expects {pipeline.sample_rate} Hz, "
                f"but OpenMurmur normalizes to {SAMPLE_RATE} Hz"
            )
        self._cache[key] = pipeline
        return pipeline

    def diarize(
        self,
        samples: FloatArray,
        *,
        max_speakers: int = DEFAULT_MAX_SPEAKERS,
        min_turn_seconds: float = DEFAULT_MIN_TURN_SECONDS,
        threshold: float = DEFAULT_THRESHOLD,
    ) -> list[SpeakerTurn]:
        if max_speakers < 1:
            raise ValueError("max_speakers must be at least 1")

        pipeline = self._pipeline(max_speakers, min_turn_seconds, threshold)
        result = pipeline.process(samples).sort_by_start_time()
        return [
            SpeakerTurn(
                start_ms=int(turn.start * 1000),
                end_ms=int(turn.end * 1000),
                speaker=int(turn.speaker),
            )
            for turn in result
        ]


def assign_speaker(
    start_ms: int | None,
    end_ms: int | None,
    turns: list[SpeakerTurn],
) -> int | None:
    """Which speaker a transcript segment belongs to, by overlap.

    Longest overlap wins. A segment with no timestamps, or one that falls
    entirely in a gap between turns, gets no speaker rather than the nearest
    guess — an unlabelled line is honest, a wrongly attributed one is not.
    """
    if start_ms is None:
        return None
    finish = end_ms if end_ms is not None else start_ms

    best_speaker: int | None = None
    best_overlap = 0
    for turn in turns:
        overlap = min(finish, turn.end_ms) - max(start_ms, turn.start_ms)
        if overlap > best_overlap:
            best_overlap = overlap
            best_speaker = turn.speaker
    return best_speaker


def speaker_count(turns: list[SpeakerTurn]) -> int:
    return len({turn.speaker for turn in turns})
