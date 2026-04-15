"""Tests for forge_review.py — Phase 4: Design Review Iron Rule Loop.

Task 4.1: compute_finding_id, domain discovery, agent routing, dispatch
Task 4.2: classify_findings, batch_fixes, commit trail, round loop, halt round
Task 4.3: targeted re-dispatch, consensus, degradation
"""
from __future__ import annotations

import sys
from pathlib import Path
from unittest.mock import patch

import pytest

sys.path.insert(0, str(Path(__file__).parent))

from forge_review import (  # pyright: ignore[reportMissingImports]
    PhaseResult,
    _apply_consensus,
    _group_domains_by_agent,
    _map_changed_sections_to_domains,
    _resolve_agent,
    _severity_meets_threshold,
    batch_fixes,
    classify_findings,
    compute_finding_id,
    run_design_review,
)


# ── Fixtures ──────────────────────────────────────────────────────────────


@pytest.fixture
def spec_file(tmp_path):
    p = tmp_path / "my-spec.md"
    p.write_text(
        "# My Spec\n\n## Solution\n\nSome design content.\n\n## Security\n\nAuth details.\n"
    )
    return p


@pytest.fixture
def minimal_state():
    return {
        "phases": {
            "design_review": {"status": "pending", "rounds": []},
        },
        "updated_at": "2026-01-01T00:00:00+00:00",
    }


@pytest.fixture
def minimal_cfg():
    return {
        "max_rounds": 2,
        "fix_threshold": "medium",
        "timeout": 60,
        "domain_routing": {
            "general": "claude",
            "security": "codex",
            "consistency": "claude",
        },
        "agent_fallback_order": ["claude", "codex"],
        "consensus_domains": ["security"],
        "consensus_threshold": 2,
    }


# ═══════════════════════════════════════════════════════════════════════════
# Task 4.1 — Routed design-review dispatch
# ═══════════════════════════════════════════════════════════════════════════


class TestComputeFindingId:
    def test_finding_id_stable(self):
        """Same inputs produce same 12-char hex ID."""
        id1 = compute_finding_id(
            "claude", "general", "## Solution", "Missing error handling"
        )
        id2 = compute_finding_id(
            "claude", "general", "## Solution", "Missing error handling"
        )
        assert id1 == id2
        assert len(id1) == 12

    def test_finding_id_hex_chars(self):
        fid = compute_finding_id("codex", "security", "## Auth", "SQL injection risk")
        assert all(c in "0123456789abcdef" for c in fid)

    def test_different_inputs_different_ids(self):
        id1 = compute_finding_id(
            "claude", "general", "## Solution", "Missing error handling"
        )
        id2 = compute_finding_id(
            "codex", "general", "## Solution", "Missing error handling"
        )
        id3 = compute_finding_id(
            "claude", "security", "## Solution", "Missing error handling"
        )
        assert id1 != id2
        assert id1 != id3

    def test_empty_inputs(self):
        fid = compute_finding_id("", "", "", "")
        assert len(fid) == 12


class TestResolveAgent:
    def test_returns_routed_when_enabled(self):
        with patch("forge_review.is_agent_enabled", return_value=True):
            assert _resolve_agent("claude", ["claude", "codex"]) == "claude"

    def test_falls_back_when_routed_disabled(self):
        def fake_enabled(agent):
            return agent != "claude"

        with patch("forge_review.is_agent_enabled", side_effect=fake_enabled):
            assert _resolve_agent("claude", ["claude", "codex"]) == "codex"

    def test_returns_none_when_all_disabled(self):
        with patch("forge_review.is_agent_enabled", return_value=False):
            assert _resolve_agent("claude", ["claude", "codex"]) is None


class TestGroupDomainsByAgent:
    def test_groups_by_routing(self):
        routing = {
            "general": "claude",
            "security": "codex",
            "consistency": "claude",
        }
        domains = {
            "general": {"order": "01", "filename": "01-general.md"},
            "security": {"order": "02", "filename": "02-security.md"},
            "consistency": {"order": "03", "filename": "03-consistency.md"},
        }
        with patch("forge_review.is_agent_enabled", return_value=True):
            groups = _group_domains_by_agent(
                routing,
                ["claude", "codex"],
                domains,
                consensus_domains=["security"],
            )
        assert "general" in groups["claude"]
        assert "consistency" in groups["claude"]
        # security is consensus domain -> excluded from normal grouping
        assert "security" not in groups.get("codex", {})

    def test_consensus_domains_excluded(self):
        routing = {"security": "codex"}
        domains = {"security": {"order": "01", "filename": "01-security.md"}}
        with patch("forge_review.is_agent_enabled", return_value=True):
            groups = _group_domains_by_agent(
                routing,
                ["claude", "codex"],
                domains,
                consensus_domains=["security"],
            )
        for agent_domains in groups.values():
            assert "security" not in agent_domains

    def test_empty_domains(self):
        with patch("forge_review.is_agent_enabled", return_value=True):
            groups = _group_domains_by_agent({}, ["claude"], {}, [])
        assert groups == {}

    def test_fallback_when_routed_agent_unavailable(self):
        routing = {"general": "gemini"}
        domains = {"general": {"order": "01", "filename": "01-general.md"}}

        def fake_enabled(agent):
            return agent != "gemini"

        with patch("forge_review.is_agent_enabled", side_effect=fake_enabled):
            groups = _group_domains_by_agent(
                routing, ["claude", "codex", "gemini"], domains, []
            )
        assert "general" in groups.get("claude", {})


