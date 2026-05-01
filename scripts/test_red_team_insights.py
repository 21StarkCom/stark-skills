"""Tests for red_team_insights.py — red-team stark-insights envelopes."""

from __future__ import annotations

import json
from pathlib import Path

import emit_queue
import red_team_insights as insights
import stark_red_team as rt


TS = "2026-05-01T12:34:56Z"


def _ctx(repo: str = "evinced/stark-skills") -> rt.RedTeamRunContext:
    return rt.RedTeamRunContext(
        run_id="manual-abc123def456",
        stage="design",
        caller="manual",
        repo=repo,
        artifact_relative_path="docs/specs/foo.md",
        cwd=None,
        env={},
        model_rates={},
        cfg_red_team={"model": "gpt-5.5-pro"},
        per_run_budget_usd=30.0,
        pr_number=428,
        started_at_iso=TS,
    )


def _finding(
    *,
    finding_id: str = "rt3",
    severity: str = "high",
    counter_proposal: str = "Split the deploy gate from the producer merge.",
) -> rt.RedTeamFinding:
    return rt.RedTeamFinding(
        id=finding_id,
        persona="reliability-distsys",
        severity=severity,
        concern="Producer events can drain before lifters accept them.",
        consequence="The queue dead-letters valid red-team telemetry.",
        counter_proposal=counter_proposal,
        trade_off="Requires a deployment gate.",
        reason_for_uncertainty=None,
    )


def _result() -> rt.RedTeamResult:
    findings = [
        _finding(finding_id="rt1", severity="high"),
        _finding(finding_id="rt2", severity="high"),
        _finding(),
        _finding(finding_id="rt4", severity="high"),
        _finding(
            finding_id="rt5",
            severity="medium",
            counter_proposal=rt.REQUEST_HUMAN_REVIEW,
        ),
        _finding(finding_id="rt6", severity="medium"),
    ]
    return rt.RedTeamResult(
        stage="design",
        round_num=1,
        synthesis="synthesis",
        findings=findings,
        blocking_count=4,
        human_review_count=1,
        raw_output="{}",
        duration_s=87.3,
        cost_usd=1.92,
        input_tokens=100,
        output_tokens=50,
    )


def _fix_plan() -> rt.RedTeamFixPlan:
    move = rt.FixPlanMove(
        id="m1",
        title="Gate producer emission",
        rationale="Track B must accept event types before cloud drain.",
        sections_touched=["section 4.2"],
        addressed_finding_ids=["rt1", "rt3"],
        new_trade_off="Adds rollout sequencing.",
    )
    return rt.RedTeamFixPlan(
        summary="Add the deployment gate before enabling drain.",
        moves=[move],
        unaddressed_finding_ids=["rt2"],
        orphan_finding_ids=[],
        notes="Operator gate stays in Phase 11.",
        input_truncated=False,
        input_omitted_finding_ids=[],
        warnings=[],
        raw_output="{}",
        duration_s=87.3,
        cost_usd=2.41,
        input_tokens=12450,
        output_tokens=3120,
        model="gpt-5.5-pro",
        reasoning_effort="xhigh",
    )


def test_build_run_envelope_matches_design_contract_field_by_field():
    envelope = insights.build_run_envelope(
        run_id="manual-abc123def456",
        stage="design",
        repo="evinced/stark-skills",
        artifact_relative_path="docs/specs/foo.md",
        pr_number=428,
        model="gpt-5.5-pro",
        caller="manual",
        final_status="halted",
        worst_severity="high",
        passed=False,
        rounds_used=1,
        total_findings=6,
        blocking_count=4,
        human_review_count=1,
        critical_count=0,
        high_count=4,
        medium_count=2,
        duration_s=87.3,
        cost_usd=1.92,
        fix_plan_status="success",
        warnings=[],
        started_at_iso=TS,
    )

    assert envelope == {
        "type": "red_team_run",
        "timestamp": TS,
        "cli": "claude",
        "source": "skill",
        "schema_version": 1,
        "project": "evinced/stark-skills",
        "dedupe_key": "red-team:run:design:manual-abc123def456",
        "payload": {
            "run_id": "manual-abc123def456",
            "stage": "design",
            "model": "gpt-5.5-pro",
            "caller": "manual",
            "final_status": "halted",
            "worst_severity": "high",
            "passed": False,
            "rounds_used": 1,
            "total_findings": 6,
            "blocking_count": 4,
            "human_review_count": 1,
            "critical_count": 0,
            "high_count": 4,
            "medium_count": 2,
            "duration_s": 87.3,
            "cost_usd": 1.92,
            "repo": "evinced/stark-skills",
            "artifact_relative_path": "docs/specs/foo.md",
            "pr_number": 428,
            "fix_plan_status": "success",
            "warnings": [],
            "round_outcomes": [],
            "terminal_transition": None,
        },
    }
    _assert_schema_valid(envelope)


