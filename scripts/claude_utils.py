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

try:
    from runtime_env import build_agent_env
except ImportError:  # pragma: no cover - backward compat for older installs
    build_agent_env = None

# Default model — pinned to avoid drift when the CLI default changes.
CLAUDE_MODEL = "claude-opus-4-6"


class AgentDisabledError(RuntimeError):
    pass

# Vertex AI config for headless sub-agent dispatch.
# Bypasses OAuth login — uses ADC (gcloud auth application-default login).
# Global region required for latest model versions (opus-4-6, sonnet-4-6).
_VERTEX_ENV = {
    "CLAUDE_CODE_USE_VERTEX": "1",
    "ANTHROPIC_VERTEX_PROJECT_ID": "infra-ai-platform",
    "CLOUD_ML_REGION": "global",
}

# Env vars that must NOT leak into CLI subprocesses.
_STRIPPED_ENV_VARS = {"ANTHROPIC_API_KEY"}
_ANTHROPIC_PREFIX = "ANTHROPIC_"
_ANTHROPIC_ALLOWED = {"ANTHROPIC_CODE_CLI", "ANTHROPIC_VERTEX_PROJECT_ID"}


def make_clean_env() -> dict[str, str]:
    """Return a copy of os.environ with Vertex AI config for headless dispatch.

    Strips ANTHROPIC_API_KEY and project-specific Anthropic vars, then
    injects Vertex AI env vars so sub-agents authenticate via ADC
    instead of requiring interactive OAuth login.
    """
    if build_agent_env is not None:
        return build_agent_env("claude", "review")

    env = {
        k: v for k, v in os.environ.items()
        if k not in _STRIPPED_ENV_VARS
        and not (k.startswith(_ANTHROPIC_PREFIX) and k not in _ANTHROPIC_ALLOWED)
    }
    env.update(_VERTEX_ENV)
    return env


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
