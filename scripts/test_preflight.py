#!/usr/bin/env python3
from __future__ import annotations

from unittest.mock import patch

import preflight


def _patch_models_and_dispatch(models: dict, agents: list[str] | None):
    """Helper: stub both knobs preflight reads (models config + dispatch rotation)."""
    cfg = {"agents": agents} if agents is not None else {}
    return (
        patch("preflight.get_models_config", return_value=models),
        patch("dispatcher_base.discover_config", return_value=cfg),
    )


def test_check_model_resolution_passes_when_dispatch_matches_enabled() -> None:
    models = {
        "claude": {"enabled": True, "model_id": "claude-opus-4-7"},
        "codex": {"enabled": True, "model_id": "gpt-5.5"},
        "gemini": {"enabled": False, "model_id": "gemini-2.5-pro"},
    }
    p1, p2 = _patch_models_and_dispatch(models, ["claude", "codex"])
    with p1, p2:
        status, message = preflight.check_model_resolution()
    assert status == "pass"
    assert "dispatched agents: ['claude', 'codex']" in message
    # Disabled gemini should be reported but not as a misalignment warning.
    assert "disabled in models: ['gemini']" in message


def test_check_model_resolution_warns_when_enabled_agent_excluded_from_rotation() -> None:
    """Regression: gemini was reported as enabled but ``config.agents``
    excluded it, so team review produced 0 gemini runs while preflight
    advertised gemini as ready. Misalignment must surface as 'warn'."""
    models = {
        "claude": {"enabled": True, "model_id": "claude-opus-4-7"},
        "codex": {"enabled": True, "model_id": "gpt-5.5"},
        "gemini": {"enabled": True, "model_id": "gemini-3.1-pro-preview"},
    }
    p1, p2 = _patch_models_and_dispatch(models, ["claude", "codex"])
    with p1, p2:
        status, message = preflight.check_model_resolution()
    assert status == "warn"
    assert "dispatched agents: ['claude', 'codex']" in message
    assert "enabled but excluded from config.agents (silently skipped): ['gemini']" in message


def test_check_model_resolution_passes_when_rotation_lists_disabled_agent() -> None:
    """An agent listed in ``config.agents`` but disabled in models is
    dropped silently and *intentionally* by the dispatcher — that's
    not a misalignment worth flagging. Only the surprising direction
    (enabled but excluded from rotation) warrants ``warn``."""
    models = {
        "claude": {"enabled": True, "model_id": "claude-opus-4-7"},
        "codex": {"enabled": False, "model_id": "gpt-5.5"},
    }
    p1, p2 = _patch_models_and_dispatch(models, ["claude", "codex"])
    with p1, p2:
        status, message = preflight.check_model_resolution()
    assert status == "pass"
    assert "dispatched agents: ['claude']" in message
    assert "in config.agents but not enabled in models" not in message


def test_check_model_resolution_warns_on_empty_intersection_for_single_agent_workflow() -> None:
    """For non-team workflows, empty rotation/enabled overlap is a
    ``warn`` — single-agent flows (``--agent`` / ``domain_agents``)
    bypass ``config.agents`` and can still dispatch."""
    models = {
        "claude": {"enabled": True, "model_id": "claude-opus-4-7"},
        "codex": {"enabled": True, "model_id": "gpt-5.5"},
    }
    p1, p2 = _patch_models_and_dispatch(models, ["gemini"])
    with p1, p2:
        status, message = preflight.check_model_resolution(workflow="stark-review")
    assert status == "warn"
    assert "no agents in the team-review intersection" in message
    assert "single-agent dispatch may still work" in message


def test_check_model_resolution_fails_on_empty_intersection_for_team_workflow() -> None:
    """For team-review workflows, empty intersection is a hard fail.
    A clean 0-finding round produced by an empty rotation is worse
    than blocking the run, because the operator might think the PR
    actually passed review."""
    models = {
        "claude": {"enabled": True, "model_id": "claude-opus-4-7"},
        "codex": {"enabled": True, "model_id": "gpt-5.5"},
    }
    p1, p2 = _patch_models_and_dispatch(models, ["gemini"])
    with p1, p2:
        status, message = preflight.check_model_resolution(workflow="stark-team-review")
    assert status == "fail"
    assert "team-review has no dispatchable agents" in message


