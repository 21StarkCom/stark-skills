"""SQLite audit module for the stark-red-team pipeline.

Tables:
- red_team_runs: one row per full red-team cycle (caller-agnostic)
- red_team_persona_stats: per-persona per-round aggregate counts
- red_team_findings: raw finding text (rt3 — enables persona tuning)

Uses audit_base for low-level plumbing. DB shares forged_review_metrics.db
so cross-skill dashboards have a single source of truth.
"""

from __future__ import annotations

import json
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
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    repo TEXT,
    artifact_relative_path TEXT,
    pr_number INTEGER,
    fix_plan_status TEXT,
    fix_plan_md TEXT,
    fix_plan_json TEXT,
    fix_plan_cost_usd REAL
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

_RED_TEAM_RUNS_V12_COLUMNS = (
    ("repo", "TEXT"),
    ("artifact_relative_path", "TEXT"),
    ("pr_number", "INTEGER"),
    ("fix_plan_status", "TEXT"),
    ("fix_plan_md", "TEXT"),
    ("fix_plan_json", "TEXT"),
    ("fix_plan_cost_usd", "REAL"),
)


def init_red_team_tables(db_path: str | Path = DEFAULT_DB_PATH) -> None:
    """Create and migrate the red_team tables if they don't exist."""
    audit_base.init_db(db_path, _CREATE_TABLES)
    _migrate_red_team_runs_v12(db_path)


def _migrate_red_team_runs_v12(db_path: str | Path) -> None:
    """Add v1.2 red_team_runs columns one-by-one for idempotent recovery."""
    conn = audit_base.connect(db_path)
    try:
        existing = {
            row[1] for row in conn.execute("PRAGMA table_info(red_team_runs)").fetchall()
        }
        for name, decl in _RED_TEAM_RUNS_V12_COLUMNS:
            if name not in existing:
                conn.execute(f"ALTER TABLE red_team_runs ADD COLUMN {name} {decl}")
                existing.add(name)
        conn.commit()
    finally:
        conn.close()


def record_red_team_run(
    run_data: dict[str, Any],
    db_path: str | Path = DEFAULT_DB_PATH,
    *,
    repo: str | None = None,
    artifact_relative_path: str | None = None,
    pr_number: int | None = None,
    fix_plan_status: str | None = "pending",
    fix_plan_md: str | None = None,
    fix_plan_json: str | None = None,
    fix_plan_cost_usd: float | None = None,
) -> None:
    """Insert one red_team_runs row."""
    repo = run_data.get("repo", repo)
    artifact_relative_path = run_data.get(
        "artifact_relative_path", artifact_relative_path
    )
    pr_number = run_data.get("pr_number", pr_number)
    fix_plan_status = run_data.get("fix_plan_status", fix_plan_status)
    fix_plan_md = run_data.get("fix_plan_md", fix_plan_md)
    fix_plan_json = _sanitize_fix_plan_json(
        run_data.get("fix_plan_json", fix_plan_json)
    )
    fix_plan_cost_usd = run_data.get("fix_plan_cost_usd", fix_plan_cost_usd)

    conn = audit_base.connect(db_path)
    try:
        conn.execute(
            "INSERT INTO red_team_runs (run_id, stage, rounds_used, final_status, "
            "total_findings, critical_count, high_count, medium_count, "
            "human_review_count, duration_s, cost_usd, model, caller, repo, "
            "artifact_relative_path, pr_number, fix_plan_status, fix_plan_md, "
            "fix_plan_json, fix_plan_cost_usd) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
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
                repo,
                artifact_relative_path,
                pr_number,
                fix_plan_status,
                fix_plan_md,
                fix_plan_json,
                fix_plan_cost_usd,
            ),
        )
        conn.commit()
    finally:
        conn.close()


def record_finding(
    *,
    run_id: str,
    stage: str,
    round_num: int,
    finding_id: str,
    persona: str,
    severity: str,
    concern: str,
    consequence: str,
    counter_proposal: str,
    trade_off: str | None,
    reason_for_uncertainty: str | None,
    db_path: str | Path = DEFAULT_DB_PATH,
) -> None:
    """Insert one durable red_team_findings row."""
    conn = audit_base.connect(db_path)
    try:
        conn.execute(
            "INSERT INTO red_team_findings (run_id, stage, round_num, finding_id, "
            "persona, severity, concern, consequence, counter_proposal, "
            "trade_off, reason_for_uncertainty) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                run_id,
                stage,
                round_num,
                finding_id,
                persona,
                severity,
                concern,
                consequence,
                counter_proposal,
                trade_off,
                reason_for_uncertainty,
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


def record_fix_plan(
    run_id: str,
    *,
    fix_plan_md: str | None,
    fix_plan_json: str | None,
    fix_plan_cost_usd: float | None,
    fix_plan_status: str,
    db_path: str | Path = DEFAULT_DB_PATH,
) -> None:
    """Update the persisted fix-plan state for an existing red-team run."""
    sanitized_json = _sanitize_fix_plan_json(fix_plan_json)
    conn = audit_base.connect(db_path)
    try:
        cur = conn.execute(
            "UPDATE red_team_runs "
            "SET fix_plan_md = ?, fix_plan_json = ?, fix_plan_cost_usd = ?, "
            "fix_plan_status = ? "
            "WHERE run_id = ?",
            (
                fix_plan_md,
                sanitized_json,
                fix_plan_cost_usd,
                fix_plan_status,
                run_id,
            ),
        )
        if cur.rowcount != 1:
            raise RuntimeError(f"red_team_runs row not found for run_id={run_id!r}")
        conn.commit()
    finally:
        conn.close()


def _sanitize_fix_plan_json(fix_plan_json: str | None) -> str | None:
    """Remove raw_output from serialized fix-plan JSON before audit storage."""
    if fix_plan_json is None:
        return None
    parsed = json.loads(fix_plan_json)
    if isinstance(parsed, dict):
        parsed.pop("raw_output", None)
        return json.dumps(parsed, separators=(",", ":"), sort_keys=True)
    return fix_plan_json


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
