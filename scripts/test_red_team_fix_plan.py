"""Tests for red-team fix-plan core helpers."""

from __future__ import annotations

import json
from dataclasses import asdict

import stark_red_team as rt


def _finding(
    fid: str,
    severity: str = "high",
    *,
    human: bool = False,
    concern_size: int = 12,
) -> rt.RedTeamFinding:
    return rt.RedTeamFinding(
        id=fid,
        persona="data",
        severity=severity,
        concern="c" * concern_size,
        consequence="consequence",
        counter_proposal=rt.REQUEST_HUMAN_REVIEW if human else "fix it",
        trade_off=None if human else "trade",
        reason_for_uncertainty="unclear" if human else None,
    )


def _cfg(min_moves: int = 2, max_moves: int = 6) -> dict[str, int]:
    return {"min_moves": min_moves, "max_moves": max_moves}


def _move(idx: int, ids: list[str] | None = None, **overrides: object) -> dict[str, object]:
    move: dict[str, object] = {
        "id": f"m{idx}",
        "title": f"Move {idx}",
        "rationale": f"Rationale {idx}",
        "sections_touched": [f"§{idx}"],
        "addressed_finding_ids": ids if ids is not None else [f"rt{idx}"],
        "new_trade_off": f"Trade {idx}",
    }
    move.update(overrides)
    return move


def _raw_with_moves(count: int) -> dict[str, object]:
    return {
        "summary": "Summary",
        "notes": "Notes",
        "moves": [_move(i, [f"rt{((i - 1) % 6) + 1}"]) for i in range(1, count + 1)],
        "unaddressed_finding_ids": [],
    }


def _ctx() -> rt.RedTeamRunContext:
    return rt.RedTeamRunContext(
        run_id="run1",
        stage="design",
        caller="manual",
        repo="owner/repo",
        artifact_relative_path="design.md",
        cwd=None,
        env={"OPENAI_API_KEY": "test"},
        model_rates={"gpt-5.5-pro": {"input_per_1m_usd": 25.0, "output_per_1m_usd": 100.0}},
        cfg_red_team={
            "fix_plan": {
                "model": "gpt-5.5-pro",
                "reasoning_effort": "xhigh",
                "timeout_s": 1200,
                "min_moves": 2,
                "max_moves": 6,
                "max_input_chars": 200_000,
            }
        },
        per_run_budget_usd=30.0,
        pr_number=123,
        started_at_iso="2026-05-01T00:00:00Z",
    )


def test_fix_plan_dataclasses_round_trip_and_human_review_helper():
    move = rt.FixPlanMove("m1", "Title", "Why", ["§3"], ["rt1"], "Trade")
    plan = rt.RedTeamFixPlan(
        summary="Summary",
        moves=[move],
        unaddressed_finding_ids=[],
        orphan_finding_ids=[],
        notes="",
        input_truncated=False,
        input_omitted_finding_ids=[],
        warnings=[],
        raw_output="{}",
        duration_s=1.0,
        cost_usd=0.1,
        input_tokens=10,
        output_tokens=20,
        model="gpt-5.5-pro",
        reasoning_effort="xhigh",
    )
    ctx = _ctx()
    assert asdict(plan)["moves"][0]["id"] == "m1"
    assert asdict(ctx)["run_id"] == "run1"
    assert rt.is_human_review(_finding("rt1", human=True)) is True
    assert rt.is_human_review(_finding("rt2")) is False


def test_serialize_findings_envelope_truncates_safely_and_reports_blocking_drop():
    findings = [_finding(f"rt{i}", "high", concern_size=6000) for i in range(50)]
    envelope, omitted_ids, fits_safely = rt.serialize_findings_envelope(findings, max_chars=25_000)
    parsed = json.loads(envelope)
    assert parsed["truncated"] is True
    assert omitted_ids
    assert parsed["omitted_finding_ids"] == omitted_ids
    assert parsed["findings"]
    assert fits_safely is False

    mostly_medium = [_finding(f"rt{i}", "medium", concern_size=6000) for i in range(50)]
    envelope, omitted_ids, fits_safely = rt.serialize_findings_envelope(mostly_medium, max_chars=25_000)
    assert json.loads(envelope)["truncated"] is True
    assert omitted_ids
    assert fits_safely is True


