"""Tests for red_team_backfill.py — local SQLite to insights queue backfill."""

from __future__ import annotations

import json
import sqlite3
from dataclasses import asdict

import red_team_audit
import red_team_backfill
import red_team_insights
import stark_red_team as rt


TS_LEGACY = "2026-04-01T00:00:00Z"
TS_FORWARD = "2026-05-01T00:00:00Z"


def _run(run_id: str, *, status: str | None, created_at: str) -> dict:
    return {
        "run_id": run_id,
        "stage": "design",
        "rounds_used": 1,
        "final_status": "halted",
        "total_findings": 2,
        "critical_count": 0,
        "high_count": 1,
        "medium_count": 1,
        "human_review_count": 1,
        "duration_s": 12.5,
        "cost_usd": 1.25,
        "model": "gpt-5.5-pro",
        "caller": "manual",
        "repo": "Evinced/stark-skills",
        "artifact_relative_path": "docs/plan.md",
        "pr_number": 42,
        "fix_plan_status": status,
        "created_at": created_at,
    }


def _move() -> rt.FixPlanMove:
    return rt.FixPlanMove(
        id="m1",
        title="Add deployment gate",
        rationale="Track B must accept event types before drain.",
        sections_touched=["Phase 11"],
        addressed_finding_ids=["rt1"],
        new_trade_off="Adds rollout sequencing.",
    )


def _fix_plan() -> rt.RedTeamFixPlan:
    return rt.RedTeamFixPlan(
        summary="Gate cloud emission before enabling red-team events.",
        moves=[_move()],
        unaddressed_finding_ids=["rt2"],
        orphan_finding_ids=["orphan-1"],
        notes="Use the Phase 11 gate.",
        input_truncated=True,
        input_omitted_finding_ids=["rt9"],
        warnings=["input was truncated"],
        raw_output="{}",
        duration_s=7.0,
        cost_usd=2.0,
        input_tokens=100,
        output_tokens=50,
        model="gpt-5.5-pro",
        reasoning_effort="xhigh",
    )


def _seed_run(db, run: dict, *, fix_plan_json: str | None = None, fix_plan_md: str | None = None):
    red_team_audit.record_red_team_run(
        run,
        db_path=db,
        fix_plan_status=run["fix_plan_status"],
        fix_plan_json=fix_plan_json,
        fix_plan_md=fix_plan_md,
        fix_plan_cost_usd=2.0 if fix_plan_json else None,
    )
    conn = sqlite3.connect(str(db))
    try:
        conn.execute(
            "UPDATE red_team_runs SET created_at = ? WHERE run_id = ?",
            (run["created_at"], run["run_id"]),
        )
        conn.commit()
    finally:
        conn.close()
    red_team_audit.record_findings(
        [
            {
                "run_id": run["run_id"],
                "stage": run["stage"],
                "round_num": 1,
                "finding_id": "rt1",
                "persona": "reliability-distsys",
                "severity": "high",
                "concern": "Events can drain before schemas are deployed.",
                "consequence": "The cloud service dead-letters valid telemetry.",
                "counter_proposal": "Deploy lifters before producer emission.",
                "trade_off": "Requires a rollout gate.",
                "reason_for_uncertainty": None,
            },
            {
                "run_id": run["run_id"],
                "stage": run["stage"],
                "round_num": 1,
                "finding_id": "rt2",
                "persona": "security-trust",
                "severity": "medium",
                "concern": "Rollback scope is ambiguous.",
                "consequence": "Operators may delete unrelated rows.",
                "counter_proposal": rt.REQUEST_HUMAN_REVIEW,
                "trade_off": None,
                "reason_for_uncertainty": "Rollback process depends on cloud state.",
            },
        ],
        db_path=db,
    )


def _fixture_db(tmp_path):
    db = tmp_path / "rt.db"
    red_team_audit.init_red_team_tables(db)
    _seed_run(db, _run("legacy-run", status=None, created_at=TS_LEGACY))
    _seed_run(
        db,
        _run("forward-run", status="success", created_at=TS_FORWARD),
        fix_plan_json=json.dumps(asdict(_fix_plan()), sort_keys=True, separators=(",", ":")),
        fix_plan_md="## Proposed Fix Plan\n...",
    )
    _seed_run(db, _run("forward-error", status="error", created_at="2026-05-02T00:00:00Z"))
    return db


