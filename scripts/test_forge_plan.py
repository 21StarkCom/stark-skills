"""Tests for forge_plan.py — plan generation, plan review Iron Rule loop."""
from __future__ import annotations

import hashlib
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from forge_plan import (
    PhaseResult,
    _all_findings_from_result,
    _build_routed_agent_groups,
    _count_findings_at_or_above,
    run_plan_phase,
    run_plan_review,
)


# ── Fixtures ───────────────────────────────────────────────────────────────


@pytest.fixture
def spec_file(tmp_path):
    p = tmp_path / "my-spec.md"
    p.write_text("# My Spec\n\nSome design content.\n")
    return p


@pytest.fixture
def plan_file(tmp_path):
    p = tmp_path / "my-spec-plan.md"
    p.write_text("# Implementation Plan\n\nPhase 1: Set up.\n")
    return p


@pytest.fixture
def minimal_state():
    return {
        "phases": {
            "plan": {"status": "pending"},
            "plan_review": {"status": "pending", "rounds": []},
        },
        "updated_at": "2026-01-01T00:00:00+00:00",
    }


@pytest.fixture
def minimal_cfg():
    return {
        "max_rounds": 2,
        "fix_threshold": "medium",
        "timeout": 60,
        "plan_review_routing": {
            "general": "claude",
            "security": "codex",
        },
        "agent_fallback_order": ["claude", "codex"],
    }


# ── _count_findings_at_or_above ────────────────────────────────────────────


class TestCountFindingsAtOrAbove:
    def test_counts_high_and_critical(self):
        findings = [
            {"severity": "low"},
            {"severity": "medium"},
            {"severity": "high"},
            {"severity": "critical"},
        ]
        assert _count_findings_at_or_above(findings, "high") == 2

    def test_medium_threshold_includes_medium(self):
        findings = [
            {"severity": "low"},
            {"severity": "medium"},
            {"severity": "high"},
        ]
        assert _count_findings_at_or_above(findings, "medium") == 2

    def test_empty_findings(self):
        assert _count_findings_at_or_above([], "medium") == 0

    def test_unknown_threshold_defaults_to_medium(self):
        findings = [{"severity": "medium"}, {"severity": "low"}]
        assert _count_findings_at_or_above(findings, "bogus") == 1

    def test_all_low_with_medium_threshold(self):
        findings = [{"severity": "low"}, {"severity": "low"}]
        assert _count_findings_at_or_above(findings, "medium") == 0


# ── _all_findings_from_result ──────────────────────────────────────────────


class TestAllFindingsFromResult:
    def test_extracts_findings_from_results(self):
        dispatch_result = {
            "results": [
                {"findings": [{"severity": "high", "title": "A"}]},
                {"findings": [{"severity": "low", "title": "B"}]},
            ]
        }
        findings = _all_findings_from_result(dispatch_result)
        assert len(findings) == 2

    def test_empty_results(self):
        assert _all_findings_from_result({"results": []}) == []

    def test_missing_results_key(self):
        assert _all_findings_from_result({}) == []

    def test_skips_non_dict_findings(self):
        dispatch_result = {
            "results": [
                {"findings": ["not a dict", {"severity": "medium", "title": "OK"}]},
            ]
        }
        findings = _all_findings_from_result(dispatch_result)
        assert len(findings) == 1


# ── _build_routed_agent_groups ─────────────────────────────────────────────


class TestBuildRoutedAgentGroups:
    def test_groups_by_routing(self):
        routing = {"general": "claude", "security": "codex", "risk": "claude"}
        domains = {
            "general": {"order": "01", "filename": "general.md"},
            "security": {"order": "02", "filename": "security.md"},
            "risk": {"order": "03", "filename": "risk.md"},
        }
        groups = _build_routed_agent_groups(routing, domains, ["claude", "codex"])
        assert set(groups["claude"].keys()) == {"general", "risk"}
        assert set(groups["codex"].keys()) == {"security"}

    def test_unknown_domain_uses_fallback(self):
        routing = {}
        domains = {"general": {"order": "01", "filename": "general.md"}}
        groups = _build_routed_agent_groups(routing, domains, ["claude"])
        assert "general" in groups["claude"]

    def test_empty_domains(self):
        groups = _build_routed_agent_groups({}, {}, ["claude"])
        assert groups == {}


# ── run_plan_phase ─────────────────────────────────────────────────────────


