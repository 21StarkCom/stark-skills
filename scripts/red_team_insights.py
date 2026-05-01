"""stark-insights event builders for red-team runs.

The builders are pure so forward emission and SQLite backfill can share the
same payload/dedupe contract. The emitters are best-effort wrappers around the
durable queue and must never affect red-team skill status.
"""

from __future__ import annotations

import sys
from dataclasses import asdict
from typing import Any

import stark_red_team as rt

_DEDUPE_PREFIXES = {"run", "finding", "fix_plan"}


def make_dedupe_key(
    kind: str,
    *,
    stage: str,
    run_id: str,
    round_num: int | None = None,
    finding_id: str | None = None,
) -> str:
    """Return the canonical red-team insights dedupe key."""
    if kind not in _DEDUPE_PREFIXES:
        raise ValueError(f"unsupported red-team dedupe kind: {kind}")
    if kind == "finding":
        if round_num is None or not finding_id:
            raise ValueError("finding dedupe key requires round_num and finding_id")
        return f"red-team:finding:{stage}:{run_id}:{round_num}:{finding_id}"
    if kind in {"run", "fix_plan"} and (round_num is not None or finding_id is not None):
        raise ValueError(f"{kind} dedupe key does not accept round_num or finding_id")
    return f"red-team:{kind}:{stage}:{run_id}"


def build_run_envelope(
    *,
    run_id: str,
    stage: str,
    repo: str | None,
    artifact_relative_path: str | None,
    pr_number: int | None,
    model: str,
    caller: str,
    final_status: str,
    worst_severity: str | None,
    passed: bool,
    rounds_used: int,
    total_findings: int,
    blocking_count: int,
    human_review_count: int,
    critical_count: int,
    high_count: int,
    medium_count: int,
    duration_s: float,
    cost_usd: float,
    fix_plan_status: str | None,
    warnings: list[str] | None,
    started_at_iso: str,
) -> dict[str, Any]:
    repo_label = repo or "unknown"
    payload = {
        "run_id": run_id,
        "stage": stage,
        "model": model,
        "caller": caller,
        "final_status": final_status,
        "worst_severity": worst_severity,
        "passed": passed,
        "rounds_used": rounds_used,
        "total_findings": total_findings,
        "blocking_count": blocking_count,
        "human_review_count": human_review_count,
        "critical_count": critical_count,
        "high_count": high_count,
        "medium_count": medium_count,
        "duration_s": duration_s,
        "cost_usd": cost_usd,
        "repo": repo_label,
        "artifact_relative_path": artifact_relative_path,
        "pr_number": pr_number,
        "fix_plan_status": fix_plan_status,
        "warnings": list(warnings or []),
    }
    return _envelope(
        "red_team_run",
        timestamp_iso=started_at_iso,
        repo=repo_label,
        dedupe_key=make_dedupe_key("run", stage=stage, run_id=run_id),
        payload=payload,
    )


def build_finding_envelope(
    *,
    run_id: str,
    stage: str,
    repo: str | None,
    pr_number: int | None,
    round_num: int,
    finding_id: str,
    persona: str,
    severity: str,
    concern: str,
    consequence: str,
    counter_proposal: str,
    trade_off: str | None,
    reason_for_uncertainty: str | None,
    is_human_review: bool,
    timestamp_iso: str,
) -> dict[str, Any]:
    repo_label = repo or "unknown"
    payload = {
        "run_id": run_id,
        "stage": stage,
        "round_num": round_num,
        "finding_id": finding_id,
        "persona": persona,
        "severity": severity,
        "concern": concern,
        "consequence": consequence,
        "counter_proposal": counter_proposal,
        "trade_off": trade_off,
        "reason_for_uncertainty": reason_for_uncertainty,
        "is_human_review": is_human_review,
        "repo": repo_label,
        "pr_number": pr_number,
    }
    return _envelope(
        "red_team_finding",
        timestamp_iso=timestamp_iso,
        repo=repo_label,
        dedupe_key=make_dedupe_key(
            "finding",
            stage=stage,
            run_id=run_id,
            round_num=round_num,
            finding_id=finding_id,
        ),
        payload=payload,
    )


