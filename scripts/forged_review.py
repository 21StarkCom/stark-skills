#!/usr/bin/env python3
"""stark-forged-review orchestrator.

Top-level entry point invoked by skill/stark-forged-review/SKILL.md. Wires
together the triage, leader+second review, gate decision, light/forge path,
delta re-review loop, and merge-gate JSON output.

The merge step itself is NOT performed here — the skill's bash section reads
the JSON we print on stdout and runs `gh pr merge` with native auth. This
keeps privileged operations out of the orchestrator.

Exit codes:
  0 — clean (merge ready, merged, user declined, or dry-run complete)
  1 — halted (findings remain after max_rounds or user declined on unclean)
  2 — dispatch failure (worktree, agent infra, subprocess crash)
  3 — invalid input (missing PR, bad args, config error)
"""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from config_loader import get_forged_review_config
import forged_review_audit as audit
import forged_review_dispatch as disp
import forged_review_engine as eng

try:
    import emit_queue
except ImportError:  # pragma: no cover
    emit_queue = None  # type: ignore

EXIT_OK = 0
EXIT_HALTED = 1
EXIT_DISPATCH_FAIL = 2
EXIT_INVALID_INPUT = 3

STATE_FILENAME = ".forged-review-state.json"
AUDIT_JSONL_BASE = Path.home() / ".claude" / "code-review" / "history" / "forged-review"


# ── Data classes ───────────────────────────────────────────────────────


@dataclass
class RunContext:
    pr_number: int
    repo: str
    branch: str
    base: str
    worktree: Path
    run_id: str
    started_at: float
    dry_run: bool
    no_escalate: bool
    force_escalate: bool
    state_path: Path
    cfg: dict[str, Any]
    rounds: list[dict[str, Any]] = field(default_factory=list)
    path_taken: str = "undecided"
    status: str = "in_progress"


# ── State file I/O ─────────────────────────────────────────────────────


def load_state(path: Path) -> dict[str, Any] | None:
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


def save_state(path: Path, state: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    state["updated_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    path.write_text(json.dumps(state, indent=2), encoding="utf-8")


# ── gh helpers ─────────────────────────────────────────────────────────


def _gh_json(args: list[str]) -> dict[str, Any]:
    """Run a gh command and return parsed JSON, raising on failure."""
    env = None  # inherit (native auth — caller has `unset GH_TOKEN` when needed)
    try:
        result = subprocess.run(
            ["gh", *args],
            capture_output=True, text=True, check=True, env=env, timeout=30,
        )
    except subprocess.CalledProcessError as exc:
        raise RuntimeError(f"gh failed: {exc.stderr.strip() or exc.stdout.strip()}") from exc
    except (subprocess.TimeoutExpired, FileNotFoundError) as exc:
        raise RuntimeError(f"gh error: {exc}") from exc
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"gh output not JSON: {result.stdout[:200]}") from exc


def detect_pr_context(pr_number: int | None, repo_override: str | None) -> dict[str, Any]:
    """Return {pr_number, repo, branch, base} for the target PR.

    If pr_number is None, detects from current branch via `gh pr view`.
    """
    if pr_number is None:
        info = _gh_json(["pr", "view", "--json", "number,headRefName,baseRefName,headRepository,repository"])
        pr_number = info.get("number")
        if not isinstance(pr_number, int):
            raise RuntimeError("could not detect PR from current branch")
    args = ["pr", "view", str(pr_number), "--json", "number,headRefName,baseRefName,url,body,title"]
    if repo_override:
        args += ["--repo", repo_override]
    info = _gh_json(args)
    repo = repo_override
    if not repo:
        remote = subprocess.run(
            ["gh", "repo", "view", "--json", "nameWithOwner"],
            capture_output=True, text=True, timeout=15,
        )
        if remote.returncode == 0:
            try:
                repo = json.loads(remote.stdout).get("nameWithOwner")
            except json.JSONDecodeError:
                repo = None
    if not repo:
        raise RuntimeError("could not detect repo; pass --repo ORG/REPO")
    return {
        "pr_number": info["number"],
        "repo": repo,
        "branch": info["headRefName"],
        "base": info["baseRefName"],
        "body": info.get("body") or "",
        "title": info.get("title") or "",
    }


def fetch_pr_diff(pr_number: int, repo: str) -> str:
    """Fetch the PR diff via gh. Returns empty string on failure."""
    try:
        result = subprocess.run(
            ["gh", "pr", "diff", str(pr_number), "--repo", repo],
            capture_output=True, text=True, check=True, timeout=60,
        )
        return result.stdout
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired, FileNotFoundError):
        return ""


