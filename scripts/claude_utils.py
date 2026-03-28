"""Shared utilities for Claude Code CLI integration.

Constants and helpers used across all dispatch scripts that invoke the Claude CLI.
"""

from __future__ import annotations

# Default model — pinned to avoid drift when the CLI default changes.
CLAUDE_MODEL = "claude-opus-4-6"


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
