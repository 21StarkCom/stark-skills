#!/usr/bin/env python3
"""Validation dispatch for plan-to-tasks decompositions.

Orchestrates validation of plan breakdown files by dispatching to external
LLM CLI tools (Codex, Gemini) in parallel. Each agent reviews the breakdown
against the original plan and reports structural/completeness issues.

Follows patterns from plan_review_dispatch.py in this repo.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from codex_utils import CODEX_MODEL, CODEX_REASONING_EFFORT_HIGH
from gemini_utils import (
    GEMINI_MODEL, setup_gemini_home, make_gemini_env,
)

# ── Constants ────────────────────────────────────────────────────────────

SCRIPTS_DIR = Path(__file__).parent
GLOBAL_CONFIG = Path.home() / ".claude" / "code-review" / "config.json"
CODEX_REASONING_CONFIG = CODEX_REASONING_EFFORT_HIGH
DEFAULT_TIMEOUT = 300

DEFAULT_PLAN_TO_TASKS_CONFIG: dict[str, Any] = {
    "validation_agents": ["codex"],
    "timeout": DEFAULT_TIMEOUT,
}


# ── Data models ──────────────────────────────────────────────────────────


@dataclass
class ValidationIssue:
    phase_id: str
    task_id: str
    field: str
    problem: str
    suggestion: str = ""


@dataclass
class ValidationResult:
    agent: str
    approved: bool = False
    issues: list[ValidationIssue] = field(default_factory=list)
    raw_output: str = ""
    error: str | None = None
    duration_s: float = 0.0


# ── Config loading ────────────────────────────────────────────────────────


def load_config(
    repo_dir: str | None = None,
    global_config: str | None = None,
) -> dict[str, Any]:
    """Load plan_to_tasks section from config.json (global → repo).

    Checks:
        1. GLOBAL_CONFIG → plan_to_tasks section
        2. {repo_dir}/.code-review/config.json → plan_to_tasks section
    Merges onto DEFAULT_PLAN_TO_TASKS_CONFIG (repo overrides global).
    """
    config = dict(DEFAULT_PLAN_TO_TASKS_CONFIG)

    global_cfg_path = Path(global_config) if global_config else GLOBAL_CONFIG
    if global_cfg_path.exists():
        try:
            data = json.loads(global_cfg_path.read_text())
            section = data.get("plan_to_tasks", {})
            config.update(section)
        except (json.JSONDecodeError, OSError):
            pass

    if repo_dir:
        repo_cfg_path = Path(repo_dir) / ".code-review" / "config.json"
        if repo_cfg_path.exists():
            try:
                data = json.loads(repo_cfg_path.read_text())
                section = data.get("plan_to_tasks", {})
                config.update(section)
            except (json.JSONDecodeError, OSError):
                pass

    return config


# ── Utilities ─────────────────────────────────────────────────────────────


def compute_plan_hash(content: str) -> str:
    """Return sha256 hex digest of content, prefixed with 'sha256:'."""
    digest = hashlib.sha256(content.encode()).hexdigest()
    return f"sha256:{digest}"


# ── Validation prompt ─────────────────────────────────────────────────────

VALIDATION_PROMPT = """You are a validation agent for a plan decomposition. You receive a JSON envelope containing:
- plan_markdown: the original spec/design document
- breakdown: the structured task decomposition (phases → tasks)
- plan_hash: SHA-256 of the plan for integrity

Your job is adversarial — try to break the decomposition. Check:
1. Coverage — every requirement maps to at least one task
2. Self-containment — each task implementable without reading other issues
3. Dependency correctness — task_id references valid, no circular deps
4. Overlap — no two tasks describe same work
5. Sizing — tasks within guardrails (≤5 AC, ≤4 files, ≤500 words in how)
6. Review sufficiency — review hints specific, not generic
7. Metric sanity — story points consistent, risk ratings aligned
8. Cross-task name/type consistency — a method/type/file-path/env-var/label referenced across multiple tasks must use the same name. A function called `clearLayers()` in Task 3 but `clearFullLayers()` in Task 7 is a bug.

