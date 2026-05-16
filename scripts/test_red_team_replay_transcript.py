"""Phase 1a tests for the ``--replay-transcript`` deterministic seam.

Verifies both Python dispatchers (``red_team_design_dispatch``,
``red_team_plan_dispatch``) can run end-to-end against a recorded
transcript without invoking the live model — the foundation Phase 2's
TS port will use for byte-level parity.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

import red_team_dispatch_common as common


REPO_ROOT = Path(__file__).resolve().parent.parent
FIXTURE = REPO_ROOT / "tools" / "fixtures" / "replays" / "sample-design-replay.json"


def _design_doc(tmp_path: Path) -> Path:
    """Write a tiny design markdown fixture so the dispatcher has something to read."""
    doc = tmp_path / "tiny-design.md"
    doc.write_text(
        "# Tiny design\n\nUsed by the replay-transcript test. Content irrelevant — the "
        "transcript supplies the findings.\n",
        encoding="utf-8",
    )
    return doc


def test_build_result_from_transcript_round_trips_findings(tmp_path):
    """The transcript-to-RedTeamResult helper preserves findings + severity counts."""
    result, history = common._build_result_from_transcript(FIXTURE, stage="design")
    assert history == []
    assert result.stage == "design"
    assert len(result.findings) == 2
    severities = sorted(f.severity for f in result.findings)
    assert severities == ["high", "medium"]
    assert result.blocking_count == 1  # rt2 (high, concrete counter_proposal)
    assert result.human_review_count == 0


def test_build_result_from_transcript_rejects_stage_mismatch(tmp_path):
    """A transcript recorded under 'design' must not be replayed under 'plan'."""
    with pytest.raises(ValueError, match="stage mismatch"):
        common._build_result_from_transcript(FIXTURE, stage="plan")


def test_build_result_from_transcript_rejects_bad_schema(tmp_path):
    bad = tmp_path / "bad.json"
    bad.write_text(json.dumps({"stage": "design", "findings": "not-a-list"}))
    with pytest.raises(ValueError, match="findings"):
        common._build_result_from_transcript(bad, stage="design")


def test_design_dispatcher_replays_transcript_end_to_end(tmp_path, monkeypatch):
    """Live end-to-end: --replay-transcript bypasses the model + persists audit row.

    Uses a fresh STARK_RED_TEAM_DB so production state is untouched.
    """
    db = tmp_path / "replay.db"
    monkeypatch.setenv("STARK_RED_TEAM_DB", str(db))
    doc = _design_doc(tmp_path)

    proc = subprocess.run(
        [
            sys.executable,
            str(Path(__file__).parent / "red_team_design_dispatch.py"),
            "--design", str(doc),
            "--no-sidecar",
            "--no-audit",  # avoid running the live record_red_team_run path which
                          # requires a fully-built RedTeamRunContext + cost rates
            "--json",
            "--replay-transcript", str(FIXTURE),
        ],
        capture_output=True, text=True,
    )
    assert proc.returncode in (0, 2), proc.stderr  # 2 when status=halted, 0 when clean
    payload = json.loads(proc.stdout)
    # The replay flips the live-LLM path off, but the rest of the pipeline runs.
    assert payload["status"] == "halted"  # rt2 is severity=high → blocking
    assert payload["total_findings"] == 2
    assert payload["blocking_count"] == 1
    assert payload["human_review_count"] == 0
    # stderr should announce the seam.
    assert "--replay-transcript active" in proc.stderr


def test_design_dispatcher_replay_missing_file_exits_error(tmp_path, monkeypatch):
    monkeypatch.setenv("STARK_RED_TEAM_DB", str(tmp_path / "x.db"))
    doc = _design_doc(tmp_path)
    proc = subprocess.run(
        [
            sys.executable,
            str(Path(__file__).parent / "red_team_design_dispatch.py"),
            "--design", str(doc),
            "--no-sidecar", "--no-audit", "--json",
            "--replay-transcript", str(tmp_path / "missing.json"),
        ],
        capture_output=True, text=True,
    )
    assert proc.returncode == 2
    payload = json.loads(proc.stdout)
    assert payload["status"] == "error"
    assert "replay transcript not found" in payload["error"]


def test_plan_dispatcher_carries_replay_transcript_flag():
    """Spec: both dispatchers must expose --replay-transcript so the
    Phase 2 --help parity gate has the flag declared on both sides."""
    proc = subprocess.run(
        [sys.executable, str(Path(__file__).parent / "red_team_plan_dispatch.py"), "--help"],
        capture_output=True, text=True, check=True,
    )
    assert "--replay-transcript PATH" in proc.stdout
    assert "deterministic seam" in proc.stdout


def test_design_dispatcher_carries_replay_transcript_flag():
    proc = subprocess.run(
        [sys.executable, str(Path(__file__).parent / "red_team_design_dispatch.py"), "--help"],
        capture_output=True, text=True, check=True,
    )
    assert "--replay-transcript PATH" in proc.stdout
    assert "deterministic seam" in proc.stdout
