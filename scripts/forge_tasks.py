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


# ── LLM task decomposition stub ────────────────────────────────────────────


def _decompose_plan(plan_text: str, cfg: dict[str, Any]) -> dict[str, Any]:
    """Call an LLM to decompose the plan into phased tasks (JSON).

    Returns a breakdown dict ``{"phases": [...]}`` on success or ``{}`` on failure.
    This stub uses Claude CLI; in tests, patch this function directly.
    """
    prompt = (
        "Decompose the following implementation plan into phased GitHub issues. "
        "Output ONLY a JSON object with this schema:\n"
        '{"phases": [{"phase_id": "P1", "name": "Phase Name", "tasks": ['
        '{"task_id": "P1.1", "title": "Task title", "body": "Acceptance criteria...\\n", '
        '"labels": ["forge", "phase-1"]}'
        "]}]}\n\n"
        f"# Plan\n\n{plan_text}"
    )

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
        raw = result.stdout.strip()
        # Strip markdown fences
        if raw.startswith("```"):
            import re  # noqa: PLC0415
            raw = re.sub(r"^```(?:json)?\s*\n?", "", raw)
            raw = re.sub(r"\n?```$", "", raw)
        start = raw.find("{")
        end = raw.rfind("}")
        if start == -1 or end == -1:
            return {}
        return json.loads(raw[start:end + 1])
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

    for attempt in range(1, max_attempts + 1):
        print(
            f"\n[forge_tasks] Decomposing plan (attempt {attempt}/{max_attempts})...",
            file=sys.stderr,
        )
        breakdown = _decompose_plan(plan_text, cfg)
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

        issues_count = sum(len(getattr(r, "issues", [])) for r in validation_results)
        print(
            f"[forge_tasks] Validation failed — {issues_count} issue(s) on attempt {attempt}.",
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