CALIBRATION — read this before flagging anything:
Only flag issues that would cause real problems during implementation — an implementer building the wrong thing, getting stuck, or shipping a bug. Minor wording, stylistic preferences, "could be clearer", and "nice to have" suggestions are NOT issues. Approve unless there are serious gaps: missing requirements, contradictory steps, placeholder content (TBD, "handle edge cases", "similar to above"), vague-to-the-point-of-unactionable tasks, or cross-task name/type mismatches.

Output ONLY a JSON object:
{"schema_version": 1, "approved": true/false, "issues": [{"phase_id": "...", "task_id": "...", "field": "...", "problem": "...", "suggestion": "..."}]}
If no issues: {"schema_version": 1, "approved": true, "issues": []}
Output ONLY the JSON, no other text."""

ISSUE_REQUIRED_FIELDS = {"phase_id", "task_id", "field", "problem"}


# ── Envelope builder ──────────────────────────────────────────────────────


def build_validation_envelope(
    plan_content: str,
    breakdown: dict[str, Any],
    plan_hash: str,
) -> dict[str, Any]:
    """Build the JSON envelope sent to each validation agent."""
    return {
        "schema_version": 1,
        "plan_markdown": plan_content,
        "breakdown": breakdown,
        "plan_hash": plan_hash,
    }


# ── Output parsing ────────────────────────────────────────────────────────


def _extract_codex_output(raw: str) -> str:
    """Extract text content from Codex JSONL event stream.

    Codex --json emits JSONL events. The actual response text appears in
    item.completed events in one of these forms (matching plan_review_dispatch.py):
    1. item.type == "agent_message" → item.text (direct text field)
    2. item.type == "message" → item.content[].output_text
    Falls back to raw string if no events are found.
    """
    # Only attempt JSONL parsing if output looks like JSON events
    if not raw.strip().startswith("{"):
        return raw

    parts: list[str] = []
    for line in raw.strip().splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            ev = json.loads(line)
        except json.JSONDecodeError:
            continue

        if ev.get("type") == "item.completed":
            item = ev.get("item", {})
            itype = item.get("type", "")
            if itype == "agent_message":
                # Primary path: direct text field on agent_message items
                text = item.get("text", "")
                if text:
                    parts.append(text)
            elif itype == "message":
                # Secondary path: content blocks with output_text
                for c in item.get("content", []):
                    if isinstance(c, dict) and c.get("type") == "output_text":
                        text = c.get("text", "")
                        if text:
                            parts.append(text)

    if parts:
        return "\n".join(parts)
    return raw


def _extract_gemini_output(raw: str) -> str:
    """Unwrap Gemini's {"response": "..."} envelope if present."""
    raw = raw.strip()
    try:
        outer = json.loads(raw)
        if isinstance(outer, dict) and "response" in outer:
            return outer["response"]
    except json.JSONDecodeError:
        pass
    return raw


def _strip_markdown_fences(text: str) -> str:
    """Remove ```json ... ``` or ``` ... ``` wrappers."""
    text = text.strip()
    # Match optional language tag after opening fence
    pattern = r"^```(?:json)?\s*\n?(.*?)\n?```$"
    match = re.match(pattern, text, re.DOTALL)
    if match:
        return match.group(1).strip()
    return text


