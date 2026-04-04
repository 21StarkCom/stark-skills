#!/usr/bin/env python3
"""Session TUI rendering functions for stark-skills.

Renders start-of-session briefings and end-of-session summaries
using tui_core primitives. All inputs are assumed pre-sanitized.
"""
from __future__ import annotations

from typing import Literal, TypedDict

from tui_core import (
    TUIConfig,
    ansi,
    format_banner,
    icon,
    render_checklist_item,
    section_header,
    strip_ansi,
    truncate,
)


# ── TypedDicts ──────────────────────────────────────────────────────

class CommitInfo(TypedDict):
    sha: str           # short SHA, e.g., "a628ae0"
    message: str       # first line of commit message
    age: str           # human-readable, e.g., "2h ago"


class PRInfo(TypedDict):
    number: int
    title: str
    status: str        # 'ready' | 'review_requested' | 'draft' | 'merged'


class HealthCheck(TypedDict):
    name: str          # e.g., "Tests", "Build", "Lint"
    passed: bool | None  # True=pass, False=fail, None=warn/skip
    detail: str        # e.g., "586 passed, 22 skipped"
    duration: float | None  # seconds, or None if not timed


class AlertInfo(TypedDict):
    level: str         # 'warning' | 'critical'
    message: str
    context: str       # e.g., "(82%)"


class BoardItem(TypedDict):
    title: str
    status: str        # 'in_flight' | 'blocked' | 'clarify'
    issue_number: str  # e.g., "#234"


class FileChange(TypedDict):
    path: str
    status: str        # 'new' | 'modified' | 'deleted' | 'renamed'


class NextUpItem(TypedDict):
    label: str
    priority: str      # 'action' | 'low'
    issue: str | None  # e.g., "#139" or None


class GitState(TypedDict):
    branch: str
    ahead: int
    behind: int
    uncommitted: list[str]
    recent_commits: list[CommitInfo]


class DiffSummary(TypedDict):
    added: int
    removed: int
    file_count: int
    key_files: list[FileChange]


class _BannerRequired(TypedDict):
    mode: Literal["start", "end"]
    repo: str
    branch: str
    session_id: str
    started_at: str     # ISO8601 with timezone


class BannerData(_BannerRequired, total=False):
    persona_name: str
    persona_catchphrase: str
    ended_at: str       # end mode
    duration: str       # pre-formatted, e.g., "2h 47m"
    session_name: str   # end mode only


# ── Color scheme constants ──────────────────────────────────────────

_SECTION = {
    "start":   {"code": "32", "emoji": "\U0001f680", "plain": "[SESSION START]"},
    "end":     {"code": "34", "emoji": "\U0001f3c1", "plain": "[SESSION END]"},
    "git":     {"code": "36", "emoji": "\U0001f500", "plain": "[GIT]"},
    "prs":     {"code": "35", "emoji": "\U0001f4cb", "plain": "[PRS]"},
    "health":  {"code": "32", "emoji": "\U0001f3e5", "plain": "[HEALTH]"},
    "alerts":  {"code": "33", "emoji": "\u26a0\ufe0f",  "plain": "[ALERTS]"},
    "board":   {"code": "34", "emoji": "\U0001f4cc", "plain": "[BOARD]"},
    "receipt": {"code": "32", "emoji": "\U0001f4ca", "plain": "[RECEIPT]"},
    "diff":    {"code": "34", "emoji": "\U0001f4c8", "plain": "[DIFF]"},
    "next":    {"code": "33", "emoji": "\U0001f449", "plain": "[NEXT]"},
    "persona": {"code": "35", "emoji": "\U0001f3ad", "plain": "[PERSONA]"},
}


def _section(config: TUIConfig, key: str, title: str) -> str:
    s = _SECTION[key]
    return section_header(config, title, s["emoji"], s["plain"])


# ── Render functions ────────────────────────────────────────────────