def test_build_finding_envelope_matches_design_contract_field_by_field():
    envelope = insights.build_finding_envelope(
        run_id="manual-abc123def456",
        stage="design",
        repo="evinced/stark-skills",
        pr_number=428,
        round_num=1,
        finding_id="rt3",
        persona="reliability-distsys",
        severity="high",
        concern="Producer events can drain before lifters accept them.",
        consequence="The queue dead-letters valid red-team telemetry.",
        counter_proposal="Split the deploy gate from the producer merge.",
        trade_off="Requires a deployment gate.",
        reason_for_uncertainty=None,
        is_human_review=False,
        timestamp_iso=TS,
    )

    assert envelope == {
        "type": "red_team_finding",
        "timestamp": TS,
        "cli": "claude",
        "source": "skill",
        "schema_version": 1,
        "project": "evinced/stark-skills",
        "dedupe_key": "red-team:finding:design:manual-abc123def456:1:rt3",
        "payload": {
            "run_id": "manual-abc123def456",
            "stage": "design",
            "round_num": 1,
            "finding_id": "rt3",
            "persona": "reliability-distsys",
            "severity": "high",
            "stable_key": "",
            "concern_hash": "",
            "risk_key": None,
            "affected_component": None,
            "failure_mode": None,
            "retention_mode": "full",
            "concern": "Producer events can drain before lifters accept them.",
            "consequence": "The queue dead-letters valid red-team telemetry.",
            "counter_proposal": "Split the deploy gate from the producer merge.",
            "trade_off": "Requires a deployment gate.",
            "reason_for_uncertainty": None,
            "concern_excerpt_hash": None,
            "consequence_excerpt_hash": None,
            "counter_proposal_excerpt_hash": None,
            "trade_off_excerpt_hash": None,
            "reason_for_uncertainty_excerpt_hash": None,
            "is_human_review": False,
            "repo": "evinced/stark-skills",
            "pr_number": 428,
        },
    }
    _assert_schema_valid(envelope)


def test_build_call_start_envelope_carries_budget_and_truncation_fields():
    """FU-rt11: pre-call event captures cumulative cost + truncation flag."""
    envelope = insights.build_call_start_envelope(
        run_id="manual-abc123",
        stage="design",
        repo="evinced/stark-skills",
        pr_number=428,
        call_id="c1abcd",
        call_phase=insights.CALL_PHASE_VERIFICATION,
        round_num=2,
        configured_model="gpt-5.5-pro",
        prompt_chars=18000,
        truncated=True,
        cumulative_cost_usd=4.25,
        per_run_budget_usd=15.00,
        timestamp_iso=TS,
    )
    assert envelope["type"] == "red_team_call_start"
    assert envelope["dedupe_key"] == "red-team:call:design:manual-abc123:c1abcd:start"
    payload = envelope["payload"]
    assert payload["call_phase"] == "verification"
    assert payload["round_num"] == 2
    assert payload["configured_model"] == "gpt-5.5-pro"
    assert payload["prompt_chars"] == 18000
    assert payload["truncated"] is True
    assert payload["cumulative_cost_usd"] == 4.25
    assert payload["per_run_budget_usd"] == 15.0
    assert payload["budget_remaining_usd"] == 10.75