class TestPhaseResult:
    def test_defaults(self):
        r = PhaseResult(status="completed")
        assert r.status == "completed"
        assert r.rounds == []
        assert r.findings_fixed == 0
        assert r.noise == 0
        assert r.commit_shas == []


# ═══════════════════════════════════════════════════════════════════════════
# Task 4.2 — Finding classification, fix batching, commit trail
# ═══════════════════════════════════════════════════════════════════════════


class TestSeverityMeetsThreshold:
    def test_critical_meets_medium(self):
        assert _severity_meets_threshold("critical", "medium") is True

    def test_high_meets_medium(self):
        assert _severity_meets_threshold("high", "medium") is True

    def test_medium_meets_medium(self):
        assert _severity_meets_threshold("medium", "medium") is True

    def test_low_does_not_meet_medium(self):
        assert _severity_meets_threshold("low", "medium") is False

    def test_low_meets_low(self):
        assert _severity_meets_threshold("low", "low") is True

    def test_unknown_severity_defaults_to_medium(self):
        assert _severity_meets_threshold("bogus", "medium") is True


class TestClassifyFindings:
    def test_fix_above_threshold(self):
        findings = [
            {
                "agent": "claude",
                "domain": "general",
                "section": "## Solution",
                "title": "Missing retry",
                "severity": "high",
                "description": "No retry logic",
            },
        ]
        classified = classify_findings(findings, "spec text", [], "medium")
        assert len(classified) == 1
        assert classified[0]["status"] == "fix"

    def test_noise_below_threshold(self):
        findings = [
            {
                "agent": "claude",
                "domain": "general",
                "section": "## Solution",
                "title": "Minor style",
                "severity": "low",
                "description": "Style nit",
            },
        ]
        classified = classify_findings(findings, "spec text", [], "medium")
        assert classified[0]["status"] == "noise"

    def test_cross_reference_high_confidence(self):
        """2+ agents on same section+title -> fix regardless of severity."""
        findings = [
            {
                "agent": "claude",
                "domain": "general",
                "section": "## Auth",
                "title": "Missing validation",
                "severity": "low",
                "description": "A",
            },
            {
                "agent": "codex",
                "domain": "security",
                "section": "## Auth",
                "title": "Missing validation",
                "severity": "low",
                "description": "B",
            },
        ]
        classified = classify_findings(findings, "spec text", [], "medium")
        fix_entries = [f for f in classified if f["status"] == "fix"]
        assert len(fix_entries) == 1
        assert fix_entries[0]["high_confidence"] is True

    def test_cross_reference_deduplicates(self):
        """Cross-referenced findings should be deduplicated to one entry."""
        findings = [
            {
                "agent": "claude",
                "domain": "general",
                "section": "## S1",
                "title": "Issue A",
                "severity": "low",
                "description": "A",
            },
            {
                "agent": "codex",
                "domain": "security",
                "section": "## S1",
                "title": "Issue A",
                "severity": "low",
                "description": "B",
            },
        ]
        classified = classify_findings(findings, "", [], "medium")
        assert len(classified) == 1

    def test_recurring_finding_second_time_flagged(self):
        """Second recurrence gets recurring=True but stays as fix."""
        finding = {
            "agent": "claude",
            "domain": "general",
            "section": "## Solution",
            "title": "Missing retry",
            "severity": "high",
            "description": "No retry",
        }
        fid = compute_finding_id("claude", "general", "## Solution", "Missing retry")

        prev_rounds = [
            {"classified_findings": [{"id": fid, "status": "fix"}]},
        ]

        classified = classify_findings([finding], "spec text", prev_rounds, "medium")
        assert classified[0]["status"] == "fix"
        assert classified[0].get("recurring") is True

    def test_recurring_finding_becomes_blocked(self):
        """Third recurrence of same finding_id triggers blocked -> HALT."""
        finding = {
            "agent": "claude",
            "domain": "general",
            "section": "## Solution",
            "title": "Missing retry",
            "severity": "high",
            "description": "No retry",
        }
        fid = compute_finding_id("claude", "general", "## Solution", "Missing retry")

        prev_rounds = [
            {"classified_findings": [{"id": fid, "status": "fix"}]},
            {"classified_findings": [{"id": fid, "status": "fix"}]},
        ]

        classified = classify_findings([finding], "spec text", prev_rounds, "medium")
        assert classified[0]["status"] == "blocked"
        assert classified[0].get("recurring") is True

    def test_progressive_recurrence_through_rounds(self):
        """Full lifecycle: fix -> recurring fix -> blocked."""
        finding = {
            "agent": "claude",
            "domain": "general",
            "section": "S1",
            "title": "T1",
            "severity": "high",
        }

        # Round 1: fix
        r1 = classify_findings([finding], "", [], "medium")
        assert r1[0]["status"] == "fix"

        # Round 2: recurring fix
        prev = [{"classified_findings": r1}]
        r2 = classify_findings([finding], "", prev, "medium")
        assert r2[0]["status"] == "fix"
        assert r2[0].get("recurring") is True

        # Round 3: blocked
        prev.append({"classified_findings": r2})
        r3 = classify_findings([finding], "", prev, "medium")
        assert r3[0]["status"] == "blocked"

    def test_empty_findings(self):
        assert classify_findings([], "", [], "medium") == []

    def test_noise_not_counted_in_recurrence(self):
        """Only 'fix' status counts toward recurrence."""
        finding = {
            "agent": "claude",
            "domain": "general",
            "section": "## Solution",
            "title": "Minor issue",
            "severity": "high",
            "description": "Something",
        }
        fid = compute_finding_id("claude", "general", "## Solution", "Minor issue")

        prev_rounds = [
            {"classified_findings": [{"id": fid, "status": "noise"}]},
        ]

        classified = classify_findings([finding], "spec text", prev_rounds, "medium")
        assert classified[0].get("recurring") is not True