def parse_validation_output(raw: str, agent: str) -> "ValidationResult":
    """Parse agent output into a ValidationResult.

    Applies agent-specific extraction, then strips markdown fences,
    then parses the JSON and constructs issues.
    """
    text = raw

    if agent == "codex":
        text = _extract_codex_output(text)
    elif agent == "gemini":
        text = _extract_gemini_output(text)

    text = _strip_markdown_fences(text)

    try:
        data = json.loads(text)
    except json.JSONDecodeError as exc:
        return ValidationResult(
            agent=agent,
            approved=False,
            raw_output=raw,
            error=f"JSON parse error: {exc}",
        )

    if not isinstance(data, dict):
        return ValidationResult(
            agent=agent,
            approved=False,
            raw_output=raw,
            error=f"Expected JSON object, got {type(data).__name__}",
        )

    approved = bool(data.get("approved", False))
    raw_issues = data.get("issues", [])
    issues: list[ValidationIssue] = []

    for item in raw_issues:
        if not isinstance(item, dict):
            continue
        if not ISSUE_REQUIRED_FIELDS.issubset(item.keys()):
            continue
        issues.append(
            ValidationIssue(
                phase_id=item["phase_id"],
                task_id=item["task_id"],
                field=item["field"],
                problem=item["problem"],
                suggestion=item.get("suggestion", ""),
            )
        )

    return ValidationResult(
        agent=agent,
        approved=approved,
        issues=issues,
        raw_output=raw,
    )


# ── Agent dispatch ────────────────────────────────────────────────────────


def _run_validation_agent(
    agent: str,
    envelope_json: str,
    timeout: int,
) -> ValidationResult:
    """Run a single validation agent subprocess and return its result."""
    start = time.monotonic()

    stdin_payload = f"{VALIDATION_PROMPT}\n\n{envelope_json}"

    try:
        if agent == "codex":
            result = subprocess.run(
                [
                    "codex", "exec",
                    "-m", CODEX_MODEL,
                    "-c", CODEX_REASONING_CONFIG,
                    "--ephemeral", "--json",
                    "--full-auto",
                    "-",
                ],
                input=stdin_payload,
                capture_output=True,
                text=True,
                timeout=timeout * 2,
            )
            raw = result.stdout or result.stderr

        elif agent == "gemini":
            gemini_home = setup_gemini_home(
                "stark-gemini-validate-", os.getcwd(), "validate",
                approval_mode="plan",
            )
            try:
                proc = subprocess.run(
                    [
                        "gemini",
                        "-m", GEMINI_MODEL,
                        "-p", VALIDATION_PROMPT,
                        "-o", "json",
                    ],
                    input=envelope_json,
                    capture_output=True,
                    text=True,
                    timeout=timeout,
                    env=make_gemini_env(gemini_home),
                )
                raw = proc.stdout or proc.stderr
            finally:
                shutil.rmtree(gemini_home, ignore_errors=True)

        else:
            return ValidationResult(
                agent=agent,
                error=f"Unknown agent: {agent}",
                duration_s=time.monotonic() - start,
            )

    except FileNotFoundError:
        return ValidationResult(
            agent=agent,
            error=f"agent_unavailable: {agent} not found in PATH",
            duration_s=time.monotonic() - start,
        )
    except subprocess.TimeoutExpired:
        return ValidationResult(
            agent=agent,
            error=f"Timeout after {timeout}s",
            duration_s=time.monotonic() - start,
        )
    except Exception as exc:  # noqa: BLE001
        return ValidationResult(
            agent=agent,
            error=f"Unexpected error: {exc}",
            duration_s=time.monotonic() - start,
        )

    duration = time.monotonic() - start
    validation_result = parse_validation_output(raw, agent=agent)
    validation_result.duration_s = duration
    return validation_result