def test_build_call_end_envelope_records_actual_model_and_transport():
    """FU-rt11: end event captures actual_model post-fallback + transport."""
    envelope = insights.build_call_end_envelope(
        run_id="manual-abc123",
        stage="design",
        repo="evinced/stark-skills",
        pr_number=428,
        call_id="c1abcd",
        call_phase=insights.CALL_PHASE_PRIMARY,
        round_num=1,
        configured_model="gpt-5.5-pro",
        actual_model="gpt-5.5-pro",
        transport="responses_api",
        prompt_chars=18000,
        truncated=False,
        input_tokens=12000,
        output_tokens=2400,
        duration_s=18.4,
        cost_usd=0.50,
        cumulative_cost_usd=4.25,
        per_run_budget_usd=15.00,
        error=None,
        request_id="resp_abc123",
        timestamp_iso=TS,
    )
    assert envelope["type"] == "red_team_call_end"
    assert envelope["dedupe_key"] == "red-team:call:design:manual-abc123:c1abcd:end"
    payload = envelope["payload"]
    assert payload["actual_model"] == "gpt-5.5-pro"
    assert payload["transport"] == "responses_api"
    assert payload["request_id"] == "resp_abc123"
    assert payload["cost_usd"] == 0.50
    # cumulative_cost_usd in the END event includes this call (4.25 + 0.50).
    assert payload["cumulative_cost_usd"] == 4.75
    assert payload["budget_remaining_usd"] == 10.25


def test_build_call_envelope_rejects_unknown_phase():
    try:
        insights.build_call_start_envelope(
            run_id="r",
            stage="design",
            repo="x",
            pr_number=None,
            call_id="c",
            call_phase="not-a-phase",
            round_num=1,
            configured_model="m",
            prompt_chars=0,
            truncated=False,
            cumulative_cost_usd=0,
            per_run_budget_usd=0,
            timestamp_iso=TS,
        )
    except ValueError as exc:
        assert "invalid call_phase" in str(exc)
    else:
        raise AssertionError("expected ValueError for unknown phase")


def test_build_fix_plan_envelope_matches_design_contract_field_by_field():
    moves = [
        {
            "id": "m1",
            "title": "Gate producer emission",
            "rationale": "Track B must accept event types before cloud drain.",
            "sections_touched": ["section 4.2"],
            "addressed_finding_ids": ["rt1", "rt3"],
            "new_trade_off": "Adds rollout sequencing.",
        }
    ]
    envelope = insights.build_fix_plan_envelope(
        run_id="manual-abc123def456",
        stage="design",
        repo="evinced/stark-skills",
        pr_number=428,
        model="gpt-5.5-pro",
        reasoning_effort="xhigh",
        summary="Add the deployment gate before enabling drain.",
        notes="Operator gate stays in Phase 11.",
        moves=moves,
        move_count=1,
        addressed_finding_ids=["rt1", "rt3"],
        unaddressed_finding_ids=["rt2"],
        orphan_finding_ids=[],
        input_truncated=False,
        input_omitted_finding_ids=[],
        warnings=[],
        cost_usd=2.41,
        duration_s=87.3,
        input_tokens=12450,
        output_tokens=3120,
        fix_plan_md="## Proposed Fix Plan\n...",
        timestamp_iso=TS,
    )

    assert envelope == {
        "type": "red_team_fix_plan",
        "timestamp": TS,
        "cli": "claude",
        "source": "skill",
        "schema_version": 1,
        "project": "evinced/stark-skills",
        "dedupe_key": "red-team:fix_plan:design:manual-abc123def456",
        "payload": {
            "run_id": "manual-abc123def456",
            "stage": "design",
            "model": "gpt-5.5-pro",
            "reasoning_effort": "xhigh",
            "summary": "Add the deployment gate before enabling drain.",
            "notes": "Operator gate stays in Phase 11.",
            "moves": moves,
            "move_count": 1,
            "addressed_finding_ids": ["rt1", "rt3"],
            "unaddressed_finding_ids": ["rt2"],
            "orphan_finding_ids": [],
            "input_truncated": False,
            "input_omitted_finding_ids": [],
            "warnings": [],
            "cost_usd": 2.41,
            "duration_s": 87.3,
            "input_tokens": 12450,
            "output_tokens": 3120,
            "fix_plan_md": "## Proposed Fix Plan\n...",
            "repo": "evinced/stark-skills",
            "pr_number": 428,
        },
    }
    _assert_schema_valid(envelope)


