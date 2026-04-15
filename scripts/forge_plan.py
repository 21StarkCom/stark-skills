#!/usr/bin/env python3
"""Plan generation, plan review, and TDD stub for stark-forge.

Phase 2 of the forge pipeline:
  1. run_plan_phase()   — generate plans (3 agents) + cross-review to pick winner
  2. run_plan_review()  — Iron Rule loop over 10 plan-review domains
"""
from __future__ import annotations

import hashlib
import subprocess
import sys
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


# ── Paths ─────────────────────────────────────────────────────────────────

FORGE_PLAN_REVIEW_DIR = (
    Path.home() / ".claude" / "code-review" / "prompts" / "forge-plan-review"
)


# ── Data structures ────────────────────────────────────────────────────────


@dataclass
class PhaseResult:
    status: str  # "completed" or "halted"
    rounds: list[dict[str, Any]] = field(default_factory=list)
    findings_fixed: int = 0
    noise: int = 0
    commit_shas: list[str] = field(default_factory=list)
    plan_path: Path | None = None
    plan_hash: str | None = None


# ── Dispatch stubs (importable at test time without real CLIs) ─────────────


def _generate_plans(spec_text: str, **kwargs: Any) -> dict[str, Any]:
    """Stub that delegates to design_to_plan_dispatch.generate_plans().

    Falls back to empty result dict when the real dispatch is unavailable.
    """
    try:
        from design_to_plan_dispatch import generate_plans  # noqa: PLC0415
        return generate_plans(design_content=spec_text, **kwargs)
    except ImportError:
        return {"results": [], "error": "dispatch not available"}


def _cross_review_plans(spec_text: str, plans: dict[str, str], **kwargs: Any) -> dict[str, Any]:
    """Stub that delegates to design_to_plan_dispatch.cross_review_plans().

    Falls back to empty result dict when the real dispatch is unavailable.
    """
    try:
        from design_to_plan_dispatch import cross_review_plans  # noqa: PLC0415
        return cross_review_plans(design_content=spec_text, plans=plans, **kwargs)
    except ImportError:
        return {
            "results": [],
            "plan_averages": {},
            "winner": None,
            "error": "dispatch not available",
        }


def _dispatch_plan_review(
    plan_content: str,
    round_num: int,
    *,
    global_prompts_dir: str,
    agents: list[str],
    domains: dict[str, dict[str, Any]] | None,
    timeout: int,
    repo_dir: str | None = None,
) -> dict[str, Any]:
    """Wrapper around plan_review_dispatch.dispatch_plan_review().

    Catches ImportError so tests can mock this function cleanly.
    """
    try:
        from plan_review_dispatch import dispatch_plan_review  # noqa: PLC0415
        return dispatch_plan_review(
            plan_content,
            round_num,
            repo_dir=repo_dir,
            global_prompts_dir=global_prompts_dir,
            agents=agents,
            domains=domains,
            timeout=timeout,
        )
    except ImportError:
        return {"results": [], "error": "plan_review_dispatch not available"}


# ── Git helpers ────────────────────────────────────────────────────────────


def _git_commit(repo_dir: Path, files: list[str], message: str) -> str | None:
    """Stage *files* and commit with *message* in *repo_dir*.

    Returns the commit SHA on success, None on failure.
    """
    try:
        subprocess.run(
            ["git", "add"] + files,
            cwd=str(repo_dir),
            capture_output=True,
            text=True,
            check=True,
        )
        subprocess.run(
            ["git", "commit", "-m", message],
            cwd=str(repo_dir),
            capture_output=True,
            text=True,
            check=True,
        )
        result = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=str(repo_dir),
            capture_output=True,
            text=True,
            check=True,
        )
        return result.stdout.strip()
    except subprocess.CalledProcessError as exc:
        print(f"[forge_plan] git error: {exc.stderr}", file=sys.stderr)
        return None


# ── Finding helpers ────────────────────────────────────────────────────────


