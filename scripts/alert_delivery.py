#!/usr/bin/env python3
"""Alert delivery — emit, check, and acknowledge operational alerts.

Usage:
    python3 scripts/alert_delivery.py [--check] [--json]

emit_alert(level, source, message) — log alert; critical level also creates a marker file.
check_alerts()                     — return unacknowledged alerts (marker files).
acknowledge_alert(marker_path)     — remove a marker file.
"""
from __future__ import annotations

import argparse
import json
import time
from datetime import datetime, timezone
from pathlib import Path

# ---------------------------------------------------------------------------
# Paths (module-level constants so tests can patch them)
# ---------------------------------------------------------------------------

_BASE = Path.home() / ".claude" / "code-review"
ALERTS_PATH = _BASE / "alerts.jsonl"
MARKERS_DIR = _BASE  # marker files live alongside other state files


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _now_str() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _append_jsonl(path: Path, entry: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as f:
        f.write(json.dumps(entry) + "\n")


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def emit_alert(level: str, source: str, message: str) -> None:
    """Log an alert.

    Args:
        level:   "info", "warning", or "critical"
        source:  subsystem that generated the alert (e.g. "cost_controls")
        message: human-readable description
    """
    entry = {
        "timestamp": _now_str(),
        "level": level,
        "source": source,
        "message": message,
    }
    _append_jsonl(ALERTS_PATH, entry)

    if level == "critical":
        # Create a marker file so --check can surface it until acknowledged
        ts = int(time.time())
        marker = MARKERS_DIR / f"alert-{ts}.marker"
        MARKERS_DIR.mkdir(parents=True, exist_ok=True)
        # If two criticals land in the same second, append a counter
        counter = 0
        while marker.exists():
            counter += 1
            marker = MARKERS_DIR / f"alert-{ts}-{counter}.marker"
        marker.touch()


def acknowledge_alert(marker_path: str | Path) -> None:
    """Remove a marker file, acknowledging the alert."""
    p = Path(marker_path)
    if p.exists():
        p.unlink()


def check_alerts() -> dict:
    """Return all unacknowledged alerts (marker files that exist).

    Returns:
        {"unacknowledged": [{"path": str}, ...]}
    """
    markers_dir = MARKERS_DIR
    unacknowledged = []
    if markers_dir.exists():
        for marker in sorted(markers_dir.glob("alert-*.marker")):
            unacknowledged.append({"path": str(marker)})
    return {"unacknowledged": unacknowledged}


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description="Alert delivery — check unacknowledged alerts")
    parser.add_argument("--check", action="store_true", help="Show unacknowledged alerts")
    parser.add_argument("--json", action="store_true", dest="as_json", help="Output JSON")
    args = parser.parse_args(argv)

    result = check_alerts()
    if args.as_json:
        print(json.dumps(result))
    else:
        n = len(result["unacknowledged"])
        if n == 0:
            print("No unacknowledged alerts.")
        else:
            print(f"{n} unacknowledged alert(s):")
            for item in result["unacknowledged"]:
                print(f"  {item['path']}")


if __name__ == "__main__":
    main()
