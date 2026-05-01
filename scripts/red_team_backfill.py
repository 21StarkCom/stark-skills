#!/usr/bin/env python3
"""Backfill local red-team SQLite audit rows into the stark-insights queue."""

from __future__ import annotations

import argparse
import json
import sqlite3
import sys
from pathlib import Path
from typing import Any, Callable, Iterable

import red_team_audit
import red_team_insights
import stark_red_team as rt

Scope = str
EnqueueFn = Callable[[dict[str, Any]], Any]


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(argv)
    db_path = Path(args.db)
    print(
        f"red-team backfill: scope={args.scope} db={db_path} "
        f"dry_run={args.dry_run} limit={args.limit if args.limit is not None else 'none'}",
        file=sys.stderr,
    )

    try:
        stats = run_backfill(
            db_path=db_path,
            scope=args.scope,
            limit=args.limit,
            dry_run=args.dry_run,
            manifest_path=Path(args.manifest) if args.manifest else None,
        )
    except Exception as exc:
        print(f"red-team backfill failed: {exc}", file=sys.stderr)
        return 1

    print(
        "red-team backfill complete: "
        f"rows={stats['rows']} skipped_rows={stats['skipped_rows']} "
        f"runs={stats['red_team_run']} findings={stats['red_team_finding']} "
        f"fix_plans={stats['red_team_fix_plan']} enqueued={stats['enqueued']} "
        f"duplicates={stats['duplicates']}",
        file=sys.stderr,
    )
    print(
        "Note: enqueue success means the local durable queue accepted the event; "
        "verify cloud insertion with a dedupe-key query against events.",
        file=sys.stderr,
    )
    return 0


def run_backfill(
    *,
    db_path: str | Path,
    scope: Scope = "legacy",
    limit: int | None = None,
    dry_run: bool = False,
    manifest_path: str | Path | None = None,
    enqueue_fn: EnqueueFn | None = None,
) -> dict[str, Any]:
    """Build and optionally enqueue historical red-team events."""
    if scope not in {"legacy", "forward", "all"}:
        raise ValueError(f"unsupported scope: {scope}")

    # Migration is intentionally first so pre-v1.2 databases gain repo and
    # fix-plan columns before the SELECT below references them.
    red_team_audit.init_red_team_tables(db_path)
    rows = _load_rows(db_path, scope=scope, limit=limit)
    enqueue = enqueue_fn or _default_enqueue
    stats: dict[str, Any] = {
        "rows": 0,
        "skipped_rows": 0,
        "red_team_run": 0,
        "red_team_finding": 0,
        "red_team_fix_plan": 0,
        "enqueued": 0,
        "duplicates": 0,
        "dedupe_keys": [],
    }

    for row in rows:
        try:
            envelopes = build_envelopes_for_row(row)
        except ValueError as exc:
            stats["skipped_rows"] += 1
            print(f"warning: skipping run_id={row['run_id']!r}: {exc}", file=sys.stderr)
            continue

        stats["rows"] += 1
        for envelope in envelopes:
            event_type = envelope["type"]
            stats[event_type] += 1
            stats["dedupe_keys"].append(envelope["dedupe_key"])
            if dry_run:
                continue
            result = enqueue(envelope)
            if result is None:
                stats["duplicates"] += 1
            else:
                stats["enqueued"] += 1

    if manifest_path is not None:
        _write_manifest(
            manifest_path,
            scope=scope,
            db_path=db_path,
            dry_run=dry_run,
            dedupe_keys=stats["dedupe_keys"],
        )
    return stats


