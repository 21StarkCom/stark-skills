"""Tests for red_team_state_machine — FU-rt4 explicit state machine."""

from __future__ import annotations

import red_team_state_machine as sm
import stark_red_team as rt


def _result(*, blocking: int = 0, error: str | None = None, findings=None) -> rt.RedTeamResult:
    return rt.RedTeamResult(
        stage="design",
        round_num=1,
        synthesis="",
        findings=findings or [],
        blocking_count=blocking,
        human_review_count=0,
        raw_output="",
        duration_s=0.1,
        cost_usd=0.0,
        error=error,
    )


def _always_overlap(a, b):
    return True


def _never_overlap(a, b):
    return False


def test_classify_clean_when_no_blocking():
    r = _result(blocking=0)
    out = sm.classify_round(r, None, overlap=_always_overlap, has_prior_good_round=False)
    assert out is sm.RoundOutcome.clean


def test_classify_confirmed_blocking_when_overlap_holds():
    primary = _result(blocking=2)
    verification = _result(blocking=2)
    out = sm.classify_round(
        primary, verification, overlap=_always_overlap, has_prior_good_round=False
    )
    assert out is sm.RoundOutcome.confirmed_blocking


def test_classify_flicker_when_overlap_fails():
    primary = _result(blocking=2)
    verification = _result(blocking=2)
    out = sm.classify_round(
        primary, verification, overlap=_never_overlap, has_prior_good_round=False
    )
    assert out is sm.RoundOutcome.flicker


def test_classify_degraded_when_verification_missing():
    primary = _result(blocking=2)
    out = sm.classify_round(
        primary, None, overlap=_always_overlap, has_prior_good_round=False
    )
    assert out is sm.RoundOutcome.degraded


def test_classify_degraded_when_verification_errored():
    primary = _result(blocking=2)
    verification = _result(error="codex timeout")
    out = sm.classify_round(
        primary, verification, overlap=_always_overlap, has_prior_good_round=False
    )
    assert out is sm.RoundOutcome.degraded


def test_classify_error_on_first_failed_primary():
    primary = _result(error="codex 503")
    out = sm.classify_round(
        primary, None, overlap=_always_overlap, has_prior_good_round=False
    )
    assert out is sm.RoundOutcome.error


def test_classify_degraded_when_primary_errors_after_prior_good_round():
    primary = _result(error="codex 503")
    out = sm.classify_round(
        primary, None, overlap=_always_overlap, has_prior_good_round=True
    )
    assert out is sm.RoundOutcome.degraded


def test_record_round_does_not_count_flicker():
    """FU-rt4 invariant: flicker must NOT consume a remediation round."""
    state = sm.IterativeRunState(max_rounds=2)
    sm.record_round(
        state,
        round_num=1,
        primary=_result(blocking=2),
        verification=_result(blocking=2),
        outcome=sm.RoundOutcome.flicker,
        transition="continue.flicker",
    )
    assert state.rounds_used == 0
    assert len(state.history) == 1
    assert state.history[0].outcome is sm.RoundOutcome.flicker


def test_record_round_counts_blocking_and_clean():
    state = sm.IterativeRunState(max_rounds=2)
    sm.record_round(
        state,
        round_num=1,
        primary=_result(blocking=0),
        verification=None,
        outcome=sm.RoundOutcome.clean,
        transition="terminate.clean",
    )
    assert state.rounds_used == 1


def test_should_terminate_clean_exits():
    state = sm.IterativeRunState(max_rounds=2)
    terminate, label = sm.should_terminate(state, sm.RoundOutcome.clean)
    assert terminate is True
    assert label == "terminate.clean"


def test_should_terminate_confirmed_blocking_exits():
    state = sm.IterativeRunState(max_rounds=2)
    terminate, label = sm.should_terminate(state, sm.RoundOutcome.confirmed_blocking)
    assert terminate is True
    assert label == "terminate.confirmed_blocking"


def test_should_terminate_flicker_continues_until_budget():
    state = sm.IterativeRunState(max_rounds=2)
    # First flicker — under budget, continue.
    terminate, label = sm.should_terminate(state, sm.RoundOutcome.flicker)
    assert terminate is False
    assert label == "continue.flicker"
    # Bump rounds_used to simulate one remediation attempt happening between.
    state.rounds_used = 2
    # Now budget-exhausted; further flicker terminates.
    terminate, label = sm.should_terminate(state, sm.RoundOutcome.flicker)
    assert terminate is True
    assert label == "terminate.budget_exhausted_flicker"


