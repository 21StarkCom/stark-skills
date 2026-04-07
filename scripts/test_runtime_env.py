#!/usr/bin/env python3
"""Tests for runtime_env.build_agent_env.

TDD: write tests first, then implement runtime_env.py.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path
from unittest.mock import patch

import pytest

# Ensure scripts/ is on path for local imports
sys.path.insert(0, str(Path(__file__).parent))

import runtime_env  # noqa: E402 — fails until implementation exists

# ---------------------------------------------------------------------------
# Test fixtures
# ---------------------------------------------------------------------------

FAKE_TOKEN = "ghs_faketoken12345"

# A controlled environment with allowlisted + non-allowlisted + blocked vars.
CONTROLLED_ENV = {
    # Allowlisted — should pass through
    "PATH": "/usr/bin:/bin",
    "HOME": "/Users/test",
    "USER": "testuser",
    "SHELL": "/bin/zsh",
    "LANG": "en_US.UTF-8",
    "TERM": "xterm-256color",
    # Must NEVER appear in returned env, even though it exists in os.environ
    "ANTHROPIC_API_KEY": "sk-ant-secret-key",
    # Not in allowlist — must not pass through
    "SECRET_TOKEN": "super-secret",
    "MY_CUSTOM_VAR": "custom-value",
}

FAKE_RUNTIME_CFG = {
    "subagent_env_allowlist": [
        "PATH",
        "HOME",
        "USER",
        "SHELL",
        "LANG",
        "TERM",
        "CLAUDE_CODE_USE_VERTEX",
        "ANTHROPIC_VERTEX_PROJECT_ID",
        "CLOUD_ML_REGION",
        "GOOGLE_APPLICATION_CREDENTIALS",
    ],
    "temp_dir_prefix": "stark-env",
    "lock_ttl_minutes": 30,
}

FAKE_FULL_CFG = {
    "github_apps": {
        "claude": "stark-claude",
        "codex": "stark-codex",
        "gemini": "stark-gemini",
    }
}


@pytest.fixture(autouse=True)
def _patch_config():
    """Patch config_loader and os.environ for every test."""
    with (
        patch("runtime_env.get_runtime_config", return_value=FAKE_RUNTIME_CFG),
        patch("runtime_env.load_config", return_value=FAKE_FULL_CFG),
        patch.dict(os.environ, CONTROLLED_ENV, clear=True),
    ):
        yield


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


def test_review_operation_includes_gh_token():
    """build_agent_env('claude', 'review') must include GH_TOKEN."""
    with patch("runtime_env.github_app.get_token", return_value=FAKE_TOKEN):
        env = runtime_env.build_agent_env("claude", "review")
    assert env.get("GH_TOKEN") == FAKE_TOKEN


@pytest.mark.parametrize(
    ("agent", "expected_app"),
    [
        ("claude", "stark-claude"),
        ("codex", "stark-codex"),
        ("gemini", "stark-gemini"),
    ],
)
def test_review_operation_uses_agent_specific_app(agent: str, expected_app: str):
    """Review envs must request the matching GitHub App token for each agent."""
    with patch("runtime_env.github_app.get_token", return_value=FAKE_TOKEN) as mock_tok:
        env = runtime_env.build_agent_env(agent, "review")
    assert env.get("GH_TOKEN") == FAKE_TOKEN
    mock_tok.assert_called_once_with(app=expected_app)


def test_pr_create_operation_excludes_gh_token():
    """build_agent_env('claude', 'pr_create') must NOT include GH_TOKEN."""
    with patch("runtime_env.github_app.get_token", return_value=FAKE_TOKEN) as mock_tok:
        env = runtime_env.build_agent_env("claude", "pr_create")
    assert "GH_TOKEN" not in env
    mock_tok.assert_not_called()


def test_issue_ops_operation_excludes_gh_token():
    """build_agent_env('claude', 'issue_ops') must NOT include GH_TOKEN."""
    with patch("runtime_env.github_app.get_token", return_value=FAKE_TOKEN) as mock_tok:
        env = runtime_env.build_agent_env("claude", "issue_ops")
    assert "GH_TOKEN" not in env
    mock_tok.assert_not_called()


def test_anthropic_api_key_never_present():
    """ANTHROPIC_API_KEY must never appear for any operation."""
    with patch("runtime_env.github_app.get_token", return_value=FAKE_TOKEN):
        for op in ("review", "pr_create", "issue_ops", "unknown_op"):
            env = runtime_env.build_agent_env("claude", op)
            assert "ANTHROPIC_API_KEY" not in env, (
                f"ANTHROPIC_API_KEY leaked for op={op!r}"
            )


def test_only_allowlisted_vars_passed_through():
    """Only allowlisted + injected vars should appear in the returned env."""
    with patch("runtime_env.github_app.get_token", return_value=FAKE_TOKEN):
        env = runtime_env.build_agent_env("claude", "review")
    # Non-allowlisted vars must not be present
    assert "SECRET_TOKEN" not in env
    assert "MY_CUSTOM_VAR" not in env
    assert "ANTHROPIC_API_KEY" not in env
    # Allowlisted vars from CONTROLLED_ENV must be present
    assert env["PATH"] == "/usr/bin:/bin"
    assert env["HOME"] == "/Users/test"
    assert env["USER"] == "testuser"


def test_unknown_operation_defaults_to_no_gh_token(capsys):
    """Unknown operations must default to no GH_TOKEN and emit a warning."""
    with patch("runtime_env.github_app.get_token", return_value=FAKE_TOKEN) as mock_tok:
        env = runtime_env.build_agent_env("claude", "unknown_op")
    assert "GH_TOKEN" not in env
    mock_tok.assert_not_called()
    captured = capsys.readouterr()
    assert "unknown_op" in captured.err
