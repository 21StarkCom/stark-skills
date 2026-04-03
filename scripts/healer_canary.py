#!/usr/bin/env python3
"""Healer canary rollout — promote/demote patterns, show status.

CLI:
    python3 scripts/healer_canary.py [--status] [--promote PATTERN_ID] [--demote PATTERN_ID] [--json]
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

HEALER_LOG = Path.home() / ".claude" / "code-review" / "healer.jsonl"
CIRCUIT_PATH = Path.home() / ".claude" / "code-review" / "healer-circuits.json"
CONFIG_PATH = Path.home() / ".claude" / "code-review" / "config.json"
PATTERNS_PATH = Path(__file__).parent / "healer_patterns.json"


# ---------------------------------------------------------------------------
# Data loading
# ---------------------------------------------------------------------------

def _load_patterns() -> list[dict]:
    try:
        return json.loads(PATTERNS_PATH.read_text())
    except Exception:
        return []


def _read_circuits() -> dict:
    try:
        return json.loads(CIRCUIT_PATH.read_text())
    except Exception:
        return {}


def _load_config() -> dict:
    try:
        return json.loads(CONFIG_PATH.read_text())
    except Exception:
        return {}


def _write_config(config: dict) -> None:
    CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
    CONFIG_PATH.write_text(json.dumps(config, indent=2))


def _load_log_entries() -> list[dict]:
    try:
        entries = []
        for line in HEALER_LOG.read_text().splitlines():
            try:
                entries.append(json.loads(line))
            except Exception:
                pass
        return entries
    except Exception:
        return []


# ---------------------------------------------------------------------------
# Stats
# ---------------------------------------------------------------------------

def _compute_stats(pattern_id: str, entries: list[dict], circuits: dict) -> dict:
    pattern_entries = [e for e in entries if e.get("pattern_id") == pattern_id]
    total = len(pattern_entries)
    successful_suggests = sum(1 for e in pattern_entries if e.get("status") == "suggested")
    applied = sum(1 for e in pattern_entries if e.get("status") == "applied")

    cutoff = datetime.now(timezone.utc) - timedelta(days=7)
    aborts_last_7d = 0
    for e in pattern_entries:
        if e.get("status") == "aborted":
            try:
                ts = datetime.fromisoformat(e["timestamp"].replace("Z", "+00:00"))
                if ts >= cutoff:
                    aborts_last_7d += 1
            except Exception:
                pass

    success_count = successful_suggests + applied
    success_rate = success_count / total if total > 0 else 0.0

    circuit_state = circuits.get(pattern_id, {})
    tripped_at = circuit_state.get("tripped_at")
    ever_tripped = circuit_state.get("ever_tripped", False)

    circuit_open = False
    if tripped_at:
        try:
            trip_time = datetime.fromisoformat(tripped_at.replace("Z", "+00:00"))
            if datetime.now(timezone.utc) - trip_time < timedelta(hours=24):
                circuit_open = True
        except Exception:
            pass

    return {
        "total_attempts": total,
        "successful_suggests": successful_suggests,
        "applied": applied,
        "aborts_last_7d": aborts_last_7d,
        "success_rate": round(success_rate, 2),
        "consecutive_failures": circuit_state.get("consecutive_failures", 0),
        "circuit_open": circuit_open,
        "ever_tripped": ever_tripped,
        "tripped_at": tripped_at,
    }


def _check_promotion_criteria(pattern: dict, stats: dict) -> list[str]:
    """Return list of unmet criteria. Empty list = eligible for promotion."""
    reasons = []
    if stats["successful_suggests"] < 5:
        reasons.append(
            f"requires >= 5 successful suggests (have {stats['successful_suggests']})"
        )
    if stats["aborts_last_7d"] > 0:
        reasons.append(
            f"has {stats['aborts_last_7d']} guard failure(s) in the last 7 days"
        )
    if stats["ever_tripped"]:
        reasons.append("circuit has been tripped")
    if pattern.get("requires_confirmation", False):
        reasons.append("requires_confirmation is true")
    return reasons


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _log(entry: dict) -> None:
    try:
        HEALER_LOG.parent.mkdir(parents=True, exist_ok=True)
        with HEALER_LOG.open("a") as f:
            f.write(json.dumps(entry) + "\n")
    except Exception:
        pass


def _emit_alert(level: str, message: str) -> None:
    try:
        from alert_delivery import emit_alert
        emit_alert(level, "healer_canary", message)
    except Exception:
        pass


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


# ---------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------

def cmd_status(args: argparse.Namespace) -> None:
    patterns = _load_patterns()
    circuits = _read_circuits()
    config = _load_config()
    auto_patterns = config.get("self_heal", {}).get("auto_patterns", [])
    entries = _load_log_entries()

    output = []
    for p in patterns:
        pid = p["id"]
        stats = _compute_stats(pid, entries, circuits)
        mode = "auto" if pid in auto_patterns else "suggest"
        circuit = "open" if stats["circuit_open"] else "closed"
        unmet = _check_promotion_criteria(p, stats)

        output.append({
            "id": pid,
            "mode": mode,
            "circuit": circuit,
            "consecutive_failures": stats["consecutive_failures"],
            "successful_suggests": stats["successful_suggests"],
            "total_attempts": stats["total_attempts"],
            "success_rate": stats["success_rate"],
            "eligible_for_promotion": mode == "suggest" and not unmet,
            "promotion_blockers": unmet if mode == "suggest" else [],
        })

    if args.json:
        print(json.dumps({"patterns": output}))
        return

    for row in output:
        circuit_flag = "OPEN  " if row["circuit"] == "open" else "closed"
        eligible = " [eligible]" if row["eligible_for_promotion"] else ""
        suggests_str = f"{row['successful_suggests']}/5 suggests"
        print(
            f"  {row['id']:30s}  mode={row['mode']:7s}  circuit={circuit_flag}"
            f"  {suggests_str}  rate={row['success_rate']:.0%}{eligible}"
        )


def cmd_promote(args: argparse.Namespace) -> None:
    pattern_id = args.promote
    patterns = _load_patterns()
    pattern = next((p for p in patterns if p["id"] == pattern_id), None)

    if pattern is None:
        print(f"Error: pattern '{pattern_id}' not found", file=sys.stderr)
        sys.exit(1)

    circuits = _read_circuits()
    entries = _load_log_entries()
    stats = _compute_stats(pattern_id, entries, circuits)

    unmet = _check_promotion_criteria(pattern, stats)
    if unmet:
        print(f"Cannot promote '{pattern_id}' — criteria not met:", file=sys.stderr)
        for reason in unmet:
            print(f"  - {reason}", file=sys.stderr)
        sys.exit(1)

    config = _load_config()
    if "self_heal" not in config:
        config["self_heal"] = {}
    auto_patterns = config["self_heal"].get("auto_patterns", [])

    if pattern_id in auto_patterns:
        msg = f"Pattern '{pattern_id}' is already in auto_patterns"
        if args.json:
            print(json.dumps({"promoted": pattern_id, "auto_patterns": auto_patterns, "note": msg}))
        else:
            print(msg)
        return

    auto_patterns.append(pattern_id)
    config["self_heal"]["auto_patterns"] = auto_patterns
    _write_config(config)

    _log({
        "timestamp": _now(),
        "event": "canary_promoted",
        "pattern_id": pattern_id,
        "mode": "auto",
    })
    _emit_alert("info", f"Pattern {pattern_id} promoted to auto-mode")

    if args.json:
        print(json.dumps({"promoted": pattern_id, "auto_patterns": auto_patterns}))
    else:
        print(f"Promoted '{pattern_id}' to auto-mode.")


def cmd_demote(args: argparse.Namespace) -> None:
    pattern_id = args.demote

    config = _load_config()
    if "self_heal" not in config:
        config["self_heal"] = {}
    auto_patterns = config["self_heal"].get("auto_patterns", [])

    if pattern_id not in auto_patterns:
        msg = f"Pattern '{pattern_id}' is not in auto_patterns"
        if args.json:
            print(json.dumps({"demoted": pattern_id, "auto_patterns": auto_patterns, "note": msg}))
        else:
            print(msg)
        return

    auto_patterns.remove(pattern_id)
    config["self_heal"]["auto_patterns"] = auto_patterns
    _write_config(config)

    _log({
        "timestamp": _now(),
        "event": "canary_demoted",
        "pattern_id": pattern_id,
        "mode": "suggest",
    })
    _emit_alert("info", f"Pattern {pattern_id} demoted to suggest-mode")

    if args.json:
        print(json.dumps({"demoted": pattern_id, "auto_patterns": auto_patterns}))
    else:
        print(f"Demoted '{pattern_id}' to suggest-mode.")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(description="Healer canary rollout management")
    parser.add_argument("--status", action="store_true", help="Show pattern status (default)")
    parser.add_argument("--promote", metavar="PATTERN_ID", help="Promote pattern to auto-mode")
    parser.add_argument("--demote", metavar="PATTERN_ID", help="Demote pattern to suggest-mode")
    parser.add_argument("--json", dest="json", action="store_true", help="Output JSON")
    args = parser.parse_args()

    if args.promote:
        cmd_promote(args)
    elif args.demote:
        cmd_demote(args)
    else:
        cmd_status(args)


if __name__ == "__main__":
    main()