def test_dedupe_key_stability_across_rebuilds():
    kwargs = {
        "kind": "finding",
        "stage": "design",
        "run_id": "manual-abc123def456",
        "round_num": 1,
        "finding_id": "rt3",
    }
    assert insights.make_dedupe_key(**kwargs) == insights.make_dedupe_key(**kwargs)
    assert insights.make_dedupe_key(**kwargs) == (
        "red-team:finding:design:manual-abc123def456:1:rt3"
    )


def test_clean_run_worst_severity_is_null_never_clean_string():
    result = rt.RedTeamResult(
        stage="design",
        round_num=1,
        synthesis="clean",
        findings=[],
        blocking_count=0,
        human_review_count=0,
        raw_output="{}",
        duration_s=1.0,
    )
    # Avoid depending on the wrapper's private helpers: pure builder owns the
    # public clean-run contract.
    envelope = insights.build_run_envelope(
        run_id="run-clean",
        stage="design",
        repo=None,
        artifact_relative_path=None,
        pr_number=None,
        model="gpt-5.5-pro",
        caller="manual",
        final_status=rt.derive_status(result),
        worst_severity=None,
        passed=True,
        rounds_used=1,
        total_findings=0,
        blocking_count=0,
        human_review_count=0,
        critical_count=0,
        high_count=0,
        medium_count=0,
        duration_s=1.0,
        cost_usd=0.0,
        fix_plan_status="skipped_disabled",
        warnings=None,
        started_at_iso=TS,
    )
    assert envelope["payload"]["worst_severity"] is None
    assert envelope["payload"]["passed"] is True
    assert envelope["payload"]["repo"] == "unknown"
    assert envelope["project"] == "unknown"
    assert envelope["payload"]["warnings"] == []


def test_emit_fix_plan_skips_when_status_is_not_success(monkeypatch):
    emitted: list[dict] = []
    monkeypatch.setattr(emit_queue, "enqueue", emitted.append)

    insights.emit_fix_plan(
        _ctx(),
        fix_plan=_fix_plan(),
        fix_plan_md="## Proposed Fix Plan",
        fix_plan_status="error",
    )

    assert emitted == []


def test_emitters_isolate_enqueue_exceptions(monkeypatch, capsys):
    def boom(_event):
        raise RuntimeError("queue unavailable")

    monkeypatch.setattr(emit_queue, "enqueue", boom)

    insights.emit_run(
        _ctx(),
        result=_result(),
        model="gpt-5.5-pro",
        fix_plan_status="success",
        run_warnings=[],
    )
    insights.emit_finding(_ctx(), finding=_finding(), round_num=1)
    insights.emit_fix_plan(
        _ctx(),
        fix_plan=_fix_plan(),
        fix_plan_md="## Proposed Fix Plan",
    )

    err = capsys.readouterr().err
    assert "queue unavailable" in err


def test_wrapper_derives_fix_plan_moves_and_addressed_union(monkeypatch):
    emitted: list[dict] = []
    monkeypatch.setattr(emit_queue, "enqueue", emitted.append)

    insights.emit_fix_plan(
        _ctx(),
        fix_plan=_fix_plan(),
        fix_plan_md="## Proposed Fix Plan",
    )

    assert len(emitted) == 1
    payload = emitted[0]["payload"]
    assert payload["move_count"] == 1
    assert payload["moves"][0]["id"] == "m1"
    assert payload["addressed_finding_ids"] == ["rt1", "rt3"]
    assert payload["fix_plan_md"] == "## Proposed Fix Plan"


def _assert_schema_valid(envelope: dict) -> None:
    assert emit_queue.validate(envelope) == []
    try:
        import jsonschema
    except ImportError:
        return
    schema_path = Path(__file__).with_name("event_schema.json")
    jsonschema.validate(envelope, json.loads(schema_path.read_text()))
