"""CLI dispatcher for /stark-red-team-plan — adversarial plan-doc challenge.

Thin wrapper over `stark_red_team.run_red_team(stage="plan", ...)` for ad-hoc
invocation against an execution-plan markdown file. Mirrors the call shape
used by `forge_orchestrator.run_red_team_plan_stage` but bypasses the
`stages.plan.enabled` gate (manual invocation is explicit) and writes a
human-readable sidecar markdown next to the plan.

Usage:
    python3 red_team_plan_dispatch.py \\
        --plan path/to/plan.md \\
        [--source-spec path/to/spec.md] \\
        [--model gpt-5.5-pro] \\
        [--no-sidecar] \\
        [--no-audit] \\
        [--json]
"""

from __future__ import annotations

import argparse
import json
import sys
import time
import uuid
from dataclasses import asdict
from pathlib import Path
from typing import Any

import stark_red_team as rt
from config_loader import get_model_rates, get_red_team_config


_STAGE = "plan"


def _read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def _final_status(result: rt.RedTeamResult) -> str:
    if result.error:
        return "error"
    if result.human_review_count > 0:
        return "halted_human_review"
    if result.blocking_count > 0:
        return "halted"
    return "clean"


def _audit_run(
    *,
    run_id: str,
    result: rt.RedTeamResult,
    model: str,
) -> None:
    """Record the run + findings to the manual-runs audit DB. Never raises."""
    try:
        import red_team_audit
    except Exception:
        return
    try:
        red_team_audit.init_red_team_tables()
        red_team_audit.record_red_team_run({
            "run_id": run_id,
            "stage": _STAGE,
            "rounds_used": 1,
            "final_status": _final_status(result),
            "total_findings": len(result.findings),
            "critical_count": sum(1 for f in result.findings if f.severity == "critical"),
            "high_count": sum(1 for f in result.findings if f.severity == "high"),
            "medium_count": sum(1 for f in result.findings if f.severity == "medium"),
            "human_review_count": result.human_review_count,
            "duration_s": result.duration_s,
            "cost_usd": result.cost_usd,
            "model": model,
            "caller": "manual",
        })
        if result.findings:
            red_team_audit.record_findings([
                {
                    "run_id": run_id,
                    "stage": _STAGE,
                    "round_num": 1,
                    "finding_id": f.id,
                    "persona": f.persona,
                    "severity": f.severity,
                    "concern": f.concern,
                    "consequence": f.consequence,
                    "counter_proposal": f.counter_proposal,
                    "trade_off": f.trade_off,
                    "reason_for_uncertainty": f.reason_for_uncertainty,
                }
                for f in result.findings
            ])
    except Exception:
        pass


_SEVERITY_BADGE = {"critical": "🛑", "high": "🔴", "medium": "🟡"}


def render_sidecar_markdown(
    *,
    plan_path: Path,
    source_spec_path: Path | None,
    result: rt.RedTeamResult,
    model: str,
    run_id: str,
) -> str:
    """Build the human-readable `<plan>.red-team.md` sidecar."""
    timestamp = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    status = _final_status(result)
    blocking = result.blocking_count
    human_review = result.human_review_count

    findings_sorted = sorted(
        result.findings,
        key=lambda f: (-rt.SEVERITY_RANK.get(f.severity, 0), f.persona, f.id),
    )

    lines: list[str] = []
    lines.append(f"# Red-team review — {plan_path.name}")
    lines.append("")
    lines.append(f"- **Date:** {timestamp}")
    lines.append(f"- **Run ID:** `{run_id}`")
    lines.append(f"- **Model:** `{model}`")
    lines.append(f"- **Source spec:** `{source_spec_path}`" if source_spec_path else "- **Source spec:** (plan used as its own spec)")
    lines.append(f"- **Status:** **{status}**")
    lines.append(
        f"- **Findings:** {len(result.findings)} total — "
        f"{blocking} blocking (≥ high), {human_review} human-review"
    )
    lines.append(
        f"- **Cost:** ${result.cost_usd:.4f} | **Duration:** {result.duration_s:.1f}s | "
        f"**Tokens:** in={result.input_tokens} out={result.output_tokens}"
    )
    lines.append("")

    if result.error:
        lines.append("## Error")
        lines.append("")
        lines.append("```")
        lines.append(result.error.strip())
        lines.append("```")
        lines.append("")
        excerpt = (result.raw_output or "").strip()
        if excerpt:
            lines.append("### Raw output excerpt")
            lines.append("")
            lines.append("```")
            lines.append(excerpt[:2000])
            lines.append("```")
            lines.append("")
        return "\n".join(lines)

    if result.synthesis:
        lines.append("## Synthesis")
        lines.append("")
        lines.append(result.synthesis.strip())
        lines.append("")

    if not findings_sorted:
        lines.append("## Findings")
        lines.append("")
        lines.append("_No findings._ The committee did not raise blocking or human-review concerns.")
        lines.append("")
        return "\n".join(lines)

    lines.append("## Findings")
    lines.append("")
    lines.append("| # | Severity | Persona | ID | Concern |")
    lines.append("|---|----------|---------|----|---------|")
    for i, f in enumerate(findings_sorted, 1):
        badge = _SEVERITY_BADGE.get(f.severity, "")
        concern_short = f.concern.replace("\n", " ").strip()
        if len(concern_short) > 140:
            concern_short = concern_short[:137] + "..."
        lines.append(f"| {i} | {badge} {f.severity} | {f.persona} | `{f.id}` | {concern_short} |")
    lines.append("")

    lines.append("## Detail")
    lines.append("")
    for i, f in enumerate(findings_sorted, 1):
        badge = _SEVERITY_BADGE.get(f.severity, "")
        lines.append(f"### {i}. {badge} `{f.id}` — {f.persona} ({f.severity})")
        lines.append("")
        lines.append(f"**Concern.** {f.concern.strip()}")
        lines.append("")
        lines.append(f"**Consequence.** {f.consequence.strip()}")
        lines.append("")
        if f.counter_proposal == rt.REQUEST_HUMAN_REVIEW:
            lines.append("**Counter-proposal.** _Requests human review._")
            if f.reason_for_uncertainty:
                lines.append("")
                lines.append(f"**Reason.** {f.reason_for_uncertainty.strip()}")
        else:
            lines.append(f"**Counter-proposal.** {f.counter_proposal.strip()}")
            if f.trade_off:
                lines.append("")
                lines.append(f"**Trade-off.** {f.trade_off.strip()}")
        lines.append("")

    return "\n".join(lines)