class TestBatchFixes:
    def test_groups_by_section(self):
        classified = [
            {"status": "fix", "section": "## Auth", "title": "A"},
            {"status": "fix", "section": "## Auth", "title": "B"},
            {"status": "fix", "section": "## API", "title": "C"},
            {"status": "noise", "section": "## Auth", "title": "D"},
        ]
        batches = batch_fixes(classified)
        assert len(batches["## Auth"]) == 2
        assert len(batches["## API"]) == 1

    def test_empty_when_no_fixes(self):
        classified = [{"status": "noise", "section": "S1", "title": "A"}]
        assert batch_fixes(classified) == {}

    def test_unknown_section_uses_key(self):
        classified = [{"status": "fix", "section": "", "title": "A"}]
        batches = batch_fixes(classified)
        assert "" in batches

    def test_missing_section_defaults_to_unknown(self):
        classified = [{"status": "fix", "title": "A"}]
        batches = batch_fixes(classified)
        assert "unknown" in batches


# ═══════════════════════════════════════════════════════════════════════════
# Task 4.3 — Targeted re-dispatch and consensus
# ═══════════════════════════════════════════════════════════════════════════


class TestMapChangedSectionsToDomains:
    def test_maps_matching_sections(self):
        changed = ["## Security Considerations", "## API Design"]
        all_domains = ["general", "security", "api-design", "consistency"]
        result = _map_changed_sections_to_domains(
            changed, all_domains, ["general", "consistency"]
        )
        assert "security" in result
        assert "api-design" in result
        assert "general" in result
        assert "consistency" in result

    def test_always_includes_specified_domains(self):
        changed = ["## Something Unrelated"]
        all_domains = ["general", "security", "consistency"]
        result = _map_changed_sections_to_domains(
            changed, all_domains, ["general", "consistency"]
        )
        # No specific match beyond always_include -> returns all
        assert set(result) == set(all_domains)

    def test_empty_changed_sections(self):
        result = _map_changed_sections_to_domains(
            [], ["general", "security"], ["general"]
        )
        assert "general" in result

    def test_falls_back_to_all_when_no_matches(self):
        changed = ["## Unrelated Thing"]
        all_domains = ["general", "security", "scalability"]
        result = _map_changed_sections_to_domains(changed, all_domains, ["general"])
        assert set(result) == set(all_domains)


