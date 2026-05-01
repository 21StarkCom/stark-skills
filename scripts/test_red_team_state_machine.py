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
