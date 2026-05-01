"""Tests for red_team_plan_dispatch.py."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

import red_team_dispatch_common as common
import red_team_plan_dispatch as dispatch
import stark_red_team as rt


def _result() -> rt.RedTeamResult:
    return rt.RedTeamResult(
        stage="plan",
        round_num=1,
        synthesis="Plan is clean.",
        findings=[],
        blocking_count=0,
        human_review_count=0,
        raw_output='{"findings":[]}',
        duration_s=1.0,
        cost_usd=0.1,
        error=None,
        input_tokens=10,
        output_tokens=5,
    )


def test_plan_render_sidecar_uses_plan_label(tmp_path: Path):
    plan = tmp_path / "plan.md"
    plan.write_text("# Plan")
    md = dispatch.render_sidecar_markdown(
        plan_path=plan,
        source_spec_path=None,
        result=_result(),
        model="gpt-5.5-pro",
        run_id="manual-abc",
    )
    assert "# Red-team review — plan.md" in md
    assert "plan used as its own spec" in md


def test_plan_run_dispatch_delegates_shared_stage(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    plan = tmp_path / "plan.md"
    plan.write_text("# Plan")
    captured: dict[str, object] = {}

    def fake_execute(**kwargs):
        captured.update(kwargs)
        return {"status": "clean", "run_id": "manual-abc"}

    monkeypatch.setattr(dispatch, "execute_dispatch", fake_execute)
    out = dispatch.run_dispatch(
        plan_path=plan,
        source_spec_path=None,
        model_override=None,
        write_sidecar=False,
        audit=False,
        cwd=None,
        enable_fix_plan_for_calibration=True,
    )
    assert out["status"] == "clean"
    assert captured["stage"] == "plan"
    assert captured["artifact_path"] == plan
    assert captured["enable_fix_plan_for_calibration"] is True


def test_plan_main_json_output(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys):
    plan = tmp_path / "plan.md"
    plan.write_text("# Plan")
    monkeypatch.setattr(
        dispatch,
        "run_dispatch",
        lambda **_: {
            "status": "clean",
            "run_id": "manual-abc",
            "model": "gpt-5.5-pro",
            "sidecar_path": None,
            "total_findings": 0,
            "blocking_count": 0,
            "human_review_count": 0,
            "cost_usd": 0.0,
            "duration_s": 0.0,
        },
    )
    rc = dispatch.main(["--plan", str(plan), "--no-sidecar", "--no-audit", "--json"])
    assert rc == 0
    assert json.loads(capsys.readouterr().out)["run_id"] == "manual-abc"


def test_plan_exports_shared_truncate_helper():
    assert dispatch.truncate_pr_comment("short", None) == common.truncate_pr_comment("short", None)
