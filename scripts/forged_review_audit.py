"""Audit and metrics module for the stark-forged-review pipeline.

Schema is intentionally separate from `forge_audit`: forged-review tracks
per-run path (light/forge), per-round mode (full/delta), leader+second
agent pairs per domain, and per-finding verdicts
(confirmed/disputed/leader_only/second_only).

Uses `audit_base` for low-level SQLite + JSONL plumbing.

DB location: ~/.claude/code-review/history/forged-review/forged_review_metrics.db
JSONL calls: ~/.claude/code-review/history/forged-review/{org}/{repo}/{pr}/calls.jsonl
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import audit_base

DEFAULT_DB_PATH = (
    Path.home()
    / ".claude"
    / "code-review"
    / "history"
    / "forged-review"
    / "forged_review_metrics.db"
)


@dataclass
class DomainCall:
    """Record for a single agent invocation on a domain in a given round."""

    run_id: str
    pr_number: int
    repo: str
    round_num: int
    round_mode: str  # "full" | "delta"
    domain: str
    agent: str
    role: str  # "leader" | "second"
    duration_s: float
    finding_count: int
    error: str | None = None
    timestamp: float = field(default_factory=audit_base.now_ts)


_CREATE_TABLES = """\
CREATE TABLE IF NOT EXISTS runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL UNIQUE,
    repo TEXT NOT NULL,
    pr_number INTEGER NOT NULL,
    path TEXT NOT NULL,              -- "light" | "forge"
    total_rounds INTEGER NOT NULL,
    total_actionable INTEGER NOT NULL,
    total_critical INTEGER NOT NULL,
    merge_outcome TEXT NOT NULL,     -- "merged" | "declined" | "halted" | "dry_run"
    duration_s REAL NOT NULL,
    invocation_source TEXT NOT NULL DEFAULT 'unknown', -- "explicit" | "auto" | "resume" | "unknown"
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE TABLE IF NOT EXISTS rounds (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    round_num INTEGER NOT NULL,
    mode TEXT NOT NULL,              -- "full" | "delta"
    domains_run TEXT NOT NULL,       -- comma-separated domain slugs
    actionable_count INTEGER NOT NULL,
    critical_count INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE TABLE IF NOT EXISTS domain_calls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    round_num INTEGER NOT NULL,
    domain TEXT NOT NULL,
    agent TEXT NOT NULL,
    role TEXT NOT NULL,              -- "leader" | "second"
    duration_s REAL NOT NULL,
    finding_count INTEGER NOT NULL,
    error TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE TABLE IF NOT EXISTS finding_verdicts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    round_num INTEGER NOT NULL,
    domain TEXT NOT NULL,
    leader_agent TEXT NOT NULL,
    second_agent TEXT NOT NULL,
    severity TEXT NOT NULL,
    verdict TEXT NOT NULL,           -- "confirmed" | "disputed" | "leader_only" | "second_only"
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
"""


def init_metrics_db(db_path: str | Path = DEFAULT_DB_PATH) -> None:
    """Create the forged_review metrics tables if they don't exist.

    Also runs idempotent schema migrations for columns added after the
    initial release: existing DBs get ALTER TABLE ADD COLUMN so they
    don't need to be dropped and recreated on upgrade.
    """
    audit_base.init_db(db_path, _CREATE_TABLES)

    # Schema migration: add invocation_source column if missing.
    conn = audit_base.connect(db_path)
    try:
        existing_cols = {
            row[1] for row in conn.execute("PRAGMA table_info(runs)").fetchall()
        }
        if "invocation_source" not in existing_cols:
            conn.execute(
                "ALTER TABLE runs ADD COLUMN invocation_source TEXT "
                "NOT NULL DEFAULT 'unknown'"
            )
            conn.commit()
    finally:
        conn.close()

    # Red team tables live in the same DB for cross-skill queries.
    try:
        import red_team_audit
        red_team_audit.init_red_team_tables(db_path)
    except ImportError:
        pass  # red_team_audit optional in older installs


def record_domain_call(
    jsonl_path: str | Path, call: DomainCall
) -> None:
    """Append a single domain-call record as a JSONL line."""
    audit_base.append_jsonl(jsonl_path, call)


def record_run(
    run_data: dict[str, Any],
    db_path: str | Path = DEFAULT_DB_PATH,
) -> None:
    """Insert a run, its rounds, domain_calls, and finding_verdicts.

    Expected run_data keys:
        run_id, repo, pr_number, path, total_rounds, total_actionable,
        total_critical, merge_outcome, duration_s,
        rounds (list), domain_calls (list), finding_verdicts (list)
    """
    conn = audit_base.connect(db_path)
    try:
        conn.execute(
            "INSERT OR REPLACE INTO runs "
            "(run_id, repo, pr_number, path, total_rounds, total_actionable, "
            " total_critical, merge_outcome, duration_s, invocation_source) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                run_data["run_id"],
                run_data["repo"],
                run_data["pr_number"],
                run_data["path"],
                run_data["total_rounds"],
                run_data["total_actionable"],
                run_data["total_critical"],
                run_data["merge_outcome"],
                run_data["duration_s"],
                run_data.get("invocation_source", "unknown"),
            ),
        )
        for rnd in run_data.get("rounds", []):
            conn.execute(
                "INSERT INTO rounds (run_id, round_num, mode, domains_run, "
                "actionable_count, critical_count) VALUES (?, ?, ?, ?, ?, ?)",
                (
                    run_data["run_id"],
                    rnd["round_num"],
                    rnd["mode"],
                    ",".join(rnd.get("domains_run", [])),
                    rnd["actionable_count"],
                    rnd["critical_count"],
                ),
            )
        for call in run_data.get("domain_calls", []):
            conn.execute(
                "INSERT INTO domain_calls (run_id, round_num, domain, agent, "
                "role, duration_s, finding_count, error) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    run_data["run_id"],
                    call["round_num"],
                    call["domain"],
                    call["agent"],
                    call["role"],
                    call["duration_s"],
                    call["finding_count"],
                    call.get("error"),
                ),
            )
        for verdict in run_data.get("finding_verdicts", []):
            conn.execute(
                "INSERT INTO finding_verdicts (run_id, round_num, domain, "
                "leader_agent, second_agent, severity, verdict) "
                "VALUES (?, ?, ?, ?, ?, ?, ?)",
                (
                    run_data["run_id"],
                    verdict["round_num"],
                    verdict["domain"],
                    verdict["leader_agent"],
                    verdict["second_agent"],
                    verdict["severity"],
                    verdict["verdict"],
                ),
            )
        conn.commit()
    finally:
        conn.close()


def get_invocation_source_counts(
    db_path: str | Path = DEFAULT_DB_PATH,
    since_days: int | None = None,
) -> dict[str, int]:
    """Return counts of runs grouped by invocation_source.

    Useful for answering "how often is /stark-forged-review being
    auto-invoked by subagents vs explicitly typed by a human?". The
    data is only meaningful to the extent callers pass --via when
    invoking the orchestrator; rows without it land in 'unknown'.
    """
    conn = audit_base.connect(db_path)
    try:
        if since_days is not None:
            rows = conn.execute(
                "SELECT invocation_source, COUNT(*) FROM runs "
                "WHERE created_at >= datetime('now', ?) "
                "GROUP BY invocation_source",
                (f"-{int(since_days)} days",),
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT invocation_source, COUNT(*) FROM runs "
                "GROUP BY invocation_source"
            ).fetchall()
    finally:
        conn.close()
    return {row[0] or "unknown": row[1] for row in rows}


def get_disagreement_rate(
    domain: str,
    db_path: str | Path = DEFAULT_DB_PATH,
    last_n: int = 50,
) -> float:
    """Fraction of recent findings where leader+second disagreed.

    Disagreement = verdict in ('disputed', 'leader_only', 'second_only').
    Agreement = verdict == 'confirmed'.
    Returns 0.0 if no data.
    """
    conn = audit_base.connect(db_path)
    try:
        row = conn.execute(
            "SELECT COUNT(*), SUM(CASE WHEN verdict='confirmed' THEN 0 ELSE 1 END) "
            "FROM (SELECT verdict FROM finding_verdicts WHERE domain = ? "
            "ORDER BY id DESC LIMIT ?)",
            (domain, last_n),
        ).fetchone()
    finally:
        conn.close()

    if not row or row[0] == 0:
        return 0.0
    total, disagree = row
    return (disagree or 0) / total
