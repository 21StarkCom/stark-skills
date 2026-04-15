#!/usr/bin/env python3
"""Task decomposition and GitHub issue creation for stark-forge Phase 4.

Turns a reviewed implementation plan into validated phased GitHub issues.
Follows the auth split policy: always ``unset GH_TOKEN`` before ``gh issue create``.
"""
from __future__ import annotations

import json
import subprocess
import sys
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from forge_plan import PhaseResult  # pyright: ignore[reportMissingImports]


# ── Data models ────────────────────────────────────────────────────────────


@dataclass
class Task:
    phase_id: str
    task_id: str
    title: str
    body: str
    labels: list[str] = field(default_factory=list)
    issue_number: int | None = None


# Decomposer guardrails — must mirror the constraints in
# plan_to_tasks_validate.VALIDATION_PROMPT so the decomposer produces
# output that has a chance of passing validation. Keeping these in lockstep
# is what fixes the user-reported "3/3 validation failures on reasonable
# decompositions" — previously the decomposer prompt didn't mention sizing,
# coverage, or dependency rules at all and the LLM had to infer them.
_DECOMPOSER_GUARDRAILS = """
## Constraints
- Each task: ≤5 acceptance criteria, ≤4 file paths touched, ≤500 words in
  the "how" section. Split tasks that exceed these limits.
- Each task must be self-contained — implementable without reading sibling
  tasks. Restate any cross-task context inside the task body.
- Cover every requirement in the plan with at least one task. Do not skip
  optional sections.
- Task IDs are sequential within a phase (P1.1, P1.2, ...). Reference other
  tasks only via their task_id; no forward references that create cycles.
- No two tasks may describe the same work. If two tasks overlap, merge or
  re-scope them.
- Provide review hints that are specific to the change, not generic
  ("test the API" is not specific; "verify pagination cursor wrapping at
  the page boundary" is).
- Story points and risk ratings must be internally consistent — a 1pt task
  cannot be high-risk; a high-risk task cannot be 1pt.
"""


# ── Subprocess wrapper (mockable) ──────────────────────────────────────────


def _run_subprocess(
    cmd: list[str],
    *,
    capture_output: bool = True,
    text: bool = True,
    input: str | None = None,  # noqa: A002
    env: dict[str, str] | None = None,
    check: bool = False,
    timeout: int = 60,
) -> subprocess.CompletedProcess:
    """Thin wrapper around subprocess.run — replace in tests via patch."""
    return subprocess.run(
        cmd,
        capture_output=capture_output,
        text=text,
        input=input,
        env=env,
        check=check,
        timeout=timeout,
    )


# ── LLM task decomposition ─────────────────────────────────────────────────


def _format_validation_feedback(prior_issues: list[Any]) -> str:
    """Render validator issues from the prior attempt for prompt feedback.

    Returns an empty string when there are no issues — callers should test
    the result before adding a "feedback" section header to the prompt.
    """
    if not prior_issues:
        return ""
    lines: list[str] = []
    for issue in prior_issues[:30]:  # cap at 30 to keep prompt size sane
        phase_id = getattr(issue, "phase_id", "?")
        task_id = getattr(issue, "task_id", "?")
        field_name = getattr(issue, "field", "?")
        problem = getattr(issue, "problem", "")
        suggestion = getattr(issue, "suggestion", "")
        line = f"- {phase_id}/{task_id} [{field_name}]: {problem}"
        if suggestion:
            line += f" — suggestion: {suggestion}"
        lines.append(line)
    return "\n".join(lines)