def _count_findings_at_or_above(
    findings: list[dict[str, Any]], threshold: str
) -> int:
    """Count findings whose severity is at or above *threshold*.

    Severity ladder (ascending): low < medium < high < critical
    """
    ladder = ["low", "medium", "high", "critical"]
    try:
        min_idx = ladder.index(threshold.lower())
    except ValueError:
        min_idx = 1  # default to medium

    return sum(
        1
        for f in findings
        if ladder.index(f.get("severity", "medium").lower()) >= min_idx
    )


def _all_findings_from_result(dispatch_result: dict[str, Any]) -> list[dict[str, Any]]:
    """Flatten all findings from a dispatch_plan_review result dict."""
    findings: list[dict[str, Any]] = []
    for sub_result in dispatch_result.get("results", []):
        for finding in sub_result.get("findings", []):
            if isinstance(finding, dict):
                findings.append(finding)
    return findings


# ── Phase 2a: Plan generation ──────────────────────────────────────────────


def run_plan_phase(
    spec_path: Path,
    state: dict[str, Any],
    cfg: dict[str, Any],
    repo_dir: Path,
) -> PhaseResult:
    """Generate implementation plans and select the winner via cross-review.

    Writes the winning plan to ``{spec-stem}-plan.md`` in *repo_dir* and
    commits it, then returns a :class:`PhaseResult` with ``plan_path`` set.
    """
    spec_text = spec_path.read_text(encoding="utf-8")
    timeout = cfg.get("timeout", 600)

    print("\n[forge_plan] Phase 2a: generating plans...", file=sys.stderr)
    gen_result = _generate_plans(spec_text, timeout=timeout)

    # Build plans dict for cross-review: {agent: plan_content}
    plans: dict[str, str] = {}
    for r in gen_result.get("results", []):
        if not r.get("error") and r.get("plan_content"):
            plans[r["agent"]] = r["plan_content"]

    if not plans:
        print("[forge_plan] No plans generated — all agents failed.", file=sys.stderr)
        return PhaseResult(status="halted")

    print("[forge_plan] Phase 2a: cross-reviewing plans...", file=sys.stderr)
    cross_result = _cross_review_plans(spec_text, plans, timeout=timeout)

    # Determine winner
    winner_agent = cross_result.get("winner")
    if winner_agent and winner_agent in plans:
        winner_content = plans[winner_agent]
    else:
        # Fall back to first successful plan
        winner_agent = next(iter(plans))
        winner_content = plans[winner_agent]

    print(
        f"[forge_plan] Winner: {winner_agent} "
        f"(avg {cross_result.get('plan_averages', {}).get(winner_agent, 0):.1f}/10)",
        file=sys.stderr,
    )

    # Write plan file
    plan_filename = f"{spec_path.stem}-plan.md"
    plan_path = repo_dir / plan_filename
    plan_path.write_text(winner_content, encoding="utf-8")

    # Commit
    sha = _git_commit(
        repo_dir,
        [plan_filename],
        f"forge: generated implementation plan (winner: {winner_agent})",
    )

    result = PhaseResult(status="completed", plan_path=plan_path)
    if sha:
        result.commit_shas.append(sha)

    # Update state
    state["phases"]["plan"]["plan_path"] = str(plan_path)
    state["phases"]["plan"]["winner_agent"] = winner_agent
    state["updated_at"] = datetime.now(timezone.utc).isoformat()

    return result


# ── Phase 2b: Plan review Iron Rule loop ──────────────────────────────────


def _discover_plan_review_domains(global_prompts_dir: str) -> dict[str, dict[str, Any]]:
    """Discover plan review domains from the forge-plan-review prompt tree."""
    try:
        from dispatcher_base import discover_domains  # noqa: PLC0415
        return discover_domains(global_prompts_dir)
    except ImportError:
        # Fallback: return the 10 standard plan-review domain keys
        return {
            domain: {"order": f"{idx + 1:02d}", "label": domain.title(), "filename": f"{domain}.md"}
            for idx, domain in enumerate([
                "general", "completeness", "security", "feasibility",
                "operability", "sequencing", "rollback", "risk", "gates", "timeline",
            ])
        }