def build_fix_plan_envelope(
    *,
    run_id: str,
    stage: str,
    repo: str | None,
    pr_number: int | None,
    model: str,
    reasoning_effort: str,
    summary: str,
    notes: str,
    moves: list[dict[str, Any]],
    move_count: int,
    addressed_finding_ids: list[str],
    unaddressed_finding_ids: list[str],
    orphan_finding_ids: list[str],
    input_truncated: bool,
    input_omitted_finding_ids: list[str],
    warnings: list[str],
    cost_usd: float,
    duration_s: float,
    input_tokens: int,
    output_tokens: int,
    fix_plan_md: str,
    timestamp_iso: str,
) -> dict[str, Any]:
    repo_label = repo or "unknown"
    payload = {
        "run_id": run_id,
        "stage": stage,
        "model": model,
        "reasoning_effort": reasoning_effort,
        "summary": summary,
        "notes": notes,
        "moves": list(moves),
        "move_count": move_count,
        "addressed_finding_ids": list(addressed_finding_ids),
        "unaddressed_finding_ids": list(unaddressed_finding_ids),
        "orphan_finding_ids": list(orphan_finding_ids),
        "input_truncated": input_truncated,
        "input_omitted_finding_ids": list(input_omitted_finding_ids),
        "warnings": list(warnings),
        "cost_usd": cost_usd,
        "duration_s": duration_s,
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
        "fix_plan_md": fix_plan_md,
        "repo": repo_label,
        "pr_number": pr_number,
    }
    return _envelope(
        "red_team_fix_plan",
        timestamp_iso=timestamp_iso,
        repo=repo_label,
        dedupe_key=make_dedupe_key("fix_plan", stage=stage, run_id=run_id),
        payload=payload,
    )


def emit_run(
    ctx: rt.RedTeamRunContext,
    *,
    result: rt.RedTeamResult,
    model: str,
    fix_plan_status: str | None,
    run_warnings: list[str] | None,
) -> None:
    """Best-effort enqueue of one ``red_team_run`` event.

    ``model`` is the resolved dispatch model (challenge call's actual model
    after any ``--model`` override), NOT ``ctx.cfg_red_team['model']``. The
    audit row, sidecar, JSON output, and this event must agree on the
    model that actually ran.
    """
    try:
        envelope = build_run_envelope(
            run_id=ctx.run_id,
            stage=ctx.stage,
            repo=ctx.repo,
            artifact_relative_path=ctx.artifact_relative_path,
            pr_number=ctx.pr_number,
            model=model,
            caller=ctx.caller,
            final_status=rt.derive_status(result),
            worst_severity=_worst_severity(result),
            passed=rt.derive_status(result) == "clean",
            rounds_used=result.round_num,
            total_findings=len(result.findings),
            blocking_count=result.blocking_count,
            human_review_count=result.human_review_count,
            critical_count=sum(1 for f in result.findings if f.severity == "critical"),
            high_count=sum(1 for f in result.findings if f.severity == "high"),
            medium_count=sum(1 for f in result.findings if f.severity == "medium"),
            duration_s=result.duration_s,
            cost_usd=result.cost_usd,
            fix_plan_status=fix_plan_status,
            warnings=run_warnings,
            started_at_iso=ctx.started_at_iso,
        )
        _enqueue(envelope, "red_team_run")
    except Exception as exc:  # pragma: no cover - defensive fail-open wrapper
        print(f"  [!] Failed to emit red_team_run: {exc}", file=sys.stderr)


