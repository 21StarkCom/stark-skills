#!/usr/bin/env python3
"""Tests for graph dependency context enrichment in multi_review.py.

Coverage:
  - _sanitize_graph_field: allowlist pass-through, injection stripping
  - _format_graph_context: empty report, full report, token budget truncation
  - _build_graph_dependency_context: subprocess success, exit 2 degradation,
      timeout degradation, invalid JSON degradation
  - domain gating: only enriched domains receive graph_context in run_review_round
      and run_single_agent_round
"""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

sys.path.insert(0, str(Path(__file__).parent))

from multi_review import (
    _build_graph_dependency_context,
    _format_graph_context,
    _sanitize_graph_field,
)


# ── _sanitize_graph_field ─────────────────────────────────────────────────────

class TestSanitizeGraphField:
    def test_safe_module_path_passes_through(self):
        assert _sanitize_graph_field("module.function") == "module.function"

    def test_safe_path_with_slash(self):
        assert _sanitize_graph_field("pkg/sub:ClassName") == "pkg/sub:ClassName"

    def test_alphanumeric_underscore_dash(self):
        assert _sanitize_graph_field("my_module-v2.fn") == "my_module-v2.fn"

    def test_strips_angle_brackets(self):
        """HTML/XML injection attempt must be stripped."""
        result = _sanitize_graph_field("<script>alert(1)</script>")
        assert "<" not in result
        assert ">" not in result

    def test_strips_backtick(self):
        result = _sanitize_graph_field("module`rm -rf`fn")
        assert "`" not in result

    def test_strips_semicolon(self):
        result = _sanitize_graph_field("module;evil.fn")
        assert ";" not in result

    def test_strips_newline(self):
        result = _sanitize_graph_field("module\nevil")
        assert "\n" not in result

    def test_empty_string_passes(self):
        assert _sanitize_graph_field("") == ""

    def test_safe_path_with_numbers(self):
        assert _sanitize_graph_field("module123.fn456") == "module123.fn456"


# ── _format_graph_context ─────────────────────────────────────────────────────

class TestFormatGraphContext:
    def _empty_blast(self, **kwargs) -> dict:
        blast = {"direct": [], "transitive": [], "event_subscribers": [], "depth_cap_reached": False}
        blast.update(kwargs)
        return blast

    def test_empty_report_returns_no_dependents(self):
        report = {
            "added_nodes": [], "removed_nodes": [],
            "added_edges": [], "removed_edges": [],
            "blast_radius": self._empty_blast(),
        }
        result = _format_graph_context(report)
        assert result is not None
        assert "<dependency-context>" in result
        assert "No dependents found." in result

    def test_added_nodes_appear(self):
        report = {
            "added_nodes": ["auth.login", "auth.logout"],
            "removed_nodes": [], "added_edges": [], "removed_edges": [],
            "blast_radius": self._empty_blast(),
        }
        result = _format_graph_context(report)
        assert "Added nodes: auth.login, auth.logout" in result

    def test_removed_nodes_appear(self):
        report = {
            "added_nodes": [], "removed_nodes": ["legacy.helper"],
            "added_edges": [], "removed_edges": [],
            "blast_radius": self._empty_blast(),
        }
        result = _format_graph_context(report)
        assert "Removed nodes: legacy.helper" in result

    def test_blast_radius_direct_dependents(self):
        report = {
            "added_nodes": [], "removed_nodes": [], "added_edges": [], "removed_edges": [],
            "blast_radius": self._empty_blast(direct=["api.handler", "worker.process"]),
        }
        result = _format_graph_context(report)
        assert "Direct dependents: api.handler, worker.process" in result

    def test_blast_radius_transitive_with_depth_cap(self):
        report = {
            "added_nodes": [], "removed_nodes": [], "added_edges": [], "removed_edges": [],
            "blast_radius": self._empty_blast(
                transitive=["downstream.fn"],
                depth_cap_reached=True,
            ),
        }
        result = _format_graph_context(report)
        assert "depth cap reached" in result
        assert "downstream.fn" in result

    def test_event_subscribers_appear(self):
        report = {
            "added_nodes": [], "removed_nodes": [], "added_edges": [], "removed_edges": [],
            "blast_radius": self._empty_blast(event_subscribers=["listener.on_event"]),
        }
        result = _format_graph_context(report)
        assert "Event subscribers: listener.on_event" in result

    def test_xml_tags_present(self):
        report = {
            "added_nodes": [], "removed_nodes": [], "added_edges": [], "removed_edges": [],
            "blast_radius": self._empty_blast(),
        }
        result = _format_graph_context(report)
        assert "<dependency-context>" in result
        assert "</dependency-context>" in result

    def test_injection_in_node_name_is_stripped(self):
        report = {
            "added_nodes": ["evil<script>"],
            "removed_nodes": [], "added_edges": [], "removed_edges": [],
            "blast_radius": self._empty_blast(),
        }
        result = _format_graph_context(report)
        assert "<script>" not in result

    def test_token_budget_triggers_truncation(self):
        """A report with very many nodes should trigger the truncation path."""
        # Create a report large enough to exceed 2000 tokens (8000 chars)
        many_nodes = [f"module{i}.function{i}" for i in range(500)]
        report = {
            "added_nodes": many_nodes,
            "removed_nodes": many_nodes,
            "added_edges": [f"module{i}.fn-module{i+1}.fn:calls" for i in range(300)],
            "removed_edges": [],
            "blast_radius": self._empty_blast(direct=["api.handler"]),
        }
        result = _format_graph_context(report)
        assert "truncated" in result.lower()
        # Truncated path should still have dependency context tags
        assert "<dependency-context>" in result
        assert "</dependency-context>" in result

    def test_token_budget_not_triggered_for_small_report(self):
        report = {
            "added_nodes": ["module.fn"],
            "removed_nodes": [],
            "added_edges": ["a->b:calls"],
            "removed_edges": [],
            "blast_radius": self._empty_blast(direct=["handler.fn"]),
        }
        result = _format_graph_context(report)
        assert "truncated" not in result.lower()
        assert "Added nodes: module.fn" in result


