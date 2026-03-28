"""Shared utilities for Codex CLI integration.

Constants and helpers used across all dispatch scripts that invoke the Codex CLI.
"""

import json

# Default model — pinned to avoid silent changes from CLI updates.
CODEX_MODEL = "gpt-5.4"

# Reasoning effort config for -c flag (TOML key=value format).
CODEX_REASONING_EFFORT_HIGH = 'model_reasoning_effort="high"'
CODEX_REASONING_EFFORT_MEDIUM = 'model_reasoning_effort="medium"'


def parse_jsonl_output(raw: str) -> str:
    """Extract assistant text from Codex --json JSONL output.

    Codex ``--json`` emits newline-delimited JSON events to stdout.
    This function extracts text from ``item.completed`` events covering
    both the current format (``agent_message``) and the legacy format
    (``message`` with ``content[].output_text``).

    Returns the concatenated text, or the original *raw* string unchanged
    if no JSONL events are detected.
    """
    if not raw.strip().startswith("{"):
        return raw

    parts: list[str] = []
    for line in raw.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            ev = json.loads(line)
            if ev.get("type") == "item.completed":
                item = ev.get("item", {})
                itype = item.get("type", "")
                # Current format: type=agent_message, text=...
                if itype == "agent_message":
                    text = item.get("text", "")
                    if text:
                        parts.append(text)
                # Legacy format: type=message, content=[{type:output_text,text:...}]
                elif itype == "message":
                    for c in item.get("content", []):
                        if c.get("type") == "output_text":
                            parts.append(c.get("text", ""))
        except json.JSONDecodeError:
            continue

    return "\n".join(parts) if parts else raw