def dispatch_validators(
    plan_content: str,
    breakdown: dict[str, Any] | str,
    plan_hash: str | None = None,
    agents: list[str] | None = None,
    timeout: int = DEFAULT_TIMEOUT,
) -> list[ValidationResult]:
    """Dispatch validation agents in parallel using ThreadPoolExecutor.

    Args:
        plan_content: Original plan/spec markdown.
        breakdown: Parsed breakdown dict or raw JSON string.
        plan_hash: SHA-256 hash of plan_content (computed if not provided).
        agents: List of agent names to dispatch. Defaults to config value.
        timeout: Per-agent timeout in seconds.

    Returns:
        List of ValidationResult objects (one per agent).
    """
    if plan_hash is None:
        plan_hash = compute_plan_hash(plan_content)

    if isinstance(breakdown, str):
        try:
            breakdown_dict: dict[str, Any] = json.loads(breakdown)
        except json.JSONDecodeError:
            breakdown_dict = {}
    else:
        breakdown_dict = breakdown

    if not agents:
        config = load_config()
        configured: list[str] | None = config.get("validation_agents")
        agents = configured if configured else ["codex"]

    envelope = build_validation_envelope(
        plan_content=plan_content,
        breakdown=breakdown_dict,
        plan_hash=plan_hash,
    )
    envelope_json = json.dumps(envelope)

    results: list[ValidationResult] = []

    with ThreadPoolExecutor(max_workers=len(agents)) as executor:
        futures = {
            executor.submit(_run_validation_agent, agent, envelope_json, timeout): agent
            for agent in agents
        }
        for future in as_completed(futures):
            results.append(future.result())

    return results


# ── CLI ───────────────────────────────────────────────────────────────────


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Validate a plan-to-tasks breakdown against the original plan.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        "plan_file",
        help="Path to the original plan/spec file.",
    )
    parser.add_argument(
        "breakdown_file",
        help="Path to the task breakdown JSON file to validate.",
    )
    parser.add_argument(
        "--agents",
        help="Comma-separated list of agents to use (default: from config, typically codex). "
             "Supported: codex, gemini. Claude is the orchestrator and is not a valid Pass 3 agent.",
    )
    parser.add_argument(
        "--timeout",
        type=int,
        default=DEFAULT_TIMEOUT,
        help=f"Per-agent timeout in seconds (default: {DEFAULT_TIMEOUT}).",
    )
    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()

    config = load_config()

    agents: list[str] = (
        args.agents.split(",") if args.agents else config.get("validation_agents", ["codex"])
    )
    SUPPORTED_VALIDATION_AGENTS = {"codex", "gemini"}
    invalid = [a for a in agents if a not in SUPPORTED_VALIDATION_AGENTS]
    if invalid:
        parser.error(
            f"unsupported validation agent(s): {','.join(invalid)}. "
            f"Supported: {','.join(sorted(SUPPORTED_VALIDATION_AGENTS))}. "
            "Claude is the orchestrator and is not a valid Pass 3 agent."
        )
    timeout: int = (
        args.timeout if args.timeout != DEFAULT_TIMEOUT else config.get("timeout", DEFAULT_TIMEOUT)
    )

    plan_content = Path(args.plan_file).read_text()
    breakdown_content = Path(args.breakdown_file).read_text()

    plan_hash = compute_plan_hash(plan_content)

    try:
        breakdown = json.loads(breakdown_content)
    except json.JSONDecodeError:
        breakdown = {}

    results = dispatch_validators(
        plan_content=plan_content,
        breakdown=breakdown,
        plan_hash=plan_hash,
        agents=agents,
        timeout=timeout,
    )

    output: dict[str, Any] = {
        "plan_hash": plan_hash,
        "agents": agents,
        "results": [
            {
                "agent": r.agent,
                "approved": r.approved,
                "issues_count": len(r.issues),
                "duration_s": r.duration_s,
                **({"error": r.error} if r.error else {}),
                **({"issues": [
                    {
                        "phase_id": i.phase_id,
                        "task_id": i.task_id,
                        "field": i.field,
                        "problem": i.problem,
                        "suggestion": i.suggestion,
                    }
                    for i in r.issues
                ]} if r.issues else {}),
            }
            for r in results
        ],
        "summary": {
            "total_agents": len(agents),
            "completed": len(results),
            "approved": sum(1 for r in results if r.approved),
            "total_issues": sum(len(r.issues) for r in results),
        },
    }

    print(json.dumps(output, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
