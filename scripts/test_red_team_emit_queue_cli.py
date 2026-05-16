"""Phase-1a live tests for ``red_team_emit_queue_cli``.

Hits the real SQLite queue via ``STARK_QUEUE_DIR=<tmp>`` so each test gets a
clean queue without touching the operator's ``~/.stark-insights/queue.db``.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest


CLI = Path(__file__).parent / "red_team_emit_queue_cli.py"


def _cli(*args: str, env: dict | None = None, stdin: str | None = None) -> subprocess.CompletedProcess:
    full_env = os.environ.copy()
    if env:
        full_env.update(env)
    return subprocess.run(
        [sys.executable, str(CLI), *args],
        env=full_env,
        input=stdin,
        capture_output=True,
        text=True,
    )


@pytest.fixture
def queue_dir(tmp_path, monkeypatch):
    """Isolate STARK_QUEUE_DIR for subprocess calls only.

    The CLI itself runs in a fresh Python interpreter (via subprocess), so
    setting the env var here propagates correctly without needing to
    re-import the in-process ``emit_queue`` module. Re-importing would
    break other tests that have already monkeypatched the in-process
    instance (notably ``test_red_team_insights``), so we deliberately
    avoid touching ``sys.modules``.
    """
    qdir = tmp_path / "queue"
    qdir.mkdir()
    monkeypatch.setenv("STARK_QUEUE_DIR", str(qdir))
    return qdir


def test_enqueue_via_stdin_returns_event_id_and_dedupe_key(queue_dir):
    proc = _cli(
        "enqueue", "--type", "red_team_run",
        env={"STARK_QUEUE_DIR": str(queue_dir)},
        stdin=json.dumps({"run_id": "r-1", "stage": "design"}),
    )
    assert proc.returncode == 0, proc.stderr
    payload = json.loads(proc.stdout)
    assert payload["ok"] is True
    assert payload["type"] == "red_team_run"
    assert payload["duplicate"] is False
    assert isinstance(payload["event_id"], str) and payload["event_id"]
    assert isinstance(payload["dedupe_key"], str) and payload["dedupe_key"]


def test_enqueue_idempotent_on_dedupe_key(queue_dir):
    common_args = [
        "enqueue", "--type", "red_team_run", "--dedupe-key", "dup-key-42",
    ]
    env = {"STARK_QUEUE_DIR": str(queue_dir)}
    first = _cli(*common_args, env=env, stdin=json.dumps({"foo": "bar"}))
    second = _cli(*common_args, env=env, stdin=json.dumps({"foo": "baz"}))
    assert first.returncode == 0 and second.returncode == 0
    first_env = json.loads(first.stdout)
    second_env = json.loads(second.stdout)
    assert first_env["duplicate"] is False
    assert second_env["duplicate"] is True
    assert second_env["dedupe_key"] == "dup-key-42"


def test_enqueue_supports_full_envelope_in_stdin(queue_dir):
    proc = _cli(
        "enqueue",
        env={"STARK_QUEUE_DIR": str(queue_dir)},
        stdin=json.dumps({
            "type": "red_team_finding",
            "dedupe_key": "envelope-form",
            "payload": {"run_id": "envelope-1", "finding_id": "f1"},
        }),
    )
    assert proc.returncode == 0, proc.stderr
    payload = json.loads(proc.stdout)
    assert payload["dedupe_key"] == "envelope-form"
    assert payload["type"] == "red_team_finding"


def test_enqueue_rejects_missing_type(queue_dir):
    proc = _cli(
        "enqueue",
        env={"STARK_QUEUE_DIR": str(queue_dir)},
        stdin=json.dumps({"foo": "bar"}),
    )
    assert proc.returncode == 2
    assert json.loads(proc.stdout)["error"] == "missing_type"


def test_enqueue_rejects_invalid_type(queue_dir):
    proc = _cli(
        "enqueue", "--type", "not_a_real_event_type",
        env={"STARK_QUEUE_DIR": str(queue_dir)},
        stdin=json.dumps({"foo": "bar"}),
    )
    assert proc.returncode == 2
    assert json.loads(proc.stdout)["error"] == "validation_failed"


def test_peek_returns_pending_rows(queue_dir):
    env = {"STARK_QUEUE_DIR": str(queue_dir)}
    _cli("enqueue", "--type", "red_team_run",
         env=env, stdin=json.dumps({"foo": "first"}))
    _cli("enqueue", "--type", "red_team_run",
         env=env, stdin=json.dumps({"foo": "second"}))
    proc = _cli("peek", env=env)
    assert proc.returncode == 0, proc.stderr
    payload = json.loads(proc.stdout)
    assert payload["count"] == 2
    assert payload["source"] == "pending"
    types = [row["event"]["type"] for row in payload["rows"]]
    assert types == ["red_team_run", "red_team_run"]


def test_peek_respects_limit(queue_dir):
    env = {"STARK_QUEUE_DIR": str(queue_dir)}
    for i in range(5):
        _cli("enqueue", "--type", "red_team_run",
             env=env, stdin=json.dumps({"i": i}))
    proc = _cli("peek", "--limit", "2", env=env)
    assert proc.returncode == 0, proc.stderr
    assert json.loads(proc.stdout)["count"] == 2


def test_peek_dead_letter_source(queue_dir):
    env = {"STARK_QUEUE_DIR": str(queue_dir)}
    _cli("enqueue", "--type", "red_team_run", "--dedupe-key", "to-dl",
         env=env, stdin=json.dumps({"foo": "bar"}))
    _cli("dead-letter", "--dedupe-key", "to-dl", "--reason", "test-dlq",
         env=env)
    proc = _cli("peek", "--source", "dead-letter", env=env)
    assert proc.returncode == 0
    payload = json.loads(proc.stdout)
    assert payload["count"] == 1
    assert payload["rows"][0]["last_error"] == "test-dlq"


def test_mark_done_removes_pending_row_and_is_idempotent(queue_dir):
    env = {"STARK_QUEUE_DIR": str(queue_dir)}
    enq = _cli("enqueue", "--type", "red_team_run", "--dedupe-key", "done-key",
               env=env, stdin=json.dumps({"foo": "bar"}))
    event_id = json.loads(enq.stdout)["event_id"]
    first = _cli("mark-done", "--event-id", event_id, env=env)
    assert json.loads(first.stdout)["removed"] == 1
    second = _cli("mark-done", "--event-id", event_id, env=env)
    second_env = json.loads(second.stdout)
    assert second_env["removed"] == 0
    assert second_env["already_done"] is True


def test_mark_done_requires_an_identifier(queue_dir):
    proc = _cli("mark-done", env={"STARK_QUEUE_DIR": str(queue_dir)})
    assert proc.returncode == 2
    assert json.loads(proc.stdout)["error"] == "missing_id"


def test_dead_letter_moves_row_and_is_idempotent(queue_dir):
    env = {"STARK_QUEUE_DIR": str(queue_dir)}
    _cli("enqueue", "--type", "red_team_run", "--dedupe-key", "dl-target",
         env=env, stdin=json.dumps({"foo": "bar"}))
    first = _cli("dead-letter", "--dedupe-key", "dl-target", "--reason", "first",
                 env=env)
    assert json.loads(first.stdout)["moved"] == 1
    second = _cli("dead-letter", "--dedupe-key", "dl-target", "--reason", "second",
                  env=env)
    sec_env = json.loads(second.stdout)
    assert sec_env["moved"] == 0
    assert sec_env["already_dead_lettered"] is True


# ── Stdout discipline ──────────────────────────────────────────────────


def test_stdout_discipline_one_json_envelope(queue_dir):
    """Every subcommand emits exactly one JSON value on stdout."""
    env = {"STARK_QUEUE_DIR": str(queue_dir)}
    for args, stdin in [
        (["enqueue", "--type", "red_team_run"], json.dumps({"foo": "bar"})),
        (["peek"], None),
        (["mark-done", "--dedupe-key", "no-such"], None),
        (["dead-letter", "--dedupe-key", "no-such"], None),
    ]:
        proc = _cli(*args, env=env, stdin=stdin)
        assert proc.returncode == 0, f"{args}: {proc.stderr}"
        # Parses cleanly + stripping the canonical re-stringification leaves
        # nothing but optional trailing whitespace.
        parsed = json.loads(proc.stdout)
        canonical = json.dumps(parsed, separators=(",", ":"), sort_keys=True)
        assert proc.stdout.replace(canonical, "", 1).strip() == ""