class TestApplyConsensus:
    def test_confirmed_when_multiple_agents_agree(self):
        findings = [
            {
                "agent": "claude",
                "section": "## Auth",
                "title": "SQL injection",
                "severity": "high",
            },
            {
                "agent": "codex",
                "section": "## Auth",
                "title": "SQL injection",
                "severity": "high",
            },
        ]
        result = _apply_consensus(findings, threshold=2)
        assert len(result) == 1
        assert result[0]["consensus"] == "confirmed"

    def test_single_agent_not_auto_noised(self):
        findings = [
            {
                "agent": "claude",
                "section": "## Auth",
                "title": "Minor issue",
                "severity": "low",
            },
        ]
        result = _apply_consensus(findings, threshold=2)
        assert len(result) == 1
        assert result[0]["consensus"] == "single_agent"

    def test_different_titles_not_grouped(self):
        findings = [
            {
                "agent": "claude",
                "section": "## Auth",
                "title": "Issue A",
                "severity": "high",
            },
            {
                "agent": "codex",
                "section": "## Auth",
                "title": "Issue B",
                "severity": "high",
            },
        ]
        result = _apply_consensus(findings, threshold=2)
        assert len(result) == 2
        assert all(f["consensus"] == "single_agent" for f in result)

    def test_empty_findings(self):
        assert _apply_consensus([], threshold=2) == []

    def test_threshold_of_one(self):
        findings = [
            {
                "agent": "claude",
                "section": "## S1",
                "title": "Thing",
                "severity": "medium",
            },
        ]
        result = _apply_consensus(findings, threshold=1)
        assert result[0]["consensus"] == "confirmed"

    def test_three_agents_with_threshold_two(self):
        """3 agents, threshold=2 -> confirmed (exceeds threshold)."""
        findings = [
            {"agent": "claude", "section": "## S1", "title": "Bug", "severity": "high"},
            {"agent": "codex", "section": "## S1", "title": "Bug", "severity": "high"},
            {"agent": "gemini", "section": "## S1", "title": "Bug", "severity": "high"},
        ]
        result = _apply_consensus(findings, threshold=2)
        assert len(result) == 1
        assert result[0]["consensus"] == "confirmed"


# ═══════════════════════════════════════════════════════════════════════════
# Integration: run_design_review
# ═══════════════════════════════════════════════════════════════════════════


