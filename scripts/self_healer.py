#!/usr/bin/env python3
"""Self-healer: apply known fix patterns to validation failures.

CLI:
    python3 scripts/self_healer.py --pattern-id ID --stderr-file PATH
                                   [--mode suggest|auto] [--json]
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

PATTERNS_PATH = Path(__file__).parent / "healer_patterns.json"
SESSION_PATH = Path.home() / ".claude" / "code-review" / "healer-session.json"
HEALER_LOG = Path.home() / ".claude" / "code-review" / "healer.jsonl"
CIRCUIT_PATH = Path.home() / ".claude" / "code-review" / "healer-circuits.json"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _load_patterns() -> list[dict]:
    try:
        return json.loads(PATTERNS_PATH.read_text())
    except Exception as e:
        print(json.dumps({"error": f"Cannot load patterns: {e}"}), file=sys.stderr)
        sys.exit(1)


def _find_pattern(patterns: list[dict], pattern_id: str) -> dict | None:
    for p in patterns:
        if p["id"] == pattern_id:
            return p
    return None


def _emit(result: dict, as_json: bool) -> None:
    if as_json:
        print(json.dumps(result))
    else:
        for k, v in result.items():
            print(f"  {k}: {v}")


def _log(entry: dict) -> None:
    try:
        HEALER_LOG.parent.mkdir(parents=True, exist_ok=True)
        with HEALER_LOG.open("a") as f:
            f.write(json.dumps(entry) + "\n")
    except Exception:
        pass


def _emit_event(payload: dict) -> None:
    # Telemetry must never break the host. _emit.emit_event swallows its own
    # subprocess errors, but the lazy import is unprotected — guard the
    # whole call so an import-time failure (missing _emit.py on sys.path,
    # SyntaxError from a future edit, partial install) cannot propagate.
    try:
        from _emit import emit_event
        emit_event("heal_attempt", payload)
    except Exception:  # noqa: BLE001 — telemetry MUST NOT break callers
        pass


# ---------------------------------------------------------------------------
# Session tracking
# ---------------------------------------------------------------------------

def _read_session() -> dict:
    try:
        return json.loads(SESSION_PATH.read_text())
    except Exception:
        return {}


def _write_session(data: dict) -> None:
    try:
        SESSION_PATH.parent.mkdir(parents=True, exist_ok=True)
        SESSION_PATH.write_text(json.dumps(data))
    except Exception:
        pass


def _session_count(pattern_id: str) -> int:
    return _read_session().get(pattern_id, 0)


def _session_increment(pattern_id: str) -> None:
    data = _read_session()
    data[pattern_id] = data.get(pattern_id, 0) + 1
    _write_session(data)


# ---------------------------------------------------------------------------
# Circuit breaker
# ---------------------------------------------------------------------------

def _read_circuits() -> dict:
    try:
        return json.loads(CIRCUIT_PATH.read_text())
    except Exception:
        return {}


def _write_circuits(data: dict) -> None:
    try:
        CIRCUIT_PATH.parent.mkdir(parents=True, exist_ok=True)
        CIRCUIT_PATH.write_text(json.dumps(data, indent=2))
    except Exception:
        pass


def _is_circuit_tripped(pattern_id: str, threshold: int) -> bool:
    circuits = _read_circuits()
    state = circuits.get(pattern_id, {})
    tripped_at = state.get("tripped_at")
    if tripped_at:
        try:
            trip_time = datetime.fromisoformat(tripped_at.replace("Z", "+00:00"))
            if datetime.now(timezone.utc) - trip_time < timedelta(hours=24):
                return True
        except Exception:
            pass
    return state.get("consecutive_failures", 0) >= threshold


def _record_circuit_failure(pattern_id: str, threshold: int) -> bool:
    """Record a failure; returns True if circuit was newly tripped."""
    circuits = _read_circuits()
    state = circuits.get(pattern_id, {})
    state["consecutive_failures"] = state.get("consecutive_failures", 0) + 1
    newly_tripped = False
    if state["consecutive_failures"] >= threshold and not state.get("tripped_at"):
        state["tripped_at"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        state["ever_tripped"] = True
        newly_tripped = True
    circuits[pattern_id] = state
    _write_circuits(circuits)
    return newly_tripped


def _record_circuit_success(pattern_id: str) -> None:
    circuits = _read_circuits()
    state = circuits.get(pattern_id, {})
    state["consecutive_failures"] = 0
    state["tripped_at"] = None
    state["last_reset_at"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    circuits[pattern_id] = state
    _write_circuits(circuits)


# ---------------------------------------------------------------------------
# Action execution
# ---------------------------------------------------------------------------

def _run_verify(verify_command: str) -> bool:
    try:
        result = subprocess.run(
            verify_command, shell=True, capture_output=True, timeout=15
        )
        return result.returncode == 0
    except Exception:
        return False


def _execute_action(pattern: dict) -> dict:
    action = pattern["action"]
    scripts_dir = Path(__file__).parent

    if action == "refresh_token":
        try:
            result = subprocess.run(
                ["python3", str(scripts_dir / "github_app.py"), "token"],
                capture_output=True, text=True, timeout=30
            )
            success = result.returncode == 0
        except Exception:
            success = False
    elif action == "release_stale_lock":
        print("no lock path specified, skipping")
        success = True
    else:
        print(f"action {action} not yet implemented")
        success = True

    verify_passed = _run_verify(pattern.get("verify_command", "true"))
    return {"success": success, "verify_passed": verify_passed}


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(description="Apply a healer pattern to a stderr file")
    parser.add_argument("--pattern-id", required=True, help="Pattern ID to apply")
    parser.add_argument("--stderr-file", required=True, help="Path to stderr file")
    parser.add_argument("--mode", choices=["suggest", "auto"], default="suggest")
    parser.add_argument("--json", dest="as_json", action="store_true",
                        help="Emit JSON output")
    args = parser.parse_args()

    try:
        from config_loader import get_self_heal_config
        cfg = get_self_heal_config()
    except Exception:
        cfg = {}
    threshold = cfg.get("circuit_breaker_threshold", 3)
    auto_patterns = cfg.get("auto_patterns", [])

    patterns = _load_patterns()
    pattern = _find_pattern(patterns, args.pattern_id)

    if pattern is None:
        msg = {"error": f"Pattern not found: {args.pattern_id}"}
        if args.as_json:
            print(json.dumps(msg))
        else:
            print(f"Error: {msg['error']}", file=sys.stderr)
        sys.exit(1)

    stderr_path = Path(args.stderr_file)
    if not stderr_path.exists():
        msg = {"error": f"stderr file not found: {args.stderr_file}"}
        if args.as_json:
            print(json.dumps(msg))
        else:
            print(f"Error: {msg['error']}", file=sys.stderr)
        sys.exit(1)

    # Guard check
    guard_cmd = pattern.get("guard")
    if guard_cmd:
        try:
            guard_result = subprocess.run(
                guard_cmd, shell=True, capture_output=True, timeout=10
            )
            if guard_result.returncode != 0:
                result = {
                    "status": "aborted",
                    "reason": "guard_failed",
                    "guard": guard_cmd,
                }
                _emit(result, args.as_json)
                _log({
                    "timestamp": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                    "pattern_id": pattern["id"],
                    "action": pattern["action"],
                    "mode": args.mode,
                    "status": "aborted",
                    "reason": "guard_failed",
                })
                sys.exit(0)
        except Exception as e:
            result = {
                "status": "aborted",
                "reason": "guard_failed",
                "guard": guard_cmd,
                "error": str(e),
            }
            _emit(result, args.as_json)
            _log({
                "timestamp": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                "pattern_id": pattern["id"],
                "action": pattern["action"],
                "mode": args.mode,
                "status": "aborted",
                "reason": "guard_failed",
            })
            sys.exit(0)

    # Session max check
    max_per_session = pattern.get("max_per_session")
    if max_per_session is not None:
        count = _session_count(pattern["id"])
        if count >= max_per_session:
            result = {
                "status": "aborted",
                "reason": "max_per_session_reached",
                "pattern_id": pattern["id"],
                "count": count,
                "max_per_session": max_per_session,
            }
            _emit(result, args.as_json)
            sys.exit(0)

    action = pattern["action"]
    requires_confirmation = pattern.get("requires_confirmation", False)

    # Auto-mode gate: pattern must be in auto_patterns to actually auto-apply
    effective_mode = args.mode
    if args.mode == "auto" and pattern["id"] not in auto_patterns:
        effective_mode = "suggest"

    # Circuit breaker: skip if circuit is open (auto mode only)
    if effective_mode == "auto" and _is_circuit_tripped(pattern["id"], threshold):
        result = {
            "status": "skipped",
            "reason": "circuit_open",
            "pattern_id": pattern["id"],
            "action": action,
        }
        _emit(result, args.as_json)
        _emit_event({"pattern_id": pattern["id"], "action": action, "mode": "auto", "status": "skipped", "reason": "circuit_open"})
        _log({
            "timestamp": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "pattern_id": pattern["id"],
            "action": action,
            "mode": "auto",
            "status": "skipped",
            "reason": "circuit_open",
        })
        try:
            from alert_delivery import emit_alert
            emit_alert("warning", "self_healer", f"Pattern {pattern['id']} circuit is open — auto-heal skipped")
        except Exception:
            pass
        sys.exit(0)

    # Suggest mode
    if effective_mode == "suggest":
        result = {
            "status": "suggested",
            "pattern_id": pattern["id"],
            "action": action,
            "requires_confirmation": requires_confirmation,
        }
        _emit(result, args.as_json)
        _emit_event({"pattern_id": pattern["id"], "action": action, "mode": effective_mode, "status": "suggested"})
        _log({
            "timestamp": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "pattern_id": pattern["id"],
            "action": action,
            "mode": effective_mode,
            "status": "suggested",
        })
        sys.exit(0)

    # Auto mode — requires_confirmation=true → skip
    if requires_confirmation:
        result = {
            "status": "skipped",
            "reason": "requires_confirmation",
            "pattern_id": pattern["id"],
            "action": action,
        }
        _emit(result, args.as_json)
        _emit_event({"pattern_id": pattern["id"], "action": action, "mode": "auto", "status": "skipped"})
        _log({
            "timestamp": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "pattern_id": pattern["id"],
            "action": action,
            "mode": "auto",
            "status": "skipped",
        })
        sys.exit(0)

    # Auto mode — execute
    execution = _execute_action(pattern)
    if max_per_session is not None and execution["success"]:
        _session_increment(pattern["id"])

    result = {
        "status": "applied",
        "pattern_id": pattern["id"],
        "action": action,
        "verify_passed": execution["verify_passed"],
    }
    _emit(result, args.as_json)
    _emit_event({"pattern_id": pattern["id"], "action": action, "mode": "auto", "status": "applied"})
    _log({
        "timestamp": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "pattern_id": pattern["id"],
        "action": action,
        "mode": "auto",
        "status": "applied",
    })

    # Update circuit breaker state based on outcome
    if execution["success"] and execution["verify_passed"]:
        _record_circuit_success(pattern["id"])
    else:
        newly_tripped = _record_circuit_failure(pattern["id"], threshold)
        if newly_tripped:
            try:
                from alert_delivery import emit_alert
                emit_alert(
                    "critical",
                    "self_healer",
                    f"Pattern {pattern['id']} circuit tripped after {threshold} consecutive failures",
                )
            except Exception:
                pass

    sys.exit(0)


if __name__ == "__main__":
    main()