def _extract_json_object(raw: str) -> dict[str, Any] | None:
    """Pull the largest top-level JSON object out of LLM output.

    Walks the string with a balanced-brace scanner that respects strings
    and escapes — far more tolerant of reasoning chatter, code fences, or
    trailing prose than ``raw.find("{") / raw.rfind("}")``.
    """
    text = raw.strip()
    # Strip a single fenced code block if the entire payload is wrapped
    if text.startswith("```"):
        import re  # noqa: PLC0415
        text = re.sub(r"^```(?:json)?\s*\n?", "", text)
        text = re.sub(r"\n?```\s*$", "", text)

    depth = 0
    start_idx = -1
    in_string = False
    escape = False
    for i, ch in enumerate(text):
        if in_string:
            if escape:
                escape = False
            elif ch == "\\":
                escape = True
            elif ch == '"':
                in_string = False
            continue
        if ch == '"':
            in_string = True
            continue
        if ch == "{":
            if depth == 0:
                start_idx = i
            depth += 1
        elif ch == "}":
            if depth == 0:
                continue
            depth -= 1
            if depth == 0 and start_idx != -1:
                candidate = text[start_idx:i + 1]
                try:
                    parsed = json.loads(candidate)
                except json.JSONDecodeError:
                    start_idx = -1
                    continue
                if isinstance(parsed, dict):
                    return parsed
    return None


def _build_decomposer_prompt(
    plan_text: str,
    prior_issues: list[Any] | None = None,
) -> str:
    """Build the decomposer prompt, optionally with retry feedback.

    The schema example is intentionally kept compact; the constraints block
    does the heavy lifting since LLMs tend to copy schema literally.
    """
    schema_example = (
        '{"phases": [{"phase_id": "P1", "name": "Phase Name", "tasks": ['
        '{"task_id": "P1.1", "title": "Task title", '
        '"body": "Acceptance criteria...\\n", '
        '"labels": ["forge", "phase-1"]}'
        "]}]}"
    )
    sections = [
        "Decompose the following implementation plan into phased GitHub issues.",
        f"Output ONLY a JSON object with this schema:\n{schema_example}",
        _DECOMPOSER_GUARDRAILS.strip(),
    ]
    feedback = _format_validation_feedback(prior_issues or [])
    if feedback:
        sections.append(
            "## Previous attempt failed validation\n"
            "The prior decomposition was rejected for the issues below. "
            "Fix every one of them in this regeneration:\n"
            f"{feedback}"
        )
    sections.append(f"# Plan\n\n{plan_text}")
    return "\n\n".join(sections)


def _decompose_plan(
    plan_text: str,
    cfg: dict[str, Any],
    prior_issues: list[Any] | None = None,
) -> dict[str, Any]:
    """Call an LLM to decompose the plan into phased tasks (JSON).

    Returns a breakdown dict ``{"phases": [...]}`` on success or ``{}`` on
    failure. ``prior_issues`` carries validator feedback from the previous
    attempt — when present, it is folded into the prompt so retries
    converge instead of re-rolling the same dice.
    """
    prompt = _build_decomposer_prompt(plan_text, prior_issues=prior_issues)

    try:
        from claude_utils import build_claude_cmd, make_clean_env  # noqa: PLC0415
        cmd = build_claude_cmd()
        result = _run_subprocess(
            cmd,
            input=prompt,
            env=make_clean_env(),
            timeout=cfg.get("timeout", 300),
        )
        if result.returncode != 0 or not result.stdout.strip():
            return {}
        parsed = _extract_json_object(result.stdout)
        return parsed or {}
    except Exception as exc:  # noqa: BLE001
        print(f"[forge_tasks] decompose_plan error: {exc}", file=sys.stderr)
        return {}


def _validate_breakdown(
    plan_text: str,
    breakdown: dict[str, Any],
    plan_hash: str | None = None,
    cfg: dict[str, Any] | None = None,
) -> list[Any]:
    """Run plan_to_tasks_validate.dispatch_validators() on the breakdown.

    Returns a list of ValidationResult objects; empty list on ImportError.
    """
    try:
        from plan_to_tasks_validate import dispatch_validators  # noqa: PLC0415
        timeout = (cfg or {}).get("timeout", 300)
        return dispatch_validators(
            plan_content=plan_text,
            breakdown=breakdown,
            plan_hash=plan_hash,
            timeout=timeout,
        )
    except ImportError:
        return []


def _validation_passed(results: list[Any]) -> bool:
    """Return True if all validators approved (or no validators ran)."""
    if not results:
        return True
    return all(getattr(r, "approved", True) for r in results)


# ── Task extraction ────────────────────────────────────────────────────────


