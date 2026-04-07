#!/usr/bin/env python3
from __future__ import annotations

from unittest.mock import patch

import preflight


def test_check_model_resolution_reports_enabled_and_disabled_agents() -> None:
    with patch(
        "preflight.get_models_config",
        return_value={
            "claude": {"enabled": True, "model_id": "claude-sonnet-4-6"},
            "codex": {"enabled": True, "model_id": "gpt-5.4"},
            "gemini": {"enabled": False, "model_id": "gemini-2.5-pro"},
        },
    ):
        status, message = preflight.check_model_resolution()

    assert status == "pass"
    assert message == "enabled agents: ['claude', 'codex']; disabled agents: ['gemini']"


def test_check_model_resolution_fails_when_required_agent_missing() -> None:
    with patch(
        "preflight.get_models_config",
        return_value={"claude": {"enabled": True, "model_id": "claude-sonnet-4-6"}},
    ):
        status, message = preflight.check_model_resolution()

    assert status == "fail"
    assert "codex" in message


def test_check_model_resolution_fails_when_all_agents_disabled() -> None:
    with patch(
        "preflight.get_models_config",
        return_value={
            "claude": {"enabled": False, "model_id": "claude-sonnet-4-6"},
            "codex": {"enabled": False, "model_id": "gpt-5.4"},
        },
    ):
        status, message = preflight.check_model_resolution()

    assert status == "fail"
    assert message == "no enabled agents in config"