class TestRunDesignReview:
    def _make_dispatch_result(self, findings=None):
        return {
            "findings": findings or [],
            "summary": {"total_findings": len(findings or [])},
            "results": [
                {
                    "agent": "claude",
                    "domain": "general",
                    "findings": findings or [],
                }
            ],
        }

    def test_clean_rounds_complete(
        self, spec_file, minimal_state, minimal_cfg, tmp_path
    ):
        """No findings -> completed."""
        empty = self._make_dispatch_result([])
        with (
            patch("forge_review._dispatch_review", return_value=empty),
            patch(
                "forge_review._discover_forge_domains",
                return_value={
                    "general": {"order": "01", "filename": "01-general.md"},
                    "consistency": {"order": "02", "filename": "02-consistency.md"},
                },
            ),
            patch("forge_review.is_agent_enabled", return_value=True),
        ):
            result = run_design_review(
                spec_file, minimal_state, minimal_cfg, tmp_path
            )

        assert result.status == "completed"
        assert any(r.get("is_halt") for r in result.rounds)

    def test_halts_on_blocked_finding(
        self, spec_file, minimal_state, minimal_cfg, tmp_path
    ):
        """Blocked finding causes immediate halt."""
        finding = {
            "agent": "claude",
            "domain": "general",
            "section": "## Solution",
            "title": "Persistent issue",
            "severity": "high",
            "description": "Cannot fix",
        }
        with (
            patch(
                "forge_review._dispatch_review",
                return_value=self._make_dispatch_result([finding]),
            ),
            patch(
                "forge_review._discover_forge_domains",
                return_value={
                    "general": {"order": "01", "filename": "01-general.md"},
                },
            ),
            patch("forge_review.is_agent_enabled", return_value=True),
            patch("forge_review._commit_round", return_value="abc123"),
        ):
            result = run_design_review(
                spec_file, minimal_state, minimal_cfg, tmp_path
            )

        assert result.status == "halted"

    def test_halt_round_uses_max_rounds_plus_one(
        self, spec_file, minimal_state, tmp_path
    ):
        """halt_round is always max_rounds + 1, not hardcoded."""
        cfg = {
            "max_rounds": 5,
            "fix_threshold": "medium",
            "timeout": 60,
            "domain_routing": {"general": "claude"},
            "agent_fallback_order": ["claude"],
            "consensus_domains": [],
            "consensus_threshold": 2,
        }
        empty = self._make_dispatch_result([])
        dispatch_rounds: list[int] = []

        def tracking_dispatch(_spec_text, round_num, **_kwargs):
            dispatch_rounds.append(round_num)
            return empty

        with (
            patch("forge_review._dispatch_review", side_effect=tracking_dispatch),
            patch(
                "forge_review._discover_forge_domains",
                return_value={
                    "general": {"order": "01", "filename": "01-general.md"},
                },
            ),
            patch("forge_review.is_agent_enabled", return_value=True),
        ):
            run_design_review(spec_file, minimal_state, cfg, tmp_path)

        assert 6 in dispatch_rounds

    def test_zero_fix_skips_commit(
        self, spec_file, minimal_state, minimal_cfg, tmp_path
    ):
        """Rounds with 0 fix findings skip commit."""
        low_finding = {
            "agent": "claude",
            "domain": "general",
            "section": "## Solution",
            "title": "Style nit",
            "severity": "low",
            "description": "Minor",
        }
        with (
            patch(
                "forge_review._dispatch_review",
                return_value=self._make_dispatch_result([low_finding]),
            ),
            patch(
                "forge_review._discover_forge_domains",
                return_value={
                    "general": {"order": "01", "filename": "01-general.md"},
                },
            ),
            patch("forge_review.is_agent_enabled", return_value=True),
        ):
            result = run_design_review(
                spec_file, minimal_state, minimal_cfg, tmp_path
            )

        assert result.status == "completed"
        assert result.commit_shas == []

    def test_commit_made_when_findings_fixed(
        self, spec_file, minimal_state, tmp_path
    ):
        cfg = {
            "max_rounds": 2,
            "fix_threshold": "medium",
            "timeout": 60,
            "domain_routing": {"general": "claude"},
            "agent_fallback_order": ["claude"],
            "consensus_domains": [],
            "consensus_threshold": 2,
        }
        high_finding = {
            "agent": "claude",
            "domain": "general",
            "section": "## Solution",
            "title": "Missing retry",
            "severity": "high",
            "description": "Add retry",
        }
        call_count = [0]

        def dispatch_decay(*_args, **_kwargs):
            call_count[0] += 1
            if call_count[0] == 1:
                return self._make_dispatch_result([high_finding])
            return self._make_dispatch_result([])

        with (
            patch("forge_review._dispatch_review", side_effect=dispatch_decay),
            patch(
                "forge_review._discover_forge_domains",
                return_value={
                    "general": {"order": "01", "filename": "01-general.md"},
                },
            ),
            patch("forge_review.is_agent_enabled", return_value=True),
            patch("forge_review._commit_round", return_value="sha123"),
            patch(
                "forge_fix_loop.apply_fixes",
                return_value=("# Spec rewritten by mock\n", True),
            ),
        ):
            result = run_design_review(spec_file, minimal_state, cfg, tmp_path)

        assert result.findings_fixed >= 1
        assert "sha123" in result.commit_shas

    def test_state_updated_after_review(
        self, spec_file, minimal_state, minimal_cfg, tmp_path
    ):
        empty = self._make_dispatch_result([])
        with (
            patch("forge_review._dispatch_review", return_value=empty),
            patch(
                "forge_review._discover_forge_domains",
                return_value={
                    "general": {"order": "01", "filename": "01-general.md"},
                },
            ),
            patch("forge_review.is_agent_enabled", return_value=True),
        ):
            run_design_review(spec_file, minimal_state, minimal_cfg, tmp_path)

        assert minimal_state["phases"]["design_review"]["status"] in (
            "completed",
            "halted",
        )
        assert "rounds" in minimal_state["phases"]["design_review"]

    def test_consensus_domain_dispatched_to_multiple_agents(
        self, spec_file, minimal_state, minimal_cfg, tmp_path
    ):
        """Security (consensus domain) dispatches to 2+ agents."""
        dispatch_calls: list[dict] = []

        def tracking_dispatch(
            _spec_text,
            _round_num,
            *,
            repo_dir,
            prompts_dir,
            agents,
            domains,
            timeout,
        ):
            dispatch_calls.append(
                {"agents": agents, "domains": list(domains.keys())}
            )
            return self._make_dispatch_result([])

        with (
            patch("forge_review._dispatch_review", side_effect=tracking_dispatch),
            patch(
                "forge_review._discover_forge_domains",
                return_value={
                    "general": {"order": "01", "filename": "01-general.md"},
                    "security": {"order": "02", "filename": "02-security.md"},
                    "consistency": {
                        "order": "03",
                        "filename": "03-consistency.md",
                    },
                },
            ),
            patch("forge_review.is_agent_enabled", return_value=True),
        ):
            run_design_review(spec_file, minimal_state, minimal_cfg, tmp_path)

        security_calls = [
            c for c in dispatch_calls if "security" in c["domains"]
        ]
        assert len(security_calls) >= 2

    def test_halt_round_dispatches_all_domains(
        self, spec_file, minimal_state, tmp_path
    ):
        cfg = {
            "max_rounds": 1,
            "fix_threshold": "medium",
            "timeout": 60,
            "domain_routing": {"general": "claude", "consistency": "claude"},
            "agent_fallback_order": ["claude"],
            "consensus_domains": [],
            "consensus_threshold": 2,
        }
        dispatch_calls: list[dict] = []

        def tracking_dispatch(_spec_text, round_num, **kwargs):
            dispatch_calls.append(
                {
                    "round": round_num,
                    "domains": list(kwargs.get("domains", {}).keys()),
                }
            )
            return self._make_dispatch_result([])

        with (
            patch("forge_review._dispatch_review", side_effect=tracking_dispatch),
            patch(
                "forge_review._discover_forge_domains",
                return_value={
                    "general": {"order": "01", "filename": "01-general.md"},
                    "consistency": {
                        "order": "02",
                        "filename": "02-consistency.md",
                    },
                },
            ),
            patch("forge_review.is_agent_enabled", return_value=True),
        ):
            run_design_review(spec_file, minimal_state, cfg, tmp_path)

        halt_calls = [c for c in dispatch_calls if c["round"] == 2]
        halt_domains: set[str] = set()
        for c in halt_calls:
            halt_domains.update(c["domains"])
        assert "general" in halt_domains
        assert "consistency" in halt_domains

    def test_fallback_builds_domains_from_routing_keys(
        self, spec_file, minimal_state, minimal_cfg, tmp_path
    ):
        """When discover returns nothing, domains built from routing config."""
        empty = self._make_dispatch_result([])
        with (
            patch("forge_review._dispatch_review", return_value=empty),
            patch("forge_review._discover_forge_domains", return_value={}),
            patch("forge_review.is_agent_enabled", return_value=True),
        ):
            result = run_design_review(
                spec_file, minimal_state, minimal_cfg, tmp_path
            )

        assert result.status in ("completed", "halted")

    def test_noise_counter_accumulates(
        self, spec_file, minimal_state, tmp_path
    ):
        """Noise findings are accumulated across rounds."""
        cfg = {
            "max_rounds": 2,
            "fix_threshold": "medium",
            "timeout": 60,
            "domain_routing": {"general": "claude"},
            "agent_fallback_order": ["claude"],
            "consensus_domains": [],
            "consensus_threshold": 2,
        }
        low_finding = {
            "agent": "claude",
            "domain": "general",
            "section": "## S1",
            "title": "Nit",
            "severity": "low",
            "description": "Style",
        }

        with (
            patch(
                "forge_review._dispatch_review",
                return_value=self._make_dispatch_result([low_finding]),
            ),
            patch(
                "forge_review._discover_forge_domains",
                return_value={
                    "general": {"order": "01", "filename": "01-general.md"},
                },
            ),
            patch("forge_review.is_agent_enabled", return_value=True),
        ):
            result = run_design_review(spec_file, minimal_state, cfg, tmp_path)

        assert result.noise >= 1

    def test_consensus_degradation_single_agent(
        self, spec_file, minimal_state, tmp_path
    ):
        """If one consensus agent is disabled, falls back gracefully."""
        cfg = {
            "max_rounds": 1,
            "fix_threshold": "medium",
            "timeout": 60,
            "domain_routing": {"general": "claude", "security": "codex"},
            "agent_fallback_order": ["claude", "codex"],
            "consensus_domains": ["security"],
            "consensus_threshold": 2,
        }

        def only_claude_enabled(agent):
            return agent == "claude"

        def tracking_dispatch(_spec_text, _round_num, **_kwargs):
            return self._make_dispatch_result([])

        with (
            patch(
                "forge_review._dispatch_review", side_effect=tracking_dispatch
            ),
            patch(
                "forge_review._discover_forge_domains",
                return_value={
                    "general": {"order": "01", "filename": "01-general.md"},
                    "security": {"order": "02", "filename": "02-security.md"},
                },
            ),
            patch(
                "forge_review.is_agent_enabled",
                side_effect=only_claude_enabled,
            ),
        ):
            result = run_design_review(spec_file, minimal_state, cfg, tmp_path)

        assert result.status in ("completed", "halted")