def build_envelopes_for_row(row: dict[str, Any]) -> list[dict[str, Any]]:
    """Build all insight envelopes for one audit run row."""
    findings = list(row["findings"])
    repo = row.get("repo") or "unknown"
    timestamp = row["created_at"]
    fix_plan_status = row.get("fix_plan_status") or "absent_pre_v1_2"
    envelopes = [
        red_team_insights.build_run_envelope(
            run_id=row["run_id"],
            stage=row["stage"],
            repo=repo,
            artifact_relative_path=row.get("artifact_relative_path"),
            pr_number=row.get("pr_number"),
            model=row["model"],
            caller=row["caller"],
            final_status=row["final_status"],
            worst_severity=_worst_severity(row),
            passed=row["final_status"] == "clean",
            rounds_used=int(row["rounds_used"]),
            total_findings=int(row["total_findings"]),
            blocking_count=_blocking_count(findings),
            human_review_count=int(row["human_review_count"]),
            critical_count=int(row["critical_count"]),
            high_count=int(row["high_count"]),
            medium_count=int(row["medium_count"]),
            duration_s=float(row["duration_s"]),
            cost_usd=float(row["cost_usd"]),
            fix_plan_status=fix_plan_status,
            warnings=[],
            started_at_iso=timestamp,
        )
    ]

    for finding in findings:
        envelopes.append(
            red_team_insights.build_finding_envelope(
                run_id=row["run_id"],
                stage=row["stage"],
                repo=repo,
                pr_number=row.get("pr_number"),
                round_num=int(finding["round_num"]),
                finding_id=finding["finding_id"],
                persona=finding["persona"],
                severity=finding["severity"],
                concern=finding["concern"],
                consequence=finding["consequence"],
                counter_proposal=finding["counter_proposal"],
                trade_off=finding.get("trade_off"),
                reason_for_uncertainty=finding.get("reason_for_uncertainty"),
                is_human_review=finding["counter_proposal"] == rt.REQUEST_HUMAN_REVIEW,
                timestamp_iso=timestamp,
            )
        )

    if fix_plan_status == "success" and row.get("fix_plan_json") is not None:
        envelopes.append(_build_fix_plan_envelope(row, repo=repo, timestamp=timestamp))
    return envelopes


def _build_fix_plan_envelope(
    row: dict[str, Any],
    *,
    repo: str,
    timestamp: str,
) -> dict[str, Any]:
    try:
        fix_plan = json.loads(row["fix_plan_json"])
    except json.JSONDecodeError as exc:
        raise ValueError(f"malformed fix_plan_json: {exc}") from exc
    if not isinstance(fix_plan, dict):
        raise ValueError("malformed fix_plan_json: top-level value is not an object")
    if fix_plan.get("error") is not None:
        raise ValueError("success row has errored fix_plan_json")

    moves = _list_of_dicts(fix_plan.get("moves"), "moves")
    return red_team_insights.build_fix_plan_envelope(
        run_id=row["run_id"],
        stage=row["stage"],
        repo=repo,
        pr_number=row.get("pr_number"),
        model=str(fix_plan.get("model") or ""),
        reasoning_effort=str(fix_plan.get("reasoning_effort") or ""),
        summary=str(fix_plan.get("summary") or ""),
        notes=str(fix_plan.get("notes") or ""),
        moves=moves,
        move_count=len(moves),
        addressed_finding_ids=_addressed_ids(moves),
        unaddressed_finding_ids=_list_of_strs(
            fix_plan.get("unaddressed_finding_ids"), "unaddressed_finding_ids"
        ),
        orphan_finding_ids=_list_of_strs(
            fix_plan.get("orphan_finding_ids"), "orphan_finding_ids"
        ),
        input_truncated=bool(fix_plan.get("input_truncated", False)),
        input_omitted_finding_ids=_list_of_strs(
            fix_plan.get("input_omitted_finding_ids"),
            "input_omitted_finding_ids",
        ),
        warnings=_list_of_strs(fix_plan.get("warnings"), "warnings"),
        cost_usd=float(fix_plan.get("cost_usd") or 0.0),
        duration_s=float(fix_plan.get("duration_s") or 0.0),
        input_tokens=int(fix_plan.get("input_tokens") or 0),
        output_tokens=int(fix_plan.get("output_tokens") or 0),
        fix_plan_md=row.get("fix_plan_md") or "",
        timestamp_iso=timestamp,
    )