def fetch_pr_changed_files(pr_number: int, repo: str) -> list[str]:
    """Return the list of files changed by the PR."""
    try:
        result = subprocess.run(
            [
                "gh", "pr", "view", str(pr_number),
                "--repo", repo,
                "--json", "files",
            ],
            capture_output=True, text=True, check=True, timeout=30,
        )
        data = json.loads(result.stdout)
        return [f["path"] for f in data.get("files", [])]
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired, FileNotFoundError, json.JSONDecodeError):
        return []


# ── Worktree management ───────────────────────────────────────────────


def create_worktree(branch: str, repo_root: Path) -> Path:
    """Create a fresh git worktree for the PR branch. Returns its path."""
    ts = int(time.time())
    worktree_parent = repo_root / ".worktrees"
    worktree_parent.mkdir(exist_ok=True)
    worktree = worktree_parent / f"forged-review-{branch.replace('/', '-')}-{ts}"
    subprocess.run(
        ["git", "worktree", "add", str(worktree), branch],
        check=True, cwd=str(repo_root), timeout=60,
    )
    return worktree


def cleanup_worktree(worktree: Path, repo_root: Path) -> None:
    try:
        subprocess.run(
            ["git", "worktree", "remove", "--force", str(worktree)],
            check=False, cwd=str(repo_root), timeout=30,
        )
    except (subprocess.TimeoutExpired, FileNotFoundError):
        shutil.rmtree(worktree, ignore_errors=True)


# ── Emit helpers ───────────────────────────────────────────────────────


def _emit(event_type: str, payload: dict[str, Any]) -> None:
    if emit_queue is None:
        return
    try:
        event = emit_queue.make_event(event_type, payload)
        emit_queue.enqueue(event)
    except Exception:  # pragma: no cover
        pass


# ── Round execution ───────────────────────────────────────────────────


def run_round(
    ctx: RunContext,
    selected_domains: list[str],
    pr_diff: str,
    round_num: int,
    round_mode: str,
    file_scope: list[str] | None = None,
) -> dict[str, Any]:
    """Run one review round (full or delta). Returns round dict to append to state."""
    _emit("forged_review.round.start", {
        "run_id": ctx.run_id,
        "round": round_num,
        "mode": round_mode,
        "domains": selected_domains,
    })

    domain_results = disp.run_review_round(
        selected_domains=selected_domains,
        domain_pairs=ctx.cfg["domain_pairs"],
        pr_diff=pr_diff,
        cwd=str(ctx.worktree),
        file_scope=file_scope,
        max_diff_chars=ctx.cfg.get("max_diff_chars_per_domain", disp.DEFAULT_MAX_DIFF_CHARS),
    )

    domain_findings: dict[str, dict[str, Any]] = {}
    all_actionable: list[dict[str, Any]] = []
    for domain, result in domain_results.items():
        domain_findings[domain] = {
            "leader": result.leader_agent,
            "second": result.second_agent,
            "confirmed": result.merged["confirmed"],
            "disputed": result.merged["disputed"],
            "leader_only": result.merged["leader_only"],
            "second_only": result.merged["second_only"],
            "leader_error": result.leader_error,
            "second_error": result.second_error,
            "leader_duration_s": result.leader_duration_s,
            "second_duration_s": result.second_duration_s,
        }
        all_actionable.extend(result.actionable)

    gate = eng.compute_gate(
        actionable_findings=all_actionable,
        forge_threshold=ctx.cfg["forge_threshold"],
        force_escalate=ctx.force_escalate,
        no_escalate=ctx.no_escalate,
    )

    round_obj = {
        "n": round_num,
        "mode": round_mode,
        "domain_findings": domain_findings,
        "actionable_count": gate["actionable_count"],
        "critical_count": gate["critical_count"],
        "gate_decision": gate["path"],
        "gate_reason": gate["reason"],
        "fix_commits": [],
    }

    _emit("forged_review.round.end", {
        "run_id": ctx.run_id,
        "round": round_num,
        "actionable": gate["actionable_count"],
        "critical": gate["critical_count"],
        "mode": round_mode,
    })

    return round_obj


# ── Main flow ─────────────────────────────────────────────────────────


