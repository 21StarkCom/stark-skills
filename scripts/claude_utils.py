"""Shared utilities for Claude Code CLI integration.

Constants and helpers used across all dispatch scripts that invoke the Claude CLI.
"""

from __future__ import annotations

import os

# Default model — pinned to avoid drift when the CLI default changes.
CLAUDE_MODEL = "claude-opus-4-6"

# Env vars that must NOT leak into CLI subprocesses.
# Purpose-specific Anthropic keys (e.g., ANTHROPIC_VECTOR_INSIGHTS) are for
# services like embedding pipelines — the CLI should use its own OAuth auth
# or the ANTHROPIC_CODE_CLI key, not a service key loaded from a project .env.
_STRIPPED_ENV_VARS = {"ANTHROPIC_API_KEY"}
_ANTHROPIC_PREFIX = "ANTHROPIC_"
_ANTHROPIC_ALLOWED = {"ANTHROPIC_CODE_CLI"}


def make_clean_env() -> dict[str, str]:
    """Return a copy of os.environ without project-specific Anthropic keys.

    Strips ANTHROPIC_API_KEY and any ANTHROPIC_* vars that aren't
    ANTHROPIC_CODE_CLI, so CLI subprocesses (claude, codex) use their
    own auth rather than a service key loaded from a project .env file.
    """
    return {
        k: v for k, v in os.environ.items()
        if k not in _STRIPPED_ENV_VARS
        and not (k.startswith(_ANTHROPIC_PREFIX) and k not in _ANTHROPIC_ALLOWED)
    }


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
