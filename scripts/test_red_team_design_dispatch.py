"""Tests for red_team_design_dispatch.py."""

from __future__ import annotations

import json
from dataclasses import asdict
from pathlib import Path

import pytest

import red_team_design_dispatch as dispatch
import red_team_dispatch_common as common
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


def _ctx(**overrides) -> rt.RedTeamRunContext:
    cfg = {
        "model": "gpt-5.5-pro",
        "personas": ["security-trust"],
        "timeout_s": 900,
        "min_severity_to_block": "high",
        "max_input_chars": 200_000,
        "per_run_budget_usd": 10.0,
        "fix_plan": {
            "enabled": False,
            "model": "gpt-5.5-pro",
            "reasoning_effort": "xhigh",
            "timeout_s": 1200,
            "min_moves": 1,
            "max_moves": 6,
            "max_input_chars": 200_000,
        },
    }
    data = {
        "run_id": "manual-abc123def456",
        "stage": "design",
        "caller": "manual",
        "repo": "evinced/stark-skills",
        "artifact_relative_path": "docs/design.md",
        "cwd": None,
        "env": {"OPENAI_API_KEY": "sk-test"},
        "model_rates": {"gpt-5.5-pro": {"input_per_1m_usd": 25, "output_per_1m_usd": 100}},
        "cfg_red_team": cfg,
        "per_run_budget_usd": 10.0,
        "pr_number": 17,
        "started_at_iso": "2026-05-01T00:00:00Z",
    }
    data.update(overrides)
    return rt.RedTeamRunContext(**data)


def _fix_plan(**overrides) -> rt.RedTeamFixPlan:
    plan = rt.RedTeamFixPlan(
        summary="Apply focused changes.",
        moves=[
            rt.FixPlanMove(
                id="move1",
                title="Fix `auth` path",
                rationale="Because rt1 blocks launch.",
                sections_touched=["Security"],
                addressed_finding_ids=["rt1", "bad-id"],
                new_trade_off="More setup.",
            )
        ],
        unaddressed_finding_ids=[],
        orphan_finding_ids=["rt2", "x"],
        notes="Ship carefully.",
        input_truncated=False,
        input_omitted_finding_ids=[],
        warnings=[],
        raw_output="{}",
        duration_s=2.0,
        cost_usd=1.5,
        input_tokens=10,
        output_tokens=20,
        model="gpt-5.5-pro",
        reasoning_effort="xhigh",
        error=None,
    )
    for key, value in overrides.items():
        setattr(plan, key, value)
    return plan


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


