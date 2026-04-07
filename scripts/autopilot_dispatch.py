#!/usr/bin/env python3
"""Autopilot dispatch — tournament-per-step implementation with enabled agents.

For each implementation step:
  1. Create one git worktree per enabled agent
  2. Dispatch agents in parallel, each implementing the step in its worktree
  3. Collect diffs from each worktree
  4. Return structured results for tournament evaluation

The SKILL.md orchestrator handles tournament evaluation and winner selection.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from claude_utils import build_claude_cmd, make_clean_env
from codex_utils import CODEX_MODEL, CODEX_REASONING_EFFORT_MEDIUM, parse_jsonl_output
from gemini_utils import (
    GEMINI_MODEL, setup_gemini_home, make_gemini_env,
    should_fallback_to_api_key, try_gemini_api_key_fallback,
    parse_json_output as parse_gemini_output,
)
try:
    from runtime_env import build_agent_env
except ImportError:  # pragma: no cover - backward compat for older installs
    build_agent_env = None

try:
    from config_loader import get_model_id, is_agent_enabled, get_self_heal_config
except ImportError:  # pragma: no cover - backward compat for older installs
    def get_model_id(agent: str) -> str | None:
        return None

    def is_agent_enabled(agent: str) -> bool:
        return True

    def get_self_heal_config() -> dict:
        return {"enabled": False, "mode": "suggest"}

# ── Config ──────────────────────────────────────────────────────────────


AGENTS = [a for a in ["claude", "codex", "gemini"] if is_agent_enabled(a)]
if not AGENTS:
    AGENTS = ["claude", "codex", "gemini"]
CODEX_REASONING_CONFIG = CODEX_REASONING_EFFORT_MEDIUM
DEFAULT_TIMEOUT = 900  # Implementation needs more time


def _resolve_model(agent: str) -> str:
    if agent == "claude":
        return get_model_id(agent) or "claude"
    if agent == "codex":
        return get_model_id(agent) or CODEX_MODEL
    if agent == "gemini":
        return get_model_id(agent) or GEMINI_MODEL
    raise ValueError(f"Unknown agent: {agent}")


# ── Data structures ────────────────────────────────────────────────────


@dataclass
class StepResult:
    agent: str
    step_id: str
    worktree_path: str = ""
    diff: str = ""
    files_changed: list[str] = field(default_factory=list)
    lines_added: int = 0
    lines_removed: int = 0
    test_passed: bool | None = None
    test_output: str = ""
    raw_output: str = ""
    error: str | None = None
    duration_s: float = 0.0
    api_key_fallback: bool = False


# ── Worktree management ───────────────────────────────────────────────


def create_worktree(repo_root: str, agent: str, step_id: str) -> str:
    """Create a git worktree for an agent to work in.

    Returns the worktree path.
    """
    branch_name = f"autopilot/{agent}/{step_id}"
    worktree_dir = os.path.join(repo_root, ".worktrees", f"autopilot-{agent}-{step_id}")

    # Get current HEAD
    head = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        capture_output=True, text=True, cwd=repo_root,
    ).stdout.strip()

    # Create worktree from current HEAD
    result = subprocess.run(
        ["git", "worktree", "add", "-b", branch_name, worktree_dir, head],
        capture_output=True, text=True, cwd=repo_root,
    )
    if result.returncode != 0:
        subprocess.run(
            ["git", "worktree", "remove", "--force", worktree_dir],
            capture_output=True, text=True, cwd=repo_root,
        )
        if os.path.exists(worktree_dir):
            shutil.rmtree(worktree_dir, ignore_errors=True)
        subprocess.run(
            ["git", "worktree", "prune"],
            capture_output=True, text=True, cwd=repo_root,
        )
        subprocess.run(
            ["git", "branch", "-D", branch_name],
            capture_output=True, text=True, cwd=repo_root,
        )
        result = subprocess.run(
            ["git", "worktree", "add", "-b", branch_name, worktree_dir, head],
            capture_output=True, text=True, cwd=repo_root,
        )
        if result.returncode != 0:
            raise RuntimeError(f"Failed to create worktree: {result.stderr}")

    return worktree_dir


def collect_diff(worktree_path: str) -> tuple[str, list[str], int, int]:
    """Collect the diff from a worktree.

    Returns (diff_text, files_changed, lines_added, lines_removed).
    """
    # Stage all changes
    subprocess.run(
        ["git", "add", "-A"],
        capture_output=True, text=True, cwd=worktree_path,
    )

    # Get the diff
    result = subprocess.run(
        ["git", "diff", "--cached", "--stat"],
        capture_output=True, text=True, cwd=worktree_path,
    )
    stat = result.stdout

    result = subprocess.run(
        ["git", "diff", "--cached"],
        capture_output=True, text=True, cwd=worktree_path,
    )
    diff = result.stdout

    # Parse stats
    files_changed = []
    lines_added = 0
    lines_removed = 0

    result = subprocess.run(
        ["git", "diff", "--cached", "--numstat"],
        capture_output=True, text=True, cwd=worktree_path,
    )
    for line in result.stdout.strip().splitlines():
        parts = line.split("\t")
        if len(parts) >= 3:
            try:
                added = int(parts[0]) if parts[0] != "-" else 0
                removed = int(parts[1]) if parts[1] != "-" else 0
                lines_added += added
                lines_removed += removed
            except ValueError:
                pass
            files_changed.append(parts[2])

    return diff, files_changed, lines_added, lines_removed


def cleanup_worktree(repo_root: str, worktree_path: str, branch_name: str) -> None:
    """Remove a worktree and its branch."""
    subprocess.run(
        ["git", "worktree", "remove", "--force", worktree_path],
        capture_output=True, text=True, cwd=repo_root,
    )
    subprocess.run(
        ["git", "branch", "-D", branch_name],
        capture_output=True, text=True, cwd=repo_root,
    )


def apply_diff(repo_root: str, diff: str) -> bool:
    """Apply a diff to the main working tree.

    Returns True if applied successfully.
    """
    if not diff.strip():
        return False
    result = subprocess.run(
        ["git", "apply", "--3way", "-"],
        input=diff, capture_output=True, text=True, cwd=repo_root,
    )
    if result.returncode != 0:
        # Try without --3way
        result = subprocess.run(
            ["git", "apply", "-"],
            input=diff, capture_output=True, text=True, cwd=repo_root,
        )
    return result.returncode == 0


# ── Agent dispatch ─────────────────────────────────────────────────────


def _run_implementation_agent(
    agent: str,
    step_id: str,
    prompt: str,
    worktree_path: str,
    timeout: int = DEFAULT_TIMEOUT,
) -> StepResult:
    """Run an agent to implement a step in a worktree."""
    result = StepResult(agent=agent, step_id=step_id, worktree_path=worktree_path)
    t0 = time.monotonic()

    if not is_agent_enabled(agent):
        result.error = "agent_disabled"
        return result

    gemini_home = None
    stdin_input = None

    if agent == "claude":
        cmd = build_claude_cmd(allowed_tools="Edit,Write,Read,Bash,Glob,Grep")
        stdin_input = prompt

    elif agent == "codex":
        cmd = [
            "codex", "exec",
            "-m", _resolve_model("codex"),
            "-c", CODEX_REASONING_CONFIG,
            "--ephemeral", "--json",
            "--full-auto",
            "-",
        ]
        stdin_input = prompt

    elif agent == "gemini":
        gemini_home = setup_gemini_home("gemini-autopilot-", worktree_path, "autopilot")
        cmd = [
            "gemini",
            "-m", _resolve_model("gemini"),
            "-p", prompt,
            "--yolo",
        ]
        stdin_input = None
    else:
        result.error = "unknown_agent"
        return result

    def _cleanup():
        if gemini_home and os.path.isdir(gemini_home):
            shutil.rmtree(gemini_home, ignore_errors=True)

    run_kwargs: dict[str, Any] = {
        "capture_output": True, "text": True,
        "timeout": timeout, "cwd": worktree_path,
    }
    if stdin_input is not None:
        run_kwargs["input"] = stdin_input
    if agent in ("claude", "codex"):
        run_kwargs["env"] = (
            build_agent_env(agent, "review")
            if build_agent_env is not None
            else make_clean_env()
        )
    if gemini_home:
        run_kwargs["env"] = make_gemini_env(gemini_home)

    max_attempts = 2
    used_api_key_fallback = False

    for attempt in range(1, max_attempts + 1):
        try:
            proc = subprocess.run(cmd, **run_kwargs)

            if proc.returncode != 0:
                stderr_snippet = proc.stderr[:500]
                print(
                    f"  [{agent}:{step_id}] CLI error (exit {proc.returncode}): {stderr_snippet}",
                    file=sys.stderr,
                )
                if (
                    agent == "gemini"
                    and attempt < max_attempts
                    and should_fallback_to_api_key(stderr_snippet)
                    and try_gemini_api_key_fallback(run_kwargs, step_id, stderr_snippet)
                ):
                    used_api_key_fallback = True
                    time.sleep(2)
                    continue
                if attempt < max_attempts:
                    time.sleep(5 * attempt)
                    continue
                _cleanup()
                result.duration_s = time.monotonic() - t0
                result.error = "cli_error"
                return result

            raw = proc.stdout or ""

            if agent == "codex":
                raw = parse_jsonl_output(raw)
            elif agent == "gemini":
                raw = parse_gemini_output(raw)

            result.raw_output = raw
            result.api_key_fallback = used_api_key_fallback
            break

        except subprocess.TimeoutExpired:
            if attempt < max_attempts:
                print(f"    {agent}:{step_id} timed out, retrying...", file=sys.stderr)
                continue
            _cleanup()
            result.duration_s = time.monotonic() - t0
            result.error = "timeout"
            return result
        except FileNotFoundError:
            _cleanup()
            result.duration_s = time.monotonic() - t0
            result.error = "agent_unavailable"
            return result

    _cleanup()

    # Collect the diff from the worktree
    try:
        diff, files, added, removed = collect_diff(worktree_path)
        result.diff = diff
        result.files_changed = files
        result.lines_added = added
        result.lines_removed = removed
    except Exception as e:
        result.error = f"diff_collection_failed: {e}"

    # Run validation chain (informational — does not block the tournament)
    try:
        result.test_passed = _run_validation_chain(worktree_path, step_id)
    except Exception as e:
        print(f"  [{agent}:{step_id}] validation chain error: {e}", file=sys.stderr)
        result.test_passed = None

    result.duration_s = time.monotonic() - t0
    return result


# ── Validation chain ──────────────────────────────────────────────────


def _run_validation_chain(worktree_path: str, step_id: str) -> bool:
    """Run validation → classify → heal → re-validate chain in a worktree.

    Returns True if validation passes (initially or after healing), False otherwise.
    Does not block the tournament — just provides test_passed signal for scoring.
    """
    scripts_dir = Path(__file__).parent

    def _run_validation() -> tuple[bool, str]:
        """Run validation_gate. Returns (passed, stderr_path)."""
        try:
            result = subprocess.run(
                [sys.executable, str(scripts_dir / "validation_gate.py"),
                 "--json", "--repo-root", worktree_path],
                capture_output=True, text=True, timeout=120,
            )
            data = json.loads(result.stdout)
            return data.get("overall") == "pass", data.get("stderr_path", "")
        except Exception as e:
            print(f"    [validation] error: {e}", file=sys.stderr)
            return False, ""

    passed, stderr_path = _run_validation()
    if passed:
        return True

    # Classify the failure
    if not stderr_path or not Path(stderr_path).exists():
        print(f"    [{step_id}] validation failed, no stderr log to classify", file=sys.stderr)
        return False

    try:
        cls_result = subprocess.run(
            [sys.executable, str(scripts_dir / "failure_classifier.py"),
             "--stderr-file", stderr_path, "--json"],
            capture_output=True, text=True, timeout=30,
        )
        cls_data = json.loads(cls_result.stdout)
    except Exception as e:
        print(f"    [{step_id}] classifier error: {e}", file=sys.stderr)
        return False

    pattern_id = cls_data.get("pattern_id")
    if not pattern_id:
        print(
            f"    [{step_id}] validation failed, category={cls_data.get('category')} "
            "(no healer pattern — unfixable)",
            file=sys.stderr,
        )
        return False

    # Attempt to heal
    heal_mode = get_self_heal_config().get("mode", "suggest")
    try:
        subprocess.run(
            [sys.executable, str(scripts_dir / "self_healer.py"),
             "--pattern-id", pattern_id,
             "--stderr-file", stderr_path,
             "--mode", heal_mode,
             "--json"],
            capture_output=True, text=True, timeout=60,
        )
    except Exception as e:
        print(f"    [{step_id}] healer error: {e}", file=sys.stderr)
        return False

    # Re-validate
    passed, _ = _run_validation()
    if not passed:
        print(
            f"    [{step_id}] still failing after heal attempt (pattern={pattern_id})",
            file=sys.stderr,
        )
    return passed


# ── Step dispatch ──────────────────────────────────────────────────────


def run_step_tournament(
    repo_root: str,
    step_id: str,
    step_prompt: str,
    agents: list[str] | None = None,
    timeout: int = DEFAULT_TIMEOUT,
    test_command: str | None = None,
) -> dict[str, Any]:
    """Run a tournament for one implementation step.

    Creates worktrees, dispatches agents, collects diffs, runs tests.
    Returns structured results for the orchestrator to evaluate and pick a winner.
    """
    if agents is None:
        agents = list(AGENTS)
        skipped_agents: list[str] = []
    else:
        requested_agents = list(agents)
        agents = [agent for agent in requested_agents if is_agent_enabled(agent)]
        skipped_agents = [agent for agent in requested_agents if not is_agent_enabled(agent)]

    total = len(agents)
    print(f"\n{'=' * 60}", file=sys.stderr)
    print(f"  Step: {step_id} — {total} agents competing", file=sys.stderr)
    print(f"{'=' * 60}", file=sys.stderr)
    for agent in skipped_agents:
        print(f"  [{agent}] skipped: disabled in config", file=sys.stderr)

    # Create worktrees
    worktrees: dict[str, str] = {}
    for agent in agents:
        try:
            wt = create_worktree(repo_root, agent, step_id)
            worktrees[agent] = wt
            print(f"  [{agent}] worktree: {wt}", file=sys.stderr)
        except RuntimeError as e:
            print(f"  [{agent}] worktree FAILED: {e}", file=sys.stderr)

    if not worktrees:
        return {
            "step_id": step_id,
            "error": "no_worktrees",
            "results": [],
            "summary": {"total": total, "succeeded": 0, "failed": total},
        }

    # Dispatch agents in parallel
    results: list[StepResult] = []

    with ThreadPoolExecutor(max_workers=len(worktrees)) as pool:
        futures = {}
        for agent, wt_path in worktrees.items():
            future = pool.submit(
                _run_implementation_agent,
                agent=agent,
                step_id=step_id,
                prompt=step_prompt,
                worktree_path=wt_path,
                timeout=timeout,
            )
            futures[future] = agent
            print(f"  [{agent}] implementing...", file=sys.stderr)

        for future in as_completed(futures):
            agent = futures[future]
            step_result = future.result()
            results.append(step_result)

            if step_result.error:
                print(
                    f"  [{agent}] ERROR: {step_result.error} [{step_result.duration_s:.1f}s]",
                    file=sys.stderr,
                )
            else:
                print(
                    f"  [{agent}] done — {len(step_result.files_changed)} files, "
                    f"+{step_result.lines_added}/-{step_result.lines_removed} "
                    f"[{step_result.duration_s:.1f}s]",
                    file=sys.stderr,
                )

    # Run tests if test_command provided
    if test_command:
        for sr in results:
            if sr.error or not sr.worktree_path:
                continue
            try:
                test_result = subprocess.run(
                    test_command, shell=True,
                    capture_output=True, text=True,
                    timeout=120, cwd=sr.worktree_path,
                )
                sr.test_passed = test_result.returncode == 0
                sr.test_output = test_result.stdout[-2000:] + test_result.stderr[-1000:]
                status = "PASS" if sr.test_passed else "FAIL"
                print(f"  [{sr.agent}] tests: {status}", file=sys.stderr)
            except subprocess.TimeoutExpired:
                sr.test_passed = False
                sr.test_output = "Test timed out after 120s"
                print(f"  [{sr.agent}] tests: TIMEOUT", file=sys.stderr)

    # Build output (don't clean up worktrees yet — orchestrator needs them for winner selection)
    succeeded = [r for r in results if not r.error and r.diff.strip()]
    return {
        "step_id": step_id,
        "results": [
            {
                "agent": r.agent,
                "worktree_path": r.worktree_path,
                "files_changed": r.files_changed,
                "lines_added": r.lines_added,
                "lines_removed": r.lines_removed,
                "diff_length": len(r.diff),
                "test_passed": r.test_passed,
                "error": r.error,
                "duration_s": r.duration_s,
                "api_key_fallback": r.api_key_fallback,
            }
            for r in results
        ],
        "diffs": {r.agent: r.diff for r in results if not r.error},
        "summary": {
            "total": total,
            "succeeded": len(succeeded),
            "failed": total - len(succeeded),
            "tests_run": test_command is not None,
        },
    }


def cleanup_step(repo_root: str, step_id: str, agents: list[str] | None = None) -> None:
    """Clean up all worktrees and branches for a step."""
    if agents is None:
        agents = list(AGENTS)
    else:
        agents = [agent for agent in agents if is_agent_enabled(agent)]
    for agent in agents:
        branch_name = f"autopilot/{agent}/{step_id}"
        worktree_dir = os.path.join(repo_root, ".worktrees", f"autopilot-{agent}-{step_id}")
        cleanup_worktree(repo_root, worktree_dir, branch_name)


# ── CLI ───────────────────────────────────────────────────────────────


def main():
    import argparse
    parser = argparse.ArgumentParser(description="Autopilot step dispatch")
    parser.add_argument("--repo-root", required=True, help="Repository root")
    parser.add_argument("--step-id", required=True, help="Step identifier (e.g., phase-1-task-2)")
    parser.add_argument("--prompt-file", required=True, help="Path to step prompt file")
    parser.add_argument("--agents", help="Comma-separated list of agents")
    parser.add_argument("--timeout", type=int, default=DEFAULT_TIMEOUT, help="Per-agent timeout")
    parser.add_argument("--test-command", help="Test command to run after implementation")
    parser.add_argument("--cleanup", action="store_true", help="Clean up worktrees for step-id")
    args = parser.parse_args()

    if args.cleanup:
        agents = args.agents.split(",") if args.agents else None
        cleanup_step(args.repo_root, args.step_id, agents)
        print(f"Cleaned up worktrees for {args.step_id}")
        return

    agents = args.agents.split(",") if args.agents else None
    prompt = Path(args.prompt_file).read_text()

    result = run_step_tournament(
        repo_root=args.repo_root,
        step_id=args.step_id,
        step_prompt=prompt,
        agents=agents,
        timeout=args.timeout,
        test_command=args.test_command,
    )

    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