def test_should_terminate_flicker_exits_on_flicker_attempts_cap():
    """FU-rt4 fix: a continuous flicker stream MUST exit even when no
    remediation round ever bumps rounds_used. The flicker_attempts cap is
    what bounds the otherwise-unbounded loop."""
    state = sm.IterativeRunState(max_rounds=2)
    cap = state.max_flicker_attempts
    # Walk the loop manually: every record_round bumps flicker_attempts.
    for _ in range(cap - 1):
        terminate, label = sm.should_terminate(state, sm.RoundOutcome.flicker)
        assert terminate is False
        assert label == "continue.flicker"
        sm.record_round(
            state,
            round_num=1,
            primary=_result(blocking=2),
            verification=_result(blocking=2),
            outcome=sm.RoundOutcome.flicker,
            transition="continue.flicker",
        )
    # One more flicker decision triggers the cap exit.
    terminate, label = sm.should_terminate(state, sm.RoundOutcome.flicker)
    assert terminate is True
    assert label == "terminate.flicker_attempts_exhausted"
    assert state.rounds_used == 0  # remediation never bumped — invariant preserved


def test_should_terminate_degraded_exits_named():
    state = sm.IterativeRunState(max_rounds=3)
    terminate, label = sm.should_terminate(state, sm.RoundOutcome.degraded)
    assert terminate is True
    assert label == "terminate.degraded"


def test_mark_terminated_is_idempotent():
    state = sm.IterativeRunState(max_rounds=1)
    sm.mark_terminated(state, "terminate.clean")
    sm.mark_terminated(state, "terminate.different")
    assert state.terminated is True
    assert state.final_transition == "terminate.clean"


# ---------------------------------------------------------------------------
# Integration: dispatcher-level _run_iterative actually terminates on flicker
# ---------------------------------------------------------------------------


def test_run_iterative_terminates_on_continuous_flicker(monkeypatch):
    """Regression for the FU-rt4 unbounded-flicker bug fixed in PR #430 review.

    Before the fix, _run_iterative would `continue` on flicker without
    bumping any counter, so primary+verification calls that kept
    disagreeing spun forever. With flicker_attempts bounded, the loop
    must terminate after ~max_rounds*2+1 flicker rounds.
    """
    import red_team_dispatch_common as common
    import stark_red_team as rt_module

    call_log: list[str] = []

    def fake_run_one_call(*, stage, artifact, source_spec, cfg, model, model_rates,
                         cwd, telemetry, round_num, call_phase, env):
        call_log.append(call_phase)
        # Every call returns blocking findings with a different concern_hash
        # so _overlap's structured/Jaccard tests both fail and the round
        # classifies as flicker.
        finding = rt_module.RedTeamFinding(
            id="rt1",
            persona="data",
            severity="high",
            concern=f"{call_phase}-{round_num}-{len(call_log)} unique concern text here",
            consequence="x",
            counter_proposal="do something",
            trade_off="something else",
            reason_for_uncertainty=None,
            risk_key=f"risk-{call_phase}-{len(call_log)}",
            affected_component=f"comp-{call_phase}-{len(call_log)}",
            failure_mode="data-loss",
            concern_hash=f"hash-{call_phase}-{len(call_log)}",
        )
        return rt_module.RedTeamResult(
            stage=stage,
            round_num=round_num,
            synthesis="",
            findings=[finding],
            blocking_count=1,
            human_review_count=0,
            raw_output="{}",
            duration_s=0.1,
            cost_usd=0.0,
        )

    monkeypatch.setattr(common, "_run_one_call", fake_run_one_call)

    ctx = rt_module.RedTeamRunContext(
        run_id="run-test",
        stage="design",
        caller="manual",
        repo="evinced/stark-skills",
        artifact_relative_path=None,
        cwd=None,
        env={},
        model_rates={},
        cfg_red_team={},
        per_run_budget_usd=15.0,
        pr_number=None,
        started_at_iso="2026-05-01T00:00:00Z",
    )
    cfg = {
        "personas": list(rt_module.VALID_PERSONA_SLUGS),
        "timeout_s": 60,
        "min_severity_to_block": "high",
        "max_input_chars": 100_000,
        "max_rounds": 2,
        "stability_overlap_jaccard_min": 0.4,
    }

    result, history = common._run_iterative(
        ctx=ctx,
        stage="design",
        artifact="x",
        source_spec="x",
        cfg=cfg,
        model="gpt-5.5-pro",
        model_rates={},
        cwd=None,
        telemetry=None,
    )

    # The loop terminated. Without the fix, this test would run forever.
    assert result is not None
    final_transition = history[-1].transition
    assert final_transition in {
        "terminate.flicker_attempts_exhausted",
        "terminate.budget_exhausted_flicker",
    }, f"unexpected final transition: {final_transition}"
    # Sanity bound: at most max_flicker_attempts flicker rounds.
    flicker_count = sum(1 for r in history if r.outcome is sm.RoundOutcome.flicker)
    assert flicker_count <= sm.IterativeRunState(max_rounds=2).max_flicker_attempts
