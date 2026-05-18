"""Shared utilities for Claude Code CLI integration.

Constants and helpers used across all dispatch scripts that invoke the Claude CLI.
"""

from __future__ import annotations

import os

try:
    from config_loader import get_model_id, is_agent_enabled
except ImportError:  # pragma: no cover - backward compat for older installs
    def get_model_id(agent: str) -> str | None:
        return None

    def is_agent_enabled(agent: str) -> bool:
        return True

# Default model — pinned to avoid drift when the CLI default changes.
CLAUDE_MODEL = "claude-opus-4-7"


class AgentDisabledError(RuntimeError):
    pass

# Source env var holding the Anthropic API key for headless dispatch.
# The value is injected into subprocesses as ANTHROPIC_API_KEY.
_API_KEY_SOURCE_VAR = "ANTHROPIC_AGENTS"

# Env vars from the host that must NOT leak into CLI subprocesses.
# ANTHROPIC_API_KEY: a stale user key would override the injected one.
# ANTHROPIC_AGENTS: internal only; subprocess sees it as ANTHROPIC_API_KEY.
_STRIPPED_ENV_VARS = {"ANTHROPIC_API_KEY", _API_KEY_SOURCE_VAR}
_ANTHROPIC_PREFIX = "ANTHROPIC_"
_ANTHROPIC_ALLOWED = {"ANTHROPIC_CODE_CLI"}


def _get_api_key() -> str:
    """Read the Anthropic API key from the configured source env var."""
    key = os.environ.get(_API_KEY_SOURCE_VAR)
    if not key:
        raise AgentDisabledError(
            f"{_API_KEY_SOURCE_VAR} not set in environment. "
            "Source your Anthropic key file (e.g. "
            "`source \"$HOME/Code/.private/API Keys/.anthropic.key\"`) "
            "before running Claude sub-agents."
        )
    return key


def make_clean_env() -> dict[str, str]:
    """Return an allowlisted env with Anthropic API key for headless dispatch.

    Delegates to ``runtime_env.build_agent_env("claude", "local")`` so the
    subprocess sees only the allowlisted vars (no leaked host secrets) and
    ANTHROPIC_API_KEY sourced from ANTHROPIC_AGENTS. The "local" operation
    is in ``_USER_AUTH_OPS`` so no GitHub App token is fetched — used by
    callers that don't touch GitHub (e.g. forge_fix_loop).

    The hand-rolled fallback below preserves behavior when ``runtime_env``
    is unavailable (older installs that haven't been fully updated).
    """
    try:
        from runtime_env import build_agent_env  # noqa: PLC0415
    except ImportError:
        env = {
            k: v for k, v in os.environ.items()
            if k not in _STRIPPED_ENV_VARS
            and not (k.startswith(_ANTHROPIC_PREFIX) and k not in _ANTHROPIC_ALLOWED)
        }
        env["ANTHROPIC_API_KEY"] = _get_api_key()
        return env
    return build_agent_env("claude", "local")


def build_claude_cmd(
    *,
    output_format: str = "text",
    allowed_tools: str | None = None,
) -> list[str]:
    """Build a Claude CLI command for headless one-shot execution.

    Returns the base command list. Caller appends stdin marker (``-``)
    or a literal prompt as needed.

    Args:
        output_format: "text" or "json" (default "text").
        allowed_tools: Comma-separated tool allowlist (e.g. "Edit,Write,Read,Bash").
            If None, Claude runs with default permissions (no tool auto-approval).
    """
    if not is_agent_enabled("claude"):
        raise AgentDisabledError("claude agent is disabled in config")
    model_id = get_model_id("claude") or CLAUDE_MODEL
    cmd = [
        "claude",
        "-p", "-",
        "--output-format", output_format,
        "--model", model_id,
        "--no-session-persistence",
    ]
    if allowed_tools:
        cmd += ["--allowedTools", allowed_tools]
    return cmd