# ── _build_graph_dependency_context ──────────────────────────────────────────

class TestBuildGraphDependencyContext:
    def _diff_report(self) -> dict:
        return {
            "added_nodes": ["auth.login"],
            "removed_nodes": [],
            "added_edges": [],
            "removed_edges": [],
            "blast_radius": {
                "direct": ["api.route"],
                "transitive": [],
                "event_subscribers": [],
                "depth_cap_reached": False,
            },
        }

    def test_success_returns_formatted_context(self):
        report_json = json.dumps(self._diff_report())
        mock_result = MagicMock()
        mock_result.returncode = 0
        mock_result.stdout = report_json

        with patch("multi_review.subprocess.run", return_value=mock_result):
            result = _build_graph_dependency_context("/repo", "main", 42, {})

        assert result is not None
        assert "<dependency-context>" in result
        assert "auth.login" in result

    def test_exit_2_returns_none(self):
        """Exit 2 (setup error) must return None — degrade gracefully."""
        mock_result = MagicMock()
        mock_result.returncode = 2
        mock_result.stdout = ""

        with patch("multi_review.subprocess.run", return_value=mock_result):
            result = _build_graph_dependency_context("/repo", "main", 42, {})

        assert result is None

    def test_timeout_returns_none(self):
        with patch("multi_review.subprocess.run", side_effect=subprocess.TimeoutExpired("cmd", 120)):
            result = _build_graph_dependency_context("/repo", "main", 42, {})

        assert result is None

    def test_os_error_returns_none(self):
        with patch("multi_review.subprocess.run", side_effect=OSError("not found")):
            result = _build_graph_dependency_context("/repo", "main", 42, {})

        assert result is None

    def test_invalid_json_stdout_returns_none(self):
        mock_result = MagicMock()
        mock_result.returncode = 0
        mock_result.stdout = "not valid json"

        with patch("multi_review.subprocess.run", return_value=mock_result):
            result = _build_graph_dependency_context("/repo", "main", 42, {})

        assert result is None

    def test_empty_stdout_returns_none(self):
        mock_result = MagicMock()
        mock_result.returncode = 0
        mock_result.stdout = "   "

        with patch("multi_review.subprocess.run", return_value=mock_result):
            result = _build_graph_dependency_context("/repo", "main", 42, {})

        assert result is None

    def test_pr_number_passed_to_subprocess(self):
        report_json = json.dumps(self._diff_report())
        mock_result = MagicMock()
        mock_result.returncode = 0
        mock_result.stdout = report_json

        with patch("multi_review.subprocess.run", return_value=mock_result) as mock_run:
            _build_graph_dependency_context("/repo", "main", 99, {})

        cmd = mock_run.call_args[0][0]
        assert "--pr" in cmd
        assert "99" in cmd

    def test_no_pr_number_omits_pr_flag(self):
        report_json = json.dumps(self._diff_report())
        mock_result = MagicMock()
        mock_result.returncode = 0
        mock_result.stdout = report_json

        with patch("multi_review.subprocess.run", return_value=mock_result) as mock_run:
            _build_graph_dependency_context("/repo", "main", None, {})

        cmd = mock_run.call_args[0][0]
        assert "--pr" not in cmd

    def test_diff_stage_is_used(self):
        report_json = json.dumps(self._diff_report())
        mock_result = MagicMock()
        mock_result.returncode = 0
        mock_result.stdout = report_json

        with patch("multi_review.subprocess.run", return_value=mock_result) as mock_run:
            _build_graph_dependency_context("/repo", "main", 1, {})

        cmd = mock_run.call_args[0][0]
        assert "--stage" in cmd
        idx = cmd.index("--stage")
        assert cmd[idx + 1] == "diff"