def emit_finding(
    ctx: rt.RedTeamRunContext,
    *,
    finding: rt.RedTeamFinding,
    round_num: int,
) -> None:
    """Best-effort enqueue of one ``red_team_finding`` event."""
    try:
        envelope = build_finding_envelope(
            run_id=ctx.run_id,
            stage=ctx.stage,
            repo=ctx.repo,
            pr_number=ctx.pr_number,
            round_num=round_num,
            finding_id=finding.id,
            persona=finding.persona,
            severity=finding.severity,
            concern=finding.concern,
            consequence=finding.consequence,
            counter_proposal=finding.counter_proposal,
            trade_off=finding.trade_off,
            reason_for_uncertainty=finding.reason_for_uncertainty,
            is_human_review=rt.is_human_review(finding),
            timestamp_iso=ctx.started_at_iso,
        )
        _enqueue(envelope, "red_team_finding")
    except Exception as exc:  # pragma: no cover - defensive fail-open wrapper
        print(f"  [!] Failed to emit red_team_finding: {exc}", file=sys.stderr)


def emit_fix_plan(
    ctx: rt.RedTeamRunContext,
    *,
    fix_plan: rt.RedTeamFixPlan,
    fix_plan_md: str,
    fix_plan_status: str = "success",
) -> None:
    """Best-effort enqueue of one successful ``red_team_fix_plan`` event."""
    if fix_plan_status != "success" or fix_plan.error is not None:
        return
    try:
        moves = [asdict(move) for move in fix_plan.moves]
        envelope = build_fix_plan_envelope(
            run_id=ctx.run_id,
            stage=ctx.stage,
            repo=ctx.repo,
            pr_number=ctx.pr_number,
            model=fix_plan.model,
            reasoning_effort=fix_plan.reasoning_effort,
            summary=fix_plan.summary,
            notes=fix_plan.notes,
            moves=moves,
            move_count=len(fix_plan.moves),
            addressed_finding_ids=_addressed_ids(fix_plan.moves),
            unaddressed_finding_ids=fix_plan.unaddressed_finding_ids,
            orphan_finding_ids=fix_plan.orphan_finding_ids,
            input_truncated=fix_plan.input_truncated,
            input_omitted_finding_ids=fix_plan.input_omitted_finding_ids,
            warnings=fix_plan.warnings,
            cost_usd=fix_plan.cost_usd,
            duration_s=fix_plan.duration_s,
            input_tokens=fix_plan.input_tokens,
            output_tokens=fix_plan.output_tokens,
            fix_plan_md=fix_plan_md,
            timestamp_iso=ctx.started_at_iso,
        )
        _enqueue(envelope, "red_team_fix_plan")
    except Exception as exc:  # pragma: no cover - defensive fail-open wrapper
        print(f"  [!] Failed to emit red_team_fix_plan: {exc}", file=sys.stderr)


def _envelope(
    event_type: str,
    *,
    timestamp_iso: str,
    repo: str,
    dedupe_key: str,
    payload: dict[str, Any],
) -> dict[str, Any]:
    return {
        "type": event_type,
        "timestamp": timestamp_iso,
        "cli": "claude",
        "source": "skill",
        "schema_version": 1,
        "project": repo,
        "dedupe_key": dedupe_key,
        "payload": payload,
    }


def _enqueue(envelope: dict[str, Any], event_type: str) -> None:
    try:
        from emit_queue import enqueue

        enqueue(envelope)
    except Exception as exc:
        print(f"  [!] Failed to emit {event_type}: {exc}", file=sys.stderr)


def _worst_severity(result: rt.RedTeamResult) -> str | None:
    if result.error:
        return None
    severities = [f.severity for f in result.findings if f.severity in rt.SEVERITY_RANK]
    if not severities:
        return None
    return max(severities, key=lambda s: rt.SEVERITY_RANK[s])


def _addressed_ids(moves: list[rt.FixPlanMove]) -> list[str]:
    out: list[str] = []
    seen: set[str] = set()
    for move in moves:
        for finding_id in move.addressed_finding_ids:
            if finding_id not in seen:
                seen.add(finding_id)
                out.append(finding_id)
    return out
