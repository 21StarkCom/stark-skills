#!/usr/bin/env python3
"""Tests for _run_graph_gate() in triage_orchestrator.py.

Coverage:
  - disabled mode: always skips subprocess, graph_blocked=False
  - shadow mode: runs subprocess, never blocks even on exit 1
  - blocking mode: exit 0 → not blocked, exit 1 → blocked, exit 2 → degraded
  - timeout degradation: graph_blocked=False, graph_error="timeout"
  - OSError degradation: graph_blocked=False, graph_error set
  - non-pr review types: always skipped regardless of mode
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parent))

from triage_orchestrator import _run_graph_gate


def _args(review_type: str = "pr", base: str = "main") -> argparse.Namespace:
    ns = argparse.Namespace()
    ns.review_type = review_type
    ns.base = base
    return ns


def _config(gate_mode: str) -> dict:
    return {"graph_gate_mode": gate_mode}


class _CompletedProcess:
    """Minimal subprocess.CompletedProcess stand-in for tests."""
    def __init__(self, returncode: int, stdout: str = "", stderr: str = "") -> None:
        self.returncode = returncode
        self.stdout = stdout
        self.stderr = stderr


def _completed(returncode: int, stdout: str = "", stderr: str = "") -> _CompletedProcess:
    return _CompletedProcess(returncode=returncode, stdout=stdout, stderr=stderr)


# ── disabled mode ────────────────────────────────────────────────────────────

class TestDisabledMode:
    def test_disabled_skips_subprocess(self):
        with patch("triage_orchestrator.subprocess.run") as mock_run:
            result = _run_graph_gate(_config("disabled"), _args())
        mock_run.assert_not_called()
        assert result["graph_blocked"] is False
        assert result["graph_mode"] == "disabled"
        assert result["graph_exit_code"] is None
        assert result["graph_error"] is None

    def test_disabled_for_non_pr_also_skips(self):
        with patch("triage_orchestrator.subprocess.run") as mock_run:
            result = _run_graph_gate(_config("disabled"), _args(review_type="design"))
        mock_run.assert_not_called()
        assert result["graph_blocked"] is False

    def test_default_mode_is_disabled(self):
        with patch("triage_orchestrator.subprocess.run") as mock_run:
            result = _run_graph_gate({}, _args())  # no graph_gate_mode key
        mock_run.assert_not_called()
        assert result["graph_blocked"] is False


# ── non-pr review types ──────────────────────────────────────────────────────

class TestNonPRReviewTypes:
    def test_shadow_skips_for_design(self):
        with patch("triage_orchestrator.subprocess.run") as mock_run:
            result = _run_graph_gate(_config("shadow"), _args(review_type="design"))
        mock_run.assert_not_called()
        assert result["graph_blocked"] is False

    def test_blocking_skips_for_plan(self):
        with patch("triage_orchestrator.subprocess.run") as mock_run:
            result = _run_graph_gate(_config("blocking"), _args(review_type="plan"))
        mock_run.assert_not_called()
        assert result["graph_blocked"] is False


# ── shadow mode ──────────────────────────────────────────────────────────────

class TestShadowMode:
    def test_shadow_exit_0_not_blocked(self):
        with patch("triage_orchestrator.subprocess.run", return_value=_completed(0)):
            result = _run_graph_gate(_config("shadow"), _args())
        assert result["graph_blocked"] is False
        assert result["graph_mode"] == "shadow"
        assert result["graph_exit_code"] == 0

    def test_shadow_exit_1_not_blocked(self):
        """Shadow mode must NEVER block, even when validation reports errors."""
        with patch("triage_orchestrator.subprocess.run", return_value=_completed(1)):
            result = _run_graph_gate(_config("shadow"), _args())
        assert result["graph_blocked"] is False
        assert result["graph_mode"] == "shadow"
        assert result["graph_exit_code"] == 1

    def test_shadow_exit_2_degrades(self):
        with patch("triage_orchestrator.subprocess.run", return_value=_completed(2)):
            result = _run_graph_gate(_config("shadow"), _args())
        assert result["graph_blocked"] is False
        assert result["graph_exit_code"] == 2
        assert result["graph_error"] == "graph_setup_error"

    def test_shadow_runs_validate_stage(self):
        with patch("triage_orchestrator.subprocess.run", return_value=_completed(0)) as mock_run:
            _run_graph_gate(_config("shadow"), _args())
        call_args = mock_run.call_args[0][0]
        assert "--stage" in call_args
        idx = call_args.index("--stage")
        assert call_args[idx + 1] == "validate"


# ── blocking mode ────────────────────────────────────────────────────────────

class TestBlockingMode:
    def test_blocking_exit_0_not_blocked(self):
        with patch("triage_orchestrator.subprocess.run", return_value=_completed(0)):
            result = _run_graph_gate(_config("blocking"), _args())
        assert result["graph_blocked"] is False
        assert result["graph_mode"] == "blocking"
        assert result["graph_exit_code"] == 0

    def test_blocking_exit_1_is_blocked(self):
        """Blocking mode must set graph_blocked=True on validation failure."""
        report = json.dumps({"errors": ["STALE: module.fn -> missing.target"], "warnings": []})
        with patch("triage_orchestrator.subprocess.run", return_value=_completed(1, stdout=report)):
            result = _run_graph_gate(_config("blocking"), _args())
        assert result["graph_blocked"] is True
        assert result["graph_mode"] == "blocking"
        assert result["graph_exit_code"] == 1
        assert result["graph_error"] is None

    def test_blocking_exit_1_no_json_stdout_still_blocked(self):
        """Exit 1 blocks even when stdout is not valid JSON."""
        with patch("triage_orchestrator.subprocess.run", return_value=_completed(1, stdout="not json")):
            result = _run_graph_gate(_config("blocking"), _args())
        assert result["graph_blocked"] is True

    def test_blocking_exit_2_degrades_not_blocked(self):
        """Exit 2 is a setup error — must degrade gracefully, not block."""
        with patch("triage_orchestrator.subprocess.run", return_value=_completed(2)):
            result = _run_graph_gate(_config("blocking"), _args())
        assert result["graph_blocked"] is False
        assert result["graph_exit_code"] == 2
        assert result["graph_error"] == "graph_setup_error"


# ── degradation paths ────────────────────────────────────────────────────────

class TestDegradation:
    def test_timeout_degrades(self):
        import subprocess
        with patch("triage_orchestrator.subprocess.run", side_effect=subprocess.TimeoutExpired("cmd", 60)):
            result = _run_graph_gate(_config("blocking"), _args())
        assert result["graph_blocked"] is False
        assert result["graph_exit_code"] is None
        assert result["graph_error"] == "timeout"

    def test_os_error_degrades(self):
        with patch("triage_orchestrator.subprocess.run", side_effect=OSError("no such file")):
            result = _run_graph_gate(_config("blocking"), _args())
        assert result["graph_blocked"] is False
        assert result["graph_exit_code"] is None
        assert "no such file" in result["graph_error"]

    def test_shadow_timeout_also_degrades(self):
        import subprocess
        with patch("triage_orchestrator.subprocess.run", side_effect=subprocess.TimeoutExpired("cmd", 60)):
            result = _run_graph_gate(_config("shadow"), _args())
        assert result["graph_blocked"] is False
        assert result["graph_error"] == "timeout"


# ── config kill switch ────────────────────────────────────────────────────────

class TestConfigKillSwitch:
    def test_kill_switch_disabled_overrides_all(self):
        """Setting graph_gate_mode=disabled must always skip the gate."""
        with patch("triage_orchestrator.subprocess.run") as mock_run:
            for mode in ("disabled",):
                result = _run_graph_gate({"graph_gate_mode": mode}, _args())
                assert result["graph_blocked"] is False
        mock_run.assert_not_called()