def _load_rows(
    db_path: str | Path,
    *,
    scope: Scope,
    limit: int | None,
) -> list[dict[str, Any]]:
    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    try:
        where = {
            "legacy": "WHERE fix_plan_status IS NULL",
            "forward": "WHERE fix_plan_status IS NOT NULL",
            "all": "",
        }[scope]
        limit_sql = "" if limit is None else " LIMIT ?"
        params: tuple[Any, ...] = () if limit is None else (limit,)
        run_rows = conn.execute(
            "SELECT run_id, stage, rounds_used, final_status, total_findings, "
            "critical_count, high_count, medium_count, human_review_count, "
            "duration_s, cost_usd, model, caller, created_at, repo, "
            "artifact_relative_path, pr_number, fix_plan_status, fix_plan_md, "
            "fix_plan_json, fix_plan_cost_usd "
            f"FROM red_team_runs {where} ORDER BY created_at, id{limit_sql}",
            params,
        ).fetchall()
        out: list[dict[str, Any]] = []
        for run_row in run_rows:
            data = dict(run_row)
            finding_rows = conn.execute(
                "SELECT round_num, finding_id, persona, severity, concern, "
                "consequence, counter_proposal, trade_off, reason_for_uncertainty "
                "FROM red_team_findings WHERE run_id = ? AND stage = ? "
                "ORDER BY round_num, id",
                (data["run_id"], data["stage"]),
            ).fetchall()
            data["findings"] = [dict(f) for f in finding_rows]
            out.append(data)
        return out
    finally:
        conn.close()


def _default_enqueue(envelope: dict[str, Any]) -> Any:
    from emit_queue import enqueue

    return enqueue(envelope)


def _write_manifest(
    path: str | Path,
    *,
    scope: Scope,
    db_path: str | Path,
    dry_run: bool,
    dedupe_keys: Iterable[str],
) -> None:
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "scope": scope,
        "db_path": str(db_path),
        "dry_run": dry_run,
        "dedupe_keys": list(dedupe_keys),
    }
    target.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def _worst_severity(row: dict[str, Any]) -> str | None:
    if int(row["critical_count"]):
        return "critical"
    if int(row["high_count"]):
        return "high"
    if int(row["medium_count"]):
        return "medium"
    return None


def _blocking_count(findings: list[dict[str, Any]]) -> int:
    return sum(
        1
        for finding in findings
        if finding["counter_proposal"] != rt.REQUEST_HUMAN_REVIEW
        and rt.SEVERITY_RANK.get(finding["severity"], 0) >= rt.SEVERITY_RANK["high"]
    )


def _addressed_ids(moves: list[dict[str, Any]]) -> list[str]:
    out: list[str] = []
    seen: set[str] = set()
    for move in moves:
        for finding_id in move.get("addressed_finding_ids") or []:
            if isinstance(finding_id, str) and finding_id not in seen:
                seen.add(finding_id)
                out.append(finding_id)
    return out


def _list_of_dicts(value: Any, field: str) -> list[dict[str, Any]]:
    if value is None:
        return []
    if not isinstance(value, list) or not all(isinstance(item, dict) for item in value):
        raise ValueError(f"malformed fix_plan_json: {field} must be a list of objects")
    return value


def _list_of_strs(value: Any, field: str) -> list[str]:
    if value is None:
        return []
    if not isinstance(value, list) or not all(isinstance(item, str) for item in value):
        raise ValueError(f"malformed fix_plan_json: {field} must be a list of strings")
    return value


def _parse_args(argv: list[str] | None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Backfill red-team SQLite audit rows into the stark-insights queue."
    )
    parser.add_argument("--dry-run", action="store_true", help="Build events without enqueueing.")
    parser.add_argument("--limit", type=int, help="Maximum red_team_runs rows to process.")
    parser.add_argument(
        "--db",
        default=str(red_team_audit.DEFAULT_DB_PATH),
        help="Path to forged_review_metrics.db.",
    )
    parser.add_argument(
        "--scope",
        choices=("all", "legacy", "forward"),
        default="legacy",
        help="Rows to backfill. Default: legacy.",
    )
    parser.add_argument(
        "--manifest",
        help="Write generated dedupe keys to this JSON file for rollback support.",
    )
    args = parser.parse_args(argv)
    if args.limit is not None and args.limit < 0:
        parser.error("--limit must be >= 0")
    return args


if __name__ == "__main__":
    raise SystemExit(main())