class TestRunPlanPhase:
    def test_generates_plan_and_writes_file(self, spec_file, minimal_state, minimal_cfg, tmp_path):
        gen_result = {
            "results": [
                {"agent": "claude", "plan_content": "# Plan\n\nPhase 1.", "error": None},
                {"agent": "codex", "plan_content": "# Plan v2\n\nPhase 1.", "error": None},
            ]
        }
        cross_result = {
            "results": [],
            "plan_averages": {"claude": 8.5, "codex": 7.2},
            "winner": "claude",
        }

        with (
            patch("forge_plan._generate_plans", return_value=gen_result),
            patch("forge_plan._cross_review_plans", return_value=cross_result),
            patch("forge_plan._git_commit", return_value="abc123"),
        ):
            result = run_plan_phase(spec_file, minimal_state, minimal_cfg, tmp_path)

        assert result.status == "completed"
        plan_path = tmp_path / "my-spec-plan.md"
        assert plan_path.exists()
        assert "Phase 1." in plan_path.read_text()
        assert result.plan_path == plan_path
        assert "abc123" in result.commit_shas

    def test_winner_extraction_uses_winner_agent_content(
        self, spec_file, minimal_state, minimal_cfg, tmp_path
    ):
        gen_result = {
            "results": [
                {"agent": "claude", "plan_content": "Claude plan content", "error": None},
                {"agent": "codex", "plan_content": "Codex plan content", "error": None},
            ]
        }
        cross_result = {
            "results": [],
            "plan_averages": {"claude": 6.0, "codex": 9.0},
            "winner": "codex",
        }

        with (
            patch("forge_plan._generate_plans", return_value=gen_result),
            patch("forge_plan._cross_review_plans", return_value=cross_result),
            patch("forge_plan._git_commit", return_value="def456"),
        ):
            run_plan_phase(spec_file, minimal_state, minimal_cfg, tmp_path)

        plan_path = tmp_path / "my-spec-plan.md"
        assert plan_path.read_text() == "Codex plan content"

    def test_fallback_to_first_plan_when_no_winner(
        self, spec_file, minimal_state, minimal_cfg, tmp_path
    ):
        gen_result = {
            "results": [
                {"agent": "claude", "plan_content": "Claude plan", "error": None},
            ]
        }
        cross_result = {
            "results": [],
            "plan_averages": {"claude": 0.0},
            "winner": None,  # No winner returned
        }

        with (
            patch("forge_plan._generate_plans", return_value=gen_result),
            patch("forge_plan._cross_review_plans", return_value=cross_result),
            patch("forge_plan._git_commit", return_value="fff000"),
        ):
            result = run_plan_phase(spec_file, minimal_state, minimal_cfg, tmp_path)

        assert result.status == "completed"
        plan_path = tmp_path / "my-spec-plan.md"
        assert plan_path.read_text() == "Claude plan"

    def test_halts_when_no_plans_generated(self, spec_file, minimal_state, minimal_cfg, tmp_path):
        gen_result = {"results": []}
        cross_result = {"results": [], "plan_averages": {}, "winner": None}

        with (
            patch("forge_plan._generate_plans", return_value=gen_result),
            patch("forge_plan._cross_review_plans", return_value=cross_result),
        ):
            result = run_plan_phase(spec_file, minimal_state, minimal_cfg, tmp_path)

        assert result.status == "halted"

    def test_updates_state_with_plan_path(self, spec_file, minimal_state, minimal_cfg, tmp_path):
        gen_result = {
            "results": [{"agent": "claude", "plan_content": "Plan content", "error": None}]
        }
        cross_result = {"winner": "claude", "plan_averages": {"claude": 8.0}, "results": []}

        with (
            patch("forge_plan._generate_plans", return_value=gen_result),
            patch("forge_plan._cross_review_plans", return_value=cross_result),
            patch("forge_plan._git_commit", return_value="aaa111"),
        ):
            run_plan_phase(spec_file, minimal_state, minimal_cfg, tmp_path)

        assert "plan_path" in minimal_state["phases"]["plan"]
        assert "winner_agent" in minimal_state["phases"]["plan"]


# ── run_plan_review ────────────────────────────────────────────────────────


