#!/usr/bin/env python3
"""PR analytics dashboard — review rounds, findings, participants, timelines.

Combines GitHub API data with stark-team-review history to produce a full
lifecycle view of PRs: review cycles, finding quality, merge times.

Usage:
    pr_status.py                        # all PRs in current repo
    pr_status.py 15                     # single PR dashboard
    pr_status.py --state merged         # only merged PRs
    pr_status.py --repo GetEvinced/foo  # override repo
    pr_status.py --json                 # machine-readable output
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

# ── Config ──────────────────────────────────────────────────────────────

SCRIPTS_DIR = Path(__file__).parent
PYTHON = str(SCRIPTS_DIR / ".venv" / "bin" / "python3")
GITHUB_APP = str(SCRIPTS_DIR / "github_app.py")
HISTORY_DIR = Path.home() / ".claude" / "code-review" / "history"

SEVERITY_ICONS = {
    "critical": "\U0001f534",
    "high": "\U0001f7e0",
    "medium": "\U0001f7e1",
    "low": "\U0001f535",
}


# ── Data structures ────────────────────────────────────────────────────


@dataclass
class ReviewRound:
    round_num: int
    findings_raw: int = 0
    findings_deduped: int = 0
    by_severity: dict[str, int] = field(default_factory=dict)
    by_outcome: dict[str, int] = field(default_factory=dict)
    commit: str | None = None


@dataclass
class Participant:
    login: str
    is_bot: bool = False
    reviews: int = 0
    comments: int = 0
    approvals: int = 0
    changes_requested: int = 0


@dataclass
class FindingHighlight:
    title: str
    severity: str
    agents_count: int
    outcome: str
    reason: str | None = None


@dataclass
class PRStatus:
    number: int
    title: str
    author: str
    state: str  # open, closed, merged
    created_at: str
    merged_at: str | None = None
    closed_at: str | None = None
    updated_at: str | None = None
    labels: list[str] = field(default_factory=list)
    additions: int = 0
    deletions: int = 0
    changed_files: int = 0
    # Time metrics
    time_to_merge_h: float | None = None
    time_to_first_review_h: float | None = None
    # Review data
    rounds: list[ReviewRound] = field(default_factory=list)
    total_findings_raw: int = 0
    total_findings_deduped: int = 0
    by_severity: dict[str, int] = field(default_factory=dict)
    by_outcome: dict[str, int] = field(default_factory=dict)
    # Participants
    participants: list[Participant] = field(default_factory=list)
    # Highlights
    top_finding: FindingHighlight | None = None
    top_noise: FindingHighlight | None = None
    # Vibe-coding KPIs
    first_time_right: bool | None = None  # merged without human CHANGES_REQUESTED
    human_review_cycles: int = 0  # count of human CHANGES_REQUESTED reviews
    human_oversight_h: float | None = None  # time from bot review to human approval
    consensus_score: float | None = None  # avg agents per finding (higher = more confident)
    signal_per_agent: dict[str, dict[str, int]] = field(default_factory=dict)  # agent -> {fix, noise, ...}
    finding_acceptance: dict[str, int] = field(default_factory=dict)  # {thumbs_up, thumbs_down, total}
    is_revert: bool = False
    reverted_by: int | None = None  # PR number that reverts this one
    rework_of: list[int] = field(default_factory=list)  # prior PRs touching same files within 7 days
    # Source
    has_history: bool = False
    has_github: bool = False


# ── GitHub API ─────────────────────────────────────────────────────────


def _get_gh_token() -> str:
    result = subprocess.run(
        [PYTHON, GITHUB_APP, "--app", "stark-claude", "token"],
        capture_output=True, text=True, timeout=15,
    )
    if result.returncode != 0:
        raise RuntimeError(f"GitHub auth failed: {result.stderr}")
    return result.stdout.strip()


def _gh_api(path: str, token: str) -> Any:
    """Call GitHub API via gh CLI."""
    result = subprocess.run(
        ["gh", "api", path, "--paginate"],
        capture_output=True, text=True,
        env={**os.environ, "GH_TOKEN": token},
        timeout=30,
    )
    if result.returncode != 0:
        print(f"  [!] gh api {path} failed (exit {result.returncode}): {result.stderr[:200]}", file=sys.stderr)
        return None
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError:
        return None


def detect_repo(cwd: str | None = None) -> str:
    try:
        result = subprocess.run(
            ["git", "remote", "get-url", "origin"],
            capture_output=True, text=True, timeout=5, cwd=cwd,
        )
        url = result.stdout.strip()
        m = re.match(r"git@[\w.-]+:(.+?)(?:\.git)?$", url)
        if m:
            return m.group(1)
        m = re.match(r"https://github\.com/(.+?)(?:\.git)?$", url)
        if m:
            return m.group(1)
    except (subprocess.TimeoutExpired, FileNotFoundError):
        pass
    return ""


# ── History loading ────────────────────────────────────────────────────


def _load_history(repo: str, pr_number: int) -> dict | None:
    """Load stark-team-review history for a PR."""
    # repo is like GetEvinced/foo — history uses the repo name part
    parts = repo.split("/")
    repo_name = parts[1] if len(parts) == 2 else repo

    pr_dir = HISTORY_DIR / parts[0] / repo_name / str(pr_number) if len(parts) == 2 \
        else HISTORY_DIR / repo_name / str(pr_number)

    if not pr_dir.exists():
        # Try just repo_name under any org
        for org_dir in HISTORY_DIR.iterdir():
            if org_dir.is_dir():
                candidate = org_dir / repo_name / str(pr_number)
                if candidate.exists():
                    pr_dir = candidate
                    break
        else:
            return None

    data: dict[str, Any] = {"dir": str(pr_dir)}

    # Load rounds.json (primary data source)
    rounds_file = pr_dir / "rounds.json"
    if rounds_file.exists():
        try:
            data["rounds"] = json.loads(rounds_file.read_text())
        except json.JSONDecodeError:
            pass

    # Load per-round files
    round_files = sorted(pr_dir.glob("round-*.json"))
    data["round_files"] = []
    for rf in round_files:
        try:
            data["round_files"].append(json.loads(rf.read_text()))
        except json.JSONDecodeError:
            pass

    # Load summary
    for summary_name in ("summary.md", "summary-run2.md"):
        sf = pr_dir / summary_name
        if sf.exists():
            data.setdefault("summaries", []).append(sf.read_text())

    return data


# ── PR analysis ────────────────────────────────────────────────────────


def _parse_datetime(s: str | None) -> datetime | None:
    if not s:
        return None
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00"))
    except (ValueError, TypeError):
        return None


def _hours_between(a: str | None, b: str | None) -> float | None:
    da, db = _parse_datetime(a), _parse_datetime(b)
    if da and db:
        return abs((db - da).total_seconds()) / 3600
    return None


def analyze_pr(repo: str, pr_data: dict, token: str) -> PRStatus:
    """Build PRStatus from GitHub data + history."""
    number = pr_data["number"]
    merged = pr_data.get("merged_at") is not None
    state = "merged" if merged else pr_data.get("state", "open")

    status = PRStatus(
        number=number,
        title=pr_data.get("title", ""),
        author=pr_data.get("user", {}).get("login", "unknown"),
        state=state,
        created_at=pr_data.get("created_at", ""),
        merged_at=pr_data.get("merged_at"),
        closed_at=pr_data.get("closed_at"),
        updated_at=pr_data.get("updated_at"),
        labels=[l.get("name", "") for l in pr_data.get("labels", [])],
        additions=pr_data.get("additions", 0),
        deletions=pr_data.get("deletions", 0),
        changed_files=pr_data.get("changed_files", 0),
        has_github=True,
    )

    # Time to merge
    if merged:
        status.time_to_merge_h = _hours_between(
            pr_data.get("created_at"), pr_data.get("merged_at"),
        )

    # Fetch reviews
    reviews_data = _gh_api(f"repos/{repo}/pulls/{number}/reviews", token) or []
    participants: dict[str, Participant] = {}

    # Add author
    participants[status.author] = Participant(
        login=status.author,
        is_bot=pr_data.get("user", {}).get("type") == "Bot",
    )

    first_review_time = None
    for review in reviews_data:
        login = review.get("user", {}).get("login", "unknown")
        is_bot = review.get("user", {}).get("type") == "Bot" or "[bot]" in login
        if login not in participants:
            participants[login] = Participant(login=login, is_bot=is_bot)
        p = participants[login]
        p.reviews += 1
        review_state = review.get("state", "")
        if review_state == "APPROVED":
            p.approvals += 1
        elif review_state == "CHANGES_REQUESTED":
            p.changes_requested += 1

        submitted = review.get("submitted_at")
        if submitted and first_review_time is None:
            first_review_time = submitted

    # Fetch comments (issue comments + review comments)
    issue_comments = _gh_api(f"repos/{repo}/issues/{number}/comments", token) or []
    review_comments = _gh_api(f"repos/{repo}/pulls/{number}/comments", token) or []

    for comment in issue_comments + review_comments:
        login = comment.get("user", {}).get("login", "unknown")
        is_bot = comment.get("user", {}).get("type") == "Bot" or "[bot]" in login
        if login not in participants:
            participants[login] = Participant(login=login, is_bot=is_bot)
        participants[login].comments += 1

    status.participants = sorted(
        participants.values(),
        key=lambda p: p.reviews + p.comments,
        reverse=True,
    )

    # Time to first review
    if first_review_time:
        status.time_to_first_review_h = _hours_between(
            pr_data.get("created_at"), first_review_time,
        )

    # ── Vibe-coding KPIs ──────────────────────────────────────────────

    # First-Time-Right: no human CHANGES_REQUESTED reviews
    human_changes_requested = 0
    human_approval_time = None
    bot_review_time = None
    for review in reviews_data:
        login = review.get("user", {}).get("login", "unknown")
        is_bot = review.get("user", {}).get("type") == "Bot" or "[bot]" in login
        review_state = review.get("state", "")
        submitted = review.get("submitted_at")
        if is_bot and bot_review_time is None and submitted:
            bot_review_time = submitted
        if not is_bot:
            if review_state == "CHANGES_REQUESTED":
                human_changes_requested += 1
            if review_state == "APPROVED" and submitted:
                human_approval_time = submitted

    status.human_review_cycles = human_changes_requested
    if merged:
        status.first_time_right = human_changes_requested == 0

    # Human oversight time: bot first review → human approval
    if bot_review_time and human_approval_time:
        status.human_oversight_h = _hours_between(bot_review_time, human_approval_time)

    # Revert detection
    title_lower = pr_data.get("title", "").lower()
    if "revert" in title_lower:
        status.is_revert = True

    # Finding acceptance: reactions on bot review comments
    bot_comments = [
        c for c in review_comments
        if c.get("user", {}).get("type") == "Bot" or "[bot]" in c.get("user", {}).get("login", "")
    ]
    if bot_comments:
        thumbs_up = 0
        thumbs_down = 0
        for c in bot_comments[:20]:  # cap API calls
            reactions = _gh_api(
                f"repos/{repo}/pulls/comments/{c['id']}/reactions", token,
            )
            if reactions:
                for r in reactions:
                    content = r.get("content", "")
                    if content in ("+1", "heart", "rocket", "hooray"):
                        thumbs_up += 1
                    elif content in ("-1", "confused"):
                        thumbs_down += 1
        status.finding_acceptance = {
            "positive": thumbs_up,
            "negative": thumbs_down,
            "total_comments": len(bot_comments),
        }

    # Rework detection (single-PR mode — check recent merged PRs touching same files)
    if status.changed_files and status.changed_files <= 50:
        pr_files = _gh_api(f"repos/{repo}/pulls/{number}/files", token) or []
        pr_filenames = {f.get("filename") for f in pr_files}
        if pr_filenames:
            # Check recently merged PRs for file overlap
            recent_prs = _gh_api(
                f"repos/{repo}/pulls?state=closed&sort=updated&direction=desc&per_page=10",
                token,
            ) or []
            for rpr in recent_prs:
                if rpr["number"] == number:
                    continue
                if not rpr.get("merged_at"):
                    continue
                # Only check PRs merged in the last 7 days before this PR was created
                days_between = _hours_between(rpr["merged_at"], pr_data.get("created_at"))
                if days_between is not None and days_between <= 168:  # 7 days
                    rpr_files = _gh_api(
                        f"repos/{repo}/pulls/{rpr['number']}/files", token,
                    ) or []
                    rpr_filenames = {f.get("filename") for f in rpr_files}
                    overlap = pr_filenames & rpr_filenames
                    if overlap:
                        status.rework_of.append(rpr["number"])

    # Load stark-team-review history
    history = _load_history(repo, number)
    if history:
        status.has_history = True
        rounds_data = history.get("rounds", {})

        # Parse rounds.json
        if rounds_data:
            findings = rounds_data.get("findings", {})
            status.total_findings_raw = findings.get("total_raw", 0)
            status.total_findings_deduped = findings.get("deduplicated", 0)
            status.by_severity = findings.get("by_severity", {})
            status.by_outcome = findings.get("by_outcome", {})

            n_rounds = rounds_data.get("rounds", 1)
            if isinstance(n_rounds, list):
                n_rounds = len(n_rounds)
            if n_rounds >= 1:
                r1 = ReviewRound(
                    round_num=1,
                    findings_raw=findings.get("total_raw", 0),
                    findings_deduped=findings.get("deduplicated", 0),
                    by_severity=findings.get("by_severity", {}),
                    by_outcome=findings.get("by_outcome", {}),
                )
                status.rounds.append(r1)

        # Parse round-N.json files
        for rf_data in history.get("round_files", []):
            rn = rf_data.get("round", 0)
            r = ReviewRound(
                round_num=rn,
                findings_raw=rf_data.get("findings_raw", 0),
                findings_deduped=rf_data.get("findings_deduplicated", 0),
                by_outcome=rf_data.get("classification", {}),
                commit=rf_data.get("commit"),
            )
            # Compute severity from issues
            for issue in rf_data.get("issues", []):
                sev = issue.get("severity", "medium")
                r.by_severity[sev] = r.by_severity.get(sev, 0) + 1
            status.rounds.append(r)

        # Deduplicate rounds by number (rounds.json round 1 + round-1.json)
        seen = set()
        unique_rounds = []
        for r in sorted(status.rounds, key=lambda r: r.round_num):
            if r.round_num not in seen:
                seen.add(r.round_num)
                unique_rounds.append(r)
        status.rounds = unique_rounds

        # Find highlights from rounds.json issues
        issues = rounds_data.get("issues", []) if rounds_data else []
        fixes = [i for i in issues if i.get("outcome") == "fix"]
        noise = [i for i in issues if i.get("outcome") in ("noise", "false_positive")]

        if fixes:
            top = max(fixes, key=lambda i: len(i.get("agents", [])))
            status.top_finding = FindingHighlight(
                title=top.get("title", ""),
                severity=top.get("severity", "medium"),
                agents_count=len(top.get("agents", [])),
                outcome="fix",
            )

        if noise:
            top = max(noise, key=lambda i: len(i.get("agents", [])))
            status.top_noise = FindingHighlight(
                title=top.get("title", ""),
                severity=top.get("severity", "low"),
                agents_count=len(top.get("agents", [])),
                outcome=top.get("outcome", "noise"),
                reason=top.get("reason"),
            )

        # Consensus score: average number of unique agents per finding
        agent_counts = []
        for issue in issues:
            agents = issue.get("agents", [])
            # Count unique base agents (claude, codex, gemini) regardless of domain
            unique_agents = {a.split("-")[0] for a in agents}
            agent_counts.append(len(unique_agents))
        if agent_counts:
            status.consensus_score = sum(agent_counts) / len(agent_counts)

        # Signal per agent: parse agent field to get per-agent outcome counts
        agent_stats: dict[str, dict[str, int]] = {}
        for issue in issues:
            outcome = issue.get("outcome", "unknown")
            for agent_domain in issue.get("agents", []):
                agent = agent_domain.split("-")[0]  # "claude-architecture" → "claude"
                if agent not in agent_stats:
                    agent_stats[agent] = {}
                agent_stats[agent][outcome] = agent_stats[agent].get(outcome, 0) + 1
        status.signal_per_agent = agent_stats

    return status


# ── Formatting ─────────────────────────────────────────────────────────


def _fmt_duration(hours: float | None) -> str:
    if hours is None:
        return "—"
    if hours < 1:
        return f"{int(hours * 60)}m"
    if hours < 24:
        return f"{hours:.1f}h"
    days = int(hours // 24)
    remaining_h = hours % 24
    return f"{days}d {remaining_h:.0f}h"


def _state_icon(state: str) -> str:
    return {"merged": "\U0001f7e3", "open": "\U0001f7e2", "closed": "\U0001f534"}.get(state, "\u26aa")


def format_single_pr(s: PRStatus) -> str:
    """Format detailed single-PR dashboard."""
    lines = []

    # Header
    icon = _state_icon(s.state)
    lines.append(f"{icon} PR #{s.number}: {s.title}")
    lines.append("\u2500" * 60)

    # Metadata
    created = s.created_at[:10] if s.created_at else "?"
    lines.append(f"  Status: {s.state}  |  Author: {s.author}  |  Created: {created}")
    lines.append(f"  Files: {s.changed_files}  |  +{s.additions} / -{s.deletions}")
    if s.labels:
        lines.append(f"  Labels: {', '.join(s.labels)}")

    # Time metrics
    if s.time_to_merge_h is not None:
        lines.append(f"  Time to merge: {_fmt_duration(s.time_to_merge_h)}")
    if s.time_to_first_review_h is not None:
        lines.append(f"  Time to first review: {_fmt_duration(s.time_to_first_review_h)}")

    # Review rounds
    if s.rounds:
        lines.append("")
        lines.append("Review Rounds")
        lines.append("\u2500" * 60)
        for r in s.rounds:
            sev_str = "  ".join(
                f"{v}{k[0].upper()}" for k, v in sorted(
                    r.by_severity.items(),
                    key=lambda x: {"critical": 0, "high": 1, "medium": 2, "low": 3}.get(x[0], 9),
                ) if v
            )
            outcome_str = "  ".join(
                f"{v} {k}" for k, v in r.by_outcome.items() if v
            )
            raw_dedup = f"{r.findings_raw} raw \u2192 {r.findings_deduped} deduped" \
                if r.findings_raw else f"{r.findings_deduped} findings"
            commit_str = f" @ {r.commit}" if r.commit else ""
            lines.append(f"  Round {r.round_num}{commit_str}: {raw_dedup}")
            if sev_str:
                lines.append(f"    Severity: {sev_str}")
            if outcome_str:
                lines.append(f"    Outcome:  {outcome_str}")

        # Round-over-round improvement
        if len(s.rounds) >= 2:
            r1 = s.rounds[0]
            r_last = s.rounds[-1]
            delta = r_last.findings_deduped - r1.findings_deduped
            direction = "\u2193" if delta < 0 else "\u2191" if delta > 0 else "\u2192"
            lines.append(f"  Trend: {direction} {abs(delta)} findings (round 1 \u2192 round {r_last.round_num})")

    elif s.has_history:
        lines.append("")
        lines.append("Review Rounds")
        lines.append("\u2500" * 60)
        lines.append(f"  1 round  |  {s.total_findings_raw} raw \u2192 {s.total_findings_deduped} deduped")

    # Findings breakdown
    if s.total_findings_deduped or s.by_severity:
        lines.append("")
        lines.append("Findings")
        lines.append("\u2500" * 60)
        if s.by_severity:
            parts = []
            for sev in ("critical", "high", "medium", "low"):
                count = s.by_severity.get(sev, 0)
                if count:
                    icon = SEVERITY_ICONS.get(sev, "")
                    parts.append(f"{icon} {count} {sev}")
            lines.append(f"  {' | '.join(parts)}")
        if s.by_outcome:
            total = sum(s.by_outcome.values()) or 1
            parts = []
            for outcome in ("fix", "noise", "false_positive", "ignored"):
                count = s.by_outcome.get(outcome, 0)
                if count:
                    pct = int(count / total * 100)
                    parts.append(f"{count} {outcome} ({pct}%)")
            lines.append(f"  {' | '.join(parts)}")
            # Signal-to-noise
            signal = s.by_outcome.get("fix", 0)
            noise = s.by_outcome.get("noise", 0) + s.by_outcome.get("false_positive", 0)
            if signal + noise:
                ratio = signal / (signal + noise) * 100
                lines.append(f"  Signal-to-noise: {ratio:.0f}%")

    # Highlights
    if s.top_finding or s.top_noise:
        lines.append("")
        lines.append("Highlights")
        lines.append("\u2500" * 60)
        if s.top_finding:
            f = s.top_finding
            lines.append(f"  \u2b50 Top finding: {f.title}")
            lines.append(f"     {f.severity} | confirmed by {f.agents_count} agent(s)")
        if s.top_noise:
            n = s.top_noise
            lines.append(f"  \U0001f4a4 Top noise:   {n.title}")
            reason = f" \u2014 {n.reason}" if n.reason else ""
            lines.append(f"     {n.outcome} | flagged by {n.agents_count} agent(s){reason}")

    # Vibe-Coding KPIs
    kpi_lines = []
    if s.first_time_right is not None:
        icon = "\u2705" if s.first_time_right else "\U0001f504"
        label = "yes" if s.first_time_right else f"no ({s.human_review_cycles} human change request(s))"
        kpi_lines.append(f"  {icon} First-time-right: {label}")
    if s.human_oversight_h is not None:
        kpi_lines.append(f"  \u23f1\ufe0f  Human oversight time: {_fmt_duration(s.human_oversight_h)}")
    if s.consensus_score is not None:
        score = s.consensus_score
        quality = "high" if score >= 2.0 else "medium" if score >= 1.5 else "low"
        kpi_lines.append(f"  \U0001f91d Consensus score: {score:.1f} agents/finding ({quality} confidence)")
    if s.is_revert:
        kpi_lines.append(f"  \u26a0\ufe0f  This PR is a revert")
    if s.rework_of:
        prs = ", ".join(f"#{n}" for n in s.rework_of)
        kpi_lines.append(f"  \U0001f504 Rework: touches files recently changed in {prs}")
    if s.finding_acceptance.get("total_comments"):
        pos = s.finding_acceptance.get("positive", 0)
        neg = s.finding_acceptance.get("negative", 0)
        total = s.finding_acceptance["total_comments"]
        if pos or neg:
            kpi_lines.append(f"  \U0001f44d Finding reactions: {pos} positive, {neg} negative (across {total} bot comments)")
        else:
            kpi_lines.append(f"  \U0001f44d Finding reactions: none (across {total} bot comments)")
    if s.signal_per_agent:
        for agent, outcomes in sorted(s.signal_per_agent.items()):
            fixes = outcomes.get("fix", 0)
            total = sum(outcomes.values()) or 1
            ratio = int(fixes / total * 100)
            parts = [f"{v} {k}" for k, v in outcomes.items() if v]
            kpi_lines.append(f"  \U0001f4ca {agent}: {ratio}% signal ({', '.join(parts)})")

    if kpi_lines:
        lines.append("")
        lines.append("Vibe-Coding KPIs")
        lines.append("\u2500" * 60)
        lines.extend(kpi_lines)

    # Participants
    if s.participants:
        lines.append("")
        lines.append("Participants")
        lines.append("\u2500" * 60)
        humans = [p for p in s.participants if not p.is_bot]
        bots = [p for p in s.participants if p.is_bot]
        parts = []
        if humans:
            parts.append(f"{len(humans)} human(s)")
        if bots:
            parts.append(f"{len(bots)} bot(s)")
        lines.append(f"  {', '.join(parts)}")
        for p in s.participants:
            tag = " [bot]" if p.is_bot else ""
            actions = []
            if p.reviews:
                actions.append(f"{p.reviews} reviews")
            if p.approvals:
                actions.append(f"{p.approvals} approvals")
            if p.changes_requested:
                actions.append(f"{p.changes_requested} changes requested")
            if p.comments:
                actions.append(f"{p.comments} comments")
            lines.append(f"  {p.login}{tag}: {', '.join(actions) if actions else 'author'}")

    # Data sources
    if not s.has_history:
        lines.append("")
        lines.append("  \u26a0\ufe0f  No stark-team-review history found for this PR")

    return "\n".join(lines)


def format_table(statuses: list[PRStatus]) -> str:
    """Format all-PRs summary table."""
    lines = [
        f"PR Dashboard \u2014 {len(statuses)} PRs",
        "\u2500" * 80,
        "",
    ]

    # Summary stats
    merged = sum(1 for s in statuses if s.state == "merged")
    open_count = sum(1 for s in statuses if s.state == "open")
    closed = sum(1 for s in statuses if s.state == "closed")
    with_history = sum(1 for s in statuses if s.has_history)
    lines.append(f"  \U0001f7e2 {open_count} open  |  \U0001f7e3 {merged} merged  |  \U0001f534 {closed} closed  |  {with_history} reviewed by stark")
    lines.append("")

    # Table header
    lines.append(f"{'#':>5}  {'State':>7}  {'Title':<35}  {'Files':>5}  {'Find':>5}  {'Sig%':>4}  {'TTM':>6}  {'FTR':>3}  {'Cns':>3}  {'Rwk':>3}")
    lines.append("\u2500" * 100)

    for s in statuses:
        title = s.title[:33] + ".." if len(s.title) > 35 else s.title
        state_str = s.state
        findings = str(s.total_findings_deduped) if s.has_history else "\u2014"

        signal = "\u2014"
        if s.by_outcome:
            fix = s.by_outcome.get("fix", 0)
            total = sum(s.by_outcome.values()) or 1
            signal = f"{int(fix / total * 100)}"

        ttm = _fmt_duration(s.time_to_merge_h)
        ftr = "\u2714" if s.first_time_right else "\u2716" if s.first_time_right is False else "\u2014"
        cns = f"{s.consensus_score:.1f}" if s.consensus_score else "\u2014"
        rwk = str(len(s.rework_of)) if s.rework_of else "\u2014"

        lines.append(
            f"{s.number:>5}  {state_str:>7}  {title:<35}  {s.changed_files:>5}  {findings:>5}  {signal:>4}  {ttm:>6}  {ftr:>3}  {cns:>3}  {rwk:>3}"
        )

    # Aggregate metrics
    merge_times = [s.time_to_merge_h for s in statuses if s.time_to_merge_h is not None]
    if merge_times:
        import statistics as stats
        lines.append("")
        lines.append(f"Time to Merge: median {_fmt_duration(stats.median(merge_times))}  |  "
                      f"mean {_fmt_duration(stats.mean(merge_times))}  |  "
                      f"p90 {_fmt_duration(sorted(merge_times)[int(len(merge_times) * 0.9)])}")

    total_findings = sum(s.total_findings_deduped for s in statuses if s.has_history)
    total_fix = sum(s.by_outcome.get("fix", 0) for s in statuses)
    total_noise = sum(s.by_outcome.get("noise", 0) + s.by_outcome.get("false_positive", 0) for s in statuses)
    if total_findings:
        lines.append(f"Findings: {total_findings} total  |  {total_fix} fixes  |  {total_noise} noise  |  "
                      f"signal {int(total_fix / (total_fix + total_noise) * 100) if total_fix + total_noise else 0}%")

    # Vibe-coding KPI aggregates
    ftr_eligible = [s for s in statuses if s.first_time_right is not None]
    if ftr_eligible:
        ftr_count = sum(1 for s in ftr_eligible if s.first_time_right)
        ftr_pct = int(ftr_count / len(ftr_eligible) * 100)
        lines.append(f"First-Time-Right: {ftr_count}/{len(ftr_eligible)} ({ftr_pct}%)")

    consensus_scores = [s.consensus_score for s in statuses if s.consensus_score is not None]
    if consensus_scores:
        import statistics as stats
        lines.append(f"Consensus: mean {stats.mean(consensus_scores):.1f} agents/finding")

    rework_count = sum(1 for s in statuses if s.rework_of)
    if rework_count:
        lines.append(f"Rework: {rework_count}/{len(statuses)} PRs touch recently-changed files")

    revert_count = sum(1 for s in statuses if s.is_revert)
    if revert_count:
        lines.append(f"Reverts: {revert_count}/{len(statuses)} PRs are reverts")

    return "\n".join(lines)


# ── Main ───────────────────────────────────────────────────────────────


def main() -> None:
    parser = argparse.ArgumentParser(description="PR analytics dashboard")
    parser.add_argument("pr_number", nargs="?", type=int, help="PR number (omit for all)")
    parser.add_argument("--all", action="store_true", help="Show all PRs (default)")
    parser.add_argument("--repo", help="Override repo (org/name)")
    parser.add_argument("--state", default="all", choices=["open", "closed", "merged", "all"],
                        help="Filter by PR state")
    parser.add_argument("--limit", type=int, default=20, help="Max PRs to show")
    parser.add_argument("--json", action="store_true", dest="json_output", help="JSON output")
    args = parser.parse_args()

    repo = args.repo or detect_repo()
    if not repo:
        print("Could not detect repo. Use --repo org/name.", file=sys.stderr)
        sys.exit(1)

    try:
        token = _get_gh_token()
    except RuntimeError as e:
        print(f"GitHub auth failed: {e}", file=sys.stderr)
        sys.exit(3)

    if args.pr_number:
        # Single PR mode
        pr_data = _gh_api(f"repos/{repo}/pulls/{args.pr_number}", token)
        if not pr_data:
            print(f"PR #{args.pr_number} not found in {repo}", file=sys.stderr)
            sys.exit(2)

        status = analyze_pr(repo, pr_data, token)

        if args.json_output:
            print(json.dumps(asdict(status), indent=2, default=str))
        else:
            print(format_single_pr(status))
    else:
        # All PRs mode
        api_state = "all" if args.state in ("all", "merged") else args.state
        prs = _gh_api(
            f"repos/{repo}/pulls?state={api_state}&per_page={args.limit}&sort=updated&direction=desc",
            token,
        ) or []

        # Filter merged if requested
        if args.state == "merged":
            prs = [p for p in prs if p.get("merged_at")]
        elif args.state == "all":
            pass  # keep all

        if not prs:
            print(f"No PRs found in {repo} (state={args.state})", file=sys.stderr)
            sys.exit(0)

        statuses = []
        for pr_data in prs[:args.limit]:
            # For table view, get full PR data (list endpoint lacks additions/deletions)
            full_pr = _gh_api(f"repos/{repo}/pulls/{pr_data['number']}", token)
            if full_pr:
                status = analyze_pr(repo, full_pr, token)
                statuses.append(status)

        if args.json_output:
            print(json.dumps([asdict(s) for s in statuses], indent=2, default=str))
        else:
            print(format_table(statuses))


if __name__ == "__main__":
    main()
