"""Shared utilities for Claude Code CLI integration.

Constants and helpers used across all dispatch scripts that invoke the Claude CLI.
"""

from __future__ import annotations

import os

# Default model — pinned to avoid drift when the CLI default changes.
CLAUDE_MODEL = "claude-sonnet-4-6"

# Vertex AI config for headless sub-agent dispatch.
# Bypasses OAuth login — uses ADC (gcloud auth application-default login).
_VERTEX_ENV = {
    "CLAUDE_CODE_USE_VERTEX": "1",
    "ANTHROPIC_VERTEX_PROJECT_ID": "development-222850",
    "CLOUD_ML_REGION": "us-east5",
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
    cmd = [
        "claude",
        "-p", "-",
        "--output-format", output_format,
        "--model", CLAUDE_MODEL,
        "--no-session-persistence",
    ]
    if allowed_tools:
        cmd += ["--allowedTools", allowed_tools]
    return cmd
