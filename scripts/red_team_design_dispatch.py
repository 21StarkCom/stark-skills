"""CLI dispatcher for /stark-red-team-design — adversarial design-doc challenge.

Thin wrapper over `stark_red_team.run_red_team(stage="design", ...)` for
ad-hoc invocation against a design markdown file. Mirrors the call shape used
by `forge_orchestrator.run_red_team_design_stage` but bypasses the
`stages.design.enabled` gate (manual invocation is explicit) and writes a
human-readable sidecar markdown next to the design.

Usage:
    python3 red_team_design_dispatch.py \\
        --design path/to/design.md \\
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
from pathlib import Path
from typing import Any

import stark_red_team as rt
from red_team_dispatch_common import (
    execute_dispatch,
    final_status,
    render_sidecar_markdown as _render_sidecar_markdown,
    sidecar_commit_message,
    truncate_pr_comment,
)


def _read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def _final_status(result: rt.RedTeamResult) -> str:
    return final_status(result)


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
        db_path = red_team_audit.resolve_db_path()
        red_team_audit.init_red_team_tables(db_path)
        red_team_audit.record_red_team_run({
            "run_id": run_id,
            "stage": "design",
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
        }, db_path=db_path)
        if result.findings:
            red_team_audit.record_findings([
                {
                    "run_id": run_id,
                    "stage": "design",
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
            ], db_path=db_path)
    except Exception:
        # Audit must never break the dispatcher.
        pass


def render_sidecar_markdown(
    *,
    design_path: Path,
    source_spec_path: Path | None,
    result: rt.RedTeamResult,
    model: str,
    run_id: str,
    fix_plan_status: str | None = None,
    fix_plan: rt.RedTeamFixPlan | None = None,
) -> str:
    """Build the human-readable `<design>.red-team.md` sidecar."""
    return _render_sidecar_markdown(
        artifact_path=design_path,
        source_spec_path=source_spec_path,
        result=result,
        model=model,
        run_id=run_id,
        stage="design",
        fix_plan_status=fix_plan_status,
        fix_plan=fix_plan,
    )


def run_dispatch(
    *,
    design_path: Path,
    source_spec_path: Path | None,
    model_override: str | None,
    write_sidecar: bool,
    audit: bool,
    cwd: str | None,
    enable_fix_plan_for_calibration: bool = False,
    replay_transcript: Path | None = None,
) -> dict[str, Any]:
    """Run the red-team and return a dict shaped for the skill."""
    return execute_dispatch(
        stage="design",
        artifact_path=design_path,
        source_spec_path=source_spec_path,
        model_override=model_override,
        write_sidecar=write_sidecar,
        audit=audit,
        cwd=cwd,
        enable_fix_plan_for_calibration=enable_fix_plan_for_calibration,
        replay_transcript=replay_transcript,
    )


def _build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="red_team_design_dispatch",
        description="Adversarial red-team review of a design doc.",
    )
    p.add_argument("--design", required=True, help="Path to the design markdown file.")
    p.add_argument(
        "--source-spec",
        default=None,
        help="Optional source-spec file. Defaults to using the design as its own spec.",
    )
    p.add_argument(
        "--model",
        default=None,
        help="Override the configured red-team model (default from red_team.model).",
    )
    p.add_argument(
        "--no-sidecar",
        action="store_true",
        help="Skip writing the <design>.red-team.md sidecar.",
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
    p.add_argument(
        "--enable-fix-plan-for-calibration",
        action="store_true",
        help="Dispatcher-only calibration override for red_team.fix_plan.enabled.",
    )
    p.add_argument(
        "--accept-red-team-human-review",
        action="append",
        default=[],
        metavar="STABLE_KEY",
        help=(
            "Accept a human-review halt by stable key before running. May "
            "be repeated. Each key triggers an interactive confirmation "
            "unless --no-confirm is set. After acceptance, the matching "
            "human-review finding will not halt this run or future runs."
        ),
    )
    p.add_argument(
        "--no-confirm",
        action="store_true",
        help="Skip the interactive accept confirmation (for scripted use).",
    )
    p.add_argument(
        "--replay-transcript",
        metavar="PATH",
        default=None,
        help=(
            "Phase 1 deterministic seam — bypass the live Codex / Responses "
            "API call and feed the recorded transcript through the parsing "
            "/ aggregation / audit-write / sidecar path. Documented in "
            "docs/specs/red-team-cli-contract-2026-05-16.md."
        ),
    )
    return p


def main(argv: list[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)
    # Phase 0 wiring: non-blocking credential smoke. Failures log to stderr
    # so the operator sees a missing Keychain entry before the run halts on
    # a token-mint error later. Phase 1 promotes this to a hard gate.
    try:
        from red_team_audit_cli import preflight_credentials_smoke
        preflight_credentials_smoke()
    except Exception:
        pass
    design_path = Path(args.design).resolve()
    source_spec_path = Path(args.source_spec).resolve() if args.source_spec else None

    # FU-rt8 — Accept any human-review halts before dispatching. Failed
    # accepts (unknown key, non-human-review key) abort the run so the
    # operator sees the error before paying for an LLM call.
    #
    # PR-#430 round-3 fix #5: route confirmation/match output to stderr so
    # ``--accept-red-team-human-review ... --json`` still produces a single
    # parseable JSON object on stdout.
    if args.accept_red_team_human_review:
        from red_team_accept import accept_one
        for key in args.accept_red_team_human_review:
            rc = accept_one(
                key,
                note=None,
                accepted_by=None,
                confirm=not args.no_confirm,
                out=sys.stderr,
            )
            if rc != 0:
                return rc

    out = run_dispatch(
        design_path=design_path,
        source_spec_path=source_spec_path,
        model_override=args.model,
        write_sidecar=not args.no_sidecar,
        audit=not args.no_audit,
        cwd=None,
        enable_fix_plan_for_calibration=args.enable_fix_plan_for_calibration,
        replay_transcript=Path(args.replay_transcript).resolve() if args.replay_transcript else None,
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
