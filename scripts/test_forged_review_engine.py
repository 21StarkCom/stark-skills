"""Tests for forged_review_engine.py — pure merge/gate/delta logic."""

from __future__ import annotations

import subprocess

import pytest

import forged_review_engine as eng


# ── merge_findings ─────────────────────────────────────────────────────


def test_merge_confirms_disputes_and_preserves_second_only():
    leader = [
        {"id": "f1", "severity": "high", "title": "SQL injection"},
        {"id": "f2", "severity": "medium", "title": "missing null check"},
        {"id": "f3", "severity": "low", "title": "naming convention"},
    ]
    second = {
        "decisions": [
            {"id": "f1", "verdict": "confirmed", "reason": "real"},
            {"id": "f2", "verdict": "disputed", "reason": "false positive"},
            {"id": "f3", "verdict": "leader_only", "reason": "subjective"},
        ],
        "second_only": [
            {"severity": "high", "title": "race condition", "file": "a.py", "line": 10}
        ],
    }
    merged = eng.merge_findings(leader, second)
    assert [f["id"] for f in merged["confirmed"]] == ["f1"]
    assert [f["id"] for f in merged["disputed"]] == ["f2"]
    assert [f["id"] for f in merged["leader_only"]] == ["f3"]
    assert len(merged["second_only"]) == 1


def test_merge_handles_missing_decision_as_leader_only():
    leader = [{"id": "f1", "severity": "high"}]
    second = {"decisions": [], "second_only": []}
    merged = eng.merge_findings(leader, second)
    assert merged["leader_only"] == leader
    assert merged["confirmed"] == []


def test_merge_handles_unknown_verdict_as_leader_only():
    leader = [{"id": "f1", "severity": "medium"}]
    second = {"decisions": [{"id": "f1", "verdict": "who_knows"}], "second_only": []}
    merged = eng.merge_findings(leader, second)
    assert merged["leader_only"] == leader


def test_merge_handles_missing_leader_id():
    leader = [{"severity": "high", "title": "no id"}]
    second = {"decisions": [], "second_only": []}
    merged = eng.merge_findings(leader, second)
    assert len(merged["leader_only"]) == 1


def test_actionable_from_merged_counts_confirmed_and_second_only():
    merged = {
        "confirmed": [{"id": "f1"}, {"id": "f2"}],
        "disputed": [{"id": "f3"}],
        "leader_only": [{"id": "f4"}],
        "second_only": [{"title": "x"}],
    }
    result = eng.actionable_from_merged(merged)
    assert len(result) == 3


# ── compute_gate ───────────────────────────────────────────────────────


def test_gate_force_and_no_escalate_mutually_exclusive():
    with pytest.raises(ValueError):
        eng.compute_gate([], forge_threshold=4, force_escalate=True, no_escalate=True)


def test_gate_force_escalate_wins():
    result = eng.compute_gate([], forge_threshold=4, force_escalate=True)
    assert result["path"] == "forge"
    assert "force_escalate" in result["reason"]


def test_gate_no_escalate_even_with_critical():
    findings = [{"severity": "critical", "title": "sql injection"}]
    result = eng.compute_gate(findings, forge_threshold=4, no_escalate=True)
    assert result["path"] == "light"
    assert result["critical_count"] == 1


def test_gate_single_critical_triggers_forge():
    findings = [{"severity": "critical"}]
    result = eng.compute_gate(findings, forge_threshold=10)
    assert result["path"] == "forge"
    assert "critical" in result["reason"]


def test_gate_below_threshold_goes_light():
    findings = [{"severity": "medium"}, {"severity": "low"}]
    result = eng.compute_gate(findings, forge_threshold=4)
    assert result["path"] == "light"
    assert result["actionable_count"] == 2


def test_gate_at_threshold_goes_forge():
    findings = [{"severity": "medium"}] * 4
    result = eng.compute_gate(findings, forge_threshold=4)
    assert result["path"] == "forge"
    assert result["actionable_count"] == 4


