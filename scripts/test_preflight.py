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
        "codex": {"enabled": True, "model_id": "gpt-5.4"},
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
        "codex": {"enabled": True, "model_id": "gpt-5.4"},
        "gemini": {"enabled": True, "model_id": "gemini-3.1-pro-preview"},
    }
    p1, p2 = _patch_models_and_dispatch(models, ["claude", "codex"])
    with p1, p2:
        status, message = preflight.check_model_resolution()
    assert status == "warn"
    assert "dispatched agents: ['claude', 'codex']" in message
    assert "enabled but excluded from config.agents (silently skipped): ['gemini']" in message


def test_check_model_resolution_warns_when_rotation_lists_disabled_agent() -> None:
    models = {
        "claude": {"enabled": True, "model_id": "claude-opus-4-7"},
        "codex": {"enabled": False, "model_id": "gpt-5.4"},
    }
    p1, p2 = _patch_models_and_dispatch(models, ["claude", "codex"])
    with p1, p2:
        status, message = preflight.check_model_resolution()
    assert status == "warn"
    assert "dispatched agents: ['claude']" in message
    assert "in config.agents but not enabled in models" in message


def test_check_model_resolution_fails_when_intersection_is_empty() -> None:
    models = {
        "claude": {"enabled": True, "model_id": "claude-opus-4-7"},
        "codex": {"enabled": True, "model_id": "gpt-5.4"},
    }
    # Rotation lists only gemini; intersection with enabled is empty.
    p1, p2 = _patch_models_and_dispatch(models, ["gemini"])
    with p1, p2:
        status, message = preflight.check_model_resolution()
    assert status == "fail"
    assert "no agents would dispatch" in message


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
        "codex": {"enabled": False, "model_id": "gpt-5.4"},
    }
    p1, p2 = _patch_models_and_dispatch(models, ["claude", "codex"])
    with p1, p2:
        status, message = preflight.check_model_resolution()
    assert status == "fail"
    assert message == "no enabled agents in config"


def test_check_model_resolution_falls_back_when_discover_config_unavailable() -> None:
    """If dispatcher_base import fails (older install), report legacy format."""
    models = {
        "claude": {"enabled": True, "model_id": "claude-opus-4-7"},
        "codex": {"enabled": True, "model_id": "gpt-5.4"},
        "gemini": {"enabled": False, "model_id": "gemini-2.5-pro"},
    }
    with patch("preflight.get_models_config", return_value=models), \
         patch("dispatcher_base.discover_config", side_effect=ImportError("missing")):
        status, message = preflight.check_model_resolution()
    assert status == "pass"
    assert message == "enabled agents: ['claude', 'codex']; disabled agents: ['gemini']"
