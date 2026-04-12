"""Tests for forged_review_audit.py — schema, writes, disagreement rate."""

from __future__ import annotations

import json

import forged_review_audit


def test_init_metrics_db_creates_all_tables(tmp_path):
    db = tmp_path / "fr.db"
    forged_review_audit.init_metrics_db(db)

    import sqlite3

    conn = sqlite3.connect(str(db))
    try:
        rows = conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
        ).fetchall()
    finally:
        conn.close()

    names = {r[0] for r in rows}
    assert {"runs", "rounds", "domain_calls", "finding_verdicts"}.issubset(names)


def test_record_domain_call_appends_jsonl(tmp_path):
    path = tmp_path / "calls.jsonl"
    call = forged_review_audit.DomainCall(
        run_id="run1",
        pr_number=42,
        repo="Org/Repo",
        round_num=1,
        round_mode="full",
        domain="correctness",
        agent="codex",
        role="leader",
        duration_s=12.5,
        finding_count=3,
    )
    forged_review_audit.record_domain_call(path, call)
    data = json.loads(path.read_text())
    assert data["run_id"] == "run1"
    assert data["domain"] == "correctness"
    assert data["role"] == "leader"
    assert data["finding_count"] == 3


def test_record_run_inserts_run_rounds_calls_verdicts(tmp_path):
    db = tmp_path / "fr.db"
    forged_review_audit.init_metrics_db(db)

    run_data = {
        "run_id": "run-2026-04-12-0001",
        "repo": "GetEvinced/foo",
        "pr_number": 77,
        "path": "forge",
        "total_rounds": 2,
        "total_actionable": 5,
        "total_critical": 1,
        "merge_outcome": "merged",
        "duration_s": 123.4,
        "rounds": [
            {
                "round_num": 1,
                "mode": "full",
                "domains_run": ["correctness", "security"],
                "actionable_count": 5,
                "critical_count": 1,
            },
            {
                "round_num": 2,
                "mode": "delta",
                "domains_run": ["correctness"],
                "actionable_count": 0,
                "critical_count": 0,
            },
        ],
        "domain_calls": [
            {
                "round_num": 1,
                "domain": "correctness",
                "agent": "codex",
                "role": "leader",
                "duration_s": 10.1,
                "finding_count": 3,
            },
            {
                "round_num": 1,
                "domain": "correctness",
                "agent": "claude",
                "role": "second",
                "duration_s": 9.2,
                "finding_count": 0,
            },
        ],
        "finding_verdicts": [
            {
                "round_num": 1,
                "domain": "correctness",
                "leader_agent": "codex",
                "second_agent": "claude",
                "severity": "high",
                "verdict": "confirmed",
            },
            {
                "round_num": 1,
                "domain": "correctness",
                "leader_agent": "codex",
                "second_agent": "claude",
                "severity": "medium",
                "verdict": "disputed",
            },
        ],
    }
    forged_review_audit.record_run(run_data, db_path=db)

    import sqlite3

    conn = sqlite3.connect(str(db))
    try:
        runs = conn.execute("SELECT run_id, path, total_rounds FROM runs").fetchall()
        rounds = conn.execute("SELECT round_num, mode FROM rounds ORDER BY round_num").fetchall()
        calls = conn.execute("SELECT agent, role FROM domain_calls").fetchall()
        verdicts = conn.execute("SELECT verdict FROM finding_verdicts").fetchall()
    finally:
        conn.close()

    assert runs == [("run-2026-04-12-0001", "forge", 2)]
    assert rounds == [(1, "full"), (2, "delta")]
    assert len(calls) == 2
    assert {v[0] for v in verdicts} == {"confirmed", "disputed"}


def test_record_run_is_idempotent_on_run_id(tmp_path):
    db = tmp_path / "fr.db"
    forged_review_audit.init_metrics_db(db)
    base = {
        "run_id": "dup",
        "repo": "x/y",
        "pr_number": 1,
        "path": "light",
        "total_rounds": 1,
        "total_actionable": 0,
        "total_critical": 0,
        "merge_outcome": "merged",
        "duration_s": 1.0,
    }
    forged_review_audit.record_run(base, db_path=db)
    forged_review_audit.record_run(base, db_path=db)  # should REPLACE not duplicate

    import sqlite3

    conn = sqlite3.connect(str(db))
    try:
        count = conn.execute("SELECT COUNT(*) FROM runs").fetchone()[0]
    finally:
        conn.close()
    assert count == 1


def test_get_disagreement_rate_empty_returns_zero(tmp_path):
    db = tmp_path / "fr.db"
    forged_review_audit.init_metrics_db(db)
    assert forged_review_audit.get_disagreement_rate("correctness", db_path=db) == 0.0


def test_get_disagreement_rate_mixed_verdicts(tmp_path):
    db = tmp_path / "fr.db"
    forged_review_audit.init_metrics_db(db)

    def _seed(verdict: str) -> None:
        forged_review_audit.record_run(
            {
                "run_id": f"r-{verdict}",
                "repo": "x/y",
                "pr_number": 1,
                "path": "forge",
                "total_rounds": 1,
                "total_actionable": 1,
                "total_critical": 0,
                "merge_outcome": "merged",
                "duration_s": 1.0,
                "finding_verdicts": [
                    {
                        "round_num": 1,
                        "domain": "correctness",
                        "leader_agent": "codex",
                        "second_agent": "claude",
                        "severity": "high",
                        "verdict": verdict,
                    }
                ],
            },
            db_path=db,
        )

    _seed("confirmed")
    _seed("confirmed")
    _seed("disputed")
    _seed("leader_only")

    rate = forged_review_audit.get_disagreement_rate("correctness", db_path=db)
    assert rate == 0.5  # 2 out of 4 are disagreements
