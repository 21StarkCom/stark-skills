"""Tests for red_team_audit.py — red-team-specific SQLite schema + writers."""

from __future__ import annotations

import sqlite3

import red_team_audit


def test_init_red_team_tables_creates_all_three(tmp_path):
    db = tmp_path / "rt.db"
    red_team_audit.init_red_team_tables(db)
    conn = sqlite3.connect(str(db))
    try:
        tables = {
            r[0]
            for r in conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table'"
            ).fetchall()
        }
    finally:
        conn.close()
    assert {"red_team_runs", "red_team_persona_stats", "red_team_findings"}.issubset(tables)


def test_record_red_team_run_writes_run_row(tmp_path):
    db = tmp_path / "rt.db"
    red_team_audit.init_red_team_tables(db)
    run = {
        "run_id": "forge-2026-04-12T10-14-00Z-a1b2c3d",
        "stage": "design",
        "rounds_used": 2,
        "final_status": "clean",
        "total_findings": 7,
        "critical_count": 1,
        "high_count": 2,
        "medium_count": 4,
        "human_review_count": 0,
        "duration_s": 42.5,
        "cost_usd": 8.75,
        "model": "o3",
        "caller": "forge",
    }
    red_team_audit.record_red_team_run(run, db_path=db)
    conn = sqlite3.connect(str(db))
    try:
        row = conn.execute(
            "SELECT run_id, final_status, cost_usd, caller FROM red_team_runs"
        ).fetchone()
    finally:
        conn.close()
    assert row == (run["run_id"], "clean", 8.75, "forge")


def test_record_findings_persists_raw_text(tmp_path):
    db = tmp_path / "rt.db"
    red_team_audit.init_red_team_tables(db)
    findings = [
        {
            "run_id": "r1",
            "stage": "design",
            "round_num": 1,
            "finding_id": "rt1",
            "persona": "security-trust",
            "severity": "critical",
            "concern": "SQL injection in user handler",
            "consequence": "Attackers can exfiltrate all user data.",
            "counter_proposal": "Use parameterized queries via the ORM.",
            "trade_off": "Slightly slower query construction.",
            "reason_for_uncertainty": None,
        }
    ]
    red_team_audit.record_findings(findings, db_path=db)
    conn = sqlite3.connect(str(db))
    try:
        rows = conn.execute(
            "SELECT persona, severity, concern, counter_proposal FROM red_team_findings"
        ).fetchall()
    finally:
        conn.close()
    assert len(rows) == 1
    assert rows[0] == ("security-trust", "critical", "SQL injection in user handler",
                       "Use parameterized queries via the ORM.")


def test_record_findings_handles_human_review_form(tmp_path):
    db = tmp_path / "rt.db"
    red_team_audit.init_red_team_tables(db)
    findings = [
        {
            "run_id": "r1",
            "stage": "design",
            "round_num": 1,
            "finding_id": "rt2",
            "persona": "reliability-distsys",
            "severity": "high",
            "concern": "Retry semantics unclear in the dispatch layer",
            "consequence": "Intermittent failures could compound silently.",
            "counter_proposal": "REQUEST_HUMAN_REVIEW",
            "trade_off": None,
            "reason_for_uncertainty": "Retry policy depends on context not in this design.",
        }
    ]
    red_team_audit.record_findings(findings, db_path=db)
    conn = sqlite3.connect(str(db))
    try:
        row = conn.execute(
            "SELECT counter_proposal, reason_for_uncertainty FROM red_team_findings"
        ).fetchone()
    finally:
        conn.close()
    assert row == ("REQUEST_HUMAN_REVIEW", "Retry policy depends on context not in this design.")


def test_record_persona_stats(tmp_path):
    db = tmp_path / "rt.db"
    red_team_audit.init_red_team_tables(db)
    stats = [
        {
            "run_id": "r1",
            "stage": "design",
            "round_num": 1,
            "persona": "security-trust",
            "findings_raised": 3,
            "findings_at_critical": 1,
            "findings_at_high": 2,
            "findings_at_medium": 0,
            "human_review_requests": 0,
        }
    ]
    red_team_audit.record_persona_stats(stats, db_path=db)
    conn = sqlite3.connect(str(db))
    try:
        row = conn.execute(
            "SELECT persona, findings_raised, findings_at_critical FROM red_team_persona_stats"
        ).fetchone()
    finally:
        conn.close()
    assert row == ("security-trust", 3, 1)


def test_prune_removes_old_runs(tmp_path):
    db = tmp_path / "rt.db"
    red_team_audit.init_red_team_tables(db)
    conn = sqlite3.connect(str(db))
    try:
        conn.execute(
            "INSERT INTO red_team_runs (run_id, stage, rounds_used, final_status, "
            "total_findings, critical_count, high_count, medium_count, "
            "human_review_count, duration_s, cost_usd, model, caller, created_at) "
            "VALUES ('old', 'design', 1, 'clean', 0, 0, 0, 0, 0, 1.0, 1.0, 'o3', 'forge', "
            "strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-200 days'))"
        )
        conn.execute(
            "INSERT INTO red_team_runs (run_id, stage, rounds_used, final_status, "
            "total_findings, critical_count, high_count, medium_count, "
            "human_review_count, duration_s, cost_usd, model, caller, created_at) "
            "VALUES ('new', 'design', 1, 'clean', 0, 0, 0, 0, 0, 1.0, 1.0, 'o3', 'forge', "
            "strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))"
        )
        conn.commit()
    finally:
        conn.close()

    deleted = red_team_audit.prune_red_team_metrics(retention_days=180, db_path=db)
    assert deleted >= 1

    conn = sqlite3.connect(str(db))
    try:
        remaining = [r[0] for r in conn.execute("SELECT run_id FROM red_team_runs").fetchall()]
    finally:
        conn.close()
    assert remaining == ["new"]