def render_session_banner(config: TUIConfig, data: BannerData) -> str:
    """Top banner for session start or end."""
    mode = data["mode"]
    s = _SECTION[mode]

    title = ansi(s["code"], icon(s["emoji"], s["plain"], config) + " " + s["plain"].strip("[]"), config)

    # Extract HH:MM from ISO8601 started_at
    started_at = data["started_at"]
    hhmm = ""
    if "T" in started_at:
        time_part = started_at.split("T")[1]
        hhmm = time_part[:5]  # "HH:MM"

    lines = [
        title,
        f"Repo: {data['repo']}  Branch: {data['branch']}",
        f"Session: {data['session_id']}",
        f"Started: {hhmm}" if hhmm else f"Started: {started_at}",
    ]

    if mode == "end":
        if "ended_at" in data:
            lines.append(f"Ended: {data['ended_at']}")
        if "duration" in data:
            lines.append(f"Duration: {data['duration']}")
        if "session_name" in data:
            lines.append(f"Name: {data['session_name']}")

    if "persona_name" in data:
        persona_line = icon("\U0001f3ad", "[PERSONA]", config) + f" {data['persona_name']}"
        if "persona_catchphrase" in data:
            persona_line += f' \u2014 "{data["persona_catchphrase"]}"'
        lines.append(persona_line)

    return format_banner(config, lines)


def render_git_state(config: TUIConfig, git: GitState) -> str:
    """Branch, ahead/behind, uncommitted files, recent commits."""
    parts: list[str] = [_section(config, "git", "Git")]

    # Branch + ahead/behind
    branch_line = f"Branch: {ansi('1', git['branch'], config)}"
    ahead, behind = git["ahead"], git["behind"]
    if ahead or behind:
        sync_parts = []
        if ahead:
            sync_parts.append(f"{ahead} ahead")
        if behind:
            sync_parts.append(f"{behind} behind")
        branch_line += f"  ({', '.join(sync_parts)})"
    parts.append(branch_line)

    # Uncommitted files (max 10)
    uncommitted = git["uncommitted"]
    if uncommitted:
        parts.append(f"Uncommitted ({len(uncommitted)}):")
        for f in uncommitted[:10]:
            parts.append(f"  {f}")
        if len(uncommitted) > 10:
            parts.append(f"  ... and {len(uncommitted) - 10} more")
    else:
        parts.append("Working tree clean")

    # Recent commits (max 5)
    commits = git["recent_commits"]
    if commits:
        parts.append("Recent commits:")
        for c in commits[:5]:
            parts.append(f"  {c['sha']}  {c['message']}  ({c['age']})")
        if len(commits) > 5:
            parts.append(f"  ... and {len(commits) - 5} more")

    return "\n".join(parts)


def render_prs(config: TUIConfig, prs: list[PRInfo]) -> str:
    """PR listing with status indicators and text labels."""
    parts: list[str] = [_section(config, "prs", "Pull Requests")]

    if not prs:
        parts.append("No open PRs.")
        return "\n".join(parts)

    status_map = {
        "ready": (icon("\u2705", "[OK]", config), "ready to merge"),
        "review_requested": (icon("\u00b7\u00b7", "..", config), "review requested"),
        "draft": (icon("\u25cb", "o", config), "draft"),
        "merged": (icon("\U0001f7e3", "*", config), "merged"),
    }

    for pr in prs:
        sym, label = status_map.get(pr["status"], ("?", pr["status"]))
        parts.append(f"  {sym} {label}  #{pr['number']} {pr['title']}")

    return "\n".join(parts)


def render_health(config: TUIConfig, checks: list[HealthCheck]) -> str:
    """Health check listing using render_checklist_item."""
    parts: list[str] = [_section(config, "health", "Health")]

    if not checks:
        parts.append("No health checks configured.")
        return "\n".join(parts)

    for check in checks:
        parts.append(render_checklist_item(
            config,
            check["passed"],
            check["name"],
            check["detail"],
            check.get("duration"),
        ))

    return "\n".join(parts)


def render_alerts(config: TUIConfig, alerts: list[AlertInfo]) -> str:
    """Alerts section. Returns empty string if no alerts."""
    if not alerts:
        return ""

    parts: list[str] = [_section(config, "alerts", "Alerts")]

    for alert in alerts:
        level_icon = icon("\u26a0\ufe0f", "[WARN]", config) if alert["level"] == "warning" else icon("\U0001f6a8", "[CRIT]", config)
        color = "33" if alert["level"] == "warning" else "31"
        parts.append(f"  {ansi(color, level_icon, config)} {alert['message']} {alert['context']}")

    return "\n".join(parts)