def test_dry_run_output_matches_expected_counts_and_manifest(tmp_path):
    db = _fixture_db(tmp_path)
    manifest = tmp_path / "manifest.json"

    stats = red_team_backfill.run_backfill(
        db_path=db,
        scope="legacy",
        dry_run=True,
        manifest_path=manifest,
    )

    assert stats["rows"] == 1
    assert stats["red_team_run"] == 1
    assert stats["red_team_finding"] == 2
    assert stats["red_team_fix_plan"] == 0
    assert stats["enqueued"] == 0
    assert stats["dedupe_keys"] == [
        "red-team:run:design:legacy-run",
        "red-team:finding:design:legacy-run:1:rt1",
        "red-team:finding:design:legacy-run:1:rt2",
    ]
    payload = json.loads(manifest.read_text())
    assert payload["scope"] == "legacy"
    assert payload["dedupe_keys"] == stats["dedupe_keys"]


def test_live_and_dry_run_produce_identical_event_counts(tmp_path):
    db = _fixture_db(tmp_path)
    enqueued = []

    dry = red_team_backfill.run_backfill(db_path=db, scope="legacy", dry_run=True)
    live = red_team_backfill.run_backfill(
        db_path=db,
        scope="legacy",
        dry_run=False,
        enqueue_fn=lambda event: enqueued.append(event) or len(enqueued),
    )

    for key in ("red_team_run", "red_team_finding", "red_team_fix_plan"):
        assert live[key] == dry[key]
    assert len(enqueued) == 3


def test_scope_filtering_legacy_forward_and_all(tmp_path):
    db = _fixture_db(tmp_path)

    legacy = red_team_backfill.run_backfill(db_path=db, scope="legacy", dry_run=True)
    forward = red_team_backfill.run_backfill(db_path=db, scope="forward", dry_run=True)
    all_rows = red_team_backfill.run_backfill(db_path=db, scope="all", dry_run=True)

    assert legacy["rows"] == 1
    assert legacy["red_team_fix_plan"] == 0
    assert forward["rows"] == 2
    assert forward["red_team_run"] == 2
    assert forward["red_team_finding"] == 4
    assert forward["red_team_fix_plan"] == 1
    assert all_rows["rows"] == 3
    assert all_rows["red_team_run"] == 3
    assert all_rows["red_team_finding"] == 6
    assert all_rows["red_team_fix_plan"] == 1


def test_malformed_fix_plan_json_skips_row_with_warning(tmp_path, capsys):
    db = tmp_path / "rt.db"
    red_team_audit.init_red_team_tables(db)
    _seed_run(db, _run("bad-forward", status="success", created_at=TS_FORWARD))
    conn = sqlite3.connect(str(db))
    try:
        conn.execute(
            "UPDATE red_team_runs SET fix_plan_json = ?, fix_plan_md = ? "
            "WHERE run_id = ?",
            ('{"moves":', "## Proposed Fix Plan", "bad-forward"),
        )
        conn.commit()
    finally:
        conn.close()

    stats = red_team_backfill.run_backfill(db_path=db, scope="forward", dry_run=True)

    assert stats["rows"] == 0
    assert stats["skipped_rows"] == 1
    assert "malformed fix_plan_json" in capsys.readouterr().err


def test_forward_fix_plan_reconstruction_matches_forward_builder(tmp_path):
    db = tmp_path / "rt.db"
    red_team_audit.init_red_team_tables(db)
    plan = _fix_plan()
    run = _run("forward-run", status="success", created_at=TS_FORWARD)
    _seed_run(
        db,
        run,
        fix_plan_json=json.dumps(asdict(plan), sort_keys=True, separators=(",", ":")),
        fix_plan_md="## Proposed Fix Plan\n...",
    )

    row = red_team_backfill._load_rows(db, scope="forward", limit=None)[0]
    envelope = [
        event
        for event in red_team_backfill.build_envelopes_for_row(row)
        if event["type"] == "red_team_fix_plan"
    ][0]
    expected = red_team_insights.build_fix_plan_envelope(
        run_id=run["run_id"],
        stage=run["stage"],
        repo=run["repo"],
        pr_number=run["pr_number"],
        model=plan.model,
        reasoning_effort=plan.reasoning_effort,
        summary=plan.summary,
        notes=plan.notes,
        moves=[asdict(_move())],
        move_count=1,
        addressed_finding_ids=["rt1"],
        unaddressed_finding_ids=["rt2"],
        orphan_finding_ids=["orphan-1"],
        input_truncated=True,
        input_omitted_finding_ids=["rt9"],
        warnings=["input was truncated"],
        cost_usd=2.0,
        duration_s=7.0,
        input_tokens=100,
        output_tokens=50,
        fix_plan_md="## Proposed Fix Plan\n...",
        timestamp_iso=TS_FORWARD,
    )
    assert envelope == expected


