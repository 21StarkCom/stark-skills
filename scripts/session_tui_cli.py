#!/usr/bin/env python3
"""CLI entry point for session TUI rendering.

Bridges SKILL.md invocation to Python rendering. Collects data from
git/gh/config with enforced timeouts, sanitizes inputs, constructs
TypedDicts, calls render functions, prints to stdout.

Usage:
    python3 scripts/session_tui_cli.py start [flags]
    python3 scripts/session_tui_cli.py end [flags]
"""
from __future__ import annotations

import argparse
import json
import logging
import os
import re
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Any

# Allow importing sibling modules when run from any location
sys.path.insert(0, str(Path(__file__).resolve().parent))

from tui_core import TUIConfig, make_config, sanitize_text  # noqa: E402
from session_tui import (  # noqa: E402
    AlertInfo,
    BannerData,
    BoardItem,
    CommitInfo,
    DiffSummary,
    FileChange,
    GitState,
    HealthCheck,
    NextUpItem,
    PRInfo,
    render_end_summary,
    render_receipt,
    render_session_banner,
    render_start_briefing,
)

# ── Constants ────────────────────────────────────────────────────────

SUBPROCESS_TIMEOUT = 15  # seconds per subprocess call
TOTAL_DEADLINE = 45  # seconds total wall-clock budget
MAX_WORKERS = 5
LOG_MAX_LINES = 1000

CODE_REVIEW_DIR = Path.home() / ".claude" / "code-review"
SESSIONS_DIR = CODE_REVIEW_DIR / "sessions"
LOG_DIR = CODE_REVIEW_DIR / "logs"
LOG_FILE = LOG_DIR / "session-errors.log"

# Token/auth redaction pattern
_TOKEN_RE = re.compile(
    r"(ghp_[A-Za-z0-9_]+|ghs_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+"
    r"|Bearer\s+\S+|token\s+\S+|Authorization:\s*\S+)",
    re.IGNORECASE,
)


# ── Logging ──────────────────────────────────────────────────────────

def _redact(text: str) -> str:
    """Redact tokens and auth headers from log text."""
    return _TOKEN_RE.sub("[REDACTED]", text)


def _log_error(message: str) -> None:
    """Append redacted error to log file, truncating to last LOG_MAX_LINES."""
    try:
        LOG_DIR.mkdir(parents=True, exist_ok=True)
        ts = time.strftime("%Y-%m-%dT%H:%M:%S%z")
        line = f"[{ts}] {_redact(message)}\n"
        # Append
        with open(LOG_FILE, "a", encoding="utf-8") as f:
            f.write(line)
        # Truncate to last N lines
        try:
            lines = LOG_FILE.read_text(encoding="utf-8").splitlines()
            if len(lines) > LOG_MAX_LINES:
                LOG_FILE.write_text(
                    "\n".join(lines[-LOG_MAX_LINES:]) + "\n",
                    encoding="utf-8",
                )
        except OSError:
            pass
    except OSError:
        pass  # logging must never crash the CLI


# ── Reason codes ─────────────────────────────────────────────────────

def _classify_error(exc: Exception) -> str:
    """Map exception to a reason code."""
    msg = str(exc).lower()
    if isinstance(exc, subprocess.TimeoutExpired):
        return "timeout"
    if "auth" in msg or "401" in msg or "403" in msg:
        return "auth_expired"
    if "not found" in msg or "404" in msg:
        return "not_found"
    if "network" in msg or "connection" in msg or "resolve" in msg:
        return "network_error"
    return "error"


# ── Subprocess helper ────────────────────────────────────────────────

def _run(cmd: list[str], timeout: int = SUBPROCESS_TIMEOUT) -> subprocess.CompletedProcess[str]:
    """Run a command with timeout, capture output."""
    return subprocess.run(
        cmd,
        capture_output=True,
        text=True,
        timeout=timeout,
        check=False,
    )


# ── Data collectors (start mode) ────────────────────────────────────