def _extract_tasks(breakdown: dict[str, Any]) -> list[Task]:
    """Flatten phases → tasks from a breakdown dict into Task objects."""
    tasks: list[Task] = []
    for phase in breakdown.get("phases", []):
        phase_id = phase.get("phase_id", "P?")
        for raw_task in phase.get("tasks", []):
            tasks.append(
                Task(
                    phase_id=phase_id,
                    task_id=raw_task.get("task_id", ""),
                    title=raw_task.get("title", ""),
                    body=raw_task.get("body", ""),
                    labels=raw_task.get("labels", []),
                )
            )
    return tasks


# ── Phase 4: Run tasks ─────────────────────────────────────────────────────


def run_tasks_phase(
    plan_path: Path,
    state: dict[str, Any],
    cfg: dict[str, Any],
    repo_dir: Path,
) -> PhaseResult:
    """Decompose plan into tasks, validate, retry on failure.

    Up to 2 retries on validation failure (3 total attempts).
    Returns PhaseResult with status="completed" on success, "halted" on failure.
    """
    del repo_dir  # reserved for future working-directory-aware decomposition
    plan_text = plan_path.read_text(encoding="utf-8")
    plan_hash = state.get("phases", {}).get("plan", {}).get("plan_hash")

    max_attempts = 3
    breakdown: dict[str, Any] = {}
    prior_issues: list[Any] = []

    for attempt in range(1, max_attempts + 1):
        feedback_note = (
            f" with feedback from {len(prior_issues)} prior issue(s)"
            if prior_issues
            else ""
        )
        print(
            f"\n[forge_tasks] Decomposing plan (attempt {attempt}/{max_attempts})"
            f"{feedback_note}...",
            file=sys.stderr,
        )
        breakdown = _decompose_plan(plan_text, cfg, prior_issues=prior_issues)
        if not breakdown:
            print(
                f"[forge_tasks] Decomposition failed on attempt {attempt}.",
                file=sys.stderr,
            )
            if attempt < max_attempts:
                time.sleep(2)
            continue

        validation_results = _validate_breakdown(plan_text, breakdown, plan_hash, cfg)
        if _validation_passed(validation_results):
            print(
                f"[forge_tasks] Validation passed on attempt {attempt}.",
                file=sys.stderr,
            )
            break

        # Collect the issues into the feedback list so the next attempt's
        # prompt can address them specifically. Without this loop the
        # decomposer just re-rolls the dice on every retry.
        prior_issues = []
        for r in validation_results:
            prior_issues.extend(getattr(r, "issues", []))

        print(
            f"[forge_tasks] Validation failed — {len(prior_issues)} issue(s) "
            f"on attempt {attempt}; feeding back into next attempt.",
            file=sys.stderr,
        )
        breakdown = {}  # Reset — force re-generation
        if attempt < max_attempts:
            time.sleep(2)
    else:
        # All attempts exhausted
        print("[forge_tasks] All decomposition attempts failed — halting.", file=sys.stderr)
        return PhaseResult(status="halted")

    tasks = _extract_tasks(breakdown)
    state["phases"]["tasks"]["breakdown"] = breakdown
    state["phases"]["tasks"]["task_count"] = len(tasks)
    state["updated_at"] = datetime.now(timezone.utc).isoformat()

    return PhaseResult(status="completed", rounds=[{"tasks": len(tasks)}])


# ── Issue creation ─────────────────────────────────────────────────────────


def _search_existing_issue(title: str, max_retries: int = 2) -> int | None:
    """Search GitHub for an existing issue with the same title prefix.

    Returns the issue number if found, None otherwise.
    Retries up to *max_retries* times with 5s backoff on transient errors.
    """
    search_term = title[:60]  # GH search term length limit
    for attempt in range(1, max_retries + 2):
        try:
            result = _run_subprocess(
                [
                    "gh", "issue", "list",
                    "--search", search_term,
                    "--json", "number,title",
                    "--limit", "10",
                ],
                timeout=30,
            )
            if result.returncode == 0 and result.stdout.strip():
                items = json.loads(result.stdout)
                for item in items:
                    if item.get("title", "").startswith(title[:40]):
                        return int(item["number"])
                return None
            # Non-zero return or empty → treat as not found if first attempt, retry otherwise
            if attempt > max_retries:
                return None
            time.sleep(5 * attempt)
        except (subprocess.TimeoutExpired, json.JSONDecodeError, OSError) as exc:
            print(f"[forge_tasks] gh issue list error: {exc}", file=sys.stderr)
            if attempt > max_retries:
                return None
            time.sleep(5 * attempt)
    return None