def test_check_model_resolution_warns_on_malformed_config_agents_for_single_agent() -> None:
    """A misformatted ``config.agents`` (string instead of list, etc.)
    is a ``warn`` for single-agent flows — they can dispatch via
    ``--agent`` / ``domain_agents`` even with broken rotation config —
    but a hard ``fail`` for team-review (covered separately)."""
    models = {
        "claude": {"enabled": True, "model_id": "claude-opus-4-7"},
        "codex": {"enabled": True, "model_id": "gpt-5.5"},
    }
    p1, p2 = _patch_models_and_dispatch(models, "claude,codex")  # type: ignore[arg-type]
    with p1, p2:
        status, message = preflight.check_model_resolution(workflow="stark-review")
    assert status == "warn"
    assert "config.agents is malformed" in message
    # The raw value must NOT be embedded — it lands in preflight.jsonl
    # and the durable event queue, where a misconfigured entry could
    # leak operator paste. Only type info is allowed.
    assert "claude,codex" not in message
    assert "expected list[str]" in message
    assert "got str" in message


def test_check_model_resolution_fails_on_malformed_config_agents_for_team_review() -> None:
    """For team-review, a malformed ``config.agents`` is a hard fail.
    review_pr() iterates the malformed value and ends up dispatching
    zero agents — a clean 0-finding round masquerading as success."""
    models = {
        "claude": {"enabled": True, "model_id": "claude-opus-4-7"},
        "codex": {"enabled": True, "model_id": "gpt-5.5"},
    }
    p1, p2 = _patch_models_and_dispatch(models, {"not": "a list"})  # type: ignore[arg-type]
    with p1, p2:
        status, message = preflight.check_model_resolution(workflow="stark-team-review")
    assert status == "fail"
    assert "config.agents is malformed" in message


def test_check_model_resolution_warns_on_discover_config_failure() -> None:
    """A non-ImportError raised by ``discover_config`` (e.g. malformed
    JSON, unreadable file) must not be swallowed."""
    models = {
        "claude": {"enabled": True, "model_id": "claude-opus-4-7"},
        "codex": {"enabled": True, "model_id": "gpt-5.5"},
    }
    with patch("preflight.get_models_config", return_value=models), \
         patch("dispatcher_base.discover_config", side_effect=RuntimeError("bad config")):
        status, message = preflight.check_model_resolution()
    assert status == "warn"
    assert "could not load review config" in message
    assert "bad config" in message


def test_check_model_resolution_warns_on_transitive_import_error() -> None:
    """An ImportError raised from inside ``dispatcher_base`` (e.g. one
    of its own dependencies missing) is NOT the same as
    ``dispatcher_base`` itself being absent. The legacy fallback only
    applies when ``dispatcher_base`` itself can't be resolved."""
    import sys
    models = {
        "claude": {"enabled": True, "model_id": "claude-opus-4-7"},
        "codex": {"enabled": True, "model_id": "gpt-5.5"},
    }
    saved = sys.modules.pop("dispatcher_base", None)

    class _BrokenLoader:
        def find_spec(self, name, *_args, **_kwargs):
            if name == "dispatcher_base":
                # Raise ImportError but with name pointing at a *different*
                # module — the dispatcher_base loader exists but
                # transitive imports failed.
                raise ImportError("config_loader missing", name="config_loader")
            return None

    sys.meta_path.insert(0, _BrokenLoader())
    try:
        with patch("preflight.get_models_config", return_value=models):
            status, message = preflight.check_model_resolution()
    finally:
        sys.meta_path.pop(0)
        if saved is not None:
            sys.modules["dispatcher_base"] = saved
    assert status == "warn"
    assert "could not import dispatcher_base" in message


def test_check_model_resolution_passes_when_config_agents_absent() -> None:
    """No ``agents`` key in merged config means "use all enabled" — a
    valid steady state, not a misalignment."""
    models = {
        "claude": {"enabled": True, "model_id": "claude-opus-4-7"},
        "codex": {"enabled": True, "model_id": "gpt-5.5"},
    }
    p1, p2 = _patch_models_and_dispatch(models, None)
    with p1, p2:
        status, message = preflight.check_model_resolution()
    assert status == "pass"
    assert "dispatched agents: ['claude', 'codex']" in message


# ---------------------------------------------------------------------------
# run_preflight() integration — verifies the warn status from
# check_model_resolution propagates to overall=degraded /
# recommended_mode=single-agent. Without this, a wiring regression that
# stopped translating "warn" to "degraded" would still pass the
# function-level tests above.
# ---------------------------------------------------------------------------