def _collect_git_state(branch_override: str | None) -> GitState | None:
    """Collect git branch, ahead/behind, uncommitted, recent commits."""
    try:
        # Branch
        if branch_override:
            branch = branch_override
        else:
            r = _run(["git", "branch", "--show-current"])
            if r.returncode != 0:
                return None
            branch = r.stdout.strip()

        # Ahead/behind
        ahead, behind = 0, 0
        r = _run(["git", "rev-list", "--left-right", "--count", "@{u}...HEAD"])
        if r.returncode == 0:
            parts = r.stdout.strip().split()
            if len(parts) == 2:
                behind = int(parts[0])
                ahead = int(parts[1])

        # Uncommitted
        r = _run(["git", "status", "--short"])
        uncommitted: list[str] = []
        if r.returncode == 0 and r.stdout.strip():
            uncommitted = [
                sanitize_text(line) for line in r.stdout.strip().splitlines()
            ]

        # Recent commits
        r = _run(["git", "log", "--oneline", "--format=%h|%s|%ar", "-5"])
        recent: list[CommitInfo] = []
        if r.returncode == 0 and r.stdout.strip():
            for line in r.stdout.strip().splitlines():
                parts_c = line.split("|", 2)
                if len(parts_c) == 3:
                    recent.append({
                        "sha": sanitize_text(parts_c[0]),
                        "message": sanitize_text(parts_c[1]),
                        "age": sanitize_text(parts_c[2]),
                    })

        return {
            "branch": sanitize_text(branch),
            "ahead": ahead,
            "behind": behind,
            "uncommitted": uncommitted,
            "recent_commits": recent,
        }
    except subprocess.TimeoutExpired:
        _log_error("git state collection timed out")
        return None
    except Exception as exc:
        _log_error(f"git state error: {exc}")
        return None


def _collect_open_prs() -> list[PRInfo]:
    """Collect open PRs via gh CLI."""
    try:
        r = _run([
            "gh", "pr", "list",
            "--json", "number,title,state,isDraft,reviewDecision",
            "--limit", "10",
        ])
        if r.returncode != 0:
            _log_error(f"gh pr list failed: {r.stderr.strip()}")
            return []

        data = json.loads(r.stdout)
        prs: list[PRInfo] = []
        for item in data:
            # Map to our status model
            if item.get("isDraft"):
                status = "draft"
            elif item.get("reviewDecision") == "APPROVED":
                status = "ready"
            elif item.get("state") == "MERGED":
                status = "merged"
            else:
                status = "review_requested"
            prs.append({
                "number": item["number"],
                "title": sanitize_text(str(item.get("title", ""))),
                "status": status,
            })
        return prs
    except subprocess.TimeoutExpired:
        _log_error("gh pr list timed out")
        return []
    except Exception as exc:
        _log_error(f"gh pr list error: {exc}")
        return []


