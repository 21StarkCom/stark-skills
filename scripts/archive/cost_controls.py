#!/usr/bin/env python3
"""Cost tracking, alert thresholds, and hard-stop enforcement.

Usage:
    python3 scripts/cost_controls.py [--check] [--reset] [--json]

record_cost(cost_usd, source) — called from other scripts to log a spend entry.
check_costs(...)              — evaluate rolling spend against configured limits.
reset_costs(...)              — clear hard-stop file and log the reset.
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone, timedelta
from pathlib import Path

# Allow importing from the parent scripts/ directory
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

# ---------------------------------------------------------------------------
# Paths (module-level constants so tests can patch them)
# ---------------------------------------------------------------------------

_BASE = Path.home() / ".claude" / "code-review"
COST_TRACKING_PATH = _BASE / "cost-tracking.jsonl"
ALERTS_PATH = _BASE / "alerts.jsonl"
HARD_STOP_PATH = _BASE / "cost-hard-stop"
AUDIT_PATH = _BASE / "cost-audit.jsonl"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _now_str() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _parse_ts(ts: str) -> datetime:
    """Parse an ISO8601 UTC timestamp string, returning a timezone-aware datetime."""
    try:
        return datetime.strptime(ts, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
    except ValueError:
        return datetime.now(timezone.utc)


def _append_jsonl(path: Path, entry: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as f:
        f.write(json.dumps(entry) + "\n")


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def record_cost(cost_usd: float, source: str) -> None:
    """Append a cost entry to cost-tracking.jsonl."""
    _append_jsonl(COST_TRACKING_PATH, {
        "timestamp": _now_str(),
        "cost_usd": cost_usd,
        "source": source,
    })


def check_costs(
    *,
    tracking_path: Path | None = None,
    alerts_path: Path | None = None,
    hard_stop_path: Path | None = None,
    config: dict | None = None,
) -> dict:
    """Compute rolling cost totals and enforce alert/hard-stop thresholds.

    Returns:
        {
            daily_usd: float,
            weekly_usd: float,
            budget_remaining_usd: float,
            alert_level: "ok" | "warning" | "critical" | "hard_stop",
        }
    """
    if tracking_path is None:
        tracking_path = COST_TRACKING_PATH
    if alerts_path is None:
        alerts_path = ALERTS_PATH
    if hard_stop_path is None:
        hard_stop_path = HARD_STOP_PATH
    if config is None:
        from config_loader import get_cost_config
        config = get_cost_config()

    weekly_budget = float(config.get("weekly_budget_usd", 50.0))
    daily_alert = float(config.get("daily_alert_usd", 15.0))
    hard_stop = float(config.get("hard_stop_usd", 100.0))

    now = datetime.now(timezone.utc)
    day_ago = now - timedelta(hours=24)
    week_ago = now - timedelta(days=7)

    daily_usd = 0.0
    weekly_usd = 0.0

    if tracking_path.exists():
        for line in tracking_path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                entry = json.loads(line)
            except json.JSONDecodeError:
                continue
            cost = float(entry.get("cost_usd", 0))
            ts = _parse_ts(entry.get("timestamp", ""))
            if ts >= day_ago:
                daily_usd += cost
            if ts >= week_ago:
                weekly_usd += cost

    budget_remaining = weekly_budget - weekly_usd

    # Determine alert level
    if weekly_usd > hard_stop:
        alert_level = "hard_stop"
        hard_stop_path.parent.mkdir(parents=True, exist_ok=True)
        hard_stop_path.touch(exist_ok=True)
        _append_jsonl(alerts_path, {
            "timestamp": _now_str(),
            "level": "critical",
            "source": "cost_controls",
            "message": f"Weekly spend ${weekly_usd:.2f} exceeds hard_stop_usd ${hard_stop:.2f}",
        })
    elif daily_usd > daily_alert:
        if daily_usd > hard_stop:
            alert_level = "critical"
        else:
            alert_level = "warning"
        _append_jsonl(alerts_path, {
            "timestamp": _now_str(),
            "level": alert_level,
            "source": "cost_controls",
            "message": f"Daily spend ${daily_usd:.2f} exceeds daily_alert_usd ${daily_alert:.2f}",
        })
    else:
        alert_level = "ok"

    return {
        "daily_usd": round(daily_usd, 6),
        "weekly_usd": round(weekly_usd, 6),
        "budget_remaining_usd": round(budget_remaining, 6),
        "alert_level": alert_level,
    }


def reset_costs(
    *,
    hard_stop_path: Path | None = None,
    audit_path: Path | None = None,
) -> dict:
    """Remove cost-hard-stop file and log the reset to the audit trail."""
    if hard_stop_path is None:
        hard_stop_path = HARD_STOP_PATH
    if audit_path is None:
        audit_path = AUDIT_PATH

    removed = hard_stop_path.exists()
    if removed:
        hard_stop_path.unlink()

    entry = {
        "timestamp": _now_str(),
        "action": "reset",
        "hard_stop_file_removed": removed,
    }
    _append_jsonl(audit_path, entry)

    return {"status": "reset", "hard_stop_file_removed": removed}


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description="Cost controls — check and reset spend limits")
    parser.add_argument("--check", action="store_true", help="Check rolling costs")
    parser.add_argument("--reset", action="store_true", help="Remove hard-stop file")
    parser.add_argument("--json", action="store_true", dest="as_json", help="Output JSON")
    args = parser.parse_args(argv)

    if args.reset:
        result = reset_costs()
        if args.as_json:
            print(json.dumps(result))
        else:
            removed = result["hard_stop_file_removed"]
            print(f"Cost hard-stop reset. File {'removed' if removed else 'was not present'}.")
        return

    # Default: --check
    result = check_costs()
    if args.as_json:
        print(json.dumps(result))
    else:
        level = result["alert_level"]
        print(f"Alert level : {level}")
        print(f"Daily spend : ${result['daily_usd']:.4f}")
        print(f"Weekly spend: ${result['weekly_usd']:.4f}")
        print(f"Budget left : ${result['budget_remaining_usd']:.4f}")


if __name__ == "__main__":
    main()