# ═══════════════════════════════════════════════════════════════════════════
# Fix-loop halt-on-noop (regression coverage for the silent-no-op-commit bug)
# ═══════════════════════════════════════════════════════════════════════════


class TestDesignReviewFixDispatchNoop:
    """When the fix-application LLM produces no changes, the loop must halt
    rather than commit an empty no-op with a misleading message and re-find
    the same issues forever."""

    def _dispatch_with_fix(self, finding_severity: str = "high") -> dict:
        # forge_review._dispatch_review is expected to return a dict with a
        # top-level "findings" list — mirroring dispatch_plan_review's shape.
        return {
            "findings": [
                {
                    "agent": "claude",
                    "domain": "general",
                    "section": "## Solution",
                    "title": "Needs work",
                    "severity": finding_severity,
                    "description": "Add error handling",
                }
            ],
            "summary": {"total_findings": 1},
        }

    def test_halts_when_apply_fixes_returns_no_change(
        self, spec_file, minimal_state, minimal_cfg, tmp_path
    ):
        """apply_fixes returning changed=False halts the round, sets
        fix_dispatch_noop on the round record, and skips the commit."""
        commit_calls: list = []

        def fake_commit(*args, **kwargs):
            commit_calls.append((args, kwargs))
            return "should-not-be-called"

        with (
            patch(
                "forge_review._dispatch_review",
                return_value=self._dispatch_with_fix(),
            ),
            patch(
                "forge_review._discover_forge_domains",
                return_value={
                    "general": {"order": "01", "filename": "01-general.md"},
                },
            ),
            patch("forge_review.is_agent_enabled", return_value=True),
            patch("forge_review._commit_round", side_effect=fake_commit),
            patch(
                "forge_fix_loop.apply_fixes",
                return_value=("# Original spec body", False),
            ),
        ):
            result = run_design_review(
                spec_file, minimal_state, minimal_cfg, tmp_path
            )

        assert result.status == "halted"
        assert commit_calls == [], "commit must be skipped on no-op rewrite"
        # Round record should be marked
        assert any(
            r.get("fix_dispatch_noop") for r in result.rounds
        ), "round record must flag fix_dispatch_noop"

    def test_continues_when_apply_fixes_changes_spec(
        self, spec_file, minimal_state, minimal_cfg, tmp_path
    ):
        """Successful (changed=True) rewrite should commit and continue
        instead of halting with fix_dispatch_noop."""
        # First call returns a fix; subsequent calls are clean
        empty: dict = {"findings": [], "summary": {"total_findings": 0}}
        responses = [self._dispatch_with_fix(), empty, empty]

        def dispatch_side_effect(*args, **kwargs):
            return responses.pop(0) if responses else empty

        with (
            patch(
                "forge_review._dispatch_review", side_effect=dispatch_side_effect,
            ),
            patch(
                "forge_review._discover_forge_domains",
                return_value={
                    "general": {"order": "01", "filename": "01-general.md"},
                },
            ),
            patch("forge_review.is_agent_enabled", return_value=True),
            patch("forge_review._commit_round", return_value="abc123"),
            patch(
                "forge_fix_loop.apply_fixes",
                return_value=("# Rewritten spec body", True),
            ),
        ):
            result = run_design_review(
                spec_file, minimal_state, minimal_cfg, tmp_path
            )

        assert result.status == "completed"
        # No round should be flagged as a fix-dispatch noop
        assert not any(
            r.get("fix_dispatch_noop") for r in result.rounds
        )


