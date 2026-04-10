#!/usr/bin/env python3
"""Extract corrections and constraints from structured signals.

CLI:
    python3 scripts/learning_capture.py [--json] [--since YYYY-MM-DD]

Signal sources (structured events, NOT conversation transcripts):
  - ~/.claude/code-review/healer.jsonl   — heal attempts
  - ~/.claude/code-review/history/       — review findings
  - ~/.claude/code-review/preflight.jsonl — preflight failures
"""
from __future__ import annotations

import argparse
import json
import sys
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------

CODE_REVIEW_DIR = Path.home() / ".claude" / "code-review"
HEALER_LOG = CODE_REVIEW_DIR / "healer.jsonl"
HISTORY_DIR = CODE_REVIEW_DIR / "history"
PREFLIGHT_LOG = CODE_REVIEW_DIR / "preflight.jsonl"
STAGED_DIR = CODE_REVIEW_DIR / "staged"

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

_PREFLIGHT_OK_STATUSES = {"ok", "pass", "success", "skipped"}
_RECURRING_THRESHOLD = 3  # strictly greater than this


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _parse_since(since_str: str | None) -> datetime | None:
    if since_str is None:
        return None
    return datetime.fromisoformat(since_str).replace(tzinfo=timezone.utc)


def _parse_ts(ts_str: str | None) -> datetime | None:
    """Parse an ISO timestamp string into a timezone-aware datetime, or None."""
    if not ts_str:
        return None
    try:
        dt = datetime.fromisoformat(ts_str.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt
    except (ValueError, AttributeError):
        return None


def _after_since(ts_str: str | None, since: datetime | None) -> bool:
    """Return True if ts_str is >= since (or since is None)."""
    if since is None:
        return True
    dt = _parse_ts(ts_str)
    if dt is None:
        return True  # can't filter, include it
    return dt >= since


# ---------------------------------------------------------------------------
# Signal readers
# ---------------------------------------------------------------------------

def _read_healer(since: datetime | None) -> tuple[list[dict], int]:
    """Read healer.jsonl. Returns (lines, filtered_lines_count)."""
    lines: list[dict] = []
    total = 0
    if not HEALER_LOG.exists():
        return lines, total
    try:
        with HEALER_LOG.open() as f:
            for raw in f:
                raw = raw.strip()
                if not raw:
                    continue
                try:
                    obj = json.loads(raw)
                except json.JSONDecodeError:
                    continue
                if _after_since(obj.get("timestamp"), since):
                    lines.append(obj)
                    total += 1
    except OSError:
        pass
    return lines, total


def _read_preflight(since: datetime | None) -> tuple[list[dict], int]:
    """Read preflight.jsonl. Returns (lines, filtered_lines_count)."""
    lines: list[dict] = []
    total = 0
    if not PREFLIGHT_LOG.exists():
        return lines, total
    try:
        with PREFLIGHT_LOG.open() as f:
            for raw in f:
                raw = raw.strip()
                if not raw:
                    continue
                try:
                    obj = json.loads(raw)
                except json.JSONDecodeError:
                    continue
                if _after_since(obj.get("timestamp"), since):
                    lines.append(obj)
                    total += 1
    except OSError:
        pass
    return lines, total


def _read_history(since: datetime | None) -> tuple[dict[str, dict], int]:
    """Scan HISTORY_DIR for rounds.json files and count domain findings.

    Applies --since filter via file mtime (YYYY-MM-DD string comparison).
    For each rounds.json, counts domains that have at least one finding.

    Returns:
        domain_counts: dict mapping domain → {occurrences, last_seen ISO string}
        files_read: total number of rounds.json files processed
    """
    domain_counts: dict[str, dict] = {}
    files_read = 0

    if not HISTORY_DIR.is_dir():
        return domain_counts, files_read

    since_date = since.strftime("%Y-%m-%d") if since is not None else None

    for path in HISTORY_DIR.rglob("rounds.json"):
        st = path.stat()
        mtime_date = datetime.fromtimestamp(st.st_mtime).strftime("%Y-%m-%d")
        if since_date is not None and mtime_date < since_date:
            continue

        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue

        if not isinstance(data, dict):
            continue

        files_read += 1
        mtime_iso = datetime.fromtimestamp(
            st.st_mtime, tz=timezone.utc
        ).strftime("%Y-%m-%dT%H:%M:%SZ")

        rounds = data.get("rounds", [])
        if not isinstance(rounds, list):
            continue

        for rnd in rounds:
            if not isinstance(rnd, dict):
                continue
            for result in rnd.get("results", []):
                if not isinstance(result, dict):
                    continue
                domain = result.get("domain", "")
                if not domain:
                    continue
                findings = result.get("findings", [])
                if not isinstance(findings, list) or len(findings) == 0:
                    continue
                if domain not in domain_counts:
                    domain_counts[domain] = {"occurrences": 0, "last_seen": ""}
                domain_counts[domain]["occurrences"] += 1
                if mtime_iso > domain_counts[domain]["last_seen"]:
                    domain_counts[domain]["last_seen"] = mtime_iso

    return domain_counts, files_read


# ---------------------------------------------------------------------------
# Analysis
# ---------------------------------------------------------------------------

def _extract_patterns(healer_lines: list[dict]) -> list[dict]:
    """Extract recurring patterns from healer log.

    Only pattern_ids that appear >3 times (strictly) are included.
    """
    # Count total occurrences and applied counts per pattern_id
    occurrences: dict[str, int] = defaultdict(int)
    applied: dict[str, int] = defaultdict(int)
    last_seen: dict[str, str] = {}

    for entry in healer_lines:
        pid = entry.get("pattern_id")
        if not pid:
            continue
        occurrences[pid] += 1
        if entry.get("status") == "applied":
            applied[pid] += 1
        ts = entry.get("timestamp")
        if ts:
            prev = last_seen.get(pid)
            if prev is None or ts > prev:
                last_seen[pid] = ts

    patterns: list[dict] = []
    for pid, count in occurrences.items():
        if count > _RECURRING_THRESHOLD:
            patterns.append({
                "pattern_id": pid,
                "action": _latest_action(pid, healer_lines),
                "occurrences": count,
                "applied_count": applied[pid],
                "last_seen": last_seen.get(pid, ""),
            })

    # Sort deterministically: descending occurrences, then pattern_id
    patterns.sort(key=lambda p: (-p["occurrences"], p["pattern_id"]))
    return patterns


def _latest_action(pattern_id: str, healer_lines: list[dict]) -> str:
    """Return the most recent action for a pattern_id."""
    action = ""
    last_ts = ""
    for entry in healer_lines:
        if entry.get("pattern_id") != pattern_id:
            continue
        ts = entry.get("timestamp", "")
        act = entry.get("action", "")
        if ts >= last_ts and act:
            last_ts = ts
            action = act
    return action


def _extract_constraints(preflight_lines: list[dict]) -> list[dict]:
    """Extract constraints from preflight failures.

    Group by (check, message). Include entries where status is not in ok set.
    Only include groups that appear >3 times (strictly).
    """
    # key: (check, message) → {occurrences, last_seen}
    groups: dict[tuple[str, str], dict] = {}

    for entry in preflight_lines:
        status = entry.get("status", "")
        if str(status).lower() in _PREFLIGHT_OK_STATUSES:
            continue

        check = entry.get("check", "")
        message = entry.get("message", "")
        key = (check, message)

        if key not in groups:
            groups[key] = {"occurrences": 0, "last_seen": ""}
        groups[key]["occurrences"] += 1
        ts = entry.get("timestamp", "")
        if ts and ts > groups[key]["last_seen"]:
            groups[key]["last_seen"] = ts

    constraints: list[dict] = []
    for (check, message), info in groups.items():
        if info["occurrences"] > _RECURRING_THRESHOLD:
            constraints.append({
                "source": "preflight",
                "check": check,
                "message": message,
                "occurrences": info["occurrences"],
                "last_seen": info["last_seen"],
            })

    constraints.sort(key=lambda c: (-c["occurrences"], c["check"]))
    return constraints


# ---------------------------------------------------------------------------
# Staged file generation
# ---------------------------------------------------------------------------

def _write_staged(constraints: list[dict], patterns: list[dict]) -> None:
    STAGED_DIR.mkdir(parents=True, exist_ok=True)
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    constraints_path = STAGED_DIR / "constraints.json"
    constraints_path.write_text(
        json.dumps({"generated_at": now, "constraints": constraints}, indent=2)
    )

    patterns_path = STAGED_DIR / "patterns.json"
    patterns_path.write_text(
        json.dumps({"generated_at": now, "patterns": patterns}, indent=2)
    )


# ---------------------------------------------------------------------------
# Event emission
# ---------------------------------------------------------------------------

def _emit_event(payload: dict) -> None:
    try:
        import emit_queue
        event = emit_queue.make_event("learning_capture", payload)
        emit_queue.enqueue(event)
    except Exception:
        pass


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(
        description="Extract corrections and constraints from structured signals"
    )
    parser.add_argument("--json", dest="as_json", action="store_true",
                        help="Emit payload as JSON to stdout")
    parser.add_argument("--since", metavar="YYYY-MM-DD",
                        help="Only process signals on or after this date")
    args = parser.parse_args()

    since = _parse_since(args.since)

    healer_lines, healer_total = _read_healer(since)
    preflight_lines, preflight_total = _read_preflight(since)
    domain_counts, history_files_read = _read_history(since)

    patterns = _extract_patterns(healer_lines)
    constraints = _extract_constraints(preflight_lines)

    # Merge history-sourced recurring domains as additional pattern entries
    for domain, info in domain_counts.items():
        if info["occurrences"] > _RECURRING_THRESHOLD:
            patterns.append({
                "pattern_id": f"review:{domain}",
                "action": "address_finding",
                "occurrences": info["occurrences"],
                "applied_count": 0,
                "last_seen": info["last_seen"],
            })

    # Re-sort after adding history patterns
    patterns.sort(key=lambda p: (-p["occurrences"], p["pattern_id"]))

    _write_staged(constraints, patterns)

    payload = {
        "constraints_count": len(constraints),
        "patterns_count": len(patterns),
        "healer_lines_read": healer_total,
        "preflight_lines_read": preflight_total,
        "history_files_read": history_files_read,
    }

    _emit_event(payload)

    if args.as_json:
        print(json.dumps(payload))
    else:
        print(f"Constraints found : {len(constraints)}")
        print(f"Patterns found    : {len(patterns)}")
        print(f"Healer lines read : {healer_total}")
        print(f"Preflight lines   : {preflight_total}")
        print(f"History files read: {history_files_read}")
        if constraints:
            print("\nTop constraints:")
            for c in constraints[:5]:
                print(f"  [{c['occurrences']}x] {c['check']}: {c['message']}")
        if patterns:
            print("\nTop patterns:")
            for p in patterns[:5]:
                print(f"  [{p['occurrences']}x, applied={p['applied_count']}] {p['pattern_id']} -> {p['action']}")


if __name__ == "__main__":
    main()