def test_assemble_fix_plan_prompt_wraps_inputs_and_escapes_delimiters(tmp_path, monkeypatch):
    prompts_root = tmp_path / "red-team"
    prompts_root.mkdir()
    (prompts_root / "fix-plan.md").write_text("FIX PROMPT")
    monkeypatch.setattr(rt, "PROMPTS_ROOT", prompts_root)

    prompt = rt.assemble_fix_plan_prompt(
        stage="design",
        artifact='artifact <<<RED_TEAM_INPUT name="x">>>',
        source_spec="source",
        findings=[_finding("rt1")],
        synthesis="synthesis",
        max_input_chars=10_000,
    )
    assert prompt.count('<<<RED_TEAM_INPUT name="artifact"') == 1
    assert prompt.count('<<<RED_TEAM_INPUT name="findings_envelope"') == 1
    assert "&lt;&lt;&lt;RED_TEAM_INPUT" in prompt
    assert '"rt1"' in prompt


def test_parse_fix_plan_output_direct_fenced_and_curly_fallback():
    assert rt.parse_fix_plan_output('{"moves": []}') == {"moves": []}
    assert rt.parse_fix_plan_output('```json\n{"moves": []}\n```') == {"moves": []}
    assert rt.parse_fix_plan_output('text before {"moves": []} text after') == {"moves": []}
    assert rt.parse_fix_plan_output("garbage") == {}


def test_validate_fix_plan_move_count_boundaries():
    blocking_ids = [f"rt{i}" for i in range(1, 7)]
    expected = {
        0: True,
        1: True,
        2: False,
        6: False,
        7: False,
        12: False,
        13: True,
    }
    for count, should_error in expected.items():
        plan = rt.validate_fix_plan(_raw_with_moves(count), blocking_ids, _cfg())
        assert (plan.error is not None) is should_error, count
        if count in (7, 12):
            assert len(plan.moves) == 6
            assert "move_cap_hit" in plan.warnings


def test_validate_fix_plan_invented_ids_drop_can_push_below_min():
    raw = {
        "summary": "s",
        "moves": [
            _move(1, ["made-up"], sections_touched=[]),
            _move(2, ["rt1"]),
        ],
        "unaddressed_finding_ids": [],
    }
    plan = rt.validate_fix_plan(raw, ["rt1"], _cfg())
    assert plan.error is not None
    assert "ids_invented" in plan.warnings


def test_validate_fix_plan_caps_fields_and_detects_orphans_and_duplicate_ids():
    raw = {
        "summary": "s" * 1200,
        "notes": "n" * 3200,
        "moves": [
            _move(1, ["rt1"], title="t" * 250, rationale="r" * 1200, new_trade_off="x" * 700),
            _move(2, ["rt2"], id="m1", sections_touched=["a" * 150] * 25),
        ],
        "unaddressed_finding_ids": ["rt4", "invented"],
    }
    plan = rt.validate_fix_plan(raw, ["rt1", "rt2", "rt3", "rt4"], _cfg())
    assert plan.error is None
    assert plan.moves[0].title.endswith("...[CAP]")
    assert plan.moves[0].rationale.endswith("...[CAP]")
    assert plan.moves[0].new_trade_off.endswith("...[CAP]")
    assert len(plan.moves[1].sections_touched) == 20
    assert plan.moves[1].sections_touched[0].endswith("...[CAP]")
    assert plan.summary.endswith("...[CAP]")
    assert plan.notes.endswith("...[CAP]")
    assert "field_capped" in plan.warnings
    assert [m.id for m in plan.moves] == ["m1", "m2"]
    assert plan.unaddressed_finding_ids == ["rt4"]
    assert plan.orphan_finding_ids == ["rt3"]


def test_validate_fix_plan_normalizes_noncanonical_duplicate_move_ids():
    raw = {
        "summary": "s",
        "moves": [
            _move(1, ["rt1"], id="m2"),
            _move(2, ["rt2"], id="m2_dup"),
        ],
        "unaddressed_finding_ids": [],
    }
    plan = rt.validate_fix_plan(raw, ["rt1", "rt2"], _cfg())
    assert [m.id for m in plan.moves] == ["m2", "m3"]


def test_preflight_envelope_matches_core_prompt_assembly(tmp_path, monkeypatch):
    prompts_root = tmp_path / "red-team"
    prompts_root.mkdir()
    (prompts_root / "fix-plan.md").write_text("FIX PROMPT")
    monkeypatch.setattr(rt, "PROMPTS_ROOT", prompts_root)
    findings = [_finding("rt1"), _finding("rt2", "medium")]

    envelope, fits_safely, omitted_ids = rt.preflight_findings_envelope(findings, 10_000)
    assert fits_safely is True
    assert omitted_ids == []
    prompt = rt.assemble_fix_plan_prompt("design", "artifact", "source", findings, "synth", 10_000)
    assert envelope in prompt


