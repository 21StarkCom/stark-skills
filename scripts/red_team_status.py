"""CLI for displaying pending red-team human-review halts (FU-rt8).

Lists every human-review finding the operator has not yet accepted via
``red_team_accept`` so a single command answers "what is blocking me?".

Usage:

  python3 red_team_status.py                       # everything pending
  python3 red_team_status.py --repo Evinced/foo    # one repo
  python3 red_team_status.py --stage design        # one stage
  python3 red_team_status.py --json                # machine-readable

The display is read-only — it never mutates state. Acceptance happens via
``red_team_accept.py``.
"""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import asdict
from typing import Sequence

import red_team_human_review


def _format_human(halts: list, out=sys.stdout) -> None:
    if not halts:
        print("red_team_status: no pending human-review halts", file=out)
        return
    print(
        f"red_team_status: {len(halts)} pending human-review halts",
        file=out,
    )
    for h in halts:
        excerpt = (h.concern_excerpt or "").replace("\n", " ").strip()
        if len(excerpt) > 140:
            excerpt = excerpt[:137] + "..."
        repo_segment = f"  repo={h.repo}" if h.repo else ""
        pr_segment = f"  pr={h.pr_number}" if h.pr_number else ""
        path_segment = (
            f"  artifact={h.artifact_relative_path}"
            if h.artifact_relative_path
            else ""
        )
        print("", file=out)
        print(f"- stable_key: {h.stable_key}", file=out)
        print(
            f"  run_id={h.run_id}  stage={h.stage}  round={h.round_num}"
            f"  persona={h.persona}  finding_id={h.finding_id}"
            f"{repo_segment}{pr_segment}{path_segment}",
            file=out,
        )
        if excerpt:
            print(f"  concern: {excerpt}", file=out)


def _format_json(halts: list, out=sys.stdout) -> None:
    json.dump([asdict(h) for h in halts], out, indent=2, sort_keys=True)
    out.write("\n")


def _build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="red_team_status",
        description=(
            "List pending red-team human-review halts. Use red_team_accept "
            "to acknowledge them by stable_key."
        ),
    )
    p.add_argument("--repo", default=None, help="Filter to one repo (nameWithOwner).")
    p.add_argument("--stage", default=None, choices=("design", "plan"), help="Filter by stage.")
    p.add_argument("--json", action="store_true", help="Emit JSON instead of human text.")
    p.add_argument(
        "--db",
        default=None,
        help=(
            "Audit DB path override. Defaults to the canonical resolver "
            "(scripts/red_team_audit_cli.py resolve-db)."
        ),
    )
    return p


def main(argv: Sequence[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)
    from red_team_audit import resolve_db_path
    db_path = resolve_db_path(args.db)
    halts = red_team_human_review.list_pending_halts(
        repo=args.repo, stage=args.stage, db_path=db_path,
    )
    if args.json:
        _format_json(halts)
    else:
        _format_human(halts)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
