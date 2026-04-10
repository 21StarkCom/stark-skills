#!/usr/bin/env python3
"""Backfill historical review data into baseline and skill-usage reports.

CLI:
    python3 scripts/backfill_history.py [--dry-run] [--since YYYY-MM-DD]

Scans ~/.claude/code-review/history/ for existing review JSON files and
produces two outputs:
  - ~/.claude/code-review/history/baselines.json  — review metrics baselines
  - ~/.claude/code-review/history/skill-usage.json — skill invocation frequencies

Both outputs are idempotent: re-running overwrites with fresh data.
"""
from __future__ import annotations

import argparse
import json
import sys
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

HISTORY_DIR = Path.home() / ".claude" / "code-review" / "history"
BASELINES_PATH = HISTORY_DIR / "baselines.json"
SKILL_USAGE_PATH = HISTORY_DIR / "skill-usage.json"


# ---------------------------------------------------------------------------
# File scanning
# ---------------------------------------------------------------------------

def scan_history_files(since: str | None = None) -> list[Path]:
    """Return all rounds.json files in HISTORY_DIR, optionally filtered by mtime date."""
    if not HISTORY_DIR.is_dir():
        return []

    files: list[Path] = []
    for f in HISTORY_DIR.rglob("rounds.json"):
        if since is not None:
            mtime = datetime.fromtimestamp(f.stat().st_mtime).strftime("%Y-%m-%d")
            if mtime < since:
                continue
        files.append(f)

    return sorted(files)


def _scan_runs_files(since: str | None = None) -> list[Path]:
    """Return all run JSON files from history/runs/."""
    runs_dir = HISTORY_DIR / "runs"
    if not runs_dir.is_dir():
        return []

    files: list[Path] = []
    for f in sorted(runs_dir.glob("*.json")):
        if since is not None:
            mtime = datetime.fromtimestamp(f.stat().st_mtime).strftime("%Y-%m-%d")
            if mtime < since:
                continue
        files.append(f)
    return files


# ---------------------------------------------------------------------------
# Metric extraction from a single rounds.json
# ---------------------------------------------------------------------------

def extract_metrics(data: dict, path: Path) -> dict:
    """Extract baseline metrics from a PR review rounds.json payload."""
    total_findings = 0
    by_agent: dict[str, int] = defaultdict(int)
    by_domain: dict[str, int] = defaultdict(int)
    review_duration_s = 0.0

    rounds = data.get("rounds", [])
    if isinstance(rounds, list):
        for rnd in rounds:
            if not isinstance(rnd, dict):
                continue
            for result in rnd.get("results", []):
                if not isinstance(result, dict):
                    continue
                agent = result.get("agent", "")
                domain = result.get("domain", "")
                duration = result.get("duration_s", 0.0)

                # findings may be a list or a count
                findings_raw = result.get("findings", [])
                if isinstance(findings_raw, list):
                    count = len(findings_raw)
                else:
                    count = int(result.get("findings_count", 0))

                total_findings += count
                if agent:
                    by_agent[agent] += count
                if domain:
                    by_domain[domain] += count
                review_duration_s += float(duration) if duration else 0.0

    # Also handle top-level findings dict (format A)
    findings_data = data.get("findings")
    if isinstance(findings_data, dict) and total_findings == 0:
        total_findings = findings_data.get("total_raw", 0)

    return {
        "total_findings": total_findings,
        "by_agent": dict(by_agent),
        "by_domain": dict(by_domain),
        "review_duration_s": review_duration_s,
    }


# ---------------------------------------------------------------------------
# Baseline generation
# ---------------------------------------------------------------------------

def generate_baseline(
    dry_run: bool = False,
    since: str | None = None,
) -> dict:
    """Scan history, compute aggregate baselines, and write baselines.json.

    Returns the baseline dict regardless of dry_run.
    """
    files = scan_history_files(since=since)

    total_reviews = 0
    total_findings = 0
    total_duration_s = 0.0
    by_agent: Counter = Counter()
    by_domain: Counter = Counter()

    for path in files:
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue

        if not isinstance(data, dict):
            continue

        metrics = extract_metrics(data, path)
        total_reviews += 1
        total_findings += metrics["total_findings"]
        total_duration_s += metrics["review_duration_s"]
        by_agent.update(metrics["by_agent"])
        by_domain.update(metrics["by_domain"])

    baseline = {
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "total_reviews": total_reviews,
        "total_findings": total_findings,
        "avg_duration_s": round(total_duration_s / total_reviews, 2) if total_reviews else 0.0,
        "by_agent": dict(by_agent),
        "by_domain": dict(by_domain),
    }

    if not dry_run:
        BASELINES_PATH.parent.mkdir(parents=True, exist_ok=True)
        BASELINES_PATH.write_text(json.dumps(baseline, indent=2), encoding="utf-8")

    return baseline


# ---------------------------------------------------------------------------
# Skill usage generation
# ---------------------------------------------------------------------------

def generate_skill_usage(
    dry_run: bool = False,
    since: str | None = None,
) -> dict:
    """Scan history/runs/ for skill invocation patterns and write skill-usage.json.

    Returns the usage dict regardless of dry_run.
    """
    run_files = _scan_runs_files(since=since)

    by_skill: Counter = Counter()
    total_runs = 0

    for path in run_files:
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue

        if not isinstance(data, dict):
            continue

        skill = data.get("skill", "").strip()
        if skill:
            by_skill[skill] += 1
            total_runs += 1

    usage = {
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "total_runs": total_runs,
        "by_skill": dict(by_skill),
    }

    if not dry_run:
        SKILL_USAGE_PATH.parent.mkdir(parents=True, exist_ok=True)
        SKILL_USAGE_PATH.write_text(json.dumps(usage, indent=2), encoding="utf-8")

    return usage


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(
        description="Backfill historical review data into baselines and skill-usage reports."
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Show what would be processed; do not write files.",
    )
    parser.add_argument(
        "--since",
        metavar="YYYY-MM-DD",
        help="Only process files modified on or after this date.",
    )
    args = parser.parse_args()

    if not HISTORY_DIR.is_dir():
        print(f"No history directory found at {HISTORY_DIR}", file=sys.stderr)
        sys.exit(0)

    baseline = generate_baseline(dry_run=args.dry_run, since=args.since)
    usage = generate_skill_usage(dry_run=args.dry_run, since=args.since)

    mode = "[dry-run] " if args.dry_run else ""
    print(f"{mode}Reviews scanned:  {baseline['total_reviews']}")
    print(f"{mode}Total findings:   {baseline['total_findings']}")
    print(f"{mode}Skill runs found: {usage['total_runs']}")
    if not args.dry_run:
        print(f"Wrote: {BASELINES_PATH}")
        print(f"Wrote: {SKILL_USAGE_PATH}")


if __name__ == "__main__":
    main()
