"""CLI for accepting red-team human-review halts (FU-rt8).

Used both as a standalone command (``red_team_accept.py STABLE_KEY``) and
via the ``--accept-red-team-human-review`` flag on the design / plan
dispatchers (which delegate the actual work here for behavior parity).

The acceptance flow:

1. Look up the stable key in the audit DB so the operator can see the
   matched concern *before* committing to the accept. The FU-rt7
   invariant — "operator confirms identity, not slot" — depends on this.
2. Print the matched finding's concern excerpt + severity + persona +
   round to stdout.
3. Optionally pause for confirmation when running interactively
   (``--no-confirm`` skips when scripting).
4. Persist one ``red_team_human_review_accepts`` row per accepted key.

The persisted accepts are honored by ``red_team_dispatch_common`` on the
next dispatcher invocation: any human-review finding whose stable_key
matches an accept row no longer counts toward the halt decision.
"""

from __future__ import annotations

import argparse
import sys
from typing import Sequence

import red_team_human_review


def _format_finding(meta: dict) -> str:
    """Pretty-print one finding so the operator can confirm identity."""
    lines = [
        f"  stable_key:  {meta['stable_key']}",
        f"  run_id:      {meta['run_id']}",
        f"  stage:       {meta['stage']}",
        f"  round_num:   {meta['round_num']}",
        f"  persona:     {meta['persona']}",
        f"  finding_id:  {meta['finding_id']}",
        f"  severity:    {meta['severity']}",
        "",
        "  Concern:",
    ]
    for paragraph in (meta.get("concern_excerpt") or "").splitlines() or ["(no excerpt stored)"]:
        lines.append(f"    {paragraph}")
    return "\n".join(lines)


def accept_one(
    stable_key: str,
    *,
    note: str | None,
    accepted_by: str | None,
    confirm: bool,
    out=sys.stdout,
) -> int:
    """Accept one stable key. Returns exit code (0 success, non-zero failure)."""
    meta = red_team_human_review.lookup_finding_metadata(stable_key)
    if meta is None:
        print(
            f"red_team_accept: no finding with stable_key={stable_key!r}",
            file=sys.stderr,
        )
        return 2
    if meta["counter_proposal"] != "REQUEST_HUMAN_REVIEW":
        print(
            f"red_team_accept: stable_key={stable_key!r} is not a human-review "
            f"finding (counter_proposal={meta['counter_proposal']!r})",
            file=sys.stderr,
        )
        return 2

    print("Matched human-review finding:", file=out)
    print(_format_finding(meta), file=out)
    print("", file=out)

    if confirm and sys.stdin.isatty():
        ans = input("Accept this finding? [y/N] ").strip().lower()
        if ans not in {"y", "yes"}:
            print("red_team_accept: cancelled", file=out)
            return 1

    red_team_human_review.accept_finding(
        stable_key,
        run_id=meta["run_id"],
        stage=meta["stage"],
        round_num=meta["round_num"],
        persona=meta["persona"],
        finding_id=meta["finding_id"],
        concern_hash=meta["concern_hash"],
        concern_excerpt=meta.get("concern_excerpt"),
        repo=meta.get("repo"),
        accepted_by=accepted_by,
        note=note,
    )
    print(f"red_team_accept: accepted {stable_key}", file=out)
    return 0


def _build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="red_team_accept",
        description=(
            "Accept a red-team human-review halt by stable key. Subsequent "
            "dispatcher runs will not halt on the same concern."
        ),
    )
    p.add_argument(
        "stable_keys",
        nargs="+",
        metavar="STABLE_KEY",
        help="One or more red-team stable keys to accept.",
    )
    p.add_argument(
        "--note",
        default=None,
        help="Optional free-text note recorded with the acceptance.",
    )
    p.add_argument(
        "--accepted-by",
        default=None,
        help="Override the recorded operator identity (defaults to $USER).",
    )
    p.add_argument(
        "--no-confirm",
        action="store_true",
        help="Skip the interactive confirmation prompt (for scripted use).",
    )
    return p


def main(argv: Sequence[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)
    rc = 0
    for key in args.stable_keys:
        result = accept_one(
            key,
            note=args.note,
            accepted_by=args.accepted_by,
            confirm=not args.no_confirm,
        )
        if result != 0:
            rc = result
    return rc


if __name__ == "__main__":
    raise SystemExit(main())