class TestDesignReviewFixTimeoutTiering:
    """The fix-dispatch call (full-spec rewrite) must use ``fix_timeout``,
    not the shared ``timeout`` used for per-domain review dispatches. The
    rewrite is a much larger output-bound operation and needs a longer
    budget than a single-domain audit."""

    def _dispatch_with_fix(self) -> dict:
        return {
            "findings": [
                {
                    "agent": "claude",
                    "domain": "general",
                    "section": "## Solution",
                    "title": "Needs work",
                    "severity": "high",
                    "description": "Add error handling",
                }
            ],
            "summary": {"total_findings": 1},
        }

    def test_apply_fixes_receives_fix_timeout_not_review_timeout(
        self, spec_file, minimal_state, tmp_path
    ):
        cfg = {
            "max_rounds": 2,
            "fix_threshold": "medium",
            "timeout": 60,
            "fix_timeout": 123,
            "domain_routing": {"general": "claude"},
            "agent_fallback_order": ["claude"],
            "consensus_domains": [],
            "consensus_threshold": 2,
        }

        captured_kwargs: dict = {}

        def capture_apply(*args, **kwargs):
            captured_kwargs.update(kwargs)
            return ("# new body", True)

        with (
            patch(
                "forge_review._dispatch_review",
                return_value=self._dispatch_with_fix(),
            ),
            patch(
                "forge_review._discover_forge_domains",
                return_value={
                    "general": {"order": "01", "filename": "01-general.md"},
                },
            ),
            patch("forge_review.is_agent_enabled", return_value=True),
            patch("forge_review._commit_round", return_value="sha"),
            patch("forge_fix_loop.apply_fixes", side_effect=capture_apply),
        ):
            run_design_review(spec_file, minimal_state, cfg, tmp_path)

        assert captured_kwargs.get("timeout") == 123, (
            "fix-dispatch must use cfg['fix_timeout'], not cfg['timeout']"
        )

    def test_fix_timeout_defaults_to_900_when_unset(
        self, spec_file, minimal_state, tmp_path
    ):
        cfg = {
            "max_rounds": 2,
            "fix_threshold": "medium",
            "timeout": 60,
            # fix_timeout deliberately absent
            "domain_routing": {"general": "claude"},
            "agent_fallback_order": ["claude"],
            "consensus_domains": [],
            "consensus_threshold": 2,
        }

        captured_kwargs: dict = {}

        def capture_apply(*args, **kwargs):
            captured_kwargs.update(kwargs)
            return ("# new body", True)

        with (
            patch(
                "forge_review._dispatch_review",
                return_value=self._dispatch_with_fix(),
            ),
            patch(
                "forge_review._discover_forge_domains",
                return_value={
                    "general": {"order": "01", "filename": "01-general.md"},
                },
            ),
            patch("forge_review.is_agent_enabled", return_value=True),
            patch("forge_review._commit_round", return_value="sha"),
            patch("forge_fix_loop.apply_fixes", side_effect=capture_apply),
        ):
            run_design_review(spec_file, minimal_state, cfg, tmp_path)

        assert captured_kwargs.get("timeout") == 900, (
            "fix-dispatch should default to 900s when fix_timeout is unset"
        )