def render_board(config: TUIConfig, items: list[BoardItem]) -> str:
    """Board items. Returns empty string if empty."""
    if not items:
        return ""

    parts: list[str] = [_section(config, "board", "Board")]

    status_map = {
        "in_flight": "\u25b6 In Flight",
        "blocked": "\u23f8 Blocked",
        "clarify": "? Clarify",
    }

    for item in items:
        status_label = status_map.get(item["status"], item["status"])
        parts.append(f"  {status_label}  {item['issue_number']} {item['title']}")

    return "\n".join(parts)


def render_receipt(config: TUIConfig, items: list[HealthCheck]) -> str:
    """End-mode receipt using render_checklist_item."""
    parts: list[str] = [_section(config, "receipt", "Receipt")]

    for item in items:
        parts.append(render_checklist_item(
            config,
            item["passed"],
            item["name"],
            item["detail"],
            item.get("duration"),
        ))

    return "\n".join(parts)


def render_diff_summary(config: TUIConfig, diff: DiffSummary) -> str:
    """Diff summary: +lines/-lines, file count, key files."""
    parts: list[str] = [_section(config, "diff", "Diff Summary")]

    added = diff["added"]
    removed = diff["removed"]
    fcount = diff["file_count"]
    plus = ansi("32", f"+{added}", config)
    minus = ansi("31", f"-{removed}", config)
    suffix = "s" if fcount != 1 else ""
    parts.append(f"  {plus} / {minus}  across {fcount} file{suffix}")

    status_icons = {
        "new": "+",
        "modified": "~",
        "deleted": "-",
        "renamed": "R",
    }

    for fc in diff["key_files"]:
        si = status_icons.get(fc["status"], "?")
        parts.append(f"  {si} {fc['path']}")

    return "\n".join(parts)


def render_next_up(config: TUIConfig, items: list[NextUpItem]) -> str:
    """Next-up items: action items first, low priority after."""
    parts: list[str] = [_section(config, "next", "Next Up")]

    action_items = [i for i in items if i["priority"] == "action"]
    low_items = [i for i in items if i["priority"] == "low"]

    for item in action_items + low_items:
        bullet = "\u25cf" if item["priority"] == "action" else "\u25cb"
        issue_str = f"  {item['issue']}" if item.get("issue") else ""
        parts.append(f"  {bullet} {item['label']}{issue_str}")

    return "\n".join(parts)


def format_duration(seconds: float) -> str:
    """Format seconds into human-readable duration.

    hours>0: "Xh Ym"; hours==0: "Xm"; both==0: "Xs"
    """
    total = int(seconds)
    hours = total // 3600
    minutes = (total % 3600) // 60
    secs = total % 60

    if hours > 0:
        return f"{hours}h {minutes}m"
    if minutes > 0:
        return f"{minutes}m"
    return f"{secs}s"


# ── Composition helpers ─────────────────────────────────────────────

def render_start_briefing(
    config: TUIConfig,
    banner: str,
    git: GitState | None,
    prs: list[PRInfo],
    health: list[HealthCheck],
    alerts: list[AlertInfo],
    board: list[BoardItem],
    next_up: list[NextUpItem],
) -> str:
    """Compose a full start-of-session briefing.

    Order: banner, git, prs, health, [alerts], [board], next_up.
    If git is None, omit git section and show warning.
    """
    sections: list[str] = [banner]

    if git is None:
        sections.append(ansi("33", icon("\u26a0\ufe0f", "[WARN]", config) + " Git state unavailable", config))
    else:
        sections.append(render_git_state(config, git))

    sections.append(render_prs(config, prs))
    sections.append(render_health(config, health))

    alerts_out = render_alerts(config, alerts)
    if alerts_out:
        sections.append(alerts_out)

    board_out = render_board(config, board)
    if board_out:
        sections.append(board_out)

    sections.append(render_next_up(config, next_up))

    return "\n\n".join(sections)


def render_end_summary(
    config: TUIConfig,
    banner: str,
    receipt: str,
    diff: DiffSummary | None,
    next_up: list[NextUpItem],
) -> str:
    """Compose a full end-of-session summary.

    Order: banner, receipt, [diff], next_up.
    """
    sections: list[str] = [banner, receipt]

    if diff is not None:
        sections.append(render_diff_summary(config, diff))

    sections.append(render_next_up(config, next_up))

    return "\n\n".join(sections)