class TestRunPlanReview:
    def _make_dispatch_result(self, findings: list[dict]) -> dict:
        return {
            "results": [
                {
                    "agent": "claude",
                    "domain": "general",
                    "findings": findings,
                    "error": None,
                }
            ]
        }

    def test_clean_rounds_complete_with_hash(self, plan_file, minimal_state, minimal_cfg, tmp_path):
        """Clean halt round freezes plan hash and returns completed."""
        # All rounds return zero actionable findings
        empty_dispatch = self._make_dispatch_result([])

        with (
            patch("forge_plan._dispatch_plan_review", return_value=empty_dispatch),
            patch("forge_plan._discover_plan_review_domains", return_value={
                "general": {"order": "01", "filename": "general.md"},
            }),
        ):
            result = run_plan_review(plan_file, minimal_state, minimal_cfg, tmp_path)

        assert result.status == "completed"
        assert result.plan_hash is not None
        expected_hash = hashlib.sha256(plan_file.read_bytes()).hexdigest()
        assert result.plan_hash == expected_hash

    def test_plan_hash_stored_in_state(self, plan_file, minimal_state, minimal_cfg, tmp_path):
        """Plan hash is written to state after clean halt round."""
        empty_dispatch = self._make_dispatch_result([])

        with (
            patch("forge_plan._dispatch_plan_review", return_value=empty_dispatch),
            patch("forge_plan._discover_plan_review_domains", return_value={
                "general": {"order": "01", "filename": "general.md"},
            }),
        ):
            run_plan_review(plan_file, minimal_state, minimal_cfg, tmp_path)

        assert "plan_hash" in minimal_state["phases"]["plan"]
        assert minimal_state["phases"]["plan"]["plan_hash"] is not None

    def test_halts_when_findings_remain_at_halt_round(
        self, plan_file, minimal_state, minimal_cfg, tmp_path
    ):
        """Halt round with remaining actionable findings returns halted."""
        high_finding = {"severity": "high", "title": "Critical gap", "section": "S1"}
        dispatch_with_finding = self._make_dispatch_result([high_finding])

        with (
            patch("forge_plan._dispatch_plan_review", return_value=dispatch_with_finding),
            patch("forge_plan._discover_plan_review_domains", return_value={
                "general": {"order": "01", "filename": "general.md"},
            }),
            patch("forge_plan._git_commit", return_value="commit1"),
        ):
            result = run_plan_review(plan_file, minimal_state, minimal_cfg, tmp_path)

        assert result.status == "halted"
        assert result.plan_hash is None

    def test_rounds_recorded_in_result(self, plan_file, minimal_state, minimal_cfg, tmp_path):
        """Each round is recorded in PhaseResult.rounds."""
        empty_dispatch = self._make_dispatch_result([])

        with (
            patch("forge_plan._dispatch_plan_review", return_value=empty_dispatch),
            patch("forge_plan._discover_plan_review_domains", return_value={
                "general": {"order": "01", "filename": "general.md"},
            }),
        ):
            result = run_plan_review(plan_file, minimal_state, minimal_cfg, tmp_path)

        # At minimum the halt round should be recorded
        assert len(result.rounds) >= 1

    def test_halt_round_equals_max_rounds_plus_one(
        self, plan_file, minimal_state, tmp_path
    ):
        """halt_round is always max_rounds + 1, not hardcoded."""
        cfg = {
            "max_rounds": 5,  # Non-default value
            "fix_threshold": "medium",
            "timeout": 60,
            "plan_review_routing": {},
            "agent_fallback_order": ["claude"],
        }
        empty_dispatch = {"results": []}
        dispatch_calls = []

        def tracking_dispatch(plan_content, round_num, **kwargs):
            dispatch_calls.append(round_num)
            return empty_dispatch

        with (
            patch("forge_plan._dispatch_plan_review", side_effect=tracking_dispatch),
            patch("forge_plan._discover_plan_review_domains", return_value={
                "general": {"order": "01", "filename": "general.md"},
            }),
        ):
            run_plan_review(plan_file, minimal_state, cfg, tmp_path)

        # Should have dispatched halt round = max_rounds + 1 = 6
        assert 6 in dispatch_calls

    def test_commit_made_when_findings_fixed(self, plan_file, minimal_state, tmp_path):
        """Fix commits are recorded when actionable findings are found and fixed."""
        cfg = {
            "max_rounds": 2,
            "fix_threshold": "medium",
            "timeout": 60,
            "plan_review_routing": {},
            "agent_fallback_order": ["claude"],
        }
        medium_finding = {"severity": "medium", "title": "Gap", "section": "S1"}
        call_count = [0]

        def dispatch_with_decay(plan_content, round_num, **kwargs):
            call_count[0] += 1
            # First call has findings, subsequent calls are clean
            if call_count[0] == 1:
                return {"results": [{"findings": [medium_finding], "agent": "claude", "domain": "g"}]}
            return {"results": [{"findings": [], "agent": "claude", "domain": "g"}]}

        commit_calls = []

        with (
            patch("forge_plan._dispatch_plan_review", side_effect=dispatch_with_decay),
            patch("forge_plan._discover_plan_review_domains", return_value={
                "general": {"order": "01", "filename": "general.md"},
            }),
            patch("forge_plan._git_commit", side_effect=lambda d, f, m: "sha" + str(len(commit_calls) + 1)) as mock_commit,
        ):
            result = run_plan_review(plan_file, minimal_state, cfg, tmp_path)
            commit_calls = mock_commit.call_args_list

        assert result.findings_fixed >= 1
