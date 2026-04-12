"""Dispatch primitives for stark-forged-review.

Wraps the per-agent CLI invocations used by `forged_review.py`. This is a
*dispatcher*, not an orchestrator — it knows how to run ONE agent with ONE
prompt, and how to compose leader + second-opinion for a domain. The
top-level orchestration (loop, gate, fix path, re-review) lives in
`forged_review.py`.

Kept intentionally small (~300 lines) to avoid the complexity of
`multi_review.py` (2000+ lines). Reuses `claude_utils`, `codex_utils`,
`gemini_utils` for CLI building and env setup.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from claude_utils import build_claude_cmd, make_clean_env
from codex_utils import (
    CODEX_REASONING_EFFORT_HIGH,
    get_codex_model,
    parse_jsonl_output,
)
from config_loader import get_forged_review_config, is_agent_enabled
from gemini_utils import get_gemini_model, make_gemini_env, setup_gemini_home

try:
    from runtime_env import build_agent_env
except ImportError:  # pragma: no cover
    build_agent_env = None  # type: ignore

import forged_review_engine as eng


DEFAULT_TIMEOUT_S = 900
GEMINI_TIMEOUT_S = 600
PROMPTS_ROOT = Path.home() / ".claude" / "code-review" / "prompts" / "forged-review"


# ── Dataclasses ────────────────────────────────────────────────────────


@dataclass
class AgentCallResult:
    """Result of a single CLI invocation."""

    agent: str
    raw_output: str
    duration_s: float
    error: str | None = None

    @property
    def ok(self) -> bool:
        return self.error is None


@dataclass
class DomainResult:
    """Merged result for one domain after leader + second-opinion."""

    domain: str
    leader_agent: str
    second_agent: str
    merged: dict[str, list[dict[str, Any]]]
    leader_duration_s: float
    second_duration_s: float
    leader_error: str | None = None
    second_error: str | None = None
    actionable: list[dict[str, Any]] = field(default_factory=list)


# ── Prompt loader ──────────────────────────────────────────────────────


def load_prompt(relative: str) -> str:
    """Load a prompt file from the forged-review prompts tree.

    `relative` is a path relative to `global/prompts/forged-review/`, e.g.
    `triage/triage.md` or `claude/01-architecture-leader.md`.
    """
    path = PROMPTS_ROOT / relative
    if not path.exists():
        raise FileNotFoundError(f"forged-review prompt not found: {path}")
    return path.read_text(encoding="utf-8")


# ── Single-agent dispatch ──────────────────────────────────────────────


def run_agent(
    agent: str,
    prompt: str,
    cwd: str | None = None,
    timeout_s: int | None = None,
) -> AgentCallResult:
    """Run one agent with the given prompt. Returns AgentCallResult.

    No retries — orchestrator handles retry policy if needed.
    """
    t0 = time.time()
    if not is_agent_enabled(agent):
        return AgentCallResult(agent=agent, raw_output="", duration_s=0.0, error="agent_disabled")

    gemini_home: str | None = None
    try:
        if agent == "claude":
            cmd = build_claude_cmd(output_format="text")
            stdin_input: str | None = prompt
            env: dict[str, str] = (
                build_agent_env("claude", "review")
                if build_agent_env is not None
                else make_clean_env()
            )
            effective_timeout = timeout_s or DEFAULT_TIMEOUT_S
        elif agent == "codex":
            cmd = [
                "codex",
                "exec",
                "-m",
                get_codex_model(),
                "-c",
                CODEX_REASONING_EFFORT_HIGH,
                "--ephemeral",
                "--json",
                "-s",
                "read-only",
                "-",
            ]
            stdin_input = prompt
            env = (
                build_agent_env("codex", "review")
                if build_agent_env is not None
                else make_clean_env()
            )
            effective_timeout = timeout_s or DEFAULT_TIMEOUT_S
        elif agent == "gemini":
            effective_cwd = cwd or os.getcwd()
            gemini_home = setup_gemini_home(
                "gemini-forged-", effective_cwd, "review", approval_mode="plan",
            )
            cmd = [
                "gemini",
                "-m",
                get_gemini_model(),
                "-p",
                prompt,
                "-o",
                "json",
            ]
            stdin_input = None
            env = make_gemini_env(gemini_home)
            effective_timeout = timeout_s or GEMINI_TIMEOUT_S
        else:
            return AgentCallResult(
                agent=agent, raw_output="", duration_s=0.0,
                error=f"unknown agent: {agent}",
            )

        run_kwargs: dict[str, Any] = {
            "capture_output": True,
            "text": True,
            "timeout": effective_timeout,
            "cwd": cwd,
            "env": env,
        }
        if stdin_input is not None:
            run_kwargs["input"] = stdin_input

        result = subprocess.run(cmd, **run_kwargs)
        duration = time.time() - t0

        if result.returncode != 0:
            return AgentCallResult(
                agent=agent,
                raw_output=result.stdout or "",
                duration_s=duration,
                error=f"exit {result.returncode}: {(result.stderr or '').strip()[:400]}",
            )

        raw = result.stdout or ""
        if agent == "codex":
            raw = parse_jsonl_output(raw)
        return AgentCallResult(agent=agent, raw_output=raw, duration_s=duration)

    except subprocess.TimeoutExpired:
        return AgentCallResult(
            agent=agent,
            raw_output="",
            duration_s=time.time() - t0,
            error=f"timeout after {timeout_s or DEFAULT_TIMEOUT_S}s",
        )
    except (OSError, FileNotFoundError) as exc:
        return AgentCallResult(
            agent=agent, raw_output="", duration_s=time.time() - t0, error=str(exc),
        )
    finally:
        if gemini_home and os.path.isdir(gemini_home):
            shutil.rmtree(gemini_home, ignore_errors=True)


# ── JSON extraction ────────────────────────────────────────────────────


def extract_json(raw: str, expect_array: bool = False) -> Any:
    """Best-effort JSON extraction from an agent's raw output.

    Agents often wrap JSON in prose or fences. We try:
      1. parse the whole thing
      2. strip markdown fences
      3. find the first/last `{..}` or `[..]` block

    Returns the parsed value, or an empty list/dict if extraction fails.
    """
    raw = (raw or "").strip()
    if not raw:
        return [] if expect_array else {}

    try:
        return json.loads(raw)
    except (json.JSONDecodeError, ValueError):
        pass

    fenced = raw
    if "```" in fenced:
        parts = fenced.split("```")
        for part in parts:
            part = part.strip()
            if part.startswith("json"):
                part = part[4:].strip()
            if part.startswith(("[", "{")):
                try:
                    return json.loads(part)
                except (json.JSONDecodeError, ValueError):
                    continue

    open_ch = "[" if expect_array else "{"
    close_ch = "]" if expect_array else "}"
    start = raw.find(open_ch)
    end = raw.rfind(close_ch)
    if 0 <= start < end:
        candidate = raw[start : end + 1]
        try:
            return json.loads(candidate)
        except (json.JSONDecodeError, ValueError):
            pass

    return [] if expect_array else {}


# ── Triage dispatch ────────────────────────────────────────────────────


def dispatch_triage(
    pr_diff: str,
    changed_files: list[str],
    pr_description: str,
    cwd: str | None = None,
) -> dict[str, Any]:
    """Run the triage prompt. Returns {selected_domains, rationale}.

    On any failure, returns a safe-default dict that selects all 9 domains.
    """
    cfg = get_forged_review_config()
    triage_agent = cfg.get("triage_agent", "claude")

    try:
        triage_prompt = load_prompt("triage/triage.md")
    except FileNotFoundError as exc:
        return _fallback_triage(f"prompt not found: {exc}")

    payload = (
        triage_prompt
        + "\n\n## PR Description\n"
        + (pr_description or "(none)")
        + "\n\n## Changed files\n"
        + "\n".join(f"- {f}" for f in changed_files)
        + "\n\n## Diff (truncated to first 12k chars)\n"
        + (pr_diff or "")[:12000]
    )

    result = run_agent(triage_agent, payload, cwd=cwd, timeout_s=300)
    if not result.ok:
        return _fallback_triage(f"triage agent failed: {result.error}")

    parsed = extract_json(result.raw_output, expect_array=False)
    if not isinstance(parsed, dict) or "selected_domains" not in parsed:
        return _fallback_triage("triage output malformed")
    return parsed


def _fallback_triage(reason: str) -> dict[str, Any]:
    return {
        "selected_domains": [
            "architecture", "accessibility", "correctness", "type-safety",
            "security", "test-coverage", "spec-conformance",
            "ui-design-conformance", "regression-prevention",
        ],
        "rationale": {
            d: f"fallback — {reason}"
            for d in [
                "architecture", "accessibility", "correctness", "type-safety",
                "security", "test-coverage", "spec-conformance",
                "ui-design-conformance", "regression-prevention",
            ]
        },
    }


# ── Domain leader + second-opinion dispatch ────────────────────────────


# Numeric prefix for domain filename resolution. Must match the prompts tree.
_DOMAIN_NUMBERS = {
    "architecture":          "01",
    "accessibility":         "02",
    "correctness":           "03",
    "type-safety":           "04",
    "security":              "05",
    "test-coverage":         "06",
    "spec-conformance":      "07",
    "ui-design-conformance": "08",
    "regression-prevention": "09",
}


def _domain_prompt_path(agent: str, domain: str, role: str) -> str:
    num = _DOMAIN_NUMBERS[domain]
    return f"{agent}/{num}-{domain}-{role}.md"


def dispatch_domain(
    domain: str,
    leader_agent: str,
    second_agent: str,
    pr_diff: str,
    file_scope: list[str] | None = None,
    cwd: str | None = None,
) -> DomainResult:
    """Run leader then second-opinion for one domain. Returns DomainResult."""
    scope_note = ""
    if file_scope:
        scope_note = (
            "\n\n## Delta-review scope\n"
            "Only review these files (ignore others in the diff):\n"
            + "\n".join(f"- {f}" for f in file_scope)
        )

    # Leader pass
    leader_prompt = load_prompt(_domain_prompt_path(leader_agent, domain, "leader"))
    leader_input = (
        leader_prompt
        + "\n\n## PR Diff\n"
        + (pr_diff or "")
        + scope_note
    )
    leader_result = run_agent(leader_agent, leader_input, cwd=cwd)
    leader_findings = []
    if leader_result.ok:
        parsed = extract_json(leader_result.raw_output, expect_array=True)
        if isinstance(parsed, list):
            leader_findings = [f for f in parsed if isinstance(f, dict)]
            _ensure_finding_ids(leader_findings)

    # Second pass
    second_prompt = load_prompt(_domain_prompt_path(second_agent, domain, "second"))
    second_input = (
        second_prompt
        + "\n\n## PR Diff\n"
        + (pr_diff or "")
        + "\n\n## Leader findings (classify each)\n"
        + json.dumps(leader_findings, indent=2)
        + scope_note
    )
    second_result = run_agent(second_agent, second_input, cwd=cwd)
    second_parsed: dict[str, Any] = {"decisions": [], "second_only": []}
    if second_result.ok:
        parsed_obj = extract_json(second_result.raw_output, expect_array=False)
        if isinstance(parsed_obj, dict):
            second_parsed = {
                "decisions": parsed_obj.get("decisions") or [],
                "second_only": parsed_obj.get("second_only") or [],
            }

    merged = eng.merge_findings(leader_findings, second_parsed)
    actionable = eng.actionable_from_merged(merged)

    return DomainResult(
        domain=domain,
        leader_agent=leader_agent,
        second_agent=second_agent,
        merged=merged,
        leader_duration_s=leader_result.duration_s,
        second_duration_s=second_result.duration_s,
        leader_error=leader_result.error,
        second_error=second_result.error,
        actionable=actionable,
    )


def _ensure_finding_ids(findings: list[dict[str, Any]]) -> None:
    """Assign fallback `id` fields to any findings missing one.

    Leader prompts are instructed to provide stable ids, but defensive against
    malformed output. Ids are assigned sequentially: `f1`, `f2`, ….
    """
    counter = 1
    existing = {f.get("id") for f in findings if isinstance(f.get("id"), str)}
    for f in findings:
        if not isinstance(f.get("id"), str):
            while f"f{counter}" in existing:
                counter += 1
            f["id"] = f"f{counter}"
            existing.add(f["id"])
            counter += 1


# ── Full review round ──────────────────────────────────────────────────


def run_review_round(
    selected_domains: list[str],
    domain_pairs: dict[str, dict[str, str]],
    pr_diff: str,
    cwd: str | None = None,
    file_scope: list[str] | None = None,
    max_workers: int = 3,
) -> dict[str, DomainResult]:
    """Run all selected domains in parallel. Returns {domain: DomainResult}.

    Each domain still runs leader→second serially; domains run in parallel via
    a ThreadPoolExecutor.
    """
    results: dict[str, DomainResult] = {}
    if not selected_domains:
        return results

    with ThreadPoolExecutor(max_workers=max_workers) as pool:
        futures = {}
        for domain in selected_domains:
            pair = domain_pairs.get(domain)
            if not pair:
                continue
            fut = pool.submit(
                dispatch_domain,
                domain,
                pair["leader"],
                pair["second"],
                pr_diff,
                file_scope,
                cwd,
            )
            futures[fut] = domain
        for fut in as_completed(futures):
            domain = futures[fut]
            try:
                results[domain] = fut.result()
            except Exception as exc:  # pragma: no cover - guardrail
                results[domain] = DomainResult(
                    domain=domain,
                    leader_agent=domain_pairs[domain]["leader"],
                    second_agent=domain_pairs[domain]["second"],
                    merged={"confirmed": [], "disputed": [], "leader_only": [], "second_only": []},
                    leader_duration_s=0.0,
                    second_duration_s=0.0,
                    leader_error=f"dispatch exception: {exc}",
                )
    return results


# ── Red-team integration scaffold ─────────────────────────────────────
#
# Added by Task 18 of stark-red-team. This wrapper exists so the
# forged_review forge path can call into stark_red_team without coupling
# directly. The forge path itself is a v1 no-op placeholder, so this
# wrapper will only be exercised once that path activates.

def dispatch_red_team_for_stage(
    stage: str,
    artifact: str,
    source_spec: str,
    pr_diff: str | None,
    cwd: str | None,
    run_id: str,
) -> dict:
    """Wrapper for the red-team dispatcher, called from forged_review's forge path.

    V1 scaffolding: the forge path in /stark-forged-review is itself deferred
    to a later release. This call site exists so when forge-path auto-apply
    ships, the red-team hook is already in place.
    """
    from config_loader import get_red_team_config, get_model_rates
    import stark_red_team as _rt

    cfg = get_red_team_config()
    if not cfg.get("enabled", True) or not cfg.get("stages", {}).get(stage, {}).get("enabled", False):
        return {"status": "disabled", "reason": f"red_team.stages.{stage}.enabled is false"}

    model_rates = get_model_rates()
    result = _rt.run_red_team(
        stage=stage,
        artifact=artifact,
        source_spec=source_spec,
        pr_diff=pr_diff,
        personas=cfg["personas"],
        model=cfg["model"],
        model_rates=model_rates,
        cwd=cwd,
        timeout_s=cfg["timeout_s"],
        min_severity_to_block=cfg["min_severity_to_block"],
        max_input_chars=cfg["max_input_chars"],
        round_num=1,
    )
    return {
        "status": "halted" if result.blocking_count > 0 or result.human_review_count > 0 else "clean",
        "result": result,
    }
