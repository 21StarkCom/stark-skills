#!/usr/bin/env python3
"""Pre-flight environment validation for stark-skills workflows.

Runs named checks and returns a structured result indicating whether the
environment is ready, degraded, or blocked for a given workflow.

Usage:
    python3 scripts/preflight.py --workflow autopilot --json
    python3 scripts/preflight.py --workflow review
    python3 scripts/preflight.py --workflow review --skip-check check_working_dir
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable

# Ensure scripts/ is on path when run directly.
sys.path.insert(0, str(Path(__file__).parent))

from config_loader import get_models_config, is_agent_enabled
import emit_queue
import github_app
import lock_helpers

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------

LOG_PATH = Path.home() / ".claude" / "code-review" / "preflight.jsonl"
HARD_STOP_PATH = Path.home() / ".claude" / "code-review" / "cost-hard-stop"

TOTAL_TIMEOUT_S = 30

# ---------------------------------------------------------------------------
# Data classes
# ---------------------------------------------------------------------------


@dataclass
class CheckResult:
    name: str
    status: str        # "pass" | "warn" | "fail" | "skip"
    message: str
    duration_s: float


@dataclass
class PreFlightResult:
    workflow: str
    overall: str       # "ready" | "degraded" | "blocked"
    checks: list[dict]
    recommended_mode: str
    timestamp: str


# ---------------------------------------------------------------------------
# Subprocess helper
# ---------------------------------------------------------------------------


def _run_cmd(args: list[str], timeout: int = 5) -> tuple[bool, str]:
    """Run a command; return (success, stdout/stderr snippet)."""
    try:
        result = subprocess.run(
            args,
            capture_output=True,
            text=True,
            timeout=timeout,
        )
        if result.returncode == 0:
            return True, (result.stdout.strip() or "ok")
        return False, (result.stderr.strip() or result.stdout.strip() or "non-zero exit")
    except subprocess.TimeoutExpired:
        return False, f"timed out after {timeout}s"
    except FileNotFoundError:
        return False, f"not found: {args[0]}"
    except Exception as exc:
        return False, str(exc)


def _timed(fn: Callable[[], tuple[str, str]]) -> tuple[str, str, float]:
    """Call fn() and return (status, message, elapsed_s)."""
    t0 = time.monotonic()
    status, message = fn()
    return status, message, round(time.monotonic() - t0, 3)


# ---------------------------------------------------------------------------
# Individual checks
# ---------------------------------------------------------------------------


def check_cli_claude() -> tuple[str, str]:
    ok, out = _run_cmd(["claude", "--version"], timeout=5)
    return ("pass", out) if ok else ("fail", out)


def check_cli_codex() -> tuple[str, str]:
    ok, out = _run_cmd(["codex", "--version"], timeout=5)
    return ("pass", out) if ok else ("fail", out)


def check_cli_gemini() -> tuple[str, str]:
    if not is_agent_enabled("gemini"):
        return "skip", "gemini disabled in config"
    ok, out = _run_cmd(["gemini", "--version"], timeout=5)
    return ("pass", out) if ok else ("fail", out)


def check_keychain_claude() -> tuple[str, str]:
    ok, out = _run_cmd(
        ["security", "find-generic-password", "-s", "STARK_CLAUDE_PRIVATE_KEY", "-w"],
        timeout=5,
    )
    return ("pass", "key found") if ok else ("fail", f"keychain: {out}")


def check_keychain_codex() -> tuple[str, str]:
    ok, out = _run_cmd(
        ["security", "find-generic-password", "-s", "STARK_CODEX_PRIVATE_KEY", "-w"],
        timeout=5,
    )
    return ("pass", "key found") if ok else ("fail", f"keychain: {out}")


def check_keychain_gemini() -> tuple[str, str]:
    if not is_agent_enabled("gemini"):
        return "skip", "gemini disabled in config"
    ok, out = _run_cmd(
        ["security", "find-generic-password", "-s", "STARK_GEMINI_PRIVATE_KEY", "-w"],
        timeout=5,
    )
    return ("pass", "key found") if ok else ("fail", f"keychain: {out}")


def check_github_app() -> tuple[str, str]:
    try:
        token = github_app.get_token()
        return ("pass", "token obtained") if token else ("fail", "empty token returned")
    except SystemExit as exc:
        return "fail", f"get_token() exited: {exc}"
    except Exception as exc:
        return "fail", str(exc)


def check_working_dir() -> tuple[str, str]:
    ok, out = _run_cmd(["git", "status", "--porcelain"], timeout=5)
    if not ok:
        return "warn", f"git status failed: {out}"
    if out.strip():
        return "warn", "working directory has uncommitted changes"
    return "pass", "clean"


def check_model_resolution() -> tuple[str, str]:
    models = get_models_config()
    expected = ["claude", "codex"]
    missing = [a for a in expected if a not in models]
    if missing:
        return "fail", f"missing agent config: {missing}"
    enabled = sorted(
        agent
        for agent, cfg in models.items()
        if isinstance(cfg, dict) and cfg.get("enabled")
    )
    if not enabled:
        return "fail", "no enabled agents in config"
    disabled = sorted(
        agent
        for agent, cfg in models.items()
        if isinstance(cfg, dict) and not cfg.get("enabled")
    )
    if disabled:
        return "pass", f"enabled agents: {enabled}; disabled agents: {disabled}"
    return "pass", f"enabled agents: {enabled}"


def check_cost_hard_stop() -> tuple[str, str]:
    if HARD_STOP_PATH.exists():
        return "fail", f"cost hard-stop active ({HARD_STOP_PATH})"
    return "pass", "no hard stop"


def check_deprecated_config() -> tuple[str, str]:
    """Warn if org/repo overrides still contain deprecated model_pins key."""
    try:
        from config_loader import load_config
        config = load_config()
    except Exception as exc:
        return "warn", f"could not load config: {exc}"

    automation = config.get("automation", {})
    if isinstance(automation, dict) and "model_pins" in automation:
        return (
            "warn",
            "automation.model_pins found in org/repo config override — "
            "remove it; use the 'models' block instead",
        )
    return "pass", "no deprecated config keys"


def check_stale_locks() -> tuple[str, str]:
    """Scan known lock locations for stale lock files."""
    lock_dirs = [
        Path.home() / ".claude" / "code-review",
        Path("/tmp"),
    ]
    stale: list[str] = []
    for lock_dir in lock_dirs:
        if not lock_dir.exists():
            continue
        for lock_file in lock_dir.glob("*.lock"):
            if lock_helpers.is_lock_stale(str(lock_file)):
                stale.append(str(lock_file))

    if stale:
        return "warn", f"stale lock files: {', '.join(stale)}"
    return "pass", "no stale locks"


# ---------------------------------------------------------------------------
# Check registry: (name, fn, is_critical)
# critical=True → a "fail" status sets overall to "blocked"
# ---------------------------------------------------------------------------

_CHECKS: list[tuple[str, Callable[[], tuple[str, str]], bool]] = [
    ("check_cli_claude",       check_cli_claude,       False),
    ("check_cli_codex",        check_cli_codex,        False),
    ("check_cli_gemini",       check_cli_gemini,       False),
    ("check_keychain_claude",  check_keychain_claude,  True),
    ("check_keychain_codex",   check_keychain_codex,   True),
    ("check_keychain_gemini",  check_keychain_gemini,  True),
    ("check_github_app",       check_github_app,       True),
    ("check_working_dir",      check_working_dir,      False),
    ("check_model_resolution", check_model_resolution, True),
    ("check_cost_hard_stop",       check_cost_hard_stop,       True),
    ("check_stale_locks",          check_stale_locks,          False),
    ("check_deprecated_config",    check_deprecated_config,    False),
]


# ---------------------------------------------------------------------------
# Core runner
# ---------------------------------------------------------------------------


def run_preflight(workflow: str, skip: set[str] | None = None) -> PreFlightResult:
    """Run all registered checks and aggregate into a PreFlightResult."""
    skip = skip or set()
    results: list[CheckResult] = []
    has_critical_fail = False
    has_noncritical_degraded = False

    for name, fn, is_critical in _CHECKS:
        if name in skip:
            print(f"  [SKIP-OVERRIDE] {name}", file=sys.stderr)
            results.append(
                CheckResult(name=name, status="skip",
                            message="skipped via --skip-check", duration_s=0.0)
            )
            continue

        status, message, duration_s = _timed(fn)
        results.append(CheckResult(name=name, status=status,
                                   message=message, duration_s=duration_s))

        if status == "fail":
            if is_critical:
                has_critical_fail = True
            else:
                has_noncritical_degraded = True
        elif status == "warn":
            has_noncritical_degraded = True

    if has_critical_fail:
        overall = "blocked"
        recommended_mode = "abort"
    elif has_noncritical_degraded:
        overall = "degraded"
        recommended_mode = "single-agent"
    else:
        overall = "ready"
        recommended_mode = "full"

    return PreFlightResult(
        workflow=workflow,
        overall=overall,
        checks=[asdict(r) for r in results],
        recommended_mode=recommended_mode,
        timestamp=datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    )


# ---------------------------------------------------------------------------
# Logging & event emission
# ---------------------------------------------------------------------------


def _log_result(result: PreFlightResult) -> None:
    """Append the result as a JSON line to the preflight log."""
    LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
    try:
        with LOG_PATH.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(asdict(result)) + "\n")
    except OSError as exc:
        print(f"preflight: warning: failed to write log: {exc}", file=sys.stderr)


def _emit_event(result: PreFlightResult) -> None:
    """Emit a preflight_check event to the durable queue."""
    try:
        event = emit_queue.make_event(
            "preflight_check",
            {
                "workflow": result.workflow,
                "overall": result.overall,
                "recommended_mode": result.recommended_mode,
                "checks": result.checks,
            },
        )
        emit_queue.enqueue(event)
    except Exception as exc:
        print(f"preflight: warning: failed to emit event: {exc}", file=sys.stderr)


# ---------------------------------------------------------------------------
# Human-readable output
# ---------------------------------------------------------------------------

_STATUS_SYMBOL = {"pass": "✓", "fail": "✗", "warn": "⚠", "skip": "–"}
_OVERALL_LABEL = {"ready": "READY", "degraded": "DEGRADED", "blocked": "BLOCKED"}


def _print_table(result: PreFlightResult) -> None:
    label = _OVERALL_LABEL.get(result.overall, result.overall.upper())
    print(f"\nPreflight: {result.workflow}  [{label}]")
    print(f"{'Check':<30} {'St':<5} {'Message'}")
    print("-" * 72)
    for check in result.checks:
        sym = _STATUS_SYMBOL.get(check["status"], "?")
        dur = f"({check['duration_s']:.3f}s)" if check["duration_s"] > 0 else ""
        print(f"{check['name']:<30} {sym} {check['status']:<5}  "
              f"{check['message']} {dur}".rstrip())
    print("-" * 72)
    print(f"Recommended mode: {result.recommended_mode}")
    print()


# ---------------------------------------------------------------------------
# CLI entry point
# ---------------------------------------------------------------------------


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Stark preflight environment validator"
    )
    parser.add_argument(
        "--workflow", default="default",
        help="Workflow name (used in log and event payload)"
    )
    parser.add_argument(
        "--json", action="store_true",
        help="Output PreFlightResult as JSON instead of a table"
    )
    parser.add_argument(
        "--skip-check", action="append", default=[], metavar="NAME",
        help="Skip a named check (repeatable, logs override to stderr)"
    )
    args = parser.parse_args()

    skip = set(args.skip_check)
    result = run_preflight(args.workflow, skip=skip)

    _log_result(result)
    _emit_event(result)

    if args.json:
        print(json.dumps(asdict(result), indent=2))
    else:
        _print_table(result)

    if result.overall == "blocked":
        sys.exit(1)


if __name__ == "__main__":
    main()