def test_migration_before_select_on_pre_v12_db(tmp_path):
    db = tmp_path / "pre-v12.db"
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
INSERT INTO red_team_runs (
    run_id, stage, rounds_used, final_status, total_findings,
    critical_count, high_count, medium_count, human_review_count,
    duration_s, cost_usd, model, caller, created_at
) VALUES (
    'old-run', 'design', 1, 'clean', 0,
    0, 0, 0, 0,
    1.0, 0.1, 'gpt-5.5-pro', 'manual', '2026-03-01T00:00:00Z'
);
"""
        )
        conn.commit()
    finally:
        conn.close()

    stats = red_team_backfill.run_backfill(db_path=db, scope="legacy", dry_run=True)
    rows = red_team_backfill._load_rows(db, scope="legacy", limit=None)

    assert stats["rows"] == 1
    assert stats["red_team_run"] == 1
    assert rows[0]["repo"] is None
    assert rows[0]["fix_plan_status"] is None


def test_idempotency_offline_unique_dedupe_table(tmp_path):
    db = _fixture_db(tmp_path)
    cloud = sqlite3.connect(str(tmp_path / "cloud.db"))
    cloud.execute("CREATE TABLE events (dedupe_key TEXT UNIQUE, event_json TEXT NOT NULL)")

    def enqueue(event):
        cur = cloud.execute(
            "INSERT OR IGNORE INTO events (dedupe_key, event_json) VALUES (?, ?)",
            (event["dedupe_key"], json.dumps(event)),
        )
        cloud.commit()
        return cloud.total_changes if cur.rowcount else None

    first = red_team_backfill.run_backfill(db_path=db, scope="legacy", enqueue_fn=enqueue)
    before = cloud.execute("SELECT COUNT(*) FROM events").fetchone()[0]
    second = red_team_backfill.run_backfill(db_path=db, scope="legacy", enqueue_fn=enqueue)
    after = cloud.execute("SELECT COUNT(*) FROM events").fetchone()[0]

    assert first["enqueued"] == 3
    assert before == 3
    assert second["enqueued"] == 0
    assert second["duplicates"] == 3
    assert after == 3
    cloud.close()


def test_kill_mid_drain_resume_offline_simulation(tmp_path):
    db = _fixture_db(tmp_path)
    local = sqlite3.connect(str(tmp_path / "queue.db"))
    cloud = sqlite3.connect(str(tmp_path / "cloud.db"))
    local.execute("CREATE TABLE pending (dedupe_key TEXT UNIQUE, event_json TEXT NOT NULL)")
    cloud.execute("CREATE TABLE events (dedupe_key TEXT UNIQUE, event_json TEXT NOT NULL)")

    def enqueue_local(event):
        cur = local.execute(
            "INSERT OR IGNORE INTO pending (dedupe_key, event_json) VALUES (?, ?)",
            (event["dedupe_key"], json.dumps(event)),
        )
        local.commit()
        return cur.lastrowid if cur.rowcount else None

    red_team_backfill.run_backfill(db_path=db, scope="legacy", enqueue_fn=enqueue_local)
    assert local.execute("SELECT COUNT(*) FROM pending").fetchone()[0] == 3

    first = local.execute(
        "SELECT rowid, dedupe_key, event_json FROM pending ORDER BY rowid LIMIT 1"
    ).fetchone()
    cloud.execute(
        "INSERT OR IGNORE INTO events (dedupe_key, event_json) VALUES (?, ?)",
        (first[1], first[2]),
    )
    local.execute("DELETE FROM pending WHERE rowid = ?", (first[0],))
    local.commit()
    cloud.commit()
    assert local.execute("SELECT COUNT(*) FROM pending").fetchone()[0] == 2

    red_team_backfill.run_backfill(db_path=db, scope="legacy", enqueue_fn=enqueue_local)
    assert local.execute("SELECT COUNT(*) FROM pending").fetchone()[0] == 3

    for dedupe_key, event_json in local.execute(
        "SELECT dedupe_key, event_json FROM pending ORDER BY rowid"
    ).fetchall():
        cloud.execute(
            "INSERT OR IGNORE INTO events (dedupe_key, event_json) VALUES (?, ?)",
            (dedupe_key, event_json),
        )
    cloud.commit()
    local.execute("DELETE FROM pending")
    local.commit()

    assert cloud.execute("SELECT COUNT(*) FROM events").fetchone()[0] == 3
    assert local.execute("SELECT COUNT(*) FROM pending").fetchone()[0] == 0
    local.close()
    cloud.close()