def run(
    pr_number: int | None,
    repo_override: str | None,
    dry_run: bool,
    resume: bool,
    no_escalate: bool,
    force_escalate: bool,
) -> int:
    """Main orchestration. Returns exit code."""
    if no_escalate and force_escalate:
        print("error: --no-escalate and --force-escalate are mutually exclusive", file=sys.stderr)
        return EXIT_INVALID_INPUT

    cfg = get_forged_review_config()

    try:
        repo_root = Path(subprocess.check_output(
            ["git", "rev-parse", "--show-toplevel"], text=True, timeout=10,
        ).strip())
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired, FileNotFoundError) as exc:
        print(f"error: not in a git repo: {exc}", file=sys.stderr)
        return EXIT_INVALID_INPUT

    # Detect PR
    try:
        pr_info = detect_pr_context(pr_number, repo_override)
    except RuntimeError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return EXIT_INVALID_INPUT

    # State file lives in the target worktree. If resuming, we try to find
    # an existing state file in a pre-existing worktree under .worktrees/.
    state: dict[str, Any] | None = None
    existing_worktree: Path | None = None
    if resume:
        candidates = sorted(
            (repo_root / ".worktrees").glob(f"forged-review-{pr_info['branch'].replace('/', '-')}-*")
        )
        for cand in reversed(candidates):
            sp = cand / STATE_FILENAME
            state = load_state(sp)
            if state:
                existing_worktree = cand
                break

    try:
        if existing_worktree is not None:
            worktree = existing_worktree
        else:
            worktree = create_worktree(pr_info["branch"], repo_root)
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired) as exc:
        print(f"error: worktree creation failed: {exc}", file=sys.stderr)
        return EXIT_DISPATCH_FAIL

    state_path = worktree / STATE_FILENAME
    existing_run_id: Any = state.get("run_id") if state else None
    if isinstance(existing_run_id, str) and existing_run_id:
        run_id = existing_run_id
    else:
        run_id = f"run-{int(time.time())}-pr{pr_info['pr_number']}"

    ctx = RunContext(
        pr_number=pr_info["pr_number"],
        repo=pr_info["repo"],
        branch=pr_info["branch"],
        base=pr_info["base"],
        worktree=worktree,
        run_id=run_id,
        started_at=time.time(),
        dry_run=dry_run,
        no_escalate=no_escalate,
        force_escalate=force_escalate,
        state_path=state_path,
        cfg=cfg,
    )
    if state:
        ctx.rounds = state.get("rounds", [])
        ctx.path_taken = state.get("path", "undecided")

    audit.init_metrics_db()

    try:
        return _execute(ctx, pr_info)
    finally:
        if not dry_run and existing_worktree is None:
            cleanup_worktree(worktree, repo_root)


def _execute(ctx: RunContext, pr_info: dict[str, Any]) -> int:
    """Inner main: triage → review → gate → (light|forge) → delta loop → merge-gate JSON."""
    print(
        f"[forged-review] starting run {ctx.run_id} on PR {ctx.pr_number} "
        f"({ctx.repo}) branch={ctx.branch}",
        file=sys.stderr,
        flush=True,
    )
    pr_diff = fetch_pr_diff(ctx.pr_number, ctx.repo)
    changed_files = fetch_pr_changed_files(ctx.pr_number, ctx.repo)
    print(
        f"[forged-review] fetched diff ({len(pr_diff)} chars, "
        f"{len(changed_files)} changed files)",
        file=sys.stderr,
        flush=True,
    )

    # Phase 1: Triage
    print("[forged-review] triage: starting", file=sys.stderr, flush=True)
    triage = disp.dispatch_triage(
        pr_diff=pr_diff,
        changed_files=changed_files,
        pr_description=pr_info.get("body", ""),
        cwd=str(ctx.worktree),
    )
    print(
        f"[forged-review] triage: done, "
        f"selected={triage.get('selected_domains', [])}",
        file=sys.stderr,
        flush=True,
    )
    all_domains = list(ctx.cfg["domain_pairs"].keys())
    try:
        selected_domains = eng.select_domains_from_triage(
            triage, ctx.cfg["always_on_domains"], all_domains,
        )
    except ValueError:
        selected_domains = all_domains

    state = _build_state(ctx, triage, selected_domains)
    save_state(ctx.state_path, state)

    # Phase 2: First full round
    round1 = run_round(
        ctx, selected_domains, pr_diff,
        round_num=1, round_mode="full",
    )
    ctx.rounds.append(round1)
    state["rounds"] = ctx.rounds
    state["current_round"] = 1
    save_state(ctx.state_path, state)

    ctx.path_taken = round1["gate_decision"]
    state["path"] = ctx.path_taken
    _emit("forged_review.gate", {
        "run_id": ctx.run_id,
        "decision": round1["gate_decision"],
        "reason": round1["gate_reason"],
    })

    # Phase 3: If clean from the start, skip to merge-gate
    if round1["actionable_count"] == 0:
        return _finalize_clean(ctx, state)

    # Phase 4: Apply fixes (light or forge path). In --dry-run mode we skip applying.
    if ctx.dry_run:
        state["status"] = "dry_run_complete"
        save_state(ctx.state_path, state)
        return _print_result_json(ctx, status="dry_run_complete")

    # Note: actual fix application (light path in-place edit, forge path
    # design→plan→implement) is out of scope for this phase of the rollout.
    # We emit the gate decision and let the user apply fixes, then --resume.
    # This keeps the first release conservative: review quality is the win;
    # auto-fix integration comes next.
    state["status"] = "awaiting_fixes"
    save_state(ctx.state_path, state)
    return _print_result_json(
        ctx,
        status="awaiting_fixes",
        message=(
            f"{round1['actionable_count']} actionable finding(s) "
            f"(gate: {round1['gate_decision']}). Apply fixes and re-run with --resume."
        ),
    )


