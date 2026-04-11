"""Tests for forge_review.py — Phase 4: Design Review Iron Rule Loop."""

from pathlib import Path

import forge_review


def test_finding_id_stable():
    id1 = forge_review.compute_finding_id("claude", "general", "## Solution", "Missing error handling")
    id2 = forge_review.compute_finding_id("claude", "general", "## Solution", "Missing error handling")
    assert id1 == id2
    assert len(id1) == 12


def test_finding_id_different_inputs():
    id1 = forge_review.compute_finding_id("claude", "general", "## Solution", "Missing error handling")
    id2 = forge_review.compute_finding_id("codex", "general", "## Solution", "Missing error handling")
    assert id1 != id2


def test_classify_findings_fix():
    findings = [
        {"agent": "claude", "domain": "general", "section": "S1", "title": "T1", "severity": "high"},
    ]
    classified = forge_review.classify_findings(findings, "", [], "medium")
    assert len(classified) == 1
    assert classified[0]["status"] == "fix"


def test_classify_findings_noise():
    findings = [
        {"agent": "claude", "domain": "general", "section": "S2", "title": "T2", "severity": "low"},
    ]
    classified = forge_review.classify_findings(findings, "", [], "medium")
    assert len(classified) == 1
    assert classified[0]["status"] == "noise"


def test_cross_reference_high_confidence():
    findings = [
        {"agent": "claude", "domain": "general", "section": "S1", "title": "T1", "severity": "low"},
        {"agent": "codex", "domain": "completeness", "section": "S1", "title": "T1", "severity": "low"},
    ]
    classified = forge_review.classify_findings(findings, "", [], "medium")
    fix_entries = [f for f in classified if f.get("high_confidence")]
    assert len(fix_entries) >= 1
    assert all(f["status"] == "fix" for f in fix_entries)


def test_recurring_finding_becomes_blocked():
    """Third recurrence of same finding_id triggers blocked -> HALT."""
    finding = {"agent": "claude", "domain": "general", "section": "S1", "title": "T1", "severity": "high"}

    # Round 1: fix
    r1 = forge_review.classify_findings([finding], "", [], "medium")
    assert r1[0]["status"] == "fix"

    # Round 2: recurring (finding_id seen once before as fix)
    prev = [{"classified_findings": r1}]
    r2 = forge_review.classify_findings([finding], "", prev, "medium")
    assert r2[0].get("recurring") is True

    # Round 3: blocked (finding_id seen twice before)
    prev.append({"classified_findings": r2})
    r3 = forge_review.classify_findings([finding], "", prev, "medium")
    assert r3[0]["status"] == "blocked"


def test_batch_fixes():
    classified = [
        {"status": "fix", "section": "S1", "title": "T1"},
        {"status": "fix", "section": "S1", "title": "T2"},
        {"status": "noise", "section": "S1", "title": "T3"},
        {"status": "fix", "section": "S2", "title": "T4"},
    ]
    batches = forge_review.batch_fixes(classified)
    assert "S1" in batches
    assert len(batches["S1"]) == 2  # two fix findings
    assert "S2" in batches
    assert len(batches["S2"]) == 1


def test_severity_meets_threshold():
    assert forge_review._severity_meets_threshold("critical", "medium") is True
    assert forge_review._severity_meets_threshold("high", "medium") is True
    assert forge_review._severity_meets_threshold("medium", "medium") is True
    assert forge_review._severity_meets_threshold("low", "medium") is False


def test_apply_consensus_confirmed():
    findings = [
        {"agent": "codex", "section": "S1", "title": "T1"},
        {"agent": "gemini", "section": "S1", "title": "T1"},
    ]
    result = forge_review._apply_consensus(findings, 2)
    confirmed = [f for f in result if f.get("consensus") == "confirmed"]
    assert len(confirmed) == 1


def test_apply_consensus_single_agent():
    findings = [
        {"agent": "codex", "section": "S1", "title": "T1"},
    ]
    result = forge_review._apply_consensus(findings, 2)
    assert len(result) == 1
    assert result[0]["consensus"] == "single_agent"