class TestDesignReviewReviewTimeoutResolution:
    """Per-domain dispatch timeout must honor ``review_timeout`` when set,
    falling back to the legacy ``timeout`` key for backward compatibility,
    finally defaulting to 300s."""

    def _dispatch_clean(self) -> dict:
        return {"findings": [], "summary": {"total_findings": 0}}

    def _run_and_capture_dispatch_timeout(
        self, cfg, spec_file, minimal_state, tmp_path,
    ) -> int | None:
        captured: dict = {}

        def capture_dispatch(*args, **kwargs):
            captured["timeout"] = kwargs.get("timeout")
            return self._dispatch_clean()

        with (
            patch(
                "forge_review._dispatch_review", side_effect=capture_dispatch,
            ),
            patch(
                "forge_review._discover_forge_domains",
                return_value={
                    "general": {"order": "01", "filename": "01-general.md"},
                },
            ),
            patch("forge_review.is_agent_enabled", return_value=True),
        ):
            run_design_review(spec_file, minimal_state, cfg, tmp_path)

        return captured.get("timeout")

    def test_review_timeout_wins_over_legacy_timeout(
        self, spec_file, minimal_state, tmp_path,
    ):
        cfg = {
            "max_rounds": 1,
            "fix_threshold": "medium",
            "review_timeout": 456,
            "timeout": 60,
            "domain_routing": {"general": "claude"},
            "agent_fallback_order": ["claude"],
            "consensus_domains": [],
            "consensus_threshold": 2,
        }
        assert self._run_and_capture_dispatch_timeout(
            cfg, spec_file, minimal_state, tmp_path,
        ) == 456

    def test_falls_back_to_legacy_timeout_when_review_timeout_absent(
        self, spec_file, minimal_state, tmp_path,
    ):
        cfg = {
            "max_rounds": 1,
            "fix_threshold": "medium",
            "timeout": 120,
            "domain_routing": {"general": "claude"},
            "agent_fallback_order": ["claude"],
            "consensus_domains": [],
            "consensus_threshold": 2,
        }
        assert self._run_and_capture_dispatch_timeout(
            cfg, spec_file, minimal_state, tmp_path,
        ) == 120

    def test_defaults_to_300_when_neither_key_set(
        self, spec_file, minimal_state, tmp_path,
    ):
        cfg = {
            "max_rounds": 1,
            "fix_threshold": "medium",
            "domain_routing": {"general": "claude"},
            "agent_fallback_order": ["claude"],
            "consensus_domains": [],
            "consensus_threshold": 2,
        }
        assert self._run_and_capture_dispatch_timeout(
            cfg, spec_file, minimal_state, tmp_path,
        ) == 300
