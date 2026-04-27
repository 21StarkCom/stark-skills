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


def validate_findings(raw_findings: list[dict[str, Any]]) -> list[RedTeamFinding]:
    """Convert raw dicts to RedTeamFinding, dropping invalid entries.

    Rules:
    - `persona` must be in VALID_PERSONA_SLUGS
    - `severity` must be in VALID_SEVERITIES
    - Required string fields: id, concern, consequence, counter_proposal
    - Either (a) concrete counter_proposal + trade_off (string), or
             (b) counter_proposal == REQUEST_HUMAN_REVIEW + reason_for_uncertainty (string)
    - Invalid entries are silently dropped
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
        if f.counter_proposal != REQUEST_HUMAN_REVIEW
        and SEVERITY_RANK.get(f.severity, 0) >= floor
    )


def count_human_review(findings: list[RedTeamFinding]) -> int:
    return sum(1 for f in findings if f.counter_proposal == REQUEST_HUMAN_REVIEW)


_WORD_RE = re.compile(r"[A-Za-z][A-Za-z0-9']*")


def _tokenize(text: str) -> set[str]:
    return {m.group(0).lower() for m in _WORD_RE.finditer(text)}


def _jaccard(a: set[str], b: set[str]) -> float:
    if not a or not b:
        return 0.0
    return len(a & b) / len(a | b)


def _overlap(
    rt_a: "RedTeamResult",
    rt_b: "RedTeamResult",
    jaccard_min: float = 0.4,
) -> bool:
    """Return True iff at least one blocking finding in each output shares
    the same persona and has a concern text Jaccard >= jaccard_min.

    Used by the stability check (rt2 + rt_b2). Two calls that find overlapping
    blocking findings under this definition are considered stably-blocking;
    calls that don't overlap are treated as flicker and the round is
    downgraded to advisory.
    """
    blocking_a = [f for f in rt_a.findings if f.counter_proposal != REQUEST_HUMAN_REVIEW
                  and SEVERITY_RANK.get(f.severity, 0) >= SEVERITY_RANK["high"]]
    blocking_b = [f for f in rt_b.findings if f.counter_proposal != REQUEST_HUMAN_REVIEW
                  and SEVERITY_RANK.get(f.severity, 0) >= SEVERITY_RANK["high"]]
    if not blocking_a or not blocking_b:
        return False

    for fa in blocking_a:
        tok_a = _tokenize(fa.concern)
        for fb in blocking_b:
            if fa.persona != fb.persona:
                continue
            tok_b = _tokenize(fb.concern)
            if _jaccard(tok_a, tok_b) >= jaccard_min:
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
) -> CodexCallResult:
    """Run codex with the given model override. Returns CodexCallResult."""
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

    usage = payload.get("usage") if isinstance(payload.get("usage"), dict) else {}
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
        )

    return CodexCallResult(
        raw_output=text,
        duration_s=duration,
        input_tokens=in_tokens,
        output_tokens=out_tokens,
        error=None,
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
) -> RedTeamResult:
    """Run one red-team call. Returns a RedTeamResult.

    Does not retry — the orchestrator handles retry policy.
    """
    prompt = assemble_prompt(
        stage=stage,
        personas=personas,
        artifact=artifact,
        source_spec=source_spec,
        pr_diff=pr_diff,
        max_input_chars=max_input_chars,
    )

    if model in RESPONSES_API_MODELS:
        call = dispatch_responses_api(
            prompt=prompt,
            model=model,
            timeout_s=timeout_s,
            env=env,
        )
    else:
        call = dispatch_codex(
            prompt=prompt,
            model=model,
            cwd=cwd,
            timeout_s=timeout_s,
            env=env,
        )

    rates = _resolve_rates(model, model_rates)
    cost_usd = _cost_for(call.input_tokens, call.output_tokens, rates)

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