def _collect_health_checks() -> list[HealthCheck]:
    """Run health checks defined in .code-review/config.json."""
    config_path = Path(".code-review/config.json")
    if not config_path.exists():
        # Try repo root
        try:
            r = _run(["git", "rev-parse", "--show-toplevel"])
            if r.returncode == 0:
                config_path = Path(r.stdout.strip()) / ".code-review" / "config.json"
        except Exception:
            pass

    if not config_path.exists():
        return []

    try:
        cfg = json.loads(config_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return []

    checks_cfg = cfg.get("session", {}).get("health_checks", [])
    if not checks_cfg:
        return []

    results: list[HealthCheck] = []
    for entry in checks_cfg:
        name = sanitize_text(str(entry.get("name", "Unknown")))
        command = entry.get("command", "")
        if not command:
            continue
        start = time.monotonic()
        try:
            r = _run(["sh", "-c", command], timeout=SUBPROCESS_TIMEOUT)
            dur = time.monotonic() - start
            results.append({
                "name": name,
                "passed": r.returncode == 0,
                "detail": sanitize_text(r.stdout.strip()[:200]) if r.stdout.strip() else ("OK" if r.returncode == 0 else f"exit {r.returncode}"),
                "duration": round(dur, 1),
            })
        except subprocess.TimeoutExpired:
            results.append({
                "name": name,
                "passed": None,
                "detail": "unavailable: timeout",
                "duration": None,
            })
        except Exception as exc:
            reason = _classify_error(exc)
            results.append({
                "name": name,
                "passed": None,
                "detail": f"unavailable: {reason}",
                "duration": None,
            })

    return results


def _collect_board_items() -> list[BoardItem]:
    """Try to collect board items from github_projects.py."""
    script = Path(__file__).resolve().parent / "github_projects.py"
    if not script.exists():
        return []

    try:
        python = sys.executable
        r = _run([
            python, str(script),
            "list-items",
            "--status", "In Progress,Blocked",
            "--json",
        ])
        if r.returncode != 0:
            return []

        data = json.loads(r.stdout)
        items: list[BoardItem] = []
        for entry in data:
            status_raw = str(entry.get("status", "")).lower()
            if "block" in status_raw:
                status = "blocked"
            elif "progress" in status_raw:
                status = "in_flight"
            else:
                status = "clarify"
            items.append({
                "title": sanitize_text(str(entry.get("title", ""))),
                "status": status,
                "issue_number": sanitize_text(str(entry.get("number", entry.get("issue_number", "")))),
            })
        return items
    except subprocess.TimeoutExpired:
        _log_error("board items collection timed out")
        return []
    except Exception as exc:
        _log_error(f"board items error: {exc}")
        return []


def _collect_alerts(session_id: str) -> list[AlertInfo]:
    """Read alerts from session alerts file."""
    alerts_path = SESSIONS_DIR / session_id / "alerts.json"
    if not alerts_path.exists():
        return []

    try:
        data = json.loads(alerts_path.read_text(encoding="utf-8"))
        if not isinstance(data, list):
            return []
        alerts: list[AlertInfo] = []
        for entry in data:
            alerts.append({
                "level": sanitize_text(str(entry.get("level", "warning"))),
                "message": sanitize_text(str(entry.get("message", ""))),
                "context": sanitize_text(str(entry.get("context", ""))),
            })
        return alerts
    except (OSError, json.JSONDecodeError):
        return []


# ── Data collectors (end mode) ──────────────────────────────────────

def _resolve_start_head(start_head: str | None) -> tuple[str | None, bool]:
    """Resolve start HEAD SHA. Returns (sha, is_approximate)."""
    if start_head:
        return start_head, False

    # Fallback: merge-base
    try:
        r = _run(["git", "merge-base", "origin/main", "HEAD"])
        if r.returncode == 0 and r.stdout.strip():
            return r.stdout.strip(), True
    except Exception as exc:
        _log_error(f"merge-base fallback error: {exc}")

    return None, True


def _collect_diff_summary(start_head: str | None) -> tuple[DiffSummary | None, bool]:
    """Collect diff stats between start_head and HEAD.

    Returns (diff_summary, is_approximate).
    """
    sha, approximate = _resolve_start_head(start_head)
    if sha is None:
        return None, True

    try:
        # Get overall stats
        r = _run(["git", "diff", "--stat", sha, "HEAD"])
        if r.returncode != 0:
            return None, approximate

        # Get numstat for line counts and key files
        r_num = _run(["git", "diff", "--numstat", sha, "HEAD"])
        if r_num.returncode != 0:
            return None, approximate

        total_added = 0
        total_removed = 0
        file_count = 0
        # Collect files with changes for key_files selection
        file_changes: list[tuple[int, str, str]] = []  # (total_lines, path, status)

        for line in r_num.stdout.strip().splitlines():
            parts = line.split("\t", 2)
            if len(parts) != 3:
                continue
            added_str, removed_str, path = parts
            # Binary files show "-" for added/removed
            added = int(added_str) if added_str != "-" else 0
            removed = int(removed_str) if removed_str != "-" else 0
            total_added += added
            total_removed += removed
            file_count += 1

            total_change = added + removed
            # Determine status
            if removed > 0 and added == 0:
                status = "deleted"
            elif added > 0 and removed == 0:
                status = "new"
            else:
                status = "modified"

            file_changes.append((total_change, path, status))

        # Key files: >50 lines changed or deleted, max 5
        key_files: list[FileChange] = []
        # Sort by change magnitude descending
        file_changes.sort(key=lambda x: x[0], reverse=True)
        for total_change, path, status in file_changes:
            if len(key_files) >= 5:
                break
            if total_change > 50 or status == "deleted":
                key_files.append({
                    "path": sanitize_text(path),
                    "status": status,
                })

        return {
            "added": total_added,
            "removed": total_removed,
            "file_count": file_count,
            "key_files": key_files,
        }, approximate

    except subprocess.TimeoutExpired:
        _log_error("diff collection timed out")
        return None, approximate
    except Exception as exc:
        _log_error(f"diff collection error: {exc}")
        return None, approximate


# ── JSON arg parsing ─────────────────────────────────────────────────

def _parse_json_arg(raw: str | None, fallback: Any = None) -> Any:
    """Parse a JSON CLI argument gracefully. Returns fallback on failure."""
    if raw is None:
        return fallback
    try:
        return json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        return fallback


# ── Parallel data collection ────────────────────────────────────────

def _collect_start_data(
    args: argparse.Namespace,
) -> dict[str, Any]:
    """Collect all start-mode data in parallel with wall-clock budget."""
    session_id = args.session_id or ""
    branch = args.branch

    results: dict[str, Any] = {
        "git": None,
        "prs": [],
        "health": [],
        "board": [],
        "alerts": [],
    }

    deadline = time.monotonic() + TOTAL_DEADLINE

    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as executor:
        futures = {
            executor.submit(_collect_git_state, branch): "git",
            executor.submit(_collect_open_prs): "prs",
            executor.submit(_collect_health_checks): "health",
            executor.submit(_collect_board_items): "board",
            executor.submit(_collect_alerts, session_id): "alerts",
        }

        for future in as_completed(futures, timeout=max(0, deadline - time.monotonic())):
            key = futures[future]
            try:
                results[key] = future.result(timeout=max(0, deadline - time.monotonic()))
            except subprocess.TimeoutExpired:
                _log_error(f"{key} collection timed out")
                if key == "health":
                    results[key] = [{"name": key, "passed": None, "detail": "unavailable: timeout", "duration": None}]
            except Exception as exc:
                reason = _classify_error(exc)
                _log_error(f"{key} collection failed: {reason} - {exc}")

    return results


# ── Auto-detect helpers ──────────────────────────────────────────────

def _auto_detect_repo() -> str:
    """Detect repo from git remote."""
    try:
        r = _run(["git", "remote", "get-url", "origin"])
        if r.returncode == 0:
            url = r.stdout.strip().rstrip("/")
            if url.endswith(".git"):
                url = url[:-4]
            for prefix in ("https://github.com/", "git@github.com:"):
                if url.startswith(prefix):
                    return url[len(prefix):]
            return url
    except Exception:
        pass
    return "unknown/repo"


def _auto_detect_branch() -> str:
    """Detect current branch."""
    try:
        r = _run(["git", "branch", "--show-current"])
        if r.returncode == 0:
            return r.stdout.strip()
    except Exception:
        pass
    return "unknown"


# ── Main modes ──────────────────────────────────────────────────────

def _run_start(args: argparse.Namespace) -> None:
    """Execute start mode: collect data, render briefing, print."""
    config = make_config(no_color=args.no_color, plain=args.plain)

    # Resolve defaults
    repo = args.repo or _auto_detect_repo()
    branch = args.branch  # None means auto-detect in collector
    started_at = args.started_at or time.strftime("%Y-%m-%dT%H:%M:%S%z")
    session_id = args.session_id or "unnamed"

    # Parse optional JSON args
    persona = _parse_json_arg(args.persona)
    next_up_raw = _parse_json_arg(args.next_up, [])

    # Collect data
    data = _collect_start_data(args)

    # Resolve branch for banner (may have been auto-detected in git collector)
    git_state: GitState | None = data["git"]
    banner_branch = branch or (git_state["branch"] if git_state else _auto_detect_branch())

    # Build banner data
    banner_data: BannerData = {
        "mode": "start",
        "repo": sanitize_text(repo),
        "branch": sanitize_text(banner_branch),
        "session_id": sanitize_text(session_id),
        "started_at": sanitize_text(started_at),
    }

    if persona and isinstance(persona, dict):
        if "name" in persona:
            banner_data["persona_name"] = sanitize_text(str(persona["name"]))
        if "catchphrase" in persona:
            banner_data["persona_catchphrase"] = sanitize_text(str(persona["catchphrase"]))

    # Build next-up items
    next_up: list[NextUpItem] = []
    if isinstance(next_up_raw, list):
        for item in next_up_raw:
            if isinstance(item, dict) and "label" in item:
                next_up.append({
                    "label": sanitize_text(str(item["label"])),
                    "priority": sanitize_text(str(item.get("priority", "low"))),
                    "issue": sanitize_text(str(item["issue"])) if item.get("issue") else None,
                })

    # Render
    banner = render_session_banner(config, banner_data)
    output = render_start_briefing(
        config,
        banner,
        git=git_state,
        prs=data["prs"],
        health=data["health"],
        alerts=data["alerts"],
        board=data["board"],
        next_up=next_up,
    )

    print(output)


def _run_end(args: argparse.Namespace) -> None:
    """Execute end mode: collect diff, render summary, print."""
    config = make_config(no_color=args.no_color, plain=args.plain)

    # Resolve defaults
    repo = args.repo or _auto_detect_repo()
    branch = args.branch or _auto_detect_branch()
    started_at = args.started_at or ""
    session_id = args.session_id or "unnamed"

    # Parse optional JSON args
    persona = _parse_json_arg(args.persona)
    next_up_raw = _parse_json_arg(args.next_up, [])
    receipt_raw = _parse_json_arg(args.receipt, [])

    # Collect diff
    diff_summary, approximate = _collect_diff_summary(args.start_head)

    # Build banner data
    banner_data: BannerData = {
        "mode": "end",
        "repo": sanitize_text(repo),
        "branch": sanitize_text(branch),
        "session_id": sanitize_text(session_id),
        "started_at": sanitize_text(started_at),
    }

    if args.name:
        banner_data["session_name"] = sanitize_text(args.name)

    if persona and isinstance(persona, dict):
        if "name" in persona:
            banner_data["persona_name"] = sanitize_text(str(persona["name"]))
        if "catchphrase" in persona:
            banner_data["persona_catchphrase"] = sanitize_text(str(persona["catchphrase"]))

    # Build receipt
    receipt_items: list[HealthCheck] = []
    if isinstance(receipt_raw, list):
        for item in receipt_raw:
            if isinstance(item, dict) and "name" in item:
                receipt_items.append({
                    "name": sanitize_text(str(item["name"])),
                    "passed": item.get("passed"),
                    "detail": sanitize_text(str(item.get("detail", ""))),
                    "duration": item.get("duration"),
                })

    # Build next-up items
    next_up: list[NextUpItem] = []
    if isinstance(next_up_raw, list):
        for item in next_up_raw:
            if isinstance(item, dict) and "label" in item:
                next_up.append({
                    "label": sanitize_text(str(item["label"])),
                    "priority": sanitize_text(str(item.get("priority", "low"))),
                    "issue": sanitize_text(str(item["issue"])) if item.get("issue") else None,
                })

    # Render
    banner = render_session_banner(config, banner_data)
    receipt_str = render_receipt(config, receipt_items) if receipt_items else ""

    # Add approximate warning to diff if needed
    output_parts: list[str] = []

    from session_tui import render_diff_summary, render_next_up, _section  # noqa: E402

    output_sections: list[str] = [banner]
    if receipt_str:
        output_sections.append(receipt_str)

    if diff_summary is not None:
        diff_section = render_diff_summary(config, diff_summary)
        if approximate:
            from tui_core import icon as _icon, ansi as _ansi
            warn = _ansi("33", _icon("\u26a0\ufe0f", "[WARN]", config) + " Session diff approximate \u2014 start HEAD not recorded.", config)
            diff_section = diff_section + "\n" + warn
        output_sections.append(diff_section)
    elif approximate and args.start_head is None:
        # No diff at all, warn
        from tui_core import icon as _icon, ansi as _ansi
        output_sections.append(
            _ansi("33", _icon("\u26a0\ufe0f", "[WARN]", config) + " No diff available \u2014 start HEAD not recorded.", config)
        )

    output_sections.append(render_next_up(config, next_up))

    print("\n\n".join(output_sections))


# ── Argument parsing ────────────────────────────────────────────────

def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="session_tui_cli",
        description="Render session TUI start/end briefings.",
    )
    subparsers = parser.add_subparsers(dest="mode", required=True)

    # Shared flags for both modes
    def _add_shared(sub: argparse.ArgumentParser) -> None:
        sub.add_argument("--plain", action="store_true", help="Plain text mode")
        sub.add_argument("--no-color", action="store_true", help="Disable ANSI color")
        sub.add_argument("--session-id", help="Session ID for banner")
        sub.add_argument("--repo", help="Repo identifier (fallback: auto-detect)")
        sub.add_argument("--branch", help="Current branch (fallback: auto-detect)")
        sub.add_argument("--start-head", help="HEAD SHA at session start")
        sub.add_argument("--started-at", help="Session start timestamp ISO8601")
        sub.add_argument("--persona", help="JSON: {name, catchphrase}")
        sub.add_argument("--next-up", help="JSON: list of {label, priority, issue}")

    # Start subcommand
    start_parser = subparsers.add_parser("start", help="Render start-of-session briefing")
    _add_shared(start_parser)

    # End subcommand
    end_parser = subparsers.add_parser("end", help="Render end-of-session summary")
    _add_shared(end_parser)
    end_parser.add_argument("--name", help="Session name for end banner")
    end_parser.add_argument("--receipt", help="JSON: list of HealthCheck-shaped dicts")

    return parser


# ── Entry point ─────────────────────────────────────────────────────

def main() -> None:
    parser = _build_parser()
    args = parser.parse_args()

    try:
        if args.mode == "start":
            _run_start(args)
        elif args.mode == "end":
            _run_end(args)
    except KeyboardInterrupt:
        sys.exit(130)
    except Exception as exc:
        _log_error(f"fatal: {exc}")
        print(f"Session TUI error: {_classify_error(exc)}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