def _build_state(
    ctx: RunContext,
    triage: dict[str, Any],
    selected_domains: list[str],
) -> dict[str, Any]:
    return {
        "version": 1,
        "run_id": ctx.run_id,
        "pr_number": ctx.pr_number,
        "repo": ctx.repo,
        "branch": ctx.branch,
        "base": ctx.base,
        "worktree": str(ctx.worktree),
        "path": ctx.path_taken,
        "triage": triage,
        "selected_domains": selected_domains,
        "rounds": ctx.rounds,
        "forge_sub_state": {
            "design": "pending",
            "design_review": "pending",
            "plan": "pending",
            "plan_review": "pending",
            "implement": "pending",
        },
        "current_round": len(ctx.rounds),
        "max_rounds": ctx.cfg["max_rounds"],
        "forge_threshold": ctx.cfg["forge_threshold"],
        "status": ctx.status,
        "started_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(ctx.started_at)),
    }


def _finalize_clean(ctx: RunContext, state: dict[str, Any]) -> int:
    state["status"] = "clean"
    save_state(ctx.state_path, state)
    _emit("forged_review.complete", {
        "run_id": ctx.run_id,
        "pr": ctx.pr_number,
        "status": "clean",
        "duration_s": time.time() - ctx.started_at,
    })
    return _print_result_json(ctx, status="clean")


def _print_result_json(
    ctx: RunContext,
    status: str,
    message: str = "",
) -> int:
    """Print a single JSON object to stdout for the skill to consume."""
    needs_merge = (
        status == "clean"
        and not ctx.dry_run
        and ctx.cfg.get("auto_merge_when_clean", True)
    )
    payload = {
        "status": status,
        "pr_number": ctx.pr_number,
        "repo": ctx.repo,
        "run_id": ctx.run_id,
        "rounds": len(ctx.rounds),
        "path": ctx.path_taken,
        "needs_merge_confirmation": needs_merge,
        "message": message,
        "summary": _summary_text(ctx),
    }
    print(json.dumps(payload, indent=2))
    if status in ("clean", "dry_run_complete"):
        return EXIT_OK
    if status == "awaiting_fixes":
        return EXIT_HALTED
    return EXIT_DISPATCH_FAIL


def _summary_text(ctx: RunContext) -> str:
    if not ctx.rounds:
        return "no rounds executed"
    last = ctx.rounds[-1]
    return (
        f"Round {last['n']} ({last['mode']}): "
        f"{last['actionable_count']} actionable, "
        f"{last['critical_count']} critical, "
        f"gate: {last['gate_decision']} ({last['gate_reason']})"
    )


# ── CLI ────────────────────────────────────────────────────────────────


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Multi-agent PR review orchestrator with leader + second-opinion",
    )
    parser.add_argument("pr_number", type=int, nargs="?",
                        help="PR number (auto-detected from current branch if omitted)")
    parser.add_argument("--repo", help="Override ORG/REPO detection")
    parser.add_argument("--dry-run", action="store_true",
                        help="Review only, no commits/pushes/merge")
    parser.add_argument("--resume", action="store_true",
                        help="Resume from an existing .forged-review-state.json")
    parser.add_argument("--no-escalate", action="store_true",
                        help="Forbid forge-path escalation; always fix in place")
    parser.add_argument("--force-escalate", action="store_true",
                        help="Always take the forge path regardless of gate")
    args = parser.parse_args(argv)

    try:
        return run(
            pr_number=args.pr_number,
            repo_override=args.repo,
            dry_run=args.dry_run,
            resume=args.resume,
            no_escalate=args.no_escalate,
            force_escalate=args.force_escalate,
        )
    except KeyboardInterrupt:
        print("\ninterrupted", file=sys.stderr)
        return EXIT_HALTED


# ── Red-team forge-path scaffold ──────────────────────────────────────
#
# Added by Task 18 of stark-red-team.
# RED TEAM SCAFFOLD — fires when forge-path auto-apply ships.
# For v1 this code path is unreachable (forge path is itself a placeholder).
# When auto-apply lands, uncomment and wire to the real call site:
#
# from forged_review_dispatch import dispatch_red_team_for_stage
# rt_status = dispatch_red_team_for_stage(
#     stage="design",
#     artifact=design_doc_text,
#     source_spec=pr_description,
#     pr_diff=pr_diff,
#     cwd=str(ctx.worktree),
#     run_id=ctx.run_id,
# )


if __name__ == "__main__":
    sys.exit(main())
