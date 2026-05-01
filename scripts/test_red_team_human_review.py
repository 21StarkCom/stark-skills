"""Tests for red_team_human_review — FU-rt8 halt recovery."""

from __future__ import annotations

import red_team_audit
import red_team_human_review as hr
import stark_red_team as rt


def _seed_finding(db, *, stable_key: str, run_id: str = "run1", concern_hash: str = "abc"):
    red_team_audit.init_red_team_tables(db)
    red_team_audit.record_red_team_run(
        {
            "run_id": run_id,
            "stage": "design",
            "rounds_used": 1,
            "final_status": "halted_human_review",
            "total_findings": 1,
            "critical_count": 0,
            "high_count": 0,
            "medium_count": 0,
            "human_review_count": 1,
            "duration_s": 1.0,
            "cost_usd": 0.10,
            "model": "gpt-5.5-pro",
            "caller": "manual",
            "repo": "evinced/stark-skills",
            "artifact_relative_path": "docs/spec.md",
            "pr_number": 42,
            "fix_plan_status": "skipped_human_review_only",
        },
        db_path=db,
    )
    red_team_audit.record_finding(
        run_id=run_id,
        stage="design",
        round_num=1,
        finding_id="rt3",
        persona="data",
        severity="high",
        concern="Schema migration may break readers",
        consequence="Data loss on rollback",
        counter_proposal="REQUEST_HUMAN_REVIEW",
        trade_off=None,
        reason_for_uncertainty="Need product input",
        stable_key=stable_key,
        concern_hash=concern_hash,
        risk_key="schema-migration-rollback",
        affected_component="migrations",
        failure_mode="data-loss",
        db_path=db,
    )


def test_accept_finding_persists_one_row(tmp_path):
    db = tmp_path / "rt.db"
    _seed_finding(db, stable_key="run1:design:1:data:rt3:abc")
    hr.accept_finding(
        "run1:design:1:data:rt3:abc",
        run_id="run1",
        stage="design",
        round_num=1,
        persona="data",
        finding_id="rt3",
        concern_hash="abc",
        concern_excerpt="Schema migration may break readers",
        repo="evinced/stark-skills",
        accepted_by="alice",
        db_path=db,
    )
    # Lookup by accept_key (cross-run identity) — the canonical path.
    accept_key = rt.compute_accept_key(
        stage="design", persona="data", concern_hash="abc",
        repo="evinced/stark-skills",
    )
    assert hr.is_accepted(accept_key, db_path=db) is True
    # Per-occurrence lookup by stable_key still works for audit-trail tooling.
    assert hr.is_accepted(stable_key="run1:design:1:data:rt3:abc", db_path=db) is True


def test_compute_accept_key_rejects_unresolved_repo():
    """PR-#430 round-3 fix #21: refuse to build an accept key without a repo."""
    import pytest
    for bad in (None, "", "unknown"):
        with pytest.raises(ValueError, match="resolved repository"):
            rt.compute_accept_key(
                stage="design", persona="data", concern_hash="abc", repo=bad,
            )


def test_accept_finding_is_idempotent(tmp_path):
    """A re-accept of the same stable_key is a no-op."""
    db = tmp_path / "rt.db"
    _seed_finding(db, stable_key="run1:design:1:data:rt3:abc")
    hr.accept_finding(
        "run1:design:1:data:rt3:abc",
        run_id="run1",
        stage="design",
        round_num=1,
        persona="data",
        finding_id="rt3",
        concern_hash="abc",
        concern_excerpt="x",
        repo="evinced/stark-skills",
        accepted_by="alice",
        db_path=db,
    )
    hr.accept_finding(
        "run1:design:1:data:rt3:abc",
        run_id="run1",
        stage="design",
        round_num=1,
        persona="data",
        finding_id="rt3",
        concern_hash="abc",
        concern_excerpt="x",
        repo="evinced/stark-skills",
        accepted_by="bob",
        db_path=db,
    )
    # Both calls succeeded; one row persists.
    import sqlite3
    conn = sqlite3.connect(str(db))
    try:
        rows = conn.execute(
            "SELECT accepted_by FROM red_team_human_review_accepts"
        ).fetchall()
    finally:
        conn.close()
    assert len(rows) == 1
    # First operator wins — the audit answer stays consistent.
    assert rows[0][0] == "alice"


def test_filter_human_review_findings_drops_accepted_keys(tmp_path):
    """A finding accepted in run-A is filtered out for run-B (cross-run match)."""
    db = tmp_path / "rt.db"
    stable_key = "run1:design:1:data:rt3:abc"
    _seed_finding(db, stable_key=stable_key)
    hr.accept_finding(
        stable_key,
        run_id="run1",
        stage="design",
        round_num=1,
        persona="data",
        finding_id="rt3",
        concern_hash="abc",
        concern_excerpt="x",
        repo="evinced/stark-skills",
        accepted_by="alice",
        db_path=db,
    )

    # The fresh dispatcher run sees the SAME concern under a different
    # run_id and a different finding_id slot. The accept_key (repo +
    # stage + persona + concern_hash) should still match.
    finding = rt.RedTeamFinding(
        id="rt7",  # different slot than the accepted finding's "rt3"
        persona="data",
        severity="high",
        concern="Schema migration may break readers",
        consequence="x",
        counter_proposal="REQUEST_HUMAN_REVIEW",
        trade_off=None,
        reason_for_uncertainty="y",
        risk_key="schema-migration-rollback",
        affected_component="migrations",
        failure_mode="data-loss",
        concern_hash="abc",
    )
    unaccepted, matched = hr.filter_human_review_findings(
        [finding],
        stage="design",
        repo="evinced/stark-skills",
        db_path=db,
    )
    assert unaccepted == []
    expected_accept_key = rt.compute_accept_key(
        stage="design", persona="data", concern_hash="abc",
        repo="evinced/stark-skills",
    )
    assert matched == [expected_accept_key]


