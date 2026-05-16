#!/usr/bin/env python3
"""Copilot dispatch — paired lead/wing implementation with review→fix loop.

For each implementation step:
  1. Create one git worktree for the lead agent
  2. Lead implements the step in its worktree
  3. Wing reviews the lead's diff out-of-tree, returns approve|revise|block JSON verdict
  4. If revise and rounds remain, lead resumes in the same worktree to address findings
  5. Loop until approved, blocked, max-rounds exhausted, or empty-diff revision detected

Returns structured JSON describing every round so the SKILL.md orchestrator
can apply the diff, commit, transition issues, and run end-of-step verification.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from autopilot_dispatch import (
    DEFAULT_TIMEOUT,
    cleanup_worktree,
    create_worktree,
    _run_implementation_agent,
)
from claude_utils import build_claude_cmd, make_clean_env
from codex_utils import (
    CODEX_REASONING_EFFORT_MEDIUM,
    parse_jsonl_output,
)
from gemini_utils import (
    make_gemini_env,
    parse_json_output as parse_gemini_output,
    setup_gemini_home,
    should_fallback_to_api_key,
    try_gemini_api_key_fallback,
)

try:
    from runtime_env import build_agent_env
except ImportError:  # pragma: no cover
    build_agent_env = None

from dispatcher_base import is_agent_enabled, resolve_model as _resolve_model


VALID_AGENTS = {"claude", "codex", "gemini"}
DEFAULT_LEAD = "claude"
DEFAULT_WING = "codex"
DEFAULT_MAX_ROUNDS = 4
WING_TIMEOUT_DEFAULT = 600

# Trailing JSON block parser: capture the last fenced ```json block, or the
# last balanced top-level JSON object in the response.
_JSON_FENCE_RE = re.compile(r"```(?:json)?\s*\n(\{.*?\})\s*\n```", re.DOTALL)


@dataclass
class RoundResult:
    round_num: int
    diff: str = ""
    files_changed: list[str] = field(default_factory=list)
    lines_added: int = 0
    lines_removed: int = 0
    test_passed: bool | None = None
    verdict: str = ""  # approve | revise | block | unparseable
    blocking_findings: list[str] = field(default_factory=list)
    suggestions: list[str] = field(default_factory=list)
    summary: str = ""
    wing_raw: str = ""
    parse_retry_used: bool = False
    duration_s: float = 0.0
    error: str | None = None


def _extract_verdict_json(text: str) -> dict | None:
    """Find the trailing JSON verdict block in a wing review response."""
    fences = _JSON_FENCE_RE.findall(text)
    candidates: list[str] = list(fences)

    # Fallback: scan for the last balanced { ... } block
    depth = 0
    start = -1
    last: str | None = None
    for i, ch in enumerate(text):
        if ch == "{":
            if depth == 0:
                start = i
            depth += 1
        elif ch == "}":
            if depth > 0:
                depth -= 1
                if depth == 0 and start >= 0:
                    last = text[start : i + 1]
    if last and last not in candidates:
        candidates.append(last)

    for cand in reversed(candidates):  # try most-recent first
        try:
            obj = json.loads(cand)
            if isinstance(obj, dict) and "verdict" in obj:
                return obj
        except json.JSONDecodeError:
            continue
    return None


def _normalize_verdict(obj: dict) -> tuple[str, list[str], list[str], str]:
    verdict = str(obj.get("verdict", "")).strip().lower()
    if verdict not in {"approve", "revise", "block"}:
        verdict = "unparseable"
    blocking = [str(x) for x in (obj.get("blocking_findings") or [])]
    suggestions = [str(x) for x in (obj.get("non_blocking_suggestions") or [])]
    summary = str(obj.get("summary", "")).strip()
    return verdict, blocking, suggestions, summary


def _snapshot_worktree(worktree_path: str) -> tuple[str, str]:
    """Capture (HEAD sha, content-hash of full worktree) for a read-only check.

    The content hash is `git write-tree` after staging every file with
    `git add -A`. This produces a deterministic SHA that changes whenever
    *any* tracked or previously-untracked file's content changes — including
    the case where a reviewer modifies an already-staged file and re-stages
    it (which leaves `git status --porcelain` byte-identical).
    """
    head = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        capture_output=True, text=True, cwd=worktree_path,
    ).stdout.strip()
    # Stage everything (lead's diff is already staged; this is idempotent and
    # ensures untracked files get hashed into the tree object).
    subprocess.run(
        ["git", "add", "-A"],
        capture_output=True, text=True, cwd=worktree_path,
    )
    tree = subprocess.run(
        ["git", "write-tree"],
        capture_output=True, text=True, cwd=worktree_path,
    ).stdout.strip()
    return head, tree


def _restore_worktree(worktree_path: str, snapshot: tuple[str, str]) -> None:
    """Best-effort restore the worktree to the pre-review snapshot."""
    head, _ = snapshot
    subprocess.run(
        ["git", "reset", "--hard", head],
        capture_output=True, text=True, cwd=worktree_path,
    )
    subprocess.run(
        ["git", "clean", "-fd"],
        capture_output=True, text=True, cwd=worktree_path,
    )


def _run_wing_review(
    wing: str,
    review_payload: str,
    cwd: str,
    timeout: int,
) -> tuple[str, str | None]:
    """Run the wing reviewer one-shot. Returns (raw_text, error_or_None)."""
    if not is_agent_enabled(wing):
        return "", "agent_disabled"

    gemini_home = None
    stdin_input: str | None = None

    if wing == "claude":
        # Read-only by tool allowlist.
        cmd = build_claude_cmd(allowed_tools="Read,Glob,Grep")
        stdin_input = review_payload
    elif wing == "codex":
        # Read-only sandbox; do NOT use --full-auto for review.
        cmd = [
            "codex", "exec",
            "-m", _resolve_model("codex"),
            "-c", CODEX_REASONING_EFFORT_MEDIUM,
            "--ephemeral", "--json",
            "-s", "read-only",
            "-",
        ]
        stdin_input = review_payload
    elif wing == "gemini":
        # Plan approval mode = read-only; do NOT use --yolo for review.
        # --skip-trust is required for headless dispatch into the lead's
        # worktree (the directory is not in the user's trustedFolders list,
        # so without this flag Gemini exits 55 before any review runs).
        gemini_home = setup_gemini_home(
            "gemini-copilot-wing-", cwd, "copilot", approval_mode="plan",
        )
        cmd = [
            "gemini",
            "-m", _resolve_model("gemini"),
            "--skip-trust",
            "-p", review_payload,
        ]
    else:
        return "", "unknown_agent"

    run_kwargs: dict[str, Any] = {
        "capture_output": True,
        "text": True,
        "timeout": timeout,
        "cwd": cwd,
    }
    if stdin_input is not None:
        run_kwargs["input"] = stdin_input
    if wing in ("claude", "codex"):
        run_kwargs["env"] = (
            build_agent_env(wing, "review")
            if build_agent_env is not None
            else make_clean_env()
        )
    if gemini_home:
        run_kwargs["env"] = make_gemini_env(gemini_home)

    try:
        proc = subprocess.run(cmd, **run_kwargs)
        if proc.returncode != 0:
            stderr_snippet = proc.stderr[:500]
            if (
                wing == "gemini"
                and should_fallback_to_api_key(stderr_snippet)
                and try_gemini_api_key_fallback(run_kwargs, "wing-review", stderr_snippet)
            ):
                proc = subprocess.run(cmd, **run_kwargs)
                if proc.returncode != 0:
                    return proc.stderr[:500], "cli_error"
            else:
                return proc.stderr[:500], "cli_error"

        raw = proc.stdout or ""
        if wing == "codex":
            raw = parse_jsonl_output(raw)
        elif wing == "gemini":
            raw = parse_gemini_output(raw)
        return raw, None
    except subprocess.TimeoutExpired:
        return "", "timeout"
    except FileNotFoundError:
        return "", "agent_unavailable"
    finally:
        if gemini_home and os.path.isdir(gemini_home):
            import shutil
            shutil.rmtree(gemini_home, ignore_errors=True)


def _build_review_payload(
    review_prompt: str,
    step_task: str,
    diff: str,
    test_passed: bool | None,
    prior_rounds: list[RoundResult],
) -> str:
    parts = [
        review_prompt,
        "\n\n## Step task being implemented\n",
        step_task,
        "\n\n## Test result\n",
        "passed" if test_passed is True else ("failed" if test_passed is False else "no test command"),
        "\n\n## Diff under review\n```diff\n",
        diff if diff.strip() else "(empty diff)",
        "\n```\n",
    ]
    if prior_rounds:
        parts.append("\n\n## Prior review history (most recent last)\n")
        for r in prior_rounds:
            parts.append(f"\n### Round {r.round_num}: {r.verdict}\n")
            if r.blocking_findings:
                parts.append("Blocking findings:\n")
                for f in r.blocking_findings:
                    parts.append(f"- {f}\n")
            if r.summary:
                parts.append(f"Summary: {r.summary}\n")
    return "".join(parts)


def _build_fix_prompt(
    base_implement_prompt: str,
    step_task: str,
    findings: list[str],
    round_num: int,
) -> str:
    findings_block = "\n".join(f"- {f}" for f in findings) if findings else "(no findings — fix anyway)"
    return (
        f"# Revision Round {round_num} — address wing reviewer findings\n\n"
        "Your previous diff was reviewed by another AI agent (the wing reviewer). "
        "It is not approved yet. Address every blocking finding below, then stop.\n\n"
        "## Wing's blocking findings (verbatim)\n"
        f"{findings_block}\n\n"
        "## Original step task (for reference)\n"
        f"{step_task}\n\n"
        "## Your prior implementation prompt (for context)\n"
        f"{base_implement_prompt}\n\n"
        "Make the minimum changes needed to resolve the findings. Do NOT commit. "
        "Re-run tests if a test command was provided."
    )


def _run_test_command(test_command: str | None, worktree_path: str) -> tuple[bool | None, str]:
    if not test_command:
        return None, ""
    import shlex
    try:
        proc = subprocess.run(
            shlex.split(test_command),
            capture_output=True, text=True, timeout=120, cwd=worktree_path,
        )
        return proc.returncode == 0, proc.stdout[-2000:] + proc.stderr[-1000:]
    except subprocess.TimeoutExpired:
        return False, "Test timed out after 120s"
    except Exception as e:
        return False, f"Test command failed to run: {e}"


def run_copilot_step(
    repo_root: str,
    step_id: str,
    implement_prompt: str,
    review_prompt: str,
    step_task: str,
    lead: str,
    wing: str,
    max_rounds: int,
    timeout: int,
    wing_timeout: int,
    test_command: str | None,
) -> dict[str, Any]:
    if lead == wing:
        return {"step_id": step_id, "error": "lead_eq_wing", "rounds": []}
    if lead not in VALID_AGENTS or wing not in VALID_AGENTS:
        return {"step_id": step_id, "error": "invalid_agent", "rounds": []}
    if not is_agent_enabled(lead):
        return {"step_id": step_id, "error": f"lead_disabled:{lead}", "rounds": []}
    if not is_agent_enabled(wing):
        return {"step_id": step_id, "error": f"wing_disabled:{wing}", "rounds": []}

    t0 = time.monotonic()
    rounds: list[RoundResult] = []

    # Lead's worktree (used for round 1 implement and all revision rounds).
    try:
        worktree_path = create_worktree(repo_root, lead, step_id)
    except Exception as e:
        return {
            "step_id": step_id,
            "lead": lead, "wing": wing,
            "error": f"worktree_create_failed: {e}",
            "rounds": [],
        }

    # ── Round 1: lead implements ───────────────────────────────────────
    sr = _run_implementation_agent(
        agent=lead, step_id=step_id, prompt=implement_prompt,
        worktree_path=worktree_path, timeout=timeout,
    )
    r1 = RoundResult(
        round_num=1,
        diff=sr.diff, files_changed=sr.files_changed,
        lines_added=sr.lines_added, lines_removed=sr.lines_removed,
        test_passed=sr.test_passed, error=sr.error,
        duration_s=sr.duration_s,
    )
    if test_command and not sr.error:
        passed, _ = _run_test_command(test_command, worktree_path)
        if passed is not None:
            r1.test_passed = passed
    if sr.error:
        rounds.append(r1)
        return _build_result(step_id, lead, wing, rounds, worktree_path,
                             final_verdict="aborted",
                             error=f"lead_round1_failed:{sr.error}",
                             total_duration=time.monotonic() - t0)
    if not sr.diff.strip():
        rounds.append(r1)
        return _build_result(step_id, lead, wing, rounds, worktree_path,
                             final_verdict="aborted",
                             error="lead_round1_empty_diff",
                             total_duration=time.monotonic() - t0)

    # ── Review→fix loop ────────────────────────────────────────────────
    final_verdict = "unresolved"
    error: str | None = None
    current_round = r1

    for round_num in range(1, max_rounds + 2):  # +1 for review-after-final-fix
        # Wing reviews the current round's diff.
        prior = rounds[:]  # rounds already finalized
        payload = _build_review_payload(
            review_prompt=review_prompt,
            step_task=step_task,
            diff=current_round.diff,
            test_passed=current_round.test_passed,
            prior_rounds=prior,
        )

        # Snapshot the worktree before the wing reviews so we can detect any
        # mutation. The wing is configured read-only (claude allowlist,
        # codex `-s read-only`, gemini approval_mode="plan"), but we still
        # verify defensively — a mutating reviewer is a contract violation.
        pre_snapshot = _snapshot_worktree(worktree_path)

        wing_raw, wing_err = _run_wing_review(wing, payload, worktree_path, wing_timeout)
        if wing_err == "timeout":
            # one retry per failure mode table
            wing_raw, wing_err = _run_wing_review(wing, payload, worktree_path, wing_timeout)

        post_snapshot = _snapshot_worktree(worktree_path)
        if pre_snapshot != post_snapshot:
            _restore_worktree(worktree_path, pre_snapshot)
            current_round.wing_raw = wing_raw
            current_round.verdict = "unparseable"
            current_round.blocking_findings = [
                "wing reviewer mutated the worktree — read-only contract violated; worktree restored",
            ]
            current_round.summary = "Wing mutation detected; aborting."
            rounds.append(current_round)
            final_verdict = "unresolved"
            error = "wing_mutation_detected"
            break

        if wing_err:
            current_round.wing_raw = wing_raw
            current_round.verdict = "unparseable"
            current_round.blocking_findings = [f"wing review {wing_err}"]
            current_round.summary = f"Wing dispatch error: {wing_err}"
            rounds.append(current_round)
            final_verdict = "unresolved"
            error = f"wing_error:{wing_err}"
            break

        verdict_obj = _extract_verdict_json(wing_raw)
        parse_retry = False
        if verdict_obj is None:
            # one retry with explicit "JSON only" suffix
            retry_payload = (
                payload
                + "\n\n## CRITICAL\nYour previous response did not contain a parseable JSON "
                  "verdict block. Respond again ending with EXACTLY one ```json fenced block "
                  "containing keys verdict, blocking_findings, non_blocking_suggestions, summary."
            )
            retry_pre = _snapshot_worktree(worktree_path)
            wing_raw, wing_err = _run_wing_review(wing, retry_payload, worktree_path, wing_timeout)
            retry_post = _snapshot_worktree(worktree_path)
            if retry_pre != retry_post:
                _restore_worktree(worktree_path, retry_pre)
                current_round.wing_raw = wing_raw
                current_round.verdict = "unparseable"
                current_round.blocking_findings = [
                    "wing reviewer mutated the worktree on parse-retry — read-only contract violated; worktree restored",
                ]
                current_round.summary = "Wing mutation detected on parse-retry; aborting."
                rounds.append(current_round)
                final_verdict = "unresolved"
                error = "wing_mutation_detected"
                break
            parse_retry = True
            if not wing_err:
                verdict_obj = _extract_verdict_json(wing_raw)

        current_round.wing_raw = wing_raw
        current_round.parse_retry_used = parse_retry

        if verdict_obj is None:
            # Treat as revise per failure mode table
            current_round.verdict = "revise"
            current_round.blocking_findings = ["wing review failed to parse — manual inspection required"]
            current_round.summary = "Unparseable verdict; treated as revise."
        else:
            v, blocking, suggestions, summary = _normalize_verdict(verdict_obj)
            current_round.verdict = v
            current_round.blocking_findings = blocking
            current_round.suggestions = suggestions
            current_round.summary = summary

        rounds.append(current_round)

        if current_round.verdict == "approve":
            final_verdict = "approved"
            break
        if current_round.verdict == "block":
            final_verdict = "blocked"
            error = "wing_blocked"
            break

        # verdict is revise (or treated-as-revise)
        if round_num > max_rounds:
            final_verdict = "max_rounds_unresolved"
            error = f"unresolved_after_{max_rounds}_fix_rounds"
            break

        # Run a fix round.
        next_round_num = round_num + 1
        fix_prompt = _build_fix_prompt(
            base_implement_prompt=implement_prompt,
            step_task=step_task,
            findings=current_round.blocking_findings,
            round_num=next_round_num,
        )
        sr_fix = _run_implementation_agent(
            agent=lead, step_id=step_id, prompt=fix_prompt,
            worktree_path=worktree_path, timeout=timeout,
        )
        next_round = RoundResult(
            round_num=next_round_num,
            diff=sr_fix.diff, files_changed=sr_fix.files_changed,
            lines_added=sr_fix.lines_added, lines_removed=sr_fix.lines_removed,
            test_passed=sr_fix.test_passed, error=sr_fix.error,
            duration_s=sr_fix.duration_s,
        )
        if test_command and not sr_fix.error:
            passed, _ = _run_test_command(test_command, worktree_path)
            if passed is not None:
                next_round.test_passed = passed
        if sr_fix.error:
            rounds.append(next_round)
            final_verdict = "unresolved"
            error = f"lead_fix_round_failed:{sr_fix.error}"
            break

        # Empty-diff guard: lead produced no changes vs the prior round.
        if next_round.diff.strip() == current_round.diff.strip():
            rounds.append(next_round)
            final_verdict = "unresolved"
            error = "lead_fix_round_no_change"
            break

        current_round = next_round

    return _build_result(
        step_id, lead, wing, rounds, worktree_path,
        final_verdict=final_verdict,
        error=error,
        total_duration=time.monotonic() - t0,
    )


def _build_result(
    step_id: str, lead: str, wing: str,
    rounds: list[RoundResult],
    worktree_path: str,
    final_verdict: str,
    error: str | None,
    total_duration: float,
) -> dict[str, Any]:
    final_round = rounds[-1] if rounds else None
    return {
        "step_id": step_id,
        "lead": lead,
        "wing": wing,
        "worktree_path": worktree_path,
        "final_verdict": final_verdict,  # approved | blocked | aborted | max_rounds_unresolved | unresolved
        "error": error,
        "duration_s": total_duration,
        "rounds": [
            {
                "round": r.round_num,
                "files_changed": r.files_changed,
                "lines_added": r.lines_added,
                "lines_removed": r.lines_removed,
                "diff_length": len(r.diff),
                "test_passed": r.test_passed,
                "verdict": r.verdict,
                "blocking_findings": r.blocking_findings,
                "non_blocking_suggestions": r.suggestions,
                "summary": r.summary,
                "parse_retry_used": r.parse_retry_used,
                "duration_s": r.duration_s,
                "error": r.error,
            }
            for r in rounds
        ],
        # Final diff is the diff of the final round (only useful when approved).
        "final_diff": final_round.diff if final_round else "",
    }


def cleanup_step(repo_root: str, step_id: str, lead: str) -> None:
    safe_lead = re.sub(r"[^a-zA-Z0-9._-]", "-", lead)
    safe_step = re.sub(r"[^a-zA-Z0-9._-]", "-", step_id)
    branch_name = f"autopilot/{safe_lead}/{safe_step}"  # match create_worktree's naming
    worktree_dir = os.path.join(
        repo_root, ".worktrees", f"autopilot-{safe_lead}-{safe_step}"
    )
    cleanup_worktree(repo_root, worktree_dir, branch_name)


def main() -> int:
    parser = argparse.ArgumentParser(description="Copilot lead/wing step dispatch")
    parser.add_argument("--repo-root", required=True)
    parser.add_argument("--step-id", required=True)
    parser.add_argument("--implement-prompt-file", help="Lead's implement prompt")
    parser.add_argument("--review-prompt-file", help="Wing's review prompt template")
    parser.add_argument("--step-task-file", help="Step task description (shared context)")
    parser.add_argument("--lead", default=DEFAULT_LEAD, choices=sorted(VALID_AGENTS))
    parser.add_argument("--wing", default=DEFAULT_WING, choices=sorted(VALID_AGENTS))
    parser.add_argument("--max-rounds", type=int, default=DEFAULT_MAX_ROUNDS,
                        help="Max fix rounds after the initial implement")
    parser.add_argument("--timeout", type=int, default=DEFAULT_TIMEOUT,
                        help="Per-lead-invocation timeout (seconds)")
    parser.add_argument("--wing-timeout", type=int, default=WING_TIMEOUT_DEFAULT,
                        help="Per-wing-invocation timeout (seconds)")
    parser.add_argument("--test-command", default=None)
    parser.add_argument("--cleanup", action="store_true",
                        help="Remove the lead's worktree for step-id and exit")
    args = parser.parse_args()

    if args.cleanup:
        cleanup_step(args.repo_root, args.step_id, args.lead)
        print(f"Cleaned up copilot worktree for {args.step_id} (lead={args.lead})")
        return 0

    if not args.implement_prompt_file or not args.review_prompt_file or not args.step_task_file:
        parser.error("--implement-prompt-file, --review-prompt-file, --step-task-file are required unless --cleanup")

    implement_prompt = Path(args.implement_prompt_file).read_text()
    review_prompt = Path(args.review_prompt_file).read_text()
    step_task = Path(args.step_task_file).read_text()

    result = run_copilot_step(
        repo_root=args.repo_root,
        step_id=args.step_id,
        implement_prompt=implement_prompt,
        review_prompt=review_prompt,
        step_task=step_task,
        lead=args.lead,
        wing=args.wing,
        max_rounds=args.max_rounds,
        timeout=args.timeout,
        wing_timeout=args.wing_timeout,
        test_command=args.test_command,
    )
    print(json.dumps(result, indent=2))
    return 0 if result.get("final_verdict") == "approved" else 1


if __name__ == "__main__":
    sys.exit(main())