def run_dispatch(
    *,
    plan_path: Path,
    source_spec_path: Path | None,
    model_override: str | None,
    write_sidecar: bool,
    audit: bool,
    cwd: str | None,
) -> dict[str, Any]:
    """Run the red-team and return a dict shaped for the skill."""
    if not plan_path.exists():
        return {"status": "error", "error": f"plan file not found: {plan_path}"}

    cfg = get_red_team_config()
    model_rates = get_model_rates()
    model = model_override or cfg["model"]

    artifact = _read_text(plan_path)
    if source_spec_path is not None:
        if not source_spec_path.exists():
            return {"status": "error", "error": f"source-spec file not found: {source_spec_path}"}
        source_spec = _read_text(source_spec_path)
    else:
        # Use the plan as its own source spec — matches forge_orchestrator
        # behavior when only one artifact is supplied.
        source_spec = artifact

    result = rt.run_red_team(
        stage=_STAGE,
        artifact=artifact,
        source_spec=source_spec,
        pr_diff=None,
        personas=cfg["personas"],
        model=model,
        model_rates=model_rates,
        cwd=cwd,
        timeout_s=cfg["timeout_s"],
        min_severity_to_block=cfg["min_severity_to_block"],
        max_input_chars=cfg["max_input_chars"],
        round_num=1,
    )

    run_id = f"manual-{uuid.uuid4().hex[:12]}"

    if audit:
        _audit_run(run_id=run_id, result=result, model=model)

    sidecar_path: Path | None = None
    if write_sidecar:
        sidecar_path = plan_path.with_suffix(plan_path.suffix + ".red-team.md")
        if plan_path.suffix == ".md":
            sidecar_path = plan_path.with_name(plan_path.stem + ".red-team.md")
        sidecar_path.write_text(
            render_sidecar_markdown(
                plan_path=plan_path,
                source_spec_path=source_spec_path,
                result=result,
                model=model,
                run_id=run_id,
            ),
            encoding="utf-8",
        )

    return {
        "status": _final_status(result),
        "run_id": run_id,
        "model": model,
        "plan_path": str(plan_path),
        "source_spec_path": str(source_spec_path) if source_spec_path else None,
        "sidecar_path": str(sidecar_path) if sidecar_path else None,
        "blocking_count": result.blocking_count,
        "human_review_count": result.human_review_count,
        "total_findings": len(result.findings),
        "duration_s": result.duration_s,
        "cost_usd": result.cost_usd,
        "input_tokens": result.input_tokens,
        "output_tokens": result.output_tokens,
        "error": result.error,
        "synthesis": result.synthesis,
        "findings": [asdict(f) for f in result.findings],
    }


def _build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="red_team_plan_dispatch",
        description="Adversarial red-team review of an execution plan doc.",
    )
    p.add_argument("--plan", required=True, help="Path to the plan markdown file.")
    p.add_argument(
        "--source-spec",
        default=None,
        help="Optional source-spec or design file. Defaults to using the plan as its own spec.",
    )
    p.add_argument(
        "--model",
        default=None,
        help="Override the configured red-team model (default from red_team.model).",
    )
    p.add_argument(
        "--no-sidecar",
        action="store_true",
        help="Skip writing the <plan>.red-team.md sidecar.",
    )
    p.add_argument(
        "--no-audit",
        action="store_true",
        help="Skip the SQLite audit row.",
    )
    p.add_argument(
        "--json",
        action="store_true",
        help="Emit a single JSON object on stdout (machine-readable).",
    )
    return p


def main(argv: list[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)
    plan_path = Path(args.plan).resolve()
    source_spec_path = Path(args.source_spec).resolve() if args.source_spec else None

    out = run_dispatch(
        plan_path=plan_path,
        source_spec_path=source_spec_path,
        model_override=args.model,
        write_sidecar=not args.no_sidecar,
        audit=not args.no_audit,
        cwd=None,
    )

    if args.json:
        json.dump(out, sys.stdout, indent=2)
        sys.stdout.write("\n")
    else:
        status = out.get("status")
        print(f"Status:           {status}")
        print(f"Model:            {out.get('model')}")
        print(f"Run ID:           {out.get('run_id')}")
        if out.get("sidecar_path"):
            print(f"Sidecar:          {out['sidecar_path']}")
        if out.get("error"):
            print(f"Error:            {out['error']}")
        else:
            print(
                f"Findings:         {out['total_findings']} "
                f"(blocking={out['blocking_count']}, human-review={out['human_review_count']})"
            )
            print(f"Cost / duration:  ${out['cost_usd']:.4f} / {out['duration_s']:.1f}s")
            if out.get("synthesis"):
                print()
                print("Synthesis:")
                print(out["synthesis"])

    if out.get("status") == "error":
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