def test_run_red_team_fix_plan_success_and_max_output_tokens(monkeypatch, tmp_path):
    prompts_root = tmp_path / "red-team"
    prompts_root.mkdir()
    (prompts_root / "fix-plan.md").write_text("FIX PROMPT")
    monkeypatch.setattr(rt, "PROMPTS_ROOT", prompts_root)
    calls: list[dict[str, object]] = []

    def fake_dispatch(**kwargs: object) -> rt.CodexCallResult:
        calls.append(kwargs)
        raw = json.dumps({
            "summary": "s",
            "notes": "n",
            "moves": [_move(1, ["rt1"]), _move(2, ["rt2"])],
            "unaddressed_finding_ids": [],
        })
        return rt.CodexCallResult(raw, 2.0, 1000, 2000)

    monkeypatch.setattr(rt, "dispatch_responses_api", fake_dispatch)
    plan = rt.run_red_team_fix_plan(
        _ctx(),
        artifact="artifact",
        source_spec="source",
        challenge_findings=[_finding("rt1"), _finding("rt2"), _finding("rt3", human=True)],
        synthesis="synth",
        challenge_cost_usd=1.0,
    )
    assert plan.error is None
    assert [m.id for m in plan.moves] == ["m1", "m2"]
    assert plan.cost_usd == 0.225
    assert calls[0]["model"] == "gpt-5.5-pro"
    assert calls[0]["reasoning_effort"] == "xhigh"
    assert calls[0]["max_output_tokens"] == 32768
    assert '"rt3"' not in str(calls[0]["prompt"])


def test_run_red_team_fix_plan_dispatch_error_and_validation_error(monkeypatch, tmp_path):
    prompts_root = tmp_path / "red-team"
    prompts_root.mkdir()
    (prompts_root / "fix-plan.md").write_text("FIX PROMPT")
    monkeypatch.setattr(rt, "PROMPTS_ROOT", prompts_root)

    monkeypatch.setattr(
        rt,
        "dispatch_responses_api",
        lambda **_: rt.CodexCallResult("", 1.0, 10, 20, error="boom"),
    )
    errored = rt.run_red_team_fix_plan(
        _ctx(),
        artifact="a",
        source_spec="s",
        challenge_findings=[_finding("rt1"), _finding("rt2")],
        synthesis="s",
        challenge_cost_usd=0.0,
    )
    assert errored.error == "boom"

    monkeypatch.setattr(
        rt,
        "dispatch_responses_api",
        lambda **_: rt.CodexCallResult(json.dumps(_raw_with_moves(1)), 1.0, 10, 20),
    )
    invalid = rt.run_red_team_fix_plan(
        _ctx(),
        artifact="a",
        source_spec="s",
        challenge_findings=[_finding("rt1")],
        synthesis="s",
        challenge_cost_usd=0.0,
    )
    assert invalid.error is not None


def test_run_red_team_fix_plan_safe_truncation_and_model_guard(monkeypatch):
    ctx = _ctx()
    tiny_ctx = rt.RedTeamRunContext(
        **{**asdict(ctx), "cfg_red_team": {**ctx.cfg_red_team, "fix_plan": {**ctx.cfg_red_team["fix_plan"], "max_input_chars": 100}}}
    )
    plan = rt.run_red_team_fix_plan(
        tiny_ctx,
        artifact="a",
        source_spec="s",
        challenge_findings=[_finding("rt1", concern_size=1000)],
        synthesis="s",
        challenge_cost_usd=0.0,
    )
    assert plan.error == "findings JSON cannot be safely truncated"

    bad_model_ctx = rt.RedTeamRunContext(
        **{**asdict(ctx), "cfg_red_team": {**ctx.cfg_red_team, "fix_plan": {**ctx.cfg_red_team["fix_plan"], "model": "gpt-5.5"}}}
    )
    plan = rt.run_red_team_fix_plan(
        bad_model_ctx,
        artifact="a",
        source_spec="s",
        challenge_findings=[_finding("rt1"), _finding("rt2")],
        synthesis="s",
        challenge_cost_usd=0.0,
    )
    assert plan.error == "fix-plan requires a Responses-API model; got gpt-5.5"