def _create_issue(task: Task, max_retries: int = 2) -> int | None:
    """Create a GitHub issue for *task* using native auth (``unset GH_TOKEN``).

    Returns the new issue number on success, None on failure.
    """
    import os  # noqa: PLC0415
    env = {k: v for k, v in os.environ.items() if k != "GH_TOKEN"}
    labels_arg = ",".join(task.labels) if task.labels else "forge"

    for attempt in range(1, max_retries + 2):
        try:
            result = _run_subprocess(
                [
                    "gh", "issue", "create",
                    "--title", task.title,
                    "--body", task.body,
                    "--label", labels_arg,
                ],
                env=env,
                timeout=30,
            )
            if result.returncode == 0:
                # gh issue create outputs the issue URL on stdout
                url = result.stdout.strip()
                # Extract number from URL: https://github.com/org/repo/issues/42
                parts = url.rstrip("/").split("/")
                if parts and parts[-1].isdigit():
                    return int(parts[-1])
                return None
            stderr_snippet = (result.stderr or "")[:300]
            print(
                f"[forge_tasks] gh issue create failed (attempt {attempt}): {stderr_snippet}",
                file=sys.stderr,
            )
            if attempt > max_retries:
                return None
            time.sleep(5 * attempt)
        except (subprocess.TimeoutExpired, OSError) as exc:
            print(f"[forge_tasks] gh issue create error: {exc}", file=sys.stderr)
            if attempt > max_retries:
                return None
            time.sleep(5 * attempt)
    return None


def create_issues(
    tasks: list[Task],
    state: dict[str, Any],
    cfg: dict[str, Any],
    dry_run: bool = False,
) -> list[int]:
    """Create GitHub issues for each task, skipping existing ones.

    In dry_run mode, prints what would be created without any subprocess calls.
    Records issue numbers in state as they are created.

    Returns list of issue numbers (existing or newly created).
    """
    del cfg  # reserved for future org/repo override support
    issue_numbers: list[int] = []
    state_tasks = state.setdefault("phases", {}).setdefault("tasks", {})
    state_issue_map: dict[str, int] = state_tasks.setdefault("issue_numbers", {})

    for task in tasks:
        if dry_run:
            print(
                f"[dry-run] Would create issue: {task.title!r} (labels: {task.labels})",
                file=sys.stderr,
            )
            continue

        print(f"[forge_tasks] Processing: {task.title!r}", file=sys.stderr)

        # Record intent before creating
        state_tasks["creating_issue"] = task.title
        state["updated_at"] = datetime.now(timezone.utc).isoformat()

        # Check for existing issue
        existing = _search_existing_issue(task.title)
        if existing is not None:
            print(
                f"[forge_tasks] Skipping — issue #{existing} already exists for: {task.title!r}",
                file=sys.stderr,
            )
            issue_numbers.append(existing)
            state_issue_map[task.task_id] = existing
            continue

        # Create new issue
        number = _create_issue(task)
        if number is None:
            print(
                f"[forge_tasks] HALT — failed to create issue for: {task.title!r}",
                file=sys.stderr,
            )
            state_tasks.pop("creating_issue", None)
            state["updated_at"] = datetime.now(timezone.utc).isoformat()
            raise RuntimeError(f"Issue creation failed for task {task.task_id!r}: {task.title!r}")

        print(f"[forge_tasks] Created issue #{number}: {task.title!r}", file=sys.stderr)
        issue_numbers.append(number)
        state_issue_map[task.task_id] = number
        state_tasks.pop("creating_issue", None)
        state["updated_at"] = datetime.now(timezone.utc).isoformat()

    return issue_numbers
