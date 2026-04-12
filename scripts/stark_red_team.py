"""Red-team dispatcher for stark-forge / stark-forged-review.

Assembles a Codex o3 prompt from the committee preamble + 5 persona files +
delimited attacker inputs (artifact, source spec, optional PR diff), dispatches
it, parses structured JSON output, and runs the iterative refinement loop with
per-round stability checks, human-review halts, and total-cycle cost tracking.

See design spec §4 for the full flow.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass
from pathlib import Path

REQUEST_HUMAN_REVIEW = "REQUEST_HUMAN_REVIEW"

VALID_PERSONA_SLUGS: frozenset[str] = frozenset({
    "security-trust",
    "reliability-distsys",
    "data",
    "product-dx",
    "cost-ops",
})

VALID_SEVERITIES: frozenset[str] = frozenset({"critical", "high", "medium"})

SEVERITY_RANK: dict[str, int] = {
    "critical": 3,
    "high": 2,
    "medium": 1,
}

PROMPTS_ROOT = Path.home() / ".claude" / "code-review" / "prompts" / "red-team"


@dataclass
class RedTeamFinding:
    """One finding from one persona in one round."""

    id: str
    persona: str
    severity: str
    concern: str
    consequence: str
    counter_proposal: str
    trade_off: str | None
    reason_for_uncertainty: str | None


@dataclass
class RedTeamResult:
    """Result of a single red-team call (one round, one stage)."""

    stage: str
    round_num: int
    synthesis: str
    findings: list[RedTeamFinding]
    blocking_count: int
    human_review_count: int
    raw_output: str
    duration_s: float
    cost_usd: float = 0.0
    error: str | None = None
    input_tokens: int = 0
    output_tokens: int = 0


_DELIMITER_OPEN_FRAGMENT = "<<<RED_TEAM_INPUT"
_DELIMITER_CLOSE_FRAGMENT = "<<<END_RED_TEAM_INPUT"
_ESCAPED_OPEN = "&lt;&lt;&lt;RED_TEAM_INPUT"
_ESCAPED_CLOSE = "&lt;&lt;&lt;END_RED_TEAM_INPUT"
_DEFAULT_MAX_INPUT_CHARS = 200_000


def _load_file(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def _escape_delimiters(text: str) -> str:
    """Replace any literal delimiter fragments with escaped forms so an
    attacker can't inject new input blocks by pasting the delimiter into
    their own artifact (rt_b1)."""
    return (
        text.replace(_DELIMITER_OPEN_FRAGMENT, _ESCAPED_OPEN)
            .replace(_DELIMITER_CLOSE_FRAGMENT, _ESCAPED_CLOSE)
    )


def _truncate(text: str, max_chars: int) -> str:
    if len(text) <= max_chars:
        return text
    return text[:max_chars] + f"\n[TRUNCATED to {max_chars} chars]"


def _wrap_input(name: str, text: str, max_chars: int) -> str:
    """Wrap attacker-controllable input in tagged delimiters with SHA-256."""
    escaped = _escape_delimiters(text)
    truncated = _truncate(escaped, max_chars)
    digest = hashlib.sha256(truncated.encode("utf-8")).hexdigest()
    return (
        f'<<<RED_TEAM_INPUT name="{name}" hash="sha256:{digest}">>>\n'
        f"{truncated}\n"
        f'<<<END_RED_TEAM_INPUT name="{name}">>>'
    )


def assemble_prompt(
    stage: str,
    personas: list[str],
    artifact: str,
    source_spec: str,
    pr_diff: str | None,
    max_input_chars: int = _DEFAULT_MAX_INPUT_CHARS,
) -> str:
    """Assemble the full red-team prompt for one call.

    Order:
      1. preamble.md
      2. design.md or plan.md (per stage)
      3. Each persona file in `personas` order
      4. artifact input block
      5. source_spec input block
      6. pr_diff input block (if provided)
    """
    preamble = _load_file(PROMPTS_ROOT / "preamble.md")
    stage_file = PROMPTS_ROOT / f"{stage}.md"
    stage_prompt = _load_file(stage_file)

    persona_texts: list[str] = []
    for slug in personas:
        path = PROMPTS_ROOT / "personas" / f"{slug}.md"
        persona_texts.append(_load_file(path))

    inputs = [
        _wrap_input("artifact", artifact, max_input_chars),
        _wrap_input("source_spec", source_spec, max_input_chars),
    ]
    if pr_diff is not None:
        inputs.append(_wrap_input("pr_diff", pr_diff, max_input_chars))

    parts = [
        preamble,
        stage_prompt,
        *persona_texts,
        *inputs,
    ]
    return "\n\n".join(parts)
