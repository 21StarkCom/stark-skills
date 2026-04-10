#!/usr/bin/env python3
"""Validation gate: run lint/typecheck/test commands and report results.

CLI: python3 scripts/validation_gate.py [--json] [--repo-root PATH] [--timeout SECONDS]

Exit code is always 0; failures are reported in output only.
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

import config_loader
import emit_queue

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

_ALLOWED_DISCOVERY_COMMANDS = {"npm test", "pytest", "make test", "python3 -m pytest"}

_LOG_DIR = Path.home() / ".claude" / "code-review" / "logs"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _get_repo_name(repo_root: Path) -> str:
    """Return the repo name from git remote, or '_default' on failure."""
    try:
        result = subprocess.run(
            ["git", "remote", "get-url", "origin"],
            capture_output=True,
            text=True,
            timeout=10,
            cwd=str(repo_root),
        )
        if result.returncode == 0:
            url = result.stdout.strip()
            # Strip trailing .git, then take last path component
            if url.endswith(".git"):
                url = url[:-4]
            return url.rstrip("/").split("/")[-1]
    except Exception:
        pass
    return "_default"


def _discover_commands(repo_root: Path) -> dict[str, str | None]:
    """Auto-discover test command from repo root. Returns {'test_cmd': cmd|None}."""
    test_cmd: str | None = None

    if (repo_root / "package.json").exists():
        test_cmd = "npm test"
    elif (repo_root / "Makefile").exists():
        test_cmd = "make test"
    elif (repo_root / "pytest.ini").exists() or (repo_root / "pyproject.toml").exists():
        test_cmd = "pytest"

    if test_cmd is not None and test_cmd not in _ALLOWED_DISCOVERY_COMMANDS:
        # Should not happen given the candidates above, but guard anyway
        return {"test_cmd": None, "_security_rejected": test_cmd}  # type: ignore[return-value]

    return {"test_cmd": test_cmd}


def _run_check(
    name: str,
    command: str | None,
    repo_root: Path,
    timeout_s: int,
) -> dict:
    """Run a single check. Returns a result dict."""
    if not command:
        return {
            "name": name,
            "command": command,
            "passed": False,
            "duration_s": 0.0,
            "failure_pattern": "TEST_COMMAND_MISSING",
            "stdout": "",
            "stderr": "",
        }

    start = time.monotonic()
    try:
        proc = subprocess.run(
            command,
            shell=True,
            capture_output=True,
            text=True,
            timeout=timeout_s,
            cwd=str(repo_root),
        )
        duration_s = round(time.monotonic() - start, 3)
        passed = proc.returncode == 0
        if passed:
            failure_pattern = None
        else:
            if name == "lint":
                failure_pattern = "LINT_ERROR"
            elif name == "typecheck":
                failure_pattern = "TYPE_ERROR"
            else:
                failure_pattern = "TEST_FAILURE"
        return {
            "name": name,
            "command": command,
            "passed": passed,
            "duration_s": duration_s,
            "failure_pattern": failure_pattern,
            "stdout": proc.stdout,
            "stderr": proc.stderr,
        }
    except subprocess.TimeoutExpired:
        duration_s = round(time.monotonic() - start, 3)
        return {
            "name": name,
            "command": command,
            "passed": False,
            "duration_s": duration_s,
            "failure_pattern": "TIMEOUT",
            "stdout": "",
            "stderr": f"Command timed out after {timeout_s}s",
        }
    except Exception as exc:
        duration_s = round(time.monotonic() - start, 3)
        return {
            "name": name,
            "command": command,
            "passed": False,
            "duration_s": duration_s,
            "failure_pattern": "TEST_FAILURE",
            "stdout": "",
            "stderr": str(exc),
        }


def _write_stderr_log(checks: list[dict]) -> str:
    """Write combined stderr from all checks to a timestamped log file. Returns path."""
    _LOG_DIR.mkdir(parents=True, exist_ok=True)
    timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    log_path = _LOG_DIR / f"run-{timestamp}.stderr"

    combined = ""
    for check in checks:
        stderr = check.get("stderr", "")
        if stderr:
            combined += f"=== {check['name']} ({check['command']}) ===\n{stderr}\n"

    log_path.write_text(combined)
    return str(log_path)


def _emit(repo: str, checks: list[dict], overall: str) -> None:
    """Emit a validation_result event. Swallows all errors."""
    try:
        passed_count = sum(1 for c in checks if c["passed"])
        payload = {
            "repo": repo,
            "overall": overall,
            "check_count": len(checks),
            "passed_count": passed_count,
        }
        event = emit_queue.make_event("validation_result", payload)
        emit_queue.enqueue(event)
    except Exception:
        pass


# ---------------------------------------------------------------------------
# Main logic
# ---------------------------------------------------------------------------


def run_validation_gate(repo_root: Path, timeout_s: int) -> dict:
    """Run validation checks and return result dict."""
    repo = _get_repo_name(repo_root)

    # Load commands from config
    per_repo_commands: dict = (
        config_loader.load_config()
        .get("validation_gate", {})
        .get("per_repo_commands", {})
    )
    config_entry: dict | None = per_repo_commands.get(repo) or per_repo_commands.get("_default")

    checks: list[dict] = []

    if config_entry is not None:
        # Use config-defined commands
        lint_cmd = config_entry.get("lint_cmd") or None
        typecheck_cmd = config_entry.get("typecheck_cmd") or None
        test_cmd = config_entry.get("test_cmd") or None

        if lint_cmd:
            checks.append(_run_check("lint", lint_cmd, repo_root, timeout_s))
        if typecheck_cmd:
            checks.append(_run_check("typecheck", typecheck_cmd, repo_root, timeout_s))
        if test_cmd:
            checks.append(_run_check("test", test_cmd, repo_root, timeout_s))
    else:
        # Discovery mode
        discovered = _discover_commands(repo_root)
        security_rejected = discovered.pop("_security_rejected", None)

        test_cmd = discovered.get("test_cmd")

        if security_rejected:
            checks.append({
                "name": "test",
                "command": security_rejected,
                "passed": False,
                "duration_s": 0.0,
                "failure_pattern": "SECURITY_REJECTED",
                "stdout": "",
                "stderr": f"Discovered command '{security_rejected}' is not in the allowlist.",
            })
        elif test_cmd:
            checks.append(_run_check("test", test_cmd, repo_root, timeout_s))
        # else: no commands found — overall will be "pass" (nothing to fail)

    stderr_path = _write_stderr_log(checks)

    # Determine overall: pass if all non-None-command checks passed (or no checks ran)
    # A check with failure_pattern="TEST_COMMAND_MISSING" means command was None — skip those
    meaningful_checks = [c for c in checks if c.get("failure_pattern") != "TEST_COMMAND_MISSING"]
    if meaningful_checks:
        overall = "pass" if all(c["passed"] for c in meaningful_checks) else "fail"
    else:
        overall = "pass"

    _emit(repo, checks, overall)

    return {
        "repo": repo,
        "checks": [
            {
                "name": c["name"],
                "command": c["command"],
                "passed": c["passed"],
                "duration_s": c["duration_s"],
                "failure_pattern": c["failure_pattern"],
            }
            for c in checks
        ],
        "overall": overall,
        "stderr_path": stderr_path,
    }


def _print_table(result: dict) -> None:
    """Print a human-readable summary."""
    print(f"Validation gate — repo: {result['repo']}")
    print(f"Overall: {result['overall'].upper()}")
    print()
    checks = result["checks"]
    if not checks:
        print("  No checks ran (no commands configured or discovered).")
    else:
        col_w = 12
        print(f"  {'Check':<{col_w}} {'Cmd':<40} {'Passed':<8} {'Duration':>10} {'Pattern'}")
        print("  " + "-" * 80)
        for c in checks:
            status = "YES" if c["passed"] else "NO"
            cmd = (c["command"] or "")[:38]
            pattern = c["failure_pattern"] or ""
            print(f"  {c['name']:<{col_w}} {cmd:<40} {status:<8} {c['duration_s']:>8.2f}s {pattern}")
    print()
    print(f"Stderr log: {result['stderr_path']}")


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def main() -> None:
    parser = argparse.ArgumentParser(description="Validation gate: lint/typecheck/test runner")
    parser.add_argument("--json", action="store_true", help="Output JSON instead of table")
    parser.add_argument(
        "--repo-root",
        default=".",
        help="Root directory of the repo to validate (default: .)",
    )
    parser.add_argument(
        "--timeout",
        type=int,
        default=None,
        help="Override timeout in seconds (default: from config, fallback 60)",
    )
    args = parser.parse_args()

    repo_root = Path(args.repo_root).resolve()

    # Determine timeout: CLI arg > config > default
    if args.timeout is not None:
        timeout_s = args.timeout
    else:
        cfg = config_loader.get_validation_gate_config()
        timeout_s = int(cfg.get("timeout_seconds", 60))

    result = run_validation_gate(repo_root, timeout_s)

    if args.json:
        print(json.dumps(result, indent=2))
    else:
        _print_table(result)

    sys.exit(0)


if __name__ == "__main__":
    main()
