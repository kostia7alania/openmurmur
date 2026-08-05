"""Audio loading helpers.

Everything downstream (Silero VAD, Qwen3-ASR) wants 16 kHz mono float32 in
[-1, 1]. Conversion happens once, here.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import numpy.typing as npt

SAMPLE_RATE = 16_000

FloatArray = npt.NDArray[np.float32]


class AudioError(Exception):
    """Raised when a file cannot be read as usable audio."""


def load_mono_16k(path: str | Path) -> FloatArray:
    """Reads an audio file as 16 kHz mono float32.

    The daemon normalizes with ffmpeg before calling, so this is a validation
    step rather than a resampler: a file that is not already 16 kHz mono means
    the caller skipped normalization, and failing loudly is better than silently
    transcribing resampled-by-accident audio.
    """
    import soundfile as sf

    try:
        data, rate = sf.read(str(path), dtype="float32", always_2d=True)
    except Exception as exc:  # every decode failure is the same to the caller
        raise AudioError(f"could not read {path}: {exc}") from exc

    if data.size == 0:
        raise AudioError(f"{path} contains no audio samples")

    mono: FloatArray = data.mean(axis=1).astype(np.float32) if data.shape[1] > 1 else data[:, 0]

    if rate != SAMPLE_RATE:
        raise AudioError(
            f"{path} is {rate} Hz; OpenMurmur normalizes to {SAMPLE_RATE} Hz before transcription"
        )
    return mono


def frame_count(samples: FloatArray, frame_size: int) -> int:
    return len(samples) // frame_size


def iter_frames(samples: FloatArray, frame_size: int) -> list[FloatArray]:
    """Splits into fixed-size frames, dropping a trailing partial frame.

    Silero requires exactly `frame_size` samples per call; a short final frame
    would be zero-padded into a false silence reading.
    """
    total = frame_count(samples, frame_size)
    return [samples[i * frame_size : (i + 1) * frame_size] for i in range(total)]


def duration_ms(samples: FloatArray) -> int:
    return round(len(samples) / SAMPLE_RATE * 1000)


def pcm16_to_float(raw: bytes) -> FloatArray:
    """Converts signed 16-bit little-endian PCM to float32 in [-1, 1].

    This is the format ffmpeg writes on the live capture pipe, so it is the
    entry point for streaming VAD. Dividing by 32768 rather than 32767 keeps
    the mapping exact for the negative full-scale sample.
    """
    if len(raw) % 2 != 0:
        raise AudioError(f"pcm payload of {len(raw)} bytes is not a whole number of samples")
    return (np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0).astype(np.float32)
