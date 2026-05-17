#!/usr/bin/env python3
"""Contextual skill suggestions — surfaces underused skills at relevant moments.

CLI:
    python3 scripts/skill_router.py --context TYPE [--json]

TYPE is one of: review, implementation, session, debug
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

import config_loader
from _emit import emit_event

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

SKILL_USAGE_PATH = Path.home() / ".claude" / "code-review" / "history" / "skill-usage.json"

VALID_CONTEXTS = {"review", "implementation", "session", "debug"}

CONTEXT_SKILLS: dict[str, list[str]] = {
    "review":         ["stark-review-improvement"],
    "implementation": ["stark-init-docs"],
    "session":        ["stark-housekeeping"],
    "debug":          ["stark-review"],
}

# ---------------------------------------------------------------------------
# Skill usage loading
# ---------------------------------------------------------------------------


def _load_skill_usage() -> dict:
    """Load skill-usage.json. Returns empty structure if missing or unreadable."""
    if not SKILL_USAGE_PATH.exists():
        return {}
    try:
        with SKILL_USAGE_PATH.open("r", encoding="utf-8") as fh:
            data = json.load(fh)
        if not isinstance(data, dict):
            return {}
        return data
    except (OSError, json.JSONDecodeError):
        return {}


# ---------------------------------------------------------------------------
# Core routing logic
# ---------------------------------------------------------------------------


def compute_suggestions(context: str) -> dict:
    """Compute skill suggestions for the given context.

    Returns a dict matching the --json output schema.
    """
    cfg = config_loader.get_skill_activation_config()
    max_suggestions: int = int(cfg.get("max_suggestions", 2))
    cooldown_hours: float = float(cfg.get("cooldown_hours", 24))
    suppressed: list[str] = list(cfg.get("suppressed_skills", []))
    suggest_after_review_rounds: int = int(cfg.get("suggest_after_review_rounds", 3))

    usage = _load_skill_usage()
    by_skill: dict[str, int] = usage.get("by_skill", {}) if isinstance(usage, dict) else {}
    generated_at_str: str | None = usage.get("generated_at") if isinstance(usage, dict) else None

    now = datetime.now(timezone.utc)

    # Parse generated_at from usage file
    hours_since_file: float = cooldown_hours + 1  # default: treat as old (beyond cooldown)
    generated_at_dt: datetime | None = None
    if generated_at_str:
        try:
            # Handle both "Z" suffix and "+00:00"
            generated_at_dt = datetime.fromisoformat(generated_at_str.replace("Z", "+00:00"))
            hours_since_file = (now - generated_at_dt).total_seconds() / 3600
        except (ValueError, TypeError):
            pass

    relevant_skills = CONTEXT_SKILLS.get(context, [])
    suppressed_count = 0
    candidates: list[dict] = []

    for idx, skill in enumerate(relevant_skills):
        # Suppressed check
        if skill in suppressed:
            suppressed_count += 1
            continue

        # Cooldown check: if skill appears in by_skill AND file is within cooldown window, skip
        in_usage = skill in by_skill
        within_cooldown = hours_since_file <= cooldown_hours

        if in_usage and within_cooldown:
            continue

        # Relevance multiplier: index 0 → 3, index 1 → 2, index 2 → 1, beyond → 1
        relevance = max(1, 3 - idx)

        score = hours_since_file * 0.5 + relevance

        last_used: str | None = generated_at_dt.strftime("%Y-%m-%dT%H:%M:%SZ") if (in_usage and generated_at_dt) else None

        candidates.append({
            "skill": skill,
            "reason": f"Not used recently; relevant for {context} context",
            "last_used": last_used,
            "relevance_score": round(score, 4),
        })

    # Sort by score descending, cap at max_suggestions
    candidates.sort(key=lambda c: c["relevance_score"], reverse=True)
    suggestions = candidates[:max_suggestions]

    timestamp = now.strftime("%Y-%m-%dT%H:%M:%SZ")

    return {
        "suggestions": suggestions,
        "context": context,
        "timestamp": timestamp,
        "config": {
            "max_suggestions": max_suggestions,
            "cooldown_hours": cooldown_hours,
            "suggest_after_review_rounds": suggest_after_review_rounds,
        },
        "_suppressed_count": suppressed_count,
    }


# ---------------------------------------------------------------------------
# Event emission
# ---------------------------------------------------------------------------


def _emit_suggestion_event(context: str, suggestions_count: int, suppressed_count: int) -> None:
    """Emit a skill_suggestion event. Silently ignore emission errors."""
    try:
        emit_event(
            "skill_suggestion",
            {
                "context": context,
                "suggestions_count": suggestions_count,
                "suppressed_count": suppressed_count,
            },
        )
    except Exception:
        pass


# ---------------------------------------------------------------------------
# Output formatting
# ---------------------------------------------------------------------------


def _human_readable(result: dict) -> str:
    suggestions = result["suggestions"]
    context = result["context"]
    lines = [f"Skill suggestions for '{context}' context:"]
    if not suggestions:
        lines.append("  (no suggestions)")
    else:
        for s in suggestions:
            skill = s["skill"]
            score = s["relevance_score"]
            reason = s["reason"]
            lines.append(f"  \u2192 {skill:<30} [score: {score}]  {reason}")
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# CLI entry point
# ---------------------------------------------------------------------------


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Contextual skill suggestions for underused skills."
    )
    parser.add_argument(
        "--context",
        required=True,
        choices=sorted(VALID_CONTEXTS),
        help="Context type: review, implementation, session, debug",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        dest="output_json",
        help="Output JSON instead of human-readable text",
    )
    args = parser.parse_args()

    result = compute_suggestions(args.context)
    suppressed_count = result.pop("_suppressed_count", 0)

    # Emit telemetry event
    _emit_suggestion_event(args.context, len(result["suggestions"]), suppressed_count)

    if args.output_json:
        print(json.dumps(result, indent=2))
    else:
        print(_human_readable(result))


if __name__ == "__main__":
    main()
