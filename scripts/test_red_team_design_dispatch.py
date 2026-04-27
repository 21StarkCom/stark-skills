"""Tests for red_team_design_dispatch.py."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

import red_team_design_dispatch as dispatch
import stark_red_team as rt


def _fake_result(
    *,
    findings: list[rt.RedTeamFinding] | None = None,
    error: str | None = None,
    blocking: int = 0,
    human_review: int = 0,
    synthesis: str = "",
) -> rt.RedTeamResult:
    return rt.RedTeamResult(
        stage="design",
        round_num=1,
        synthesis=synthesis,
        findings=findings or [],
        blocking_count=blocking,
        human_review_count=human_review,
        raw_output="{}",
        duration_s=12.3,
        cost_usd=0.4567,
        error=error,
        input_tokens=100,
        output_tokens=50,
    )


def _finding(
    *,
    fid: str = "rt1",
    persona: str = "security-trust",
    severity: str = "high",
    counter: str = "Use X instead.",
    trade_off: str | None = "Slightly slower.",
    reason: str | None = None,
) -> rt.RedTeamFinding:
    return rt.RedTeamFinding(
        id=fid,
        persona=persona,
        severity=severity,
        concern="Concern text.",
        consequence="Bad outcome.",
        counter_proposal=counter,
        trade_off=trade_off,
        reason_for_uncertainty=reason,
    )


def test_final_status_clean():
    r = _fake_result()
    assert dispatch._final_status(r) == "clean"


def test_final_status_halted_blocking():
    r = _fake_result(blocking=2)
    assert dispatch._final_status(r) == "halted"


def test_final_status_halted_human_review():
    r = _fake_result(human_review=1)
    assert dispatch._final_status(r) == "halted_human_review"


def test_final_status_human_review_takes_precedence_over_blocking():
    r = _fake_result(blocking=2, human_review=1)
    assert dispatch._final_status(r) == "halted_human_review"


def test_final_status_error():
    r = _fake_result(error="boom")
    assert dispatch._final_status(r) == "error"


def test_render_sidecar_no_findings(tmp_path: Path):
    design = tmp_path / "design.md"
    design.write_text("# Design")
    md = dispatch.render_sidecar_markdown(
        design_path=design,
        source_spec_path=None,
        result=_fake_result(synthesis="All looks fine."),
        model="gpt-5.5-pro",
        run_id="manual-abc",
    )
    assert "# Red-team review — design.md" in md
    assert "**Model:** `gpt-5.5-pro`" in md
    assert "**Status:** **clean**" in md
    assert "_No findings._" in md
    assert "All looks fine." in md
    assert "design used as its own spec" in md


def test_render_sidecar_with_findings_sorted_by_severity(tmp_path: Path):
    design = tmp_path / "design.md"
    design.write_text("# Design")
    findings = [
        _finding(fid="rt-medium", severity="medium"),
        _finding(fid="rt-critical", severity="critical"),
        _finding(fid="rt-high", severity="high"),
    ]
    md = dispatch.render_sidecar_markdown(
        design_path=design,
        source_spec_path=tmp_path / "spec.md",
        result=_fake_result(findings=findings, blocking=2),
        model="gpt-5.5-pro",
        run_id="manual-abc",
    )
    # critical row appears before high which appears before medium
    crit = md.index("rt-critical")
    high = md.index("rt-high")
    med = md.index("rt-medium")
    assert crit < high < med
    assert "**Status:** **halted**" in md
    assert "spec.md" in md


def test_render_sidecar_human_review_form(tmp_path: Path):
    design = tmp_path / "d.md"
    design.write_text("# D")
    findings = [
        _finding(
            counter=rt.REQUEST_HUMAN_REVIEW,
            trade_off=None,
            reason="Need stakeholder input.",
        )
    ]
    md = dispatch.render_sidecar_markdown(
        design_path=design,
        source_spec_path=None,
        result=_fake_result(findings=findings, human_review=1),
        model="gpt-5.5-pro",
        run_id="manual-x",
    )
    assert "_Requests human review._" in md
    assert "Need stakeholder input." in md


def test_render_sidecar_error_path(tmp_path: Path):
    design = tmp_path / "d.md"
    design.write_text("# D")
    md = dispatch.render_sidecar_markdown(
        design_path=design,
        source_spec_path=None,
        result=_fake_result(error="dispatch timeout"),
        model="gpt-5.5-pro",
        run_id="manual-x",
    )
    assert "## Error" in md
    assert "dispatch timeout" in md


def test_run_dispatch_design_missing(tmp_path: Path):
    out = dispatch.run_dispatch(
        design_path=tmp_path / "missing.md",
        source_spec_path=None,
        model_override=None,
        write_sidecar=False,
        audit=False,
        cwd=None,
    )
    assert out["status"] == "error"
    assert "not found" in out["error"]


def test_run_dispatch_source_spec_missing(tmp_path: Path):
    design = tmp_path / "d.md"
    design.write_text("# D")
    out = dispatch.run_dispatch(
        design_path=design,
        source_spec_path=tmp_path / "missing-spec.md",
        model_override=None,
        write_sidecar=False,
        audit=False,
        cwd=None,
    )
    assert out["status"] == "error"
    assert "source-spec" in out["error"]


def test_run_dispatch_writes_sidecar_and_returns_paths(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    design = tmp_path / "my-design.md"
    design.write_text("# My Design")

    captured: dict[str, object] = {}

    def fake_run_red_team(**kwargs):
        captured.update(kwargs)
        return _fake_result(
            findings=[_finding()],
            blocking=1,
            synthesis="One concern raised.",
        )

    monkeypatch.setattr(dispatch.rt, "run_red_team", fake_run_red_team)

    out = dispatch.run_dispatch(
        design_path=design,
        source_spec_path=None,
        model_override="gpt-5.5-pro",
        write_sidecar=True,
        audit=False,
        cwd=None,
    )

    assert out["status"] == "halted"
    assert out["model"] == "gpt-5.5-pro"
    assert out["total_findings"] == 1
    assert out["blocking_count"] == 1
    sidecar = Path(out["sidecar_path"])
    assert sidecar.exists()
    # `<design>.md` -> `<design>.red-team.md` (sibling, no double-`.md`)
    assert sidecar.name == "my-design.red-team.md"
    text = sidecar.read_text()
    assert "One concern raised." in text
    assert captured["stage"] == "design"
    # When source-spec is None, dispatcher feeds the design as its own spec.
    assert captured["source_spec"] == "# My Design"


def test_run_dispatch_no_sidecar(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    design = tmp_path / "design.md"
    design.write_text("# Design")
    monkeypatch.setattr(
        dispatch.rt,
        "run_red_team",
        lambda **_: _fake_result(),
    )
    out = dispatch.run_dispatch(
        design_path=design,
        source_spec_path=None,
        model_override=None,
        write_sidecar=False,
        audit=False,
        cwd=None,
    )
    assert out["sidecar_path"] is None


def test_run_dispatch_uses_explicit_source_spec(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    design = tmp_path / "design.md"
    design.write_text("# Design body")
    spec = tmp_path / "spec.md"
    spec.write_text("# Spec body")

    captured: dict[str, object] = {}

    def fake(**kwargs):
        captured.update(kwargs)
        return _fake_result()

    monkeypatch.setattr(dispatch.rt, "run_red_team", fake)

    out = dispatch.run_dispatch(
        design_path=design,
        source_spec_path=spec,
        model_override=None,
        write_sidecar=False,
        audit=False,
        cwd=None,
    )
    assert out["status"] == "clean"
    assert captured["artifact"] == "# Design body"
    assert captured["source_spec"] == "# Spec body"


def test_main_json_output_clean(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
):
    design = tmp_path / "design.md"
    design.write_text("# Design")
    monkeypatch.setattr(dispatch.rt, "run_red_team", lambda **_: _fake_result())

    rc = dispatch.main([
        "--design", str(design),
        "--no-sidecar", "--no-audit", "--json",
    ])
    assert rc == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload["status"] == "clean"
    assert payload["total_findings"] == 0


def test_main_returns_2_on_error(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
):
    rc = dispatch.main([
        "--design", str(tmp_path / "missing.md"),
        "--no-sidecar", "--no-audit", "--json",
    ])
    assert rc == 2
    payload = json.loads(capsys.readouterr().out)
    assert payload["status"] == "error"