def test_filter_human_review_findings_does_not_match_different_repo(tmp_path):
    """PR-#430 review fix #10: cross-repo match must NOT happen."""
    db = tmp_path / "rt.db"
    _seed_finding(db, stable_key="run1:design:1:data:rt3:abc")
    # Accept under repo-A
    hr.accept_finding(
        "run1:design:1:data:rt3:abc",
        run_id="run1",
        stage="design",
        round_num=1,
        persona="data",
        finding_id="rt3",
        concern_hash="abc",
        concern_excerpt="x",
        repo="repo-a",
        accepted_by="alice",
        db_path=db,
    )
    finding = rt.RedTeamFinding(
        id="rt1", persona="data", severity="high",
        concern="Same concern", consequence="x",
        counter_proposal="REQUEST_HUMAN_REVIEW",
        trade_off=None, reason_for_uncertainty="y",
        risk_key="schema-migration-rollback",
        affected_component="migrations",
        failure_mode="data-loss",
        concern_hash="abc",
    )
    # Filter under repo-B → should NOT match
    unaccepted, matched = hr.filter_human_review_findings(
        [finding], stage="design", repo="repo-b", db_path=db,
    )
    assert len(unaccepted) == 1
    assert matched == []


def test_filter_human_review_findings_does_not_match_different_concern(tmp_path):
    """A NEW concern (different concern_hash) must not be auto-accepted."""
    db = tmp_path / "rt.db"
    _seed_finding(db, stable_key="run1:design:1:data:rt3:abc")
    hr.accept_finding(
        "run1:design:1:data:rt3:abc",
        run_id="run1",
        stage="design",
        round_num=1,
        persona="data",
        finding_id="rt3",
        concern_hash="abc",
        concern_excerpt="x",
        repo="evinced/stark-skills",
        accepted_by="alice",
        db_path=db,
    )
    # Same persona but a different risk → different concern_hash → halt
    new_finding = rt.RedTeamFinding(
        id="rt1",
        persona="data",
        severity="high",
        concern="Different risk",
        consequence="x",
        counter_proposal="REQUEST_HUMAN_REVIEW",
        trade_off=None,
        reason_for_uncertainty="y",
        risk_key="other-risk",
        affected_component="other",
        failure_mode="cost",
        concern_hash="zzz",  # different hash
    )
    unaccepted, matched = hr.filter_human_review_findings(
        [new_finding], stage="design", repo="evinced/stark-skills", db_path=db,
    )
    assert len(unaccepted) == 1
    assert matched == []


def test_list_pending_halts_excludes_accepted(tmp_path):
    db = tmp_path / "rt.db"
    _seed_finding(db, stable_key="run1:design:1:data:rt3:abc")
    pending = hr.list_pending_halts(db_path=db)
    assert len(pending) == 1
    assert pending[0].stable_key == "run1:design:1:data:rt3:abc"
    # Accept with the SAME repo as the seeded finding (evinced/stark-skills);
    # the repo-scoped accept_key is what makes list_pending_halts exclude it.
    hr.accept_finding(
        "run1:design:1:data:rt3:abc",
        run_id="run1",
        stage="design",
        round_num=1,
        persona="data",
        finding_id="rt3",
        concern_hash="abc",
        concern_excerpt="x",
        repo="evinced/stark-skills",
        accepted_by="alice",
        db_path=db,
    )
    pending = hr.list_pending_halts(db_path=db)
    assert pending == []


def test_list_pending_halts_does_not_exclude_accept_from_different_repo(tmp_path):
    """PR-#430 review fix #10: an accept in repo A must NOT suppress a halt
    in repo B. The accept_key includes a repo prefix so cross-repo
    suppression is structurally impossible."""
    db = tmp_path / "rt.db"
    _seed_finding(db, stable_key="run1:design:1:data:rt3:abc")
    # Accept under a DIFFERENT repo
    hr.accept_finding(
        "run1:design:1:data:rt3:abc",
        run_id="run1",
        stage="design",
        round_num=1,
        persona="data",
        finding_id="rt3",
        concern_hash="abc",
        concern_excerpt="x",
        repo="other/repo",
        accepted_by="alice",
        db_path=db,
    )
    pending = hr.list_pending_halts(db_path=db)
    assert len(pending) == 1, "cross-repo accept must not suppress this repo's halt"


def test_list_pending_halts_filters_by_repo_and_stage(tmp_path):
    db = tmp_path / "rt.db"
    _seed_finding(db, stable_key="run1:design:1:data:rt3:abc")
    assert hr.list_pending_halts(repo="evinced/stark-skills", db_path=db)
    assert not hr.list_pending_halts(repo="other/repo", db_path=db)
    assert hr.list_pending_halts(stage="design", db_path=db)
    assert not hr.list_pending_halts(stage="plan", db_path=db)


def test_lookup_finding_metadata_returns_concern_excerpt(tmp_path):
    db = tmp_path / "rt.db"
    _seed_finding(db, stable_key="run1:design:1:data:rt3:abc")
    meta = hr.lookup_finding_metadata("run1:design:1:data:rt3:abc", db_path=db)
    assert meta is not None
    assert meta["counter_proposal"] == "REQUEST_HUMAN_REVIEW"
    assert "Schema migration" in (meta["concern_excerpt"] or "")


def test_lookup_finding_metadata_returns_none_for_unknown_key(tmp_path):
    db = tmp_path / "rt.db"
    red_team_audit.init_red_team_tables(db)
    assert hr.lookup_finding_metadata("nope:does:not:exist", db_path=db) is None