def _build_routed_agent_groups(
    routing: dict[str, str],
    domains: dict[str, dict[str, Any]],
    fallback_order: list[str],
) -> dict[str, dict[str, dict[str, Any]]]:
    """Group domains by their routed agent.

    Returns: ``{agent: {domain_key: domain_meta, ...}, ...}``
    """
    groups: dict[str, dict[str, dict[str, Any]]] = {}
    for domain_key, domain_meta in domains.items():
        agent = routing.get(domain_key, fallback_order[0] if fallback_order else "claude")
        groups.setdefault(agent, {})[domain_key] = domain_meta
    return groups


def run_plan_review(
    plan_path: Path,
    state: dict[str, Any],
    cfg: dict[str, Any],
    repo_dir: Path,
) -> PhaseResult:
    """Iron Rule loop for plan review.

    Runs up to ``cfg["max_rounds"]`` review rounds, fixing findings between
    rounds. On the halt round (``max_rounds + 1``), dispatches all domains.
    If any fix/blocked findings remain, returns ``status="halted"``.
    After a clean halt round, freezes the plan hash in state.
    """
    max_rounds = cfg.get("max_rounds", 3)
    halt_round = max_rounds + 1
    fix_threshold = cfg.get("fix_threshold", "medium")
    timeout = cfg.get("review_timeout", cfg.get("timeout", 300))
    fix_timeout = cfg.get("fix_timeout", 900)
    plan_review_routing = cfg.get("plan_review_routing", {})
    fallback_order = cfg.get("agent_fallback_order", ["claude", "codex", "gemini"])
    global_prompts_dir = str(FORGE_PLAN_REVIEW_DIR)

    all_domains = _discover_plan_review_domains(global_prompts_dir)
    agent_groups = _build_routed_agent_groups(
        plan_review_routing, all_domains, fallback_order
    )

    result = PhaseResult(status="pending")
    print(
        f"\n[forge_plan] Phase 2b: plan review (max_rounds={max_rounds}, "
        f"halt_round={halt_round}, threshold={fix_threshold})",
        file=sys.stderr,
    )

    for round_num in range(1, halt_round + 1):
        is_halt_round = round_num == halt_round
        plan_text = plan_path.read_text(encoding="utf-8")

        round_findings: list[dict[str, Any]] = []
        print(
            f"\n[forge_plan] Round {round_num}"
            + (" (halt round)" if is_halt_round else ""),
            file=sys.stderr,
        )

        # Dispatch each agent group
        for agent, domain_dict in agent_groups.items():
            dispatch_result = _dispatch_plan_review(
                plan_text,
                round_num,
                global_prompts_dir=global_prompts_dir,
                agents=[agent],
                domains=domain_dict,
                timeout=timeout,
                repo_dir=str(repo_dir),
            )
            round_findings.extend(_all_findings_from_result(dispatch_result))

        # Classify findings
        actionable = _count_findings_at_or_above(round_findings, fix_threshold)
        noise = len(round_findings) - actionable

        round_record: dict[str, Any] = {
            "round": round_num,
            "total_findings": len(round_findings),
            "actionable": actionable,
            "noise": noise,
            "halt_round": is_halt_round,
        }
        result.rounds.append(round_record)
        result.noise += noise

        # Persist rounds after every iteration so a halt/crash before the
        # clean-halt tail doesn't lose the round log.
        state["phases"]["plan_review"]["rounds"] = list(result.rounds)
        state["phases"]["plan_review"]["findings_fixed"] = result.findings_fixed
        state["phases"]["plan_review"]["noise"] = result.noise
        state["updated_at"] = datetime.now(timezone.utc).isoformat()

        print(
            f"[forge_plan] Round {round_num}: {actionable} actionable, {noise} noise",
            file=sys.stderr,
        )

        if is_halt_round:
            if actionable > 0:
                print(
                    f"[forge_plan] HALT — {actionable} finding(s) remain after round {round_num}.",
                    file=sys.stderr,
                )
                result.status = "halted"
                return result
            else:
                print("[forge_plan] Halt round clean — plan review passed.", file=sys.stderr)
                break

        if actionable == 0:
            # Early termination — jump straight to halt round
            print(
                f"[forge_plan] Round {round_num} clean — skipping to halt round.",
                file=sys.stderr,
            )
            # Run halt round immediately on next iteration
            # (set round_num to halt_round - 1 so the loop naturally goes to halt_round)
            # We do this by continuing to the halt round iteration
            continue

        # Apply fixes — dispatch an LLM to rewrite the plan, then commit
        # only if the rewrite actually changed the document. A silent
        # no-op commit would mislead readers and re-find the same issues.
        from forge_fix_loop import apply_fixes  # noqa: PLC0415

        fix_findings = [
            f for f in round_findings
            if f.get("severity", "medium").lower() in {"medium", "high", "critical"}
        ]
        _, changed = apply_fixes(
            plan_path,
            fix_findings,
            artifact_kind="implementation plan",
            round_num=round_num,
            timeout=fix_timeout,
        )

        if not changed:
            print(
                f"[forge_plan] Round {round_num}: fix dispatch produced no "
                f"changes ({actionable} actionable findings). Halting — "
                "subsequent rounds would re-find the same issues.",
                file=sys.stderr,
            )
            round_record["fix_dispatch_noop"] = True
            state["phases"]["plan_review"]["rounds"] = list(result.rounds)
            state["updated_at"] = datetime.now(timezone.utc).isoformat()
            result.status = "halted"
            return result

        result.findings_fixed += actionable

        # Commit after each fix round
        sha = _git_commit(
            repo_dir,
            [plan_path.name],
            f"forge: plan review round {round_num} — fixed {actionable} findings",
        )
        if sha:
            result.commit_shas.append(sha)
            round_record["commit_sha"] = sha

    # Freeze plan hash after clean halt round
    plan_text = plan_path.read_text(encoding="utf-8")
    plan_hash = hashlib.sha256(plan_text.encode()).hexdigest()
    result.plan_hash = plan_hash
    result.plan_path = plan_path
    result.status = "completed"

    # Store in state
    state["phases"]["plan_review"]["plan_hash"] = plan_hash
    state["phases"]["plan"]["plan_hash"] = plan_hash
    state["updated_at"] = datetime.now(timezone.utc).isoformat()

    print(f"[forge_plan] Plan hash frozen: {plan_hash[:12]}...", file=sys.stderr)
    return result


# ── Red-team plan-stage scaffold ──────────────────────────────────────
#
# Added by Task 17 of stark-red-team. This is a NO-OP in v1 — the plan
# stage is gated on red_team.stages.plan.enabled which defaults to false.
# When the config flag flips true (Week 3 of the rollout), this function
# will dispatch the red team on the plan artifact.

def _maybe_run_red_team_plan_stage(state: dict, cfg_loader=None) -> dict:
    """Scaffolded call site for plan-stage red team. Disabled in v1.

    When red_team.stages.plan.enabled becomes true in config, this function
    will dispatch the red team on the plan artifact (mirror of
    forge_orchestrator.run_red_team_design_stage). For v1 this is a no-op.
    """
    if cfg_loader is None:
        from config_loader import get_red_team_config as cfg_loader  # type: ignore
    cfg = cfg_loader()
    stages = cfg.get("stages", {})
    plan_enabled = stages.get("plan", {}).get("enabled", False)
    if not plan_enabled:
        return {"status": "disabled", "reason": "red_team.stages.plan.enabled is false"}
    return {"status": "skipped", "reason": "plan-stage red team scaffold not yet implemented"}
