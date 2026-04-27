"""Wrapper-level integration tests: red-team callers must surface
`error` as final status, not as `clean`. Round-3 finding 1 — derive_status
itself is unit-tested but no test exercises the wrappers, so a future
refactor that brings back count-based status would silently regress.
"""

from __future__ import annotations

import stark_red_team as rt


def _err_result() -> rt.RedTeamResult:
    return rt.RedTeamResult(
        stage="design", round_num=1, synthesis="",
        findings=[], blocking_count=0, human_review_count=0,
        raw_output="", duration_s=0.5, error="parse failed",
    )


def _clean_result() -> rt.RedTeamResult:
    return rt.RedTeamResult(
        stage="design", round_num=1, synthesis="",
        findings=[], blocking_count=0, human_review_count=0,
        raw_output='{"synthesis":"","findings":[]}', duration_s=0.5,
    )


def test_forged_review_wrapper_returns_error_status_for_parse_error(monkeypatch):
    import forged_review_dispatch
    import stark_red_team as _rt

    monkeypatch.setattr(_rt, "run_red_team", lambda **_: _err_result())
    monkeypatch.setattr(
        "config_loader.get_red_team_config",
        lambda: {
            "enabled": True,
            "stages": {"design": {"enabled": True}},
            "personas": list(rt.VALID_PERSONA_SLUGS),
            "model": "gpt-5.5-pro",
            "timeout_s": 60,
            "min_severity_to_block": "high",
            "max_input_chars": 200_000,
        },
    )
    monkeypatch.setattr(
        "config_loader.get_model_rates",
        lambda: {"_fallback": {"input_per_1m_usd": 0, "output_per_1m_usd": 0}},
    )

    out = forged_review_dispatch.dispatch_red_team_for_stage(
        stage="design", artifact="A", source_spec="S", pr_diff=None,
        cwd=None, run_id="r1",
    )
    assert out["status"] == "error"


def test_forged_review_wrapper_returns_clean_when_no_findings_and_no_error(monkeypatch):
    import forged_review_dispatch
    import stark_red_team as _rt

    monkeypatch.setattr(_rt, "run_red_team", lambda **_: _clean_result())
    monkeypatch.setattr(
        "config_loader.get_red_team_config",
        lambda: {
            "enabled": True,
            "stages": {"design": {"enabled": True}},
            "personas": list(rt.VALID_PERSONA_SLUGS),
            "model": "gpt-5.5-pro",
            "timeout_s": 60,
            "min_severity_to_block": "high",
            "max_input_chars": 200_000,
        },
    )
    monkeypatch.setattr(
        "config_loader.get_model_rates",
        lambda: {"_fallback": {"input_per_1m_usd": 0, "output_per_1m_usd": 0}},
    )

    out = forged_review_dispatch.dispatch_red_team_for_stage(
        stage="design", artifact="A", source_spec="S", pr_diff=None,
        cwd=None, run_id="r1",
    )
    assert out["status"] == "clean"