# ── domain gating in run_review_round ────────────────────────────────────────

class TestDomainGating:
    """Verify only enriched domains receive graph_context."""

    def _make_subagent_result(self, agent, domain):
        from multi_review import SubAgentResult
        return SubAgentResult(agent=agent, domain=domain, raw_output="", findings=[], error=None, duration_s=0.1)

    def test_enriched_domains_get_graph_context(self):
        """Domains in enriched_domains must receive graph_context; others must not."""
        from multi_review import run_single_agent_round

        captured_calls: list[tuple[str, str | None]] = []

        def mock_run_subagent(agent, domain_key, base, cwd, spec_context, graph_context=None):
            captured_calls.append((domain_key, graph_context))
            return self._make_subagent_result(agent, domain_key)

        domain_agent_map = {
            "architecture": "codex",
            "correctness": "codex",
            "security": "codex",
        }
        enriched_domains = ["architecture", "correctness"]
        graph_ctx = "## Dependency Context\n\n<dependency-context>test</dependency-context>"

        with patch("multi_review._run_subagent", side_effect=mock_run_subagent):
            run_single_agent_round(
                base="main",
                round_num=1,
                domain_agent_map=domain_agent_map,
                graph_context=graph_ctx,
                enriched_domains=enriched_domains,
            )

        call_map = {domain: ctx for domain, ctx in captured_calls}
        # Enriched domains should get graph context
        assert call_map["architecture"] == graph_ctx
        assert call_map["correctness"] == graph_ctx
        # Non-enriched domain should NOT get graph context
        assert call_map["security"] is None

    def test_no_enriched_domains_means_no_graph_context(self):
        """If enriched_domains is empty, no domain should get graph_context."""
        from multi_review import run_single_agent_round

        captured_calls: list[tuple[str, str | None]] = []

        def mock_run_subagent(agent, domain_key, base, cwd, spec_context, graph_context=None):
            captured_calls.append((domain_key, graph_context))
            return self._make_subagent_result(agent, domain_key)

        with patch("multi_review._run_subagent", side_effect=mock_run_subagent):
            run_single_agent_round(
                base="main",
                round_num=1,
                domain_agent_map={"architecture": "codex"},
                graph_context="some context",
                enriched_domains=[],
            )

        _, ctx = captured_calls[0]
        assert ctx is None

    def test_none_graph_context_passes_none_to_all(self):
        """If graph_context is None, all domains receive None."""
        from multi_review import run_single_agent_round

        captured_calls: list[tuple[str, str | None]] = []

        def mock_run_subagent(agent, domain_key, base, cwd, spec_context, graph_context=None):
            captured_calls.append((domain_key, graph_context))
            return self._make_subagent_result(agent, domain_key)

        with patch("multi_review._run_subagent", side_effect=mock_run_subagent):
            run_single_agent_round(
                base="main",
                round_num=1,
                domain_agent_map={"architecture": "codex"},
                graph_context=None,
                enriched_domains=["architecture"],
            )

        _, ctx = captured_calls[0]
        assert ctx is None
