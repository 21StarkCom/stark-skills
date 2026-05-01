"""Tests for red_team_audit.py — red-team-specific SQLite schema + writers."""

from __future__ import annotations

import json
import sqlite3
from dataclasses import asdict

import red_team_audit
import stark_red_team as rt


def _schema_bytes(db):
    conn = sqlite3.connect(str(db))
    try:
        rows = conn.execute("PRAGMA table_info(red_team_runs)").fetchall()
    finally:
        conn.close()
    return "\n".join("|".join("" if c is None else str(c) for c in row) for row in rows)


def _create_v1_runs_table(db):
    conn = sqlite3.connect(str(db))
    try:
        conn.executescript(
            """\
CREATE TABLE red_team_runs (
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
"""
        )
        conn.commit()
    finally:
        conn.close()


def _run():
    return {
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


def test_init_red_team_tables_migrates_runs_schema_idempotently(tmp_path):
    fresh = tmp_path / "fresh.db"
    red_team_audit.init_red_team_tables(fresh)
    red_team_audit.init_red_team_tables(fresh)
    expected = _schema_bytes(fresh)

    v1 = tmp_path / "v1.db"
    _create_v1_runs_table(v1)
    red_team_audit.init_red_team_tables(v1)
    red_team_audit.init_red_team_tables(v1)
    assert _schema_bytes(v1) == expected

    partial = tmp_path / "partial.db"
    _create_v1_runs_table(partial)
    conn = sqlite3.connect(str(partial))
    try:
        conn.execute("ALTER TABLE red_team_runs ADD COLUMN repo TEXT")
        conn.execute("ALTER TABLE red_team_runs ADD COLUMN artifact_relative_path TEXT")
        conn.execute("ALTER TABLE red_team_runs ADD COLUMN pr_number INTEGER")
        conn.commit()
    finally:
        conn.close()
    red_team_audit.init_red_team_tables(partial)
    red_team_audit.init_red_team_tables(partial)
    assert _schema_bytes(partial) == expected


def test_record_red_team_run_writes_run_row(tmp_path):
    db = tmp_path / "rt.db"
    red_team_audit.init_red_team_tables(db)
    run = _run()
    red_team_audit.record_red_team_run(run, db_path=db)
    conn = sqlite3.connect(str(db))
    try:
        row = conn.execute(
            "SELECT run_id, final_status, cost_usd, caller FROM red_team_runs"
        ).fetchone()
    finally:
        conn.close()
    assert row == (run["run_id"], "clean", 8.75, "forge")


def test_record_red_team_run_round_trips_v12_fields(tmp_path):
    db = tmp_path / "rt.db"
    red_team_audit.init_red_team_tables(db)
    run = {
        **_run(),
        "repo": "Evinced/stark-skills",
        "artifact_relative_path": "docs/plan.md",
        "pr_number": 42,
        "fix_plan_status": "pending",
    }
    red_team_audit.record_red_team_run(run, db_path=db)
    conn = sqlite3.connect(str(db))
    try:
        row = conn.execute(
            "SELECT repo, artifact_relative_path, pr_number, fix_plan_status "
            "FROM red_team_runs WHERE run_id = ?",
            (run["run_id"],),
        ).fetchone()
    finally:
        conn.close()
    assert row == ("Evinced/stark-skills", "docs/plan.md", 42, "pending")


def test_pending_fix_plan_status_survives_recovery_reinit(tmp_path):
    db = tmp_path / "rt.db"
    red_team_audit.init_red_team_tables(db)
    red_team_audit.record_red_team_run(_run(), db_path=db, fix_plan_status="pending")

    red_team_audit.init_red_team_tables(db)
    conn = sqlite3.connect(str(db))
    try:
        row = conn.execute(
            "SELECT fix_plan_status, fix_plan_json FROM red_team_runs"
        ).fetchone()
    finally:
        conn.close()
    assert row == ("pending", None)


def test_record_finding_persists_single_row_with_event_keys(tmp_path):
    db = tmp_path / "rt.db"
    red_team_audit.init_red_team_tables(db)
    red_team_audit.record_finding(
        run_id="run1",
        stage="design",
        round_num=2,
        finding_id="rt7",
        persona="data-integrity",
        severity="high",
        concern="Local audit is not durable before event emission",
        consequence="Backfill can miss findings after a crash.",
        counter_proposal="Insert finding before enqueueing the event.",
        trade_off=None,
        reason_for_uncertainty="Depends on Phase 5 ordering.",
        db_path=db,
    )
    conn = sqlite3.connect(str(db))
    try:
        row = conn.execute(
            "SELECT run_id, finding_id, severity, concern FROM red_team_findings"
        ).fetchone()
    finally:
        conn.close()
    assert row == (
        "run1",
        "rt7",
        "high",
        "Local audit is not durable before event emission",
    )


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


def test_record_fix_plan_updates_existing_run_and_strips_raw_output(tmp_path):
    db = tmp_path / "rt.db"
    red_team_audit.init_red_team_tables(db)
    run = _run()
    red_team_audit.record_red_team_run(run, db_path=db)
    plan = rt.RedTeamFixPlan(
        summary="Use a single durable write path.",
        moves=[
            rt.FixPlanMove(
                "m1",
                "Persist before emission",
                "Crash recovery needs local state.",
                ["Phase 5"],
                ["rt1"],
                "One extra SQLite write.",
            )
        ],
        unaddressed_finding_ids=[],
        orphan_finding_ids=["rt-orphan"],
        notes="",
        input_truncated=False,
        input_omitted_finding_ids=[],
        warnings=["kept bounded"],
        raw_output='{"attacker":"echo"}',
        duration_s=3.5,
        cost_usd=0.12,
        input_tokens=100,
        output_tokens=50,
        model="gpt-5.5-pro",
        reasoning_effort="xhigh",
    )

    red_team_audit.record_fix_plan(
        run["run_id"],
        fix_plan_md="## Proposed Fix Plan",
        fix_plan_json=json.dumps(asdict(plan)),
        fix_plan_cost_usd=plan.cost_usd,
        fix_plan_status="success",
        db_path=db,
    )

    conn = sqlite3.connect(str(db))
    try:
        row = conn.execute(
            "SELECT fix_plan_status, fix_plan_md, fix_plan_json, fix_plan_cost_usd "
            "FROM red_team_runs WHERE run_id = ?",
            (run["run_id"],),
        ).fetchone()
    finally:
        conn.close()
    parsed = json.loads(row[2])
    reconstructed = rt.RedTeamFixPlan(
        **{**parsed, "moves": [rt.FixPlanMove(**m) for m in parsed["moves"]], "raw_output": ""}
    )
    assert row[:2] == ("success", "## Proposed Fix Plan")
    assert row[3] == 0.12
    assert "raw_output" not in parsed
    assert reconstructed.summary == plan.summary
    assert reconstructed.orphan_finding_ids == ["rt-orphan"]
    assert reconstructed.warnings == ["kept bounded"]
    assert reconstructed.model == "gpt-5.5-pro"


def test_record_fix_plan_status_values_and_missing_parent_error(tmp_path):
    db = tmp_path / "rt.db"
    red_team_audit.init_red_team_tables(db)
    statuses = ["success", "error", "skipped_disabled", "skipped_no_blocking_findings"]
    for status in statuses:
        run = {**_run(), "run_id": f"run-{status}"}
        red_team_audit.record_red_team_run(run, db_path=db)
        red_team_audit.record_fix_plan(
            run["run_id"],
            fix_plan_md=None,
            fix_plan_json=None,
            fix_plan_cost_usd=None,
            fix_plan_status=status,
            db_path=db,
        )

    conn = sqlite3.connect(str(db))
    try:
        rows = [
            r[0]
            for r in conn.execute(
                "SELECT fix_plan_status FROM red_team_runs ORDER BY run_id"
            ).fetchall()
        ]
    finally:
        conn.close()
    assert rows == ["error", "skipped_disabled", "skipped_no_blocking_findings", "success"]

    try:
        red_team_audit.record_fix_plan(
            "missing",
            fix_plan_md=None,
            fix_plan_json=None,
            fix_plan_cost_usd=None,
            fix_plan_status="error",
            db_path=db,
        )
    except RuntimeError as exc:
        assert "run_id='missing'" in str(exc)
    else:
        raise AssertionError("record_fix_plan should reject missing parent run")


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
