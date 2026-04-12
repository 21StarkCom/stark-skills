"""SQLite audit module for the stark-red-team pipeline.

Tables:
- red_team_runs: one row per full red-team cycle (caller-agnostic)
- red_team_persona_stats: per-persona per-round aggregate counts
- red_team_findings: raw finding text (rt3 — enables persona tuning)

Uses audit_base for low-level plumbing. DB shares forged_review_metrics.db
so cross-skill dashboards have a single source of truth.
"""

from __future__ import annotations

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


_CREATE_TABLES = """\
CREATE TABLE IF NOT EXISTS red_team_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    stage TEXT NOT NULL,
    rounds_used INTEGER NOT NULL,
    final_status TEXT NOT NULL,
    total_findings INTEGER NOT NULL,
    critical_count INTEGER NOT NULL,
    high_count INTEGER NOT NULL,
    medium_count INTEGER NOT NULL,
    human_review_count INTEGER NOT NULL,
    duration_s REAL NOT NULL,
    cost_usd REAL NOT NULL,
    model TEXT NOT NULL,
    caller TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE TABLE IF NOT EXISTS red_team_persona_stats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    stage TEXT NOT NULL,
    round_num INTEGER NOT NULL,
    persona TEXT NOT NULL,
    findings_raised INTEGER NOT NULL,
    findings_at_critical INTEGER NOT NULL,
    findings_at_high INTEGER NOT NULL,
    findings_at_medium INTEGER NOT NULL,
    human_review_requests INTEGER NOT NULL,
    version INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS red_team_findings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    stage TEXT NOT NULL,
    round_num INTEGER NOT NULL,
    finding_id TEXT NOT NULL,
    persona TEXT NOT NULL,
    severity TEXT NOT NULL,
    concern TEXT NOT NULL,
    consequence TEXT NOT NULL,
    counter_proposal TEXT NOT NULL,
    trade_off TEXT,
    reason_for_uncertainty TEXT,
    version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_red_team_findings_run
    ON red_team_findings(run_id, round_num);
CREATE INDEX IF NOT EXISTS idx_red_team_findings_persona
    ON red_team_findings(persona, severity);
"""


def init_red_team_tables(db_path: str | Path = DEFAULT_DB_PATH) -> None:
    """Create the red_team tables if they don't exist."""
    audit_base.init_db(db_path, _CREATE_TABLES)


def record_red_team_run(
    run_data: dict[str, Any],
    db_path: str | Path = DEFAULT_DB_PATH,
) -> None:
    """Insert one red_team_runs row."""
    conn = audit_base.connect(db_path)
    try:
        conn.execute(
            "INSERT INTO red_team_runs (run_id, stage, rounds_used, final_status, "
            "total_findings, critical_count, high_count, medium_count, "
            "human_review_count, duration_s, cost_usd, model, caller) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                run_data["run_id"],
                run_data["stage"],
                run_data["rounds_used"],
                run_data["final_status"],
                run_data["total_findings"],
                run_data["critical_count"],
                run_data["high_count"],
                run_data["medium_count"],
                run_data["human_review_count"],
                run_data["duration_s"],
                run_data["cost_usd"],
                run_data["model"],
                run_data["caller"],
            ),
        )
        conn.commit()
    finally:
        conn.close()


def record_findings(
    findings: list[dict[str, Any]],
    db_path: str | Path = DEFAULT_DB_PATH,
) -> None:
    """Insert raw finding rows."""
    conn = audit_base.connect(db_path)
    try:
        for f in findings:
            conn.execute(
                "INSERT INTO red_team_findings (run_id, stage, round_num, finding_id, "
                "persona, severity, concern, consequence, counter_proposal, "
                "trade_off, reason_for_uncertainty) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    f["run_id"],
                    f["stage"],
                    f["round_num"],
                    f["finding_id"],
                    f["persona"],
                    f["severity"],
                    f["concern"],
                    f["consequence"],
                    f["counter_proposal"],
                    f.get("trade_off"),
                    f.get("reason_for_uncertainty"),
                ),
            )
        conn.commit()
    finally:
        conn.close()


def record_persona_stats(
    stats: list[dict[str, Any]],
    db_path: str | Path = DEFAULT_DB_PATH,
) -> None:
    """Insert per-persona stat rows."""
    conn = audit_base.connect(db_path)
    try:
        for s in stats:
            conn.execute(
                "INSERT INTO red_team_persona_stats (run_id, stage, round_num, persona, "
                "findings_raised, findings_at_critical, findings_at_high, "
                "findings_at_medium, human_review_requests) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    s["run_id"],
                    s["stage"],
                    s["round_num"],
                    s["persona"],
                    s["findings_raised"],
                    s["findings_at_critical"],
                    s["findings_at_high"],
                    s["findings_at_medium"],
                    s["human_review_requests"],
                ),
            )
        conn.commit()
    finally:
        conn.close()


def prune_red_team_metrics(
    retention_days: int = 180,
    db_path: str | Path = DEFAULT_DB_PATH,
) -> int:
    """Delete rows older than retention_days. Returns total rows deleted."""
    conn = audit_base.connect(db_path)
    try:
        cutoff = f"-{retention_days} days"
        r1 = conn.execute(
            "DELETE FROM red_team_runs WHERE created_at < "
            "strftime('%Y-%m-%dT%H:%M:%SZ', 'now', ?)",
            (cutoff,),
        ).rowcount
        r2 = conn.execute(
            "DELETE FROM red_team_findings WHERE created_at < "
            "strftime('%Y-%m-%dT%H:%M:%SZ', 'now', ?)",
            (cutoff,),
        ).rowcount
        conn.commit()
    finally:
        conn.close()
    return r1 + r2
