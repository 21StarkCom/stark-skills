"""Skill documentation generation — minimal compatibility shim.

The full multi-LLM documentation generator that lived here was removed in
commit ``fdb1856`` (chore: remove 16 unused skills and their infrastructure).
This module survives as a SHIM so two pre-existing callers can still import
their data contracts: ``scripts/tournament.py`` (which pulls in ``VizResult``
plus the prompt/response helpers via a lazy import) and
``scripts/test_dispatch_routing.py`` (which references ``SkillData``,
``build_generation_prompt``, and ``_parse_viz_response`` for routing tests).

It is NOT a public CLI, NOT the original generator, and SHOULD NOT be used
as a starting point for re-implementing the tool. If a future change needs
the full generator back, treat this file as a contract surface and put the
real implementation in a separate module.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any


@dataclass
class SkillData:
    name: str
    description: str
    argument_hint: str
    complexity: str
    line_count: int
    raw_md: str


@dataclass
class VizResult:
    agent: str
    skill: str
    audience: str
    html: str = ""
    mermaid: str = ""
    doc_content: str = ""
    alt_text: str = ""
    error: str | None = None
    duration_s: float = 0.0
    api_key_fallback: bool = False


def build_generation_prompt(skill: SkillData, audience: str, css: str) -> str:
    payload = {
        "skill": {
            "name": skill.name,
            "description": skill.description,
            "argument_hint": skill.argument_hint,
            "complexity": skill.complexity,
            "line_count": skill.line_count,
            "raw_md": skill.raw_md,
        },
        "audience": audience,
        "css": css,
    }
    return (
        "Generate editable skill documentation visualization artifacts as JSON "
        "with keys html, mermaid, doc_content, and alt_text.\n\n"
        + json.dumps(payload, sort_keys=True)
    )


def _parse_viz_response(raw: str) -> dict[str, Any]:
    text = (raw or "").strip()
    if text.startswith("```"):
        parts = text.split("```")
        for part in parts:
            candidate = part.strip()
            if candidate.startswith("json"):
                candidate = candidate[4:].strip()
            if candidate.startswith("{"):
                text = candidate
                break
    try:
        parsed = json.loads(text)
    except (json.JSONDecodeError, ValueError):
        parsed = {}
    return {
        "html": str(parsed.get("html") or ""),
        "mermaid": str(parsed.get("mermaid") or ""),
        "doc_content": str(parsed.get("doc_content") or ""),
        "alt_text": str(parsed.get("alt_text") or ""),
    }