def test_gate_severity_case_insensitive():
    findings = [{"severity": "CRITICAL"}]
    result = eng.compute_gate(findings, forge_threshold=10)
    assert result["path"] == "forge"
    assert result["critical_count"] == 1


# ── scope_delta_rereview ───────────────────────────────────────────────


def test_scope_empty_commits_returns_domains_only():
    prior = {
        "domain_findings": {
            "correctness": {"confirmed": [{"id": "f1"}], "second_only": []},
            "security": {"confirmed": [], "second_only": []},
        }
    }
    result = eng.scope_delta_rereview(prior, fix_commits=[])
    assert result["domains"] == ["correctness"]
    assert result["files"] == []


def test_scope_includes_domains_with_second_only():
    prior = {
        "domain_findings": {
            "correctness": {"confirmed": [], "second_only": [{"title": "x"}]},
            "security": {"confirmed": [], "second_only": []},
        }
    }
    result = eng.scope_delta_rereview(prior, fix_commits=[])
    assert result["domains"] == ["correctness"]


def test_scope_with_commits_calls_git(tmp_path, monkeypatch):
    calls = []

    def fake_run(args, **kwargs):
        calls.append(args)
        return subprocess.CompletedProcess(
            args=args, returncode=0, stdout="a.py\nb.py\n", stderr=""
        )

    monkeypatch.setattr(subprocess, "run", fake_run)
    prior = {
        "domain_findings": {
            "correctness": {"confirmed": [{"id": "f1"}], "second_only": []},
        }
    }
    result = eng.scope_delta_rereview(prior, fix_commits=["abc", "def"], repo_root=tmp_path)
    assert result["files"] == ["a.py", "b.py"]
    assert calls[0][1] == "diff"
    assert "abc^..def" in calls[0]


def test_scope_handles_git_failure_gracefully(tmp_path, monkeypatch):
    def fake_run(args, **kwargs):
        raise subprocess.CalledProcessError(returncode=1, cmd=args)

    monkeypatch.setattr(subprocess, "run", fake_run)
    prior = {"domain_findings": {"correctness": {"confirmed": [{"id": "f1"}]}}}
    result = eng.scope_delta_rereview(prior, fix_commits=["abc"], repo_root=tmp_path)
    assert result["files"] == []
    assert result["domains"] == ["correctness"]


# ── select_domains_from_triage ─────────────────────────────────────────


_ALL = [
    "architecture",
    "accessibility",
    "correctness",
    "type-safety",
    "security",
    "test-coverage",
    "spec-conformance",
    "ui-design-conformance",
    "regression-prevention",
]
_ALWAYS_ON = ["correctness", "regression-prevention"]


def test_select_domains_preserves_all_domains_order():
    triage = {"selected_domains": ["security", "architecture", "correctness"]}
    result = eng.select_domains_from_triage(triage, _ALWAYS_ON, _ALL)
    assert result == ["architecture", "correctness", "security", "regression-prevention"]


def test_select_domains_always_on_added_even_if_missing():
    triage = {"selected_domains": ["security"]}
    result = eng.select_domains_from_triage(triage, _ALWAYS_ON, _ALL)
    assert "correctness" in result
    assert "regression-prevention" in result
    assert "security" in result


def test_select_domains_drops_unknown_hallucinations():
    triage = {"selected_domains": ["security", "cryptography", "quantum-safety"]}
    result = eng.select_domains_from_triage(triage, _ALWAYS_ON, _ALL)
    assert "cryptography" not in result
    assert "quantum-safety" not in result
    assert "security" in result


def test_select_domains_raises_on_missing_key():
    with pytest.raises(ValueError):
        eng.select_domains_from_triage({}, _ALWAYS_ON, _ALL)


def test_select_domains_raises_on_non_dict():
    with pytest.raises(ValueError):
        eng.select_domains_from_triage("oops", _ALWAYS_ON, _ALL)  # type: ignore


def test_select_domains_raises_on_non_list():
    with pytest.raises(ValueError):
        eng.select_domains_from_triage(
            {"selected_domains": "security"}, _ALWAYS_ON, _ALL
        )
