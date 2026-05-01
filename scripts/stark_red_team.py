"""Red-team dispatcher for stark-forge / stark-forged-review.

Assembles a Codex o3 prompt from the committee preamble + 5 persona files +
delimited attacker inputs (artifact, source spec, optional PR diff), dispatches
it, parses structured JSON output, and runs the iterative refinement loop with
per-round stability checks, human-review halts, and total-cycle cost tracking.

See design spec §4 for the full flow.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
import time
import urllib.error
import urllib.request
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from codex_utils import CODEX_REASONING_EFFORT_HIGH

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

# Models that route through the OpenAI Responses API (HTTP) instead of the
# codex CLI. The codex CLI in ChatGPT-auth mode rejects o3 and the *-pro
# tiers, but the org has Responses-API entitlement to the same models — this
# parallel transport is what restores the locked `red_team.model` (default
# `o3`) to working order without weakening the lock or changing codex auth.
RESPONSES_API_MODELS: frozenset[str] = frozenset({
    "o3",
    "o3-mini",
    "gpt-5.5-pro",
    "gpt-5.4-pro",
})

# Per-model valid `reasoning.effort` values for the Responses API. The pro
# tiers reject "low"; o3 accepts low/medium/high but not "xhigh".
_RESPONSES_API_REASONING_EFFORT: dict[str, frozenset[str]] = {
    "o3": frozenset({"low", "medium", "high"}),
    "o3-mini": frozenset({"low", "medium", "high"}),
    "gpt-5.5-pro": frozenset({"medium", "high", "xhigh"}),
    "gpt-5.4-pro": frozenset({"medium", "high", "xhigh"}),
}

_RESPONSES_API_URL = "https://api.openai.com/v1/responses"
_RESPONSES_API_DEFAULT_MAX_OUTPUT_TOKENS = 32768


_VALID_FAILURE_MODES: frozenset[str] = frozenset({
    "data-loss",
    "availability",
    "cost",
    "security",
    "correctness",
    "compliance",
    "performance",
    "operability",
})

_SLUG_RE = re.compile(r"[^a-z0-9]+")


def _slugify(value: str, max_len: int = 64) -> str:
    """Normalize a free-text string to a deterministic slug.

    Used for `risk_key` and `affected_component` so two different wordings of
    the same identity collapse to the same slug. ``"Schema migration"`` and
    ``"schema-migration"`` both become ``"schema-migration"``.
    """
    slug = _SLUG_RE.sub("-", (value or "").lower()).strip("-")
    return slug[:max_len]


def _normalize_concern(text: str) -> str:
    """Lowercase + collapse whitespace for stable hashing.

    Two phrasings that differ only in case or whitespace produce the same
    ``concern_hash``. Bigger semantic differences are still captured by the
    structured ``risk_key``/``affected_component``/``failure_mode`` triple.
    """
    return " ".join((text or "").lower().split())


def compute_concern_hash(
    persona: str,
    risk_key: str | None,
    affected_component: str | None,
    concern: str,
) -> str:
    """SHA-256 fingerprint of a finding's stable identity (FU-rt5 + FU-rt7).

    Two paths, picked based on structured-identity availability:

    1. **Structured-identity path:** when ``risk_key`` is set, the hash is
       ``persona|risk_key|affected_component`` — concern prose is deliberately
       NOT in the hash. The same risk re-surfaced in different wording
       produces the same fingerprint, which is what FU-rt5's "structured
       fields are the identity" promises and what makes cross-run
       acceptance work even when the model rewords.
    2. **Back-compat path:** when ``risk_key`` is absent (legacy pre-FU-rt5
       producers), fall back to ``persona|normalized_concern``. Without
       structured fields, the prose is the only signal we have; collapsing
       on persona alone would mute every future finding from the same
       persona once one was accepted.

    PR #430 review finding #12 strengthened the structured-path test to
    cover genuinely different rephrasings of the same risk.
    """
    if risk_key:
        canonical = "|".join([
            persona or "",
            risk_key,
            affected_component or "",
        ])
    else:
        canonical = "|".join([
            persona or "",
            "",
            affected_component or "",
            _normalize_concern(concern),
        ])
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:16]


def compute_stable_key(
    *,
    run_id: str,
    stage: str,
    round_num: int,
    persona: str,
    finding_id: str,
    concern_hash: str,
) -> str:
    """Build the canonical stable AUDIT key for one finding occurrence.

    Format: ``{run_id}:{stage}:{round_num}:{persona}:{finding_id}:{concern_hash}``.
    Identifies one specific occurrence in audit rows / PR-comment anchors so a
    reviewer can copy a key and have it pin to that exact row. The trailing
    ``concern_hash`` is what makes the audit key collision-resistant across
    reruns where the model may renumber slot-3 with a different concern
    (FU-rt7).

    For human-review halt recovery (FU-rt8), use :func:`compute_accept_key`
    instead — the audit key embeds run / round / finding-id slot fields that
    are not stable across reruns.
    """
    return f"{run_id}:{stage}:{round_num}:{persona}:{finding_id}:{concern_hash}"


def compute_accept_key(
    *,
    stage: str,
    persona: str,
    concern_hash: str,
    repo: str | None = None,
) -> str:
    """Build the cross-run ACCEPT key for human-review halt recovery (FU-rt8).

    Format: ``{repo}:{stage}:{persona}:{concern_hash}``. Drops ``run_id``,
    ``round_num``, and ``finding_id`` so the same risk surfaced under a
    fresh run / new finding-id slot still matches an operator's prior
    acceptance. ``concern_hash`` already carries the structured identity
    (persona + risk_key + affected_component, see :func:`compute_concern_hash`),
    so a finding that has the same hash IS the same concern by FU-rt5's
    definition.

    PR-#430 review fix #10: repo prefix added so accepting a concern in
    one repository cannot silently suppress a matching halt in a different
    repository (the audit DB is shared across the operator's full
    workspace). ``repo=None`` falls back to a literal ``unknown`` prefix
    so legacy callers pre-fix still produce a deterministic value.
    """
    return f"{repo or 'unknown'}:{stage}:{persona}:{concern_hash}"


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
    # FU-rt5 — Structured fields. Optional during the prompt-rollout window;
    # once prompts in production routinely emit them, validate_findings will
    # promote these to required for non-human-review findings.
    risk_key: str | None = None
    affected_component: str | None = None
    failure_mode: str | None = None
    # FU-rt7 — Stable identity. Computed from persona + structured fields +
    # normalized concern text by ``validate_findings``; never read from the
    # model. Two reruns of the same risk produce identical hashes.
    concern_hash: str = ""


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


@dataclass(frozen=True)
class RedTeamRunContext:
    """Shared identity and runtime context for one red-team invocation."""

    run_id: str
    stage: str
    caller: str
    repo: str
    artifact_relative_path: str | None
    cwd: str | None
    env: dict[str, str]
    model_rates: dict[str, Any]
    cfg_red_team: dict[str, Any]
    per_run_budget_usd: float
    pr_number: int | None
    started_at_iso: str


@dataclass
class FixPlanMove:
    """One design-level move in a red-team fix plan."""

    id: str
    title: str
    rationale: str
    sections_touched: list[str]
    addressed_finding_ids: list[str]
    new_trade_off: str


@dataclass
class RedTeamFixPlan:
    """Validated proposed fix plan for blocking red-team findings."""

    summary: str
    moves: list[FixPlanMove]
    unaddressed_finding_ids: list[str]
    orphan_finding_ids: list[str]
    notes: str
    input_truncated: bool
    input_omitted_finding_ids: list[str]
    warnings: list[str]
    raw_output: str
    duration_s: float
    cost_usd: float
    input_tokens: int
    output_tokens: int
    model: str
    reasoning_effort: str
    error: str | None = None


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


def is_human_review(f: RedTeamFinding) -> bool:
    return f.counter_proposal == REQUEST_HUMAN_REVIEW


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


def _finding_to_envelope_dict(f: RedTeamFinding) -> dict[str, Any]:
    return {
        "id": f.id,
        "persona": f.persona,
        "severity": f.severity,
        "concern": f.concern,
        "consequence": f.consequence,
        "counter_proposal": f.counter_proposal,
        "trade_off": f.trade_off,
        "reason_for_uncertainty": f.reason_for_uncertainty,
    }


def serialize_findings_envelope(
    findings: list[RedTeamFinding],
    max_chars: int,
) -> tuple[str, list[str], bool]:
    """Serialize findings for fix-plan input without cutting partial JSON.

    Returns ``(envelope_json, omitted_ids, fits_safely)``. ``fits_safely`` is
    false only when a blocking finding was omitted by the size cap.
    """
    sorted_findings = sorted(
        findings,
        key=lambda f: (-SEVERITY_RANK.get(f.severity, 0), is_human_review(f), f.id),
    )
    kept: list[dict[str, Any]] = []
    omitted_ids: list[str] = []
    omitted_blocking = False

    def _dump(truncated: bool, ids: list[str], rows: list[dict[str, Any]]) -> str:
        return json.dumps(
            {
                "truncated": truncated,
                "omitted_finding_ids": ids,
                "findings": rows,
            },
            sort_keys=True,
            separators=(",", ":"),
        )

    for finding in sorted_findings:
        candidate_ids = [*omitted_ids]
        candidate_rows = [*kept, _finding_to_envelope_dict(finding)]
        candidate_json = _dump(bool(candidate_ids), candidate_ids, candidate_rows)
        if len(candidate_json) <= max_chars:
            kept = candidate_rows
            continue
        omitted_ids.append(finding.id)
        if not is_human_review(finding) and SEVERITY_RANK.get(finding.severity, 0) >= SEVERITY_RANK["high"]:
            omitted_blocking = True

    envelope_json = _dump(bool(omitted_ids), omitted_ids, kept)
    return envelope_json, omitted_ids, not omitted_blocking


def preflight_findings_envelope(
    findings: list[RedTeamFinding],
    max_chars: int,
) -> tuple[str, bool, list[str]]:
    envelope, omitted_ids, fits_safely = serialize_findings_envelope(findings, max_chars)
    return envelope, fits_safely, omitted_ids


def _assemble_fix_plan_prompt_from_envelope(
    stage: str,
    artifact: str,
    source_spec: str,
    findings_envelope: str,
    synthesis: str,
    max_input_chars: int,
) -> str:
    fix_plan_prompt = _load_file(PROMPTS_ROOT / "fix-plan.md")
    inputs = [
        _wrap_input("artifact", artifact, max_input_chars),
        _wrap_input("source_spec", source_spec, max_input_chars),
        _wrap_input("findings_envelope", findings_envelope, max_input_chars),
        _wrap_input("synthesis", synthesis, max_input_chars),
    ]
    return "\n\n".join([fix_plan_prompt, f"Stage: {stage}", *inputs])


def assemble_fix_plan_prompt(
    stage: str,
    artifact: str,
    source_spec: str,
    findings: list[RedTeamFinding],
    synthesis: str,
    max_input_chars: int,
) -> str:
    envelope, _fits_safely, _omitted_ids = preflight_findings_envelope(findings, max_input_chars)
    return _assemble_fix_plan_prompt_from_envelope(
        stage=stage,
        artifact=artifact,
        source_spec=source_spec,
        findings_envelope=envelope,
        synthesis=synthesis,
        max_input_chars=max_input_chars,
    )


def parse_output(raw: str) -> dict[str, Any]:
    """Best-effort JSON extraction from a red-team raw output.

    Returns the parsed object, or empty dict if extraction fails.
    """
    text = (raw or "").strip()
    if not text:
        return {}

    try:
        result = json.loads(text)
        if isinstance(result, dict):
            return result
    except (json.JSONDecodeError, ValueError):
        pass

    # Try fenced code blocks
    if "```" in text:
        for part in text.split("```"):
            part = part.strip()
            if part.startswith("json"):
                part = part[4:].strip()
            if part.startswith("{"):
                try:
                    result = json.loads(part)
                    if isinstance(result, dict):
                        return result
                except (json.JSONDecodeError, ValueError):
                    continue

    # Try first/last curly brace
    start = text.find("{")
    end = text.rfind("}")
    if 0 <= start < end:
        try:
            result = json.loads(text[start : end + 1])
            if isinstance(result, dict):
                return result
        except (json.JSONDecodeError, ValueError):
            pass

    return {}


def parse_fix_plan_output(raw: str) -> dict[str, Any]:
    return parse_output(raw)


_CAP_MARKER = "...[CAP]"


def _empty_fix_plan(
    *,
    error: str | None,
    warnings: list[str] | None = None,
    raw_output: str = "",
    duration_s: float = 0.0,
    cost_usd: float = 0.0,
    input_tokens: int = 0,
    output_tokens: int = 0,
    model: str = "",
    reasoning_effort: str = "",
    input_truncated: bool = False,
    input_omitted_finding_ids: list[str] | None = None,
) -> RedTeamFixPlan:
    return RedTeamFixPlan(
        summary="",
        moves=[],
        unaddressed_finding_ids=[],
        orphan_finding_ids=[],
        notes="",
        input_truncated=input_truncated,
        input_omitted_finding_ids=input_omitted_finding_ids or [],
        warnings=warnings or [],
        raw_output=raw_output,
        duration_s=duration_s,
        cost_usd=cost_usd,
        input_tokens=input_tokens,
        output_tokens=output_tokens,
        model=model,
        reasoning_effort=reasoning_effort,
        error=error,
    )


def _cap_text(value: str, limit: int, warnings: list[str]) -> str:
    if len(value) <= limit:
        return value
    if "field_capped" not in warnings:
        warnings.append("field_capped")
    return value[: max(0, limit - len(_CAP_MARKER))] + _CAP_MARKER


def _unique_move_id(raw_id: str, used: set[str], fallback_num: int) -> str:
    candidate = raw_id if re.fullmatch(r"m\d+", raw_id) else f"m{fallback_num}"
    if candidate and candidate not in used:
        used.add(candidate)
        return candidate
    idx = fallback_num
    while True:
        candidate = f"m{idx}"
        if candidate not in used:
            used.add(candidate)
            return candidate
        idx += 1


def validate_fix_plan(
    raw_dict: dict[str, Any],
    blocking_finding_ids: list[str],
    cfg: dict[str, Any],
) -> RedTeamFixPlan:
    """Validate model JSON into a bounded RedTeamFixPlan. Never raises."""
    warnings: list[str] = []
    try:
        min_moves = int(cfg.get("min_moves", 2))
        max_moves = int(cfg.get("max_moves", 6))
        blocking_ids = list(dict.fromkeys(str(fid) for fid in blocking_finding_ids))
        blocking_set = set(blocking_ids)

        if not isinstance(raw_dict, dict):
            return _empty_fix_plan(error="fix-plan output is not a JSON object")
        raw_moves = raw_dict.get("moves")
        if not isinstance(raw_moves, list):
            return _empty_fix_plan(error="fix-plan output missing required 'moves' list")
        raw_count = len(raw_moves)
        if raw_count < min_moves or raw_count > max_moves * 2:
            return _empty_fix_plan(
                error=f"fix-plan returned {raw_count} moves; expected {min_moves}..{max_moves}",
            )

        parsed_moves: list[tuple[int, FixPlanMove]] = []
        used_ids: set[str] = set()
        for idx, raw_move in enumerate(raw_moves, start=1):
            if not isinstance(raw_move, dict):
                continue
            required = ("id", "title", "rationale", "new_trade_off")
            values: dict[str, str] = {}
            invalid = False
            for key in required:
                value = raw_move.get(key)
                if not isinstance(value, str) or not value.strip():
                    invalid = True
                    break
                values[key] = value.strip()
            if invalid:
                continue
            sections_raw = raw_move.get("sections_touched")
            ids_raw = raw_move.get("addressed_finding_ids")
            if not isinstance(sections_raw, list) or not isinstance(ids_raw, list):
                continue

            sections: list[str] = []
            for item in sections_raw[:20]:
                if isinstance(item, str):
                    sections.append(_cap_text(item.strip(), 100, warnings))
            if len(sections_raw) > 20 and "field_capped" not in warnings:
                warnings.append("field_capped")

            addressed: list[str] = []
            invented = False
            for item in ids_raw:
                if not isinstance(item, str):
                    invented = True
                    continue
                if item not in blocking_set:
                    invented = True
                    continue
                if item not in addressed:
                    addressed.append(item)
            if invented and "ids_invented" not in warnings:
                warnings.append("ids_invented")
            if not addressed and not sections:
                continue

            move_id = _unique_move_id(values["id"], used_ids, idx)
            parsed_moves.append((
                idx,
                FixPlanMove(
                    id=move_id,
                    title=_cap_text(values["title"], 200, warnings),
                    rationale=_cap_text(values["rationale"], 1000, warnings),
                    sections_touched=sections,
                    addressed_finding_ids=addressed,
                    new_trade_off=_cap_text(values["new_trade_off"], 500, warnings),
                ),
            ))

        if len(parsed_moves) < min_moves:
            return _empty_fix_plan(
                error=f"fix-plan returned {len(parsed_moves)} valid moves after validation; expected at least {min_moves}",
                warnings=warnings,
            )

        if len(parsed_moves) > max_moves:
            parsed_moves = sorted(
                parsed_moves,
                key=lambda pair: (-len(pair[1].addressed_finding_ids), pair[0]),
            )[:max_moves]
            parsed_moves = sorted(parsed_moves, key=lambda pair: pair[0])
            if "move_cap_hit" not in warnings:
                warnings.append("move_cap_hit")

        moves = [move for _idx, move in parsed_moves]
        addressed_set: set[str] = set()
        for move in moves:
            addressed_set.update(move.addressed_finding_ids)

        raw_unaddressed = raw_dict.get("unaddressed_finding_ids", [])
        if not isinstance(raw_unaddressed, list):
            raw_unaddressed = []
        model_unaddressed: list[str] = []
        for item in raw_unaddressed:
            if isinstance(item, str) and item in blocking_set and item not in addressed_set and item not in model_unaddressed:
                model_unaddressed.append(item)
        orphan_ids = [
            fid
            for fid in blocking_ids
            if fid not in addressed_set and fid not in set(model_unaddressed)
        ]

        summary = raw_dict.get("summary", "")
        notes = raw_dict.get("notes", "")
        if not isinstance(summary, str):
            summary = ""
        if not isinstance(notes, str):
            notes = ""

        return RedTeamFixPlan(
            summary=_cap_text(summary, 1000, warnings),
            moves=moves,
            unaddressed_finding_ids=model_unaddressed,
            orphan_finding_ids=orphan_ids,
            notes=_cap_text(notes, 3000, warnings),
            input_truncated=False,
            input_omitted_finding_ids=[],
            warnings=warnings,
            raw_output="",
            duration_s=0.0,
            cost_usd=0.0,
            input_tokens=0,
            output_tokens=0,
            model="",
            reasoning_effort="",
            error=None,
        )
    except Exception as exc:  # pragma: no cover - defensive no-raise contract
        return _empty_fix_plan(error=f"fix-plan validation error: {exc}", warnings=warnings)


def _extract_structured_field(raw: dict[str, Any], key: str) -> str | None:
    """Read an optional structured field, slugifying free-text values.

    Returns ``None`` for missing/empty/non-string values so callers can
    distinguish "model omitted this field" (back-compat path) from "model
    provided a slug" (FU-rt5 stability gate path).
    """
    value = raw.get(key)
    if not isinstance(value, str):
        return None
    slug = _slugify(value)
    return slug or None


def _extract_failure_mode(raw: dict[str, Any]) -> str | None:
    value = raw.get("failure_mode")
    if not isinstance(value, str):
        return None
    slug = _slugify(value)
    return slug if slug in _VALID_FAILURE_MODES else None


def validate_findings(raw_findings: list[dict[str, Any]]) -> list[RedTeamFinding]:
    """Convert raw dicts to RedTeamFinding, dropping invalid entries.

    Rules:
    - `persona` must be in VALID_PERSONA_SLUGS
    - `severity` must be in VALID_SEVERITIES
    - Required string fields: id, concern, consequence, counter_proposal
    - Either (a) concrete counter_proposal + trade_off (string), or
             (b) counter_proposal == REQUEST_HUMAN_REVIEW + reason_for_uncertainty (string)
    - Invalid entries are silently dropped

    Optional structured fields (FU-rt5): ``risk_key``, ``affected_component``,
    ``failure_mode``. These flow through when present (slugified) and feed the
    stability gate's structured-overlap check; absent values fall back to the
    Jaccard concern-text gate. ``concern_hash`` is always computed from
    persona + structured fields + normalized concern text and stamped on the
    finding for downstream stable-key composition (FU-rt7).
    """
    out: list[RedTeamFinding] = []
    for raw in raw_findings:
        if not isinstance(raw, dict):
            continue
        persona = raw.get("persona")
        severity = raw.get("severity")
        counter_proposal = raw.get("counter_proposal")

        if persona not in VALID_PERSONA_SLUGS:
            continue
        if severity not in VALID_SEVERITIES:
            continue
        if not isinstance(counter_proposal, str) or not counter_proposal:
            continue

        required_strs = ("id", "concern", "consequence")
        if any(not isinstance(raw.get(k), str) or not raw.get(k) for k in required_strs):
            continue

        risk_key = _extract_structured_field(raw, "risk_key")
        affected_component = _extract_structured_field(raw, "affected_component")
        failure_mode = _extract_failure_mode(raw)
        concern_hash = compute_concern_hash(
            persona=persona,
            risk_key=risk_key,
            affected_component=affected_component,
            concern=raw["concern"],
        )

        if counter_proposal == REQUEST_HUMAN_REVIEW:
            reason = raw.get("reason_for_uncertainty")
            if not isinstance(reason, str) or not reason:
                continue
            out.append(RedTeamFinding(
                id=raw["id"],
                persona=persona,
                severity=severity,
                concern=raw["concern"],
                consequence=raw["consequence"],
                counter_proposal=REQUEST_HUMAN_REVIEW,
                trade_off=None,
                reason_for_uncertainty=reason,
                risk_key=risk_key,
                affected_component=affected_component,
                failure_mode=failure_mode,
                concern_hash=concern_hash,
            ))
        else:
            trade_off = raw.get("trade_off")
            if not isinstance(trade_off, str) or not trade_off:
                continue
            out.append(RedTeamFinding(
                id=raw["id"],
                persona=persona,
                severity=severity,
                concern=raw["concern"],
                consequence=raw["consequence"],
                counter_proposal=counter_proposal,
                trade_off=trade_off,
                reason_for_uncertainty=None,
                risk_key=risk_key,
                affected_component=affected_component,
                failure_mode=failure_mode,
                concern_hash=concern_hash,
            ))
    return out


def derive_status(result: "RedTeamResult") -> str:
    """Map a RedTeamResult to a single canonical status string for callers.

    Centralized so that every caller follows the same precedence rule —
    `error` first, then human-review halt, then blocking-finding halt,
    then clean. Without this helper, callers that only checked counts
    silently classified parse errors as `clean` (round-2 finding 8).
    Returns one of: ``"error" | "halted_human_review" | "halted" | "clean"``.
    """
    if result.error:
        return "error"
    if result.human_review_count > 0:
        return "halted_human_review"
    if result.blocking_count > 0:
        return "halted"
    return "clean"


def count_blocking(
    findings: list[RedTeamFinding],
    min_severity: str = "high",
) -> int:
    """Count findings at or above min_severity, excluding REQUEST_HUMAN_REVIEW.

    Human-review findings are tracked separately via count_human_review —
    they halt the loop unconditionally but don't contribute to blocking_count.
    """
    floor = SEVERITY_RANK[min_severity]
    return sum(
        1
        for f in findings
        if not is_human_review(f)
        and SEVERITY_RANK.get(f.severity, 0) >= floor
    )


def count_human_review(findings: list[RedTeamFinding]) -> int:
    return sum(1 for f in findings if is_human_review(f))


_WORD_RE = re.compile(r"[A-Za-z][A-Za-z0-9']*")


def _tokenize(text: str) -> set[str]:
    return {m.group(0).lower() for m in _WORD_RE.finditer(text)}


def _jaccard(a: set[str], b: set[str]) -> float:
    if not a or not b:
        return 0.0
    return len(a & b) / len(a | b)


def _structured_overlap(fa: RedTeamFinding, fb: RedTeamFinding) -> bool:
    """Two findings overlap iff they share persona + the full structured triple.

    The structured triple ``(risk_key, affected_component, failure_mode)``
    carries the risk identity. PR-#430 review (#6) tightened this from
    "match on risk_key alone" to "match on the full triple": two
    findings from the same persona with the same generic ``risk_key``
    (e.g. ``security-issue``) but different ``affected_component`` /
    ``failure_mode`` were being reported as stably-blocking when they were
    in fact unrelated. Persona is checked at the call site so we don't
    re-test it here, but we do guard against partial-identity cases.
    """
    if fa.persona != fb.persona:
        return False
    if not fa.risk_key or fa.risk_key != fb.risk_key:
        return False
    if not fa.affected_component or fa.affected_component != fb.affected_component:
        return False
    # ``failure_mode`` may be None for legacy producers. Match if both
    # populated; treat one-sided None as a match (the triple's risk_key +
    # component already pin the identity).
    if fa.failure_mode and fb.failure_mode and fa.failure_mode != fb.failure_mode:
        return False
    return True


def _has_structured_identity(f: RedTeamFinding) -> bool:
    """A finding has structured identity if at least ``risk_key`` is set.

    ``affected_component`` alone isn't enough — two unrelated risks against
    the same component would falsely match.
    """
    return bool(f.risk_key)


def _overlap(
    rt_a: "RedTeamResult",
    rt_b: "RedTeamResult",
    jaccard_min: float = 0.4,
) -> bool:
    """Return True iff at least one blocking finding pair overlaps stably.

    Stability test, in order of preference (FU-rt5):

    1. **Structured-fields path:** if both findings have ``risk_key``,
       require persona + structured-identity match (``_structured_overlap``).
       This is the canonical path once prompts emit structured fields.
    2. **Jaccard fallback:** if either finding lacks structured identity
       (back-compat with v1 outputs and the prompt-rollout window), fall
       back to persona + concern-text Jaccard ≥ ``jaccard_min``.

    Calls that overlap under one of these tests are stably blocking; calls
    that don't are treated as flicker and the round is downgraded to advisory.
    """
    blocking_a = [f for f in rt_a.findings if not is_human_review(f)
                  and SEVERITY_RANK.get(f.severity, 0) >= SEVERITY_RANK["high"]]
    blocking_b = [f for f in rt_b.findings if not is_human_review(f)
                  and SEVERITY_RANK.get(f.severity, 0) >= SEVERITY_RANK["high"]]
    if not blocking_a or not blocking_b:
        return False

    for fa in blocking_a:
        for fb in blocking_b:
            if fa.persona != fb.persona:
                continue
            if _has_structured_identity(fa) and _has_structured_identity(fb):
                if _structured_overlap(fa, fb):
                    return True
                continue
            if _jaccard(_tokenize(fa.concern), _tokenize(fb.concern)) >= jaccard_min:
                return True
    return False


@dataclass
class CodexCallResult:
    """Result of a single Codex subprocess dispatch."""

    raw_output: str
    duration_s: float
    input_tokens: int
    output_tokens: int
    error: str | None = None
    # FU-rt11 — Responses API ``id`` field (present only on the HTTP path).
    # Threaded through into ``CallTelemetryRecord`` so an operator paging
    # through telemetry can correlate against OpenAI-side logs / dashboards.
    request_id: str | None = None


def _parse_codex_jsonl_tokens(raw: str) -> tuple[int, int]:
    """Extract token usage from codex --json JSONL output.

    Best-effort — returns (0, 0) if no usage data is found.
    """
    in_tokens = 0
    out_tokens = 0
    for line in raw.splitlines():
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            ev = json.loads(line)
        except (json.JSONDecodeError, ValueError):
            continue
        usage = ev.get("usage") or ev.get("item", {}).get("usage")
        if isinstance(usage, dict):
            in_tokens += int(usage.get("input_tokens") or 0)
            out_tokens += int(usage.get("output_tokens") or 0)
    return in_tokens, out_tokens


def _extract_codex_assistant_text(raw: str) -> str:
    """Pull plain assistant text from a codex --json JSONL stream.

    Returns the original raw string if no assistant text events found.
    """
    parts: list[str] = []
    for line in raw.splitlines():
        if not line.strip().startswith("{"):
            continue
        try:
            ev = json.loads(line)
        except (json.JSONDecodeError, ValueError):
            continue
        if ev.get("type") == "item.completed":
            item = ev.get("item", {})
            itype = item.get("type", "")
            if itype == "agent_message":
                text = item.get("text", "")
                if text:
                    parts.append(text)
            elif itype == "message":
                for c in item.get("content", []):
                    if c.get("type") == "output_text":
                        parts.append(c.get("text", ""))
    return "\n".join(parts) if parts else raw


def dispatch_codex(
    prompt: str,
    model: str,
    cwd: str | None,
    timeout_s: int,
    env: dict[str, str] | None = None,
    *,
    sandbox: bool = True,
) -> CodexCallResult:
    """Run codex with the given model override. Returns CodexCallResult.

    When ``sandbox=True`` (the FU-rt1 default), the codex subprocess runs
    from an empty temp directory with a scrubbed env. This contains the
    blast radius if attacker-controlled artifact / spec / PR-diff text in
    the prompt manages to coax codex into a tool call: there's no repo
    to read, no secrets to exfiltrate, and codex's own ``-s read-only``
    flag still blocks writes. Pass ``sandbox=False`` only for paths that
    have already isolated cwd / env upstream.
    """
    t0 = time.time()
    cmd = [
        "codex",
        "exec",
        "-m",
        model,
        "-c",
        CODEX_REASONING_EFFORT_HIGH,
        "--ephemeral",
        "--json",
        "-s",
        "read-only",
        "-",
    ]

    if sandbox:
        from red_team_sandbox import isolate_workdir, scrub_env, wrap_command

        scrubbed_env = scrub_env(env)
        wrapped_cmd = wrap_command(cmd)
        with isolate_workdir() as tmp:
            try:
                proc = subprocess.run(
                    wrapped_cmd,
                    input=prompt,
                    capture_output=True,
                    text=True,
                    timeout=timeout_s,
                    cwd=str(tmp),
                    env=scrubbed_env,
                )
            except subprocess.TimeoutExpired:
                return CodexCallResult(
                    raw_output="",
                    duration_s=time.time() - t0,
                    input_tokens=0,
                    output_tokens=0,
                    error=f"codex timeout after {timeout_s}s",
                )
            except (OSError, FileNotFoundError) as exc:
                return CodexCallResult(
                    raw_output="",
                    duration_s=time.time() - t0,
                    input_tokens=0,
                    output_tokens=0,
                    error=f"codex dispatch error: {exc}",
                )

            duration = time.time() - t0
            if proc.returncode != 0:
                return CodexCallResult(
                    raw_output=proc.stdout or "",
                    duration_s=duration,
                    input_tokens=0,
                    output_tokens=0,
                    error=f"codex exit {proc.returncode}: {(proc.stderr or '').strip()[:400]}",
                )

            in_tokens, out_tokens = _parse_codex_jsonl_tokens(proc.stdout or "")
            raw_text = _extract_codex_assistant_text(proc.stdout or "")
            return CodexCallResult(
                raw_output=raw_text,
                duration_s=duration,
                input_tokens=in_tokens,
                output_tokens=out_tokens,
                error=None,
            )

    try:
        proc = subprocess.run(
            cmd,
            input=prompt,
            capture_output=True,
            text=True,
            timeout=timeout_s,
            cwd=cwd,
            env=env,
        )
    except subprocess.TimeoutExpired:
        return CodexCallResult(
            raw_output="",
            duration_s=time.time() - t0,
            input_tokens=0,
            output_tokens=0,
            error=f"codex timeout after {timeout_s}s",
        )
    except (OSError, FileNotFoundError) as exc:
        return CodexCallResult(
            raw_output="",
            duration_s=time.time() - t0,
            input_tokens=0,
            output_tokens=0,
            error=f"codex dispatch error: {exc}",
        )

    duration = time.time() - t0
    if proc.returncode != 0:
        return CodexCallResult(
            raw_output=proc.stdout or "",
            duration_s=duration,
            input_tokens=0,
            output_tokens=0,
            error=f"codex exit {proc.returncode}: {(proc.stderr or '').strip()[:400]}",
        )

    in_tokens, out_tokens = _parse_codex_jsonl_tokens(proc.stdout or "")
    raw_text = _extract_codex_assistant_text(proc.stdout or "")
    return CodexCallResult(
        raw_output=raw_text,
        duration_s=duration,
        input_tokens=in_tokens,
        output_tokens=out_tokens,
        error=None,
    )


def _resolve_openai_api_key(env: Mapping[str, str]) -> str | None:
    """Resolve an OpenAI API key from a mapping (typically os.environ).

    Resolution order:
      1. ``OPENAI_API_KEY`` if non-empty.
      2. ``OPENAI_API_KEY_FILE`` + ``OPENAI_API_KEY_LABEL``: read the file and
         return the value for the matching ``LABEL=value`` line.
      3. ``None`` if neither path yields a key.

    The labeled-file form keeps user-specific paths out of shared code while
    supporting workflows where the key lives in a non-dotenv format.
    """
    direct = env.get("OPENAI_API_KEY")
    if direct:
        return direct
    file_path = env.get("OPENAI_API_KEY_FILE")
    label = env.get("OPENAI_API_KEY_LABEL")
    if not file_path or not label:
        return None
    try:
        text = Path(file_path).read_text(encoding="utf-8")
    except OSError:
        return None
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        if key.strip() == label:
            return value.strip()
    return None


def _map_reasoning_effort(model: str, effort: str) -> str:
    """Map a requested reasoning effort to one valid for the given model.

    Pro-tier models reject ``"low"``; ``o3`` rejects ``"xhigh"``. Passing
    through the user's value would surface as a 400 from the API; instead we
    silently round to the nearest valid effort so callers can use a single
    default (``"high"``) across all Responses-API models.
    """
    allowed = _RESPONSES_API_REASONING_EFFORT.get(model)
    if allowed is None or effort in allowed:
        return effort
    if effort == "low" and "medium" in allowed:
        return "medium"
    if effort == "xhigh" and "high" in allowed:
        return "high"
    if "high" in allowed:
        return "high"
    return next(iter(allowed))


def _extract_responses_text(payload: dict[str, Any]) -> str:
    """Pull plain assistant text from a Responses API payload.

    Prefers the top-level ``output_text`` shortcut when present; otherwise
    walks ``output[*].content[*]`` for ``output_text``-typed parts.
    """
    top = payload.get("output_text")
    if isinstance(top, str) and top:
        return top
    parts: list[str] = []
    output = payload.get("output")
    if not isinstance(output, list):
        return ""
    for item in output:
        if not isinstance(item, dict):
            continue
        content = item.get("content")
        if not isinstance(content, list):
            continue
        for chunk in content:
            if not isinstance(chunk, dict):
                continue
            if chunk.get("type") == "output_text":
                text = chunk.get("text")
                if isinstance(text, str):
                    parts.append(text)
    return "\n".join(parts)


def dispatch_responses_api(
    prompt: str,
    model: str,
    timeout_s: int,
    reasoning_effort: str = "high",
    env: Mapping[str, str] | None = None,
    max_output_tokens: int = _RESPONSES_API_DEFAULT_MAX_OUTPUT_TOKENS,
) -> CodexCallResult:
    """Dispatch a red-team call via the OpenAI Responses API (HTTP).

    Parallel transport to ``dispatch_codex`` for models the codex CLI cannot
    reach in ChatGPT-auth mode (``o3``, ``gpt-5.5-pro``, ``gpt-5.4-pro``).
    Returns a :class:`CodexCallResult` with the same shape so downstream
    parsing/cost code is unchanged.
    """
    t0 = time.time()
    if env is None:
        env = os.environ

    api_key = _resolve_openai_api_key(env)
    if not api_key:
        return CodexCallResult(
            raw_output="",
            duration_s=time.time() - t0,
            input_tokens=0,
            output_tokens=0,
            error=(
                "no OpenAI API key available — set OPENAI_API_KEY or "
                "OPENAI_API_KEY_FILE+OPENAI_API_KEY_LABEL"
            ),
        )

    body = {
        "model": model,
        "input": prompt,
        "reasoning": {"effort": _map_reasoning_effort(model, reasoning_effort)},
        "max_output_tokens": max_output_tokens,
        # Red-team prompts contain attacker-controlled artifact / spec /
        # PR-diff content. Responses API defaults `store: true` (30-day
        # retention for retrieval). Opt out so attacker-influenced material
        # is not persisted server-side beyond the call itself.
        "store": False,
    }
    data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(
        _RESPONSES_API_URL,
        data=data,
        method="POST",
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
    )

    try:
        with urllib.request.urlopen(req, timeout=timeout_s) as resp:
            payload_bytes = resp.read()
    except urllib.error.HTTPError as exc:
        # Provider response bodies can echo rejected prompt content; status
        # code is enough for triage. The body is intentionally not embedded
        # in `error` because that string lands in audit logs and run state.
        return CodexCallResult(
            raw_output="",
            duration_s=time.time() - t0,
            input_tokens=0,
            output_tokens=0,
            error=f"responses api http {exc.code} {exc.reason or ''}".strip(),
        )
    except urllib.error.URLError as exc:
        return CodexCallResult(
            raw_output="",
            duration_s=time.time() - t0,
            input_tokens=0,
            output_tokens=0,
            error=f"responses api error: {exc.reason}",
        )
    except (TimeoutError, OSError) as exc:
        return CodexCallResult(
            raw_output="",
            duration_s=time.time() - t0,
            input_tokens=0,
            output_tokens=0,
            error=f"responses api transport error: {exc}",
        )

    duration = time.time() - t0
    try:
        payload = json.loads(payload_bytes.decode("utf-8"))
    except (json.JSONDecodeError, UnicodeDecodeError, ValueError) as exc:
        return CodexCallResult(
            raw_output="",
            duration_s=duration,
            input_tokens=0,
            output_tokens=0,
            error=f"responses api invalid JSON: {exc}",
        )
    if not isinstance(payload, dict):
        return CodexCallResult(
            raw_output="",
            duration_s=duration,
            input_tokens=0,
            output_tokens=0,
            error="responses api returned non-object payload",
        )

    raw_usage = payload.get("usage")
    usage: dict[str, Any] = raw_usage if isinstance(raw_usage, dict) else {}
    # output_tokens already includes reasoning tokens; do NOT add
    # output_tokens_details.reasoning_tokens or we'd double-count cost.
    # Coerce defensively — schema drift (string instead of int) shouldn't
    # crash dispatch; treat as unknown and zero out. Round-3 finding 4.
    def _safe_int(v: Any) -> int:
        try:
            return int(v) if v is not None else 0
        except (TypeError, ValueError):
            return 0

    in_tokens = _safe_int(usage.get("input_tokens"))
    out_tokens = _safe_int(usage.get("output_tokens"))

    text = _extract_responses_text(payload)
    # FU-rt11 (PR #430 review #20) — capture the Responses-API ``id`` so
    # downstream telemetry can correlate against OpenAI-side logs.
    raw_request_id = payload.get("id")
    request_id = raw_request_id if isinstance(raw_request_id, str) and raw_request_id else None
    status = payload.get("status")
    if isinstance(status, str) and status != "completed":
        # Provider error objects can echo rejected prompt content into
        # `error.message`; that string lands in audit logs. Surface only
        # status + structured `error.code` (which is enumerated provider
        # state, not free-form content). Full error remains in raw_output
        # for debug. Round-3 finding 3.
        err = payload.get("error") if isinstance(payload.get("error"), dict) else {}
        code = err.get("code") if isinstance(err, dict) else None
        code_suffix = f" ({code})" if isinstance(code, str) and code else ""
        return CodexCallResult(
            raw_output=text,
            duration_s=duration,
            input_tokens=in_tokens,
            output_tokens=out_tokens,
            error=f"responses api status {status}{code_suffix}",
            request_id=request_id,
        )

    return CodexCallResult(
        raw_output=text,
        duration_s=duration,
        input_tokens=in_tokens,
        output_tokens=out_tokens,
        error=None,
        request_id=request_id,
    )


def _resolve_rates(model: str, model_rates: dict[str, Any]) -> dict[str, float]:
    """Look up rates for a model, falling back to _fallback."""
    if model in model_rates:
        return model_rates[model]
    return model_rates.get("_fallback", {"input_per_1m_usd": 0.0, "output_per_1m_usd": 0.0})


def _cost_for(input_tokens: int, output_tokens: int, rates: dict[str, float]) -> float:
    return (
        input_tokens * rates.get("input_per_1m_usd", 0.0)
        + output_tokens * rates.get("output_per_1m_usd", 0.0)
    ) / 1_000_000


@dataclass
class CallTelemetryRecord:
    """One call's measurable footprint, for FU-rt11 telemetry sinks.

    The orchestrator-facing ``CallTelemetrySink`` receives this on every
    dispatched call (primary, verification, regen, inner-review, fix-plan).
    Fields are the union of what cost/budget forensics, transport-fallback
    detection, and Responses-API correlation need.
    """

    call_id: str
    call_phase: str  # primary | verification | regeneration | inner_review | fix_plan
    round_num: int
    configured_model: str
    actual_model: str  # post-fallback (codex-CLI may swap)
    transport: str  # "responses_api" | "codex_cli"
    prompt_chars: int
    truncated: bool
    input_tokens: int
    output_tokens: int
    duration_s: float
    cost_usd: float
    error: str | None
    request_id: str | None  # Responses-API id when available


class CallTelemetrySink:
    """Hook surface injected by the orchestrator. Default = no-op.

    Two methods, fired around each call:

    - ``start(call_id, call_phase, round_num, configured_model, prompt_chars,
      truncated)``
    - ``end(record)`` with the populated :class:`CallTelemetryRecord`

    A live implementation translates these into ``red_team_call_start`` /
    ``red_team_call_end`` insight events; the in-tree default is silent so
    unit tests that build ``RedTeamRunContext`` without a telemetry hook
    don't break.
    """

    def start(
        self,
        *,
        call_id: str,
        call_phase: str,
        round_num: int,
        configured_model: str,
        prompt_chars: int,
        truncated: bool,
    ) -> None:  # pragma: no cover - default no-op
        del call_id, call_phase, round_num, configured_model, prompt_chars, truncated

    def end(self, record: CallTelemetryRecord) -> None:  # pragma: no cover
        del record


_NULL_TELEMETRY = CallTelemetrySink()


def _new_call_id() -> str:
    """Short opaque ID for one dispatch call. Used to pair start/end events."""
    import uuid
    return uuid.uuid4().hex[:12]


def _prompt_was_truncated(prompt: str) -> bool:
    """Heuristic: ``_wrap_input`` injects a ``[TRUNCATED to N chars]`` marker
    into any block that exceeded the cap. Presence of that marker means the
    prompt was truncated *somewhere*.

    Used by FU-rt11 telemetry so an operator triaging a flicker / bad result
    can see at a glance whether the relevant artifact made it into the call.
    """
    return "[TRUNCATED to " in prompt


def run_red_team(
    stage: str,
    artifact: str,
    source_spec: str,
    pr_diff: str | None,
    personas: list[str],
    model: str,
    model_rates: dict[str, Any],
    cwd: str | None,
    timeout_s: int,
    min_severity_to_block: str,
    max_input_chars: int,
    round_num: int = 1,
    env: dict[str, str] | None = None,
    telemetry: CallTelemetrySink | None = None,
    call_phase: str = "primary",
) -> RedTeamResult:
    """Run one red-team call. Returns a RedTeamResult.

    Does not retry — the orchestrator handles retry policy.

    The optional ``telemetry`` sink fires per-call ``start`` / ``end`` events
    around dispatch. ``call_phase`` lets the orchestrator label primary vs.
    verification vs. regeneration vs. inner-review without changing the
    return shape (FU-rt11).
    """
    sink = telemetry or _NULL_TELEMETRY
    prompt = assemble_prompt(
        stage=stage,
        personas=personas,
        artifact=artifact,
        source_spec=source_spec,
        pr_diff=pr_diff,
        max_input_chars=max_input_chars,
    )
    prompt_chars = len(prompt)
    truncated = _prompt_was_truncated(prompt)
    call_id = _new_call_id()

    sink.start(
        call_id=call_id,
        call_phase=call_phase,
        round_num=round_num,
        configured_model=model,
        prompt_chars=prompt_chars,
        truncated=truncated,
    )

    transport: str
    if model in RESPONSES_API_MODELS:
        transport = "responses_api"
        call = dispatch_responses_api(
            prompt=prompt,
            model=model,
            timeout_s=timeout_s,
            env=env,
        )
    else:
        transport = "codex_cli"
        call = dispatch_codex(
            prompt=prompt,
            model=model,
            cwd=cwd,
            timeout_s=timeout_s,
            env=env,
        )

    rates = _resolve_rates(model, model_rates)
    cost_usd = _cost_for(call.input_tokens, call.output_tokens, rates)
    sink.end(
        CallTelemetryRecord(
            call_id=call_id,
            call_phase=call_phase,
            round_num=round_num,
            configured_model=model,
            # ``actual_model`` differs from ``configured_model`` only if a
            # downstream layer fell back; today both transports honor the
            # configured ID, so they match. Tracked separately so the
            # invariant is observable when fallback paths grow.
            actual_model=model,
            transport=transport,
            prompt_chars=prompt_chars,
            truncated=truncated,
            input_tokens=call.input_tokens,
            output_tokens=call.output_tokens,
            duration_s=call.duration_s,
            cost_usd=cost_usd,
            error=call.error,
            # FU-rt11: Responses API attaches an ``id`` to every payload;
            # codex-CLI dispatch leaves this None.
            request_id=call.request_id,
        )
    )

    if call.error is not None:
        return RedTeamResult(
            stage=stage,
            round_num=round_num,
            synthesis="",
            findings=[],
            blocking_count=0,
            human_review_count=0,
            raw_output=call.raw_output,
            duration_s=call.duration_s,
            cost_usd=cost_usd,
            error=call.error,
            input_tokens=call.input_tokens,
            output_tokens=call.output_tokens,
        )

    parsed = parse_output(call.raw_output)
    # rt3 — do not fail open into clean. There are three ways the model
    # output can look like "0 findings = clean" without actually being one:
    #   (a) empty raw_output / non-JSON / non-object JSON  → parsed == {}
    #   (b) valid object but no `findings` key             → schema drift
    #   (c) `findings` key present but not a list          → schema drift
    # All three were previously indistinguishable from a successful clean
    # review. Surface them as `error` so the orchestrator routes to a
    # degraded/halted path. raw_output is preserved on the same dataclass
    # for debug; the error string itself is generic so it's safe to land
    # in audit logs (model output may echo attacker-controlled spec/diff
    # content, so we don't embed an excerpt here — review found 9).
    parse_error_reason: str | None = None
    if not parsed:
        parse_error_reason = "empty or not valid JSON"
    elif "findings" not in parsed:
        parse_error_reason = "missing required 'findings' field"
    elif not isinstance(parsed.get("findings"), list):
        parse_error_reason = "'findings' field is not a list"
    if parse_error_reason is not None:
        return RedTeamResult(
            stage=stage,
            round_num=round_num,
            synthesis="",
            findings=[],
            blocking_count=0,
            human_review_count=0,
            raw_output=call.raw_output,
            duration_s=call.duration_s,
            cost_usd=cost_usd,
            error=(
                f"red-team output {parse_error_reason} — refusing to treat as "
                "clean. See raw_output for full text."
            ),
            input_tokens=call.input_tokens,
            output_tokens=call.output_tokens,
        )
    synthesis = parsed.get("synthesis", "")
    raw_findings = parsed.get("findings") or []
    findings = validate_findings(raw_findings) if isinstance(raw_findings, list) else []

    # rt3 (round-3 #8) — if the model emitted findings but ALL of them
    # failed schema validation, that's schema drift, not a clean run. The
    # earlier guards caught missing/non-list findings; this one catches
    # the case where the array exists with N entries but every entry is
    # malformed (wrong persona slug, missing required fields, etc.).
    if raw_findings and not findings:
        return RedTeamResult(
            stage=stage,
            round_num=round_num,
            synthesis=synthesis if isinstance(synthesis, str) else "",
            findings=[],
            blocking_count=0,
            human_review_count=0,
            raw_output=call.raw_output,
            duration_s=call.duration_s,
            cost_usd=cost_usd,
            error=(
                f"red-team output had {len(raw_findings)} findings but all "
                "failed schema validation — refusing to treat as clean. "
                "See raw_output for full text."
            ),
            input_tokens=call.input_tokens,
            output_tokens=call.output_tokens,
        )

    return RedTeamResult(
        stage=stage,
        round_num=round_num,
        synthesis=synthesis if isinstance(synthesis, str) else "",
        findings=findings,
        blocking_count=count_blocking(findings, min_severity_to_block),
        human_review_count=count_human_review(findings),
        raw_output=call.raw_output,
        duration_s=call.duration_s,
        cost_usd=cost_usd,
        error=None,
        input_tokens=call.input_tokens,
        output_tokens=call.output_tokens,
    )


def run_red_team_fix_plan(
    ctx: RedTeamRunContext,
    *,
    artifact: str,
    source_spec: str,
    challenge_findings: list[RedTeamFinding],
    synthesis: str,
    challenge_cost_usd: float,
    telemetry: CallTelemetrySink | None = None,
) -> RedTeamFixPlan:
    """Run one fix-plan attempt for blocking challenge findings.

    The dispatcher gate should call ``preflight_findings_envelope`` with the
    same filtered findings before deciding whether to dispatch. This function
    repeats that single serialization decision internally so direct callers get
    identical skip/error behavior and prompt contents.

    The optional ``telemetry`` sink fires per-call ``start`` / ``end`` events
    with ``call_phase="fix_plan"`` around the Responses-API dispatch (PR #430
    review fix for FU-rt11 finding #19).
    """
    del challenge_cost_usd  # Cost budget handling is a dispatcher concern.
    sink = telemetry or _NULL_TELEMETRY
    fix_cfg = ctx.cfg_red_team.get("fix_plan", {})
    model = str(fix_cfg.get("model", ""))
    reasoning_effort = str(fix_cfg.get("reasoning_effort", ""))
    max_input_chars = int(fix_cfg.get("max_input_chars", _DEFAULT_MAX_INPUT_CHARS))
    timeout_s = int(fix_cfg.get("timeout_s", 1200))

    filtered_findings = [f for f in challenge_findings if not is_human_review(f)]
    envelope, fits_safely, omitted_ids = preflight_findings_envelope(filtered_findings, max_input_chars)
    input_truncated = bool(omitted_ids)
    if not fits_safely:
        return _empty_fix_plan(
            error="findings JSON cannot be safely truncated",
            model=model,
            reasoning_effort=reasoning_effort,
            input_truncated=input_truncated,
            input_omitted_finding_ids=omitted_ids,
        )

    if model not in RESPONSES_API_MODELS:
        return _empty_fix_plan(
            error=f"fix-plan requires a Responses-API model; got {model}",
            model=model,
            reasoning_effort=reasoning_effort,
            input_truncated=input_truncated,
            input_omitted_finding_ids=omitted_ids,
        )

    prompt = _assemble_fix_plan_prompt_from_envelope(
        stage=ctx.stage,
        artifact=artifact,
        source_spec=source_spec,
        findings_envelope=envelope,
        synthesis=synthesis,
        max_input_chars=max_input_chars,
    )
    call_id = _new_call_id()
    prompt_chars = len(prompt)
    truncated = _prompt_was_truncated(prompt)
    sink.start(
        call_id=call_id,
        call_phase="fix_plan",
        round_num=0,
        configured_model=model,
        prompt_chars=prompt_chars,
        truncated=truncated,
    )
    call = dispatch_responses_api(
        prompt=prompt,
        model=model,
        timeout_s=timeout_s,
        reasoning_effort=reasoning_effort,
        env=ctx.env,
        max_output_tokens=_RESPONSES_API_DEFAULT_MAX_OUTPUT_TOKENS,
    )
    rates = _resolve_rates(model, ctx.model_rates)
    cost_usd = _cost_for(call.input_tokens, call.output_tokens, rates)
    sink.end(
        CallTelemetryRecord(
            call_id=call_id,
            call_phase="fix_plan",
            round_num=0,
            configured_model=model,
            actual_model=model,
            transport="responses_api",
            prompt_chars=prompt_chars,
            truncated=truncated,
            input_tokens=call.input_tokens,
            output_tokens=call.output_tokens,
            duration_s=call.duration_s,
            cost_usd=cost_usd,
            error=call.error,
            request_id=call.request_id,
        )
    )
    if call.error is not None:
        return _empty_fix_plan(
            error=call.error,
            raw_output=call.raw_output,
            duration_s=call.duration_s,
            cost_usd=cost_usd,
            input_tokens=call.input_tokens,
            output_tokens=call.output_tokens,
            model=model,
            reasoning_effort=reasoning_effort,
            input_truncated=input_truncated,
            input_omitted_finding_ids=omitted_ids,
        )

    parsed = parse_fix_plan_output(call.raw_output)
    if not parsed:
        return _empty_fix_plan(
            error="fix-plan output empty or not valid JSON",
            raw_output=call.raw_output,
            duration_s=call.duration_s,
            cost_usd=cost_usd,
            input_tokens=call.input_tokens,
            output_tokens=call.output_tokens,
            model=model,
            reasoning_effort=reasoning_effort,
            input_truncated=input_truncated,
            input_omitted_finding_ids=omitted_ids,
        )

    blocking_ids = [
        f.id
        for f in filtered_findings
        if SEVERITY_RANK.get(f.severity, 0) >= SEVERITY_RANK["high"]
    ]
    plan = validate_fix_plan(parsed, blocking_ids, fix_cfg)
    plan.raw_output = call.raw_output
    plan.duration_s = call.duration_s
    plan.cost_usd = cost_usd
    plan.input_tokens = call.input_tokens
    plan.output_tokens = call.output_tokens
    plan.model = model
    plan.reasoning_effort = reasoning_effort
    plan.input_truncated = input_truncated
    plan.input_omitted_finding_ids = omitted_ids
    return plan
