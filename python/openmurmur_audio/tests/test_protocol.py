"""Protocol framing and worker dispatch, with no model and no audio device."""

from __future__ import annotations

import io
import json

import pytest

from openmurmur_audio.protocol import Request, error, ok, write_response
from openmurmur_audio.worker import Worker


def test_parses_a_well_formed_request() -> None:
    request = Request.parse('{"id":"abc","op":"transcribe","path":"/tmp/a.wav"}')
    assert request.id == "abc"
    assert request.op == "transcribe"
    assert request.payload == {"path": "/tmp/a.wav"}


@pytest.mark.parametrize(
    "line",
    [
        "not json",
        "[]",
        '{"op":"ping"}',
        '{"id":"abc"}',
        '{"id":1,"op":"ping"}',
    ],
)
def test_rejects_malformed_requests(line: str) -> None:
    with pytest.raises((ValueError, TypeError)):
        Request.parse(line)


def test_responses_are_single_ndjson_lines() -> None:
    stream = io.StringIO()
    write_response(stream, ok("id-1", "ping", worker_version="0.1.0"))
    write_response(stream, error("id-2", "bad_request", "nope"))

    lines = stream.getvalue().splitlines()
    assert len(lines) == 2
    assert json.loads(lines[0]) == {
        "id": "id-1",
        "ok": True,
        "op": "ping",
        "worker_version": "0.1.0",
    }
    assert json.loads(lines[1])["ok"] is False


def test_response_keeps_unicode_readable() -> None:
    """Cyrillic and Thai must survive the wire as themselves, not as \\uXXXX."""
    stream = io.StringIO()
    write_response(stream, ok("i", "transcribe", text="привет สวัสดี"))
    assert "привет สวัสดี" in stream.getvalue()


def test_ping_needs_no_model() -> None:
    response = Worker().handle(Request.parse('{"id":"p","op":"ping"}'))
    assert response["ok"] is True
    assert response["op"] == "ping"


def test_unknown_operation_is_an_error_not_a_crash() -> None:
    response = Worker().handle(Request.parse('{"id":"x","op":"rm -rf /"}'))
    assert response["ok"] is False
    assert response["code"] == "bad_request"


def test_transcribe_without_a_path_is_rejected() -> None:
    response = Worker().handle(Request.parse('{"id":"x","op":"transcribe"}'))
    assert response["ok"] is False
    assert response["code"] == "bad_request"


def test_transcribe_of_a_missing_file_reports_audio_unreadable() -> None:
    response = Worker().handle(
        Request.parse('{"id":"x","op":"transcribe","path":"/nonexistent/nope.wav"}')
    )
    assert response["ok"] is False
    assert response["code"] == "audio_unreadable"