def _replace_checks_with_target(
    monkeypatch, target_name: str, target_fn, target_critical: bool
):
    """Monkey-patch ``_CHECKS`` to a 2-element list: a stubbed pass-only
    check plus the test target. Patching individual check function names
    on the preflight module isn't enough — _CHECKS holds direct
    references to the original callables, not name lookups."""
    stub_checks = [
        ("check_stub_pass", lambda: ("pass", "stubbed"), False),
        (target_name, target_fn, target_critical),
    ]
    monkeypatch.setattr(preflight, "_CHECKS", stub_checks)


def test_run_preflight_propagates_warn_to_degraded(monkeypatch) -> None:
    """Misalignment warn at the check level → overall=degraded at the
    aggregate level → recommended_mode=single-agent."""
    _replace_checks_with_target(
        monkeypatch,
        "check_model_resolution",
        lambda _workflow=None: ("warn", "dispatched agents: ['claude']; enabled but excluded ['gemini']"),
        True,
    )
    result = preflight.run_preflight("stark-review")
    assert result.overall == "degraded"
    assert result.recommended_mode == "single-agent"
    mr = next(c for c in result.checks if c["name"] == "check_model_resolution")
    assert mr["status"] == "warn"


def test_run_preflight_propagates_critical_fail_to_blocked(monkeypatch) -> None:
    """check_model_resolution is critical=True; a fail blocks the run."""
    _replace_checks_with_target(
        monkeypatch,
        "check_model_resolution",
        lambda _workflow=None: ("fail", "missing agent config: ['codex']"),
        True,
    )
    result = preflight.run_preflight("stark-team-review")
    assert result.overall == "blocked"
    assert result.recommended_mode == "abort"
    mr = next(c for c in result.checks if c["name"] == "check_model_resolution")
    assert mr["status"] == "fail"


def test_run_preflight_passes_workflow_to_check_model_resolution(monkeypatch) -> None:
    """The workflow argument must propagate so empty-intersection
    severity is correct (fail for team-review, warn otherwise)."""
    seen_workflows: list[str | None] = []

    def stub(workflow=None):
        seen_workflows.append(workflow)
        return ("pass", "stubbed")

    _replace_checks_with_target(monkeypatch, "check_model_resolution", stub, True)
    preflight.run_preflight("stark-team-review")
    assert seen_workflows == ["stark-team-review"]


def test_check_model_resolution_fails_when_required_agent_missing() -> None:
    with patch(
        "preflight.get_models_config",
        return_value={"claude": {"enabled": True, "model_id": "claude-opus-4-7"}},
    ):
        status, message = preflight.check_model_resolution()
    assert status == "fail"
    assert "codex" in message


def test_check_model_resolution_fails_when_all_agents_disabled() -> None:
    models = {
        "claude": {"enabled": False, "model_id": "claude-opus-4-7"},
        "codex": {"enabled": False, "model_id": "gpt-5.5"},
    }
    p1, p2 = _patch_models_and_dispatch(models, ["claude", "codex"])
    with p1, p2:
        status, message = preflight.check_model_resolution()
    assert status == "fail"
    assert message == "no enabled agents in config"


def test_check_model_resolution_falls_back_when_discover_config_unavailable(monkeypatch) -> None:
    """If ``dispatcher_base`` can't be imported (older install), report
    legacy format. The ``import dispatcher_base`` happens inside the
    function under test, so we have to perturb ``sys.modules`` rather
    than patch the attribute."""
    import sys
    models = {
        "claude": {"enabled": True, "model_id": "claude-opus-4-7"},
        "codex": {"enabled": True, "model_id": "gpt-5.5"},
        "gemini": {"enabled": False, "model_id": "gemini-2.5-pro"},
    }

    # Force a fresh ImportError on the in-function import.
    saved = sys.modules.pop("dispatcher_base", None)

    class _Blocker:
        def find_spec(self, name, *_args, **_kwargs):
            if name == "dispatcher_base":
                # The legacy-fallback path is triggered by an
                # ImportError whose `name` attribute is exactly
                # ``dispatcher_base``. Anything else routes through
                # the transitive-import warn path.
                raise ImportError("simulated absence", name="dispatcher_base")
            return None

    blocker = _Blocker()
    sys.meta_path.insert(0, blocker)
    try:
        with patch("preflight.get_models_config", return_value=models):
            status, message = preflight.check_model_resolution()
    finally:
        sys.meta_path.remove(blocker)
        if saved is not None:
            sys.modules["dispatcher_base"] = saved
    assert status == "pass"
    assert message == "enabled agents: ['claude', 'codex']; disabled agents: ['gemini']"