def test_build_dispatch_env_preserves_openai_key(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("OPENAI_API_KEY", "sk-direct")
    monkeypatch.setenv("OPENAI_API_KEY_FILE", "/tmp/keyfile")
    monkeypatch.setenv("OPENAI_API_KEY_LABEL", "OPENAI")
    monkeypatch.setattr(common, "build_agent_env", None, raising=False)
    env = common.build_dispatch_env()
    assert rt._resolve_openai_api_key(env) == rt._resolve_openai_api_key(dict(common.os.environ))


@pytest.mark.parametrize(
    ("result", "expected"),
    [
        (_fake_result(), "skipped_disabled"),
        (_fake_result(error="boom"), "skipped_challenge_error"),
        (_fake_result(findings=[_finding(counter=rt.REQUEST_HUMAN_REVIEW)], human_review=1), "skipped_human_review_only"),
        (_fake_result(blocking=0), "skipped_clean"),
        (_fake_result(findings=[_finding()], blocking=1), "skipped_budget_exhausted"),
    ],
)
def test_fix_plan_skip_statuses(result: rt.RedTeamResult, expected: str):
    ctx = _ctx()
    if expected != "skipped_disabled":
        ctx = rt.RedTeamRunContext(
            **{
                **asdict(ctx),
                "cfg_red_team": {
                    **ctx.cfg_red_team,
                    "fix_plan": {**ctx.cfg_red_team["fix_plan"], "enabled": True},
                },
                "per_run_budget_usd": 0.01 if expected == "skipped_budget_exhausted" else 10.0,
            }
        )
    status, plan, warnings = common.resolve_fix_plan(
        ctx=ctx,
        challenge=result,
        artifact="# D",
        source_spec="# D",
        enable_fix_plan_for_calibration=False,
    )
    assert status == expected
    assert plan is None
    assert warnings == []


def test_fix_plan_kill_switch_overrides_enabled_config(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
):
    ctx = _ctx(
        cfg_red_team={
            **_ctx().cfg_red_team,
            "fix_plan": {**_ctx().cfg_red_team["fix_plan"], "enabled": True},
        }
    )
    monkeypatch.setenv("STARK_RED_TEAM_FIX_PLAN_KILL", "true")
    monkeypatch.setattr(common, "_KILL_SWITCH_WARNED", False)
    status, plan, warnings = common.resolve_fix_plan(
        ctx=ctx,
        challenge=_fake_result(findings=[_finding()], blocking=1),
        artifact="# D",
        source_spec="# D",
        enable_fix_plan_for_calibration=True,
    )
    assert status == "skipped_kill_switch"
    assert plan is None
    assert warnings == ["red_team.fix_plan.kill_switch_active"]
    assert "red_team.fix_plan.kill_switch_active" in capsys.readouterr().err


def test_calibration_override_runs_fix_plan_and_over_budget_warning(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
):
    plan = _fix_plan(cost_usd=2.0)
    monkeypatch.setattr(common.rt, "run_red_team_fix_plan", lambda *_, **__: plan)
    ctx = _ctx(per_run_budget_usd=1.0)
    status, returned, warnings = common.resolve_fix_plan(
        ctx=ctx,
        challenge=_fake_result(findings=[_finding()], blocking=1),
        artifact="# D",
        source_spec="# D",
        enable_fix_plan_for_calibration=True,
    )
    assert status == "success"
    assert returned is plan
    assert warnings == ["over_budget_after_fix"]
    assert plan.warnings == ["over_budget_after_fix"]
    assert "exceeds budget" in capsys.readouterr().err


def test_render_fix_plan_section_escapes_untrusted_content_and_ids():
    plan = _fix_plan()
    plan.moves[0].rationale = "tries ``` fence"
    plan.moves[0].new_trade_off = "<script>alert(1)</script>"
    plan.notes = "```` four ticks"
    md = common.render_fix_plan_section(fix_plan_status="success", fix_plan=plan)
    assert "### 1. Fix \\`auth\\` path" in md
    assert "```text\ntries ``` fence\n```" in md
    assert "```text\n<script>alert(1)</script>\n```" in md
    assert "`rt1`" in md
    assert "bad-id" not in md
    assert "`rt2`" in md
    # Content with a 4-tick run gets a 5-tick fence so the inner run
    # cannot close the outer fence (review-round security fix).
    assert "\n`````text\n```` four ticks\n`````" in md


def test_render_fix_plan_section_error_retry_hint_and_cap():
    errored = _fix_plan(error="timeout", moves=[], cost_usd=0.25)
    md = common.render_fix_plan_section(fix_plan_status="error", fix_plan=errored)
    assert "**Status:** error — timeout" in md
    assert "--no-pr-comment" in md

    huge = _fix_plan(notes="x" * 20_000)
    capped = common.render_fix_plan_section(fix_plan_status="success", fix_plan=huge)
    assert len(capped) <= common.FIX_PLAN_SECTION_LIMIT
    assert "[TRUNCATED — see local SQLite fix_plan_json]" in capped


def test_truncate_pr_comment_cascade():
    body = (
        "## Proposed Fix Plan\n"
        "**Rationale.** " + ("r" * 70_000) + "\n"
        "### Notes\n" + ("n" * 70_000)
    )
    out = common.truncate_pr_comment(body, None)
    assert len(out) <= common.GH_COMMENT_LIMIT
    assert "[TRUNCATED — see sidecar]" in out
    assert "[TRUNCATED]" in out or "[TRUNCATED — see sidecar for full content]" in out


def test_sidecar_commit_message_success_and_skips():
    result = _fake_result(findings=[_finding()], blocking=1)
    success = common.sidecar_commit_message(
        artifact_path=Path("design.md"),
        result=result,
        challenge_model="gpt-5.5-pro",
        fix_plan_status="success",
        fix_plan=_fix_plan(),
        run_id="manual-abc",
        stage="design",
    )
    assert "docs(red-team): findings + fix plan for design.md" in success
    assert "1 findings (1 blocking, 0 human-review)" in success
    assert "Fix plan: 1 moves addressing rt1, bad-id" in success

    skipped = common.sidecar_commit_message(
        artifact_path=Path("design.md"),
        result=_fake_result(),
        challenge_model="gpt-5.5-pro",
        fix_plan_status="skipped_clean",
        fix_plan=None,
        run_id="manual-abc",
        stage="design",
    )
    assert "Fix plan: skipped (clean)" in skipped


def test_run_dispatch_audit_before_emit_order_and_final_status_invariant(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    design = tmp_path / "design.md"
    design.write_text("# Design")
    calls: list[str] = []
    result = _fake_result(findings=[_finding()], blocking=1)
    errored_plan = _fix_plan(error="parse failure", moves=[], cost_usd=0.2)

    monkeypatch.setattr(dispatch.rt, "run_red_team", lambda **_: result)
    monkeypatch.setattr(common.rt, "run_red_team_fix_plan", lambda *_, **__: errored_plan)
    monkeypatch.setattr(common, "_repo_root", lambda cwd: tmp_path)
    monkeypatch.setattr(common, "_repo_name", lambda cwd: "evinced/stark-skills")
    monkeypatch.setattr(common, "_pr_number", lambda cwd: 123)
    monkeypatch.setattr(common, "build_dispatch_env", lambda: {"OPENAI_API_KEY": "sk-test"})
    monkeypatch.setattr(
        common,
        "get_red_team_config",
        lambda: {
            **_ctx().cfg_red_team,
            "fix_plan": {**_ctx().cfg_red_team["fix_plan"], "enabled": True},
        },
    )
    monkeypatch.setattr(common, "get_model_rates", lambda: _ctx().model_rates)

    class Audit:
        @staticmethod
        def resolve_db_path(cli_db=None):
            return "/tmp/test-stub.db"

        @staticmethod
        def init_red_team_tables(db_path=None):
            calls.append("init")

        @staticmethod
        def record_red_team_run(data, db_path=None):
            calls.append(f"run:{data['fix_plan_status']}:{data['final_status']}")

        @staticmethod
        def record_finding(**kwargs):
            calls.append(f"finding:{kwargs['finding_id']}")

        @staticmethod
        def record_fix_plan(run_id, **kwargs):
            calls.append(f"fix:{kwargs['fix_plan_status']}")

    class Insights:
        @staticmethod
        def emit_finding(ctx, **kwargs):
            calls.append(f"emit_finding:{ctx.run_id}:{ctx.stage}:{ctx.repo}:{ctx.artifact_relative_path}:{ctx.pr_number}")

        @staticmethod
        def emit_fix_plan(ctx, **kwargs):
            calls.append("emit_fix")

        @staticmethod
        def emit_run(ctx, **kwargs):
            calls.append(f"emit_run:{kwargs['fix_plan_status']}:{kwargs['result'].blocking_count}")

    real_import = __import__

    def fake_import(name, *args, **kwargs):
        if name == "red_team_audit":
            return Audit
        if name == "red_team_insights":
            return Insights
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr("builtins.__import__", fake_import)

    out = dispatch.run_dispatch(
        design_path=design,
        source_spec_path=None,
        model_override="gpt-5.5-pro",
        write_sidecar=False,
        audit=True,
        cwd=str(tmp_path),
    )
    assert out["status"] == "halted"
    assert out["fix_plan_status"] == "error"
    assert calls == [
        "init",
        "run:pending:halted",
        "finding:rt1",
        f"emit_finding:{out['run_id']}:design:evinced/stark-skills:design.md:123",
        "fix:error",
        "emit_run:error:1",
    ]
