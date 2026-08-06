"""NDJSON request/response protocol shared with the TypeScript daemon.

One JSON object per line. Requests arrive on stdin, responses leave on stdout.
stderr carries human-readable logs and is never parsed by the daemon, so it is
safe for library warnings and progress output.
"""

from __future__ import annotations

import json
import sys
from dataclasses import dataclass
from typing import Any, Final, Literal, TextIO

PROTOCOL_VERSION: Final = "1"

ErrorCode = Literal[
    "bad_request",
    "model_not_loaded",
    "model_load_failed",
    "audio_unreadable",
    "transcribe_failed",
    "vad_failed",
    # The Silero model is not installed at all, as opposed to a frame that
    # failed to score. The daemon reports it differently: one is a missing
    # install the user can fix, the other is a transient error.
    "vad_unavailable",
    # Same distinction for diarization: models missing (fixable by the user)
    # versus a run that failed.
    "diarization_unavailable",
    "diarization_failed",
    "internal",
]


@dataclass(frozen=True, slots=True)
class Request:
    id: str
    op: str
    payload: dict[str, Any]

    @staticmethod
    def parse(line: str) -> Request:
        raw = json.loads(line)
        if not isinstance(raw, dict):
            raise ValueError("request must be a JSON object")
        request_id = raw.get("id")
        op = raw.get("op")
        if not isinstance(request_id, str) or not isinstance(op, str):
            raise ValueError('request must carry string "id" and "op"')
        payload = {k: v for k, v in raw.items() if k not in ("id", "op")}
        return Request(id=request_id, op=op, payload=payload)


def ok(request_id: str, op: str, **fields: Any) -> dict[str, Any]:
    return {"id": request_id, "ok": True, "op": op, **fields}


def error(request_id: str, code: ErrorCode, message: str) -> dict[str, Any]:
    return {"id": request_id, "ok": False, "code": code, "error": message}


def write_response(stream: TextIO, response: dict[str, Any]) -> None:
    """Writes one NDJSON line and flushes.

    Flushing every line matters: the daemon blocks on a response, and a buffered
    reply would look like a hung worker.
    """
    stream.write(json.dumps(response, ensure_ascii=False, separators=(",", ":")))
    stream.write("\n")
    stream.flush()


def log(message: str) -> None:
    """Human-readable logging. Never goes to stdout, which is protocol-only."""
    print(message, file=sys.stderr, flush=True)
