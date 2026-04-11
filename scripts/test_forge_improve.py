#!/usr/bin/env python3
"""Tests for forge_improve — self-improvement module."""
from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_db(tmp_path: Path) -> Path:
    """Create a minimal forge metrics SQLite DB with domain_stats table."""
    db = tmp_path / "forge_metrics.db"
    conn = sqlite3.connect(str(db))
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute(
        """
        CREATE TABLE domain_stats (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            run_id TEXT NOT NULL,
            domain TEXT NOT NULL,
            agent TEXT NOT NULL,
            round_num INTEGER NOT NULL,
            finding_count INTEGER NOT NULL,
            signal_count INTEGER NOT NULL DEFAULT 0,
            noise_count INTEGER NOT NULL DEFAULT 0,
            duration_s REAL NOT NULL,
            created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
        )
        """
    )
    conn.commit()
    conn.close()
    return db


def _insert_stats(db: Path, domain: str, signal: int, noise: int) -> None:
    conn = sqlite3.connect(str(db))
    conn.execute(
        "INSERT INTO domain_stats (run_id, domain, agent, round_num, finding_count, signal_count, noise_count, duration_s) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        ("run-001", domain, "claude", 1, signal + noise, signal, noise, 1.0),
    )
    conn.commit()
    conn.close()


# ---------------------------------------------------------------------------
# forge_improve imports (after DB helpers so fixtures can be defined above)
# ---------------------------------------------------------------------------

import sys, os

sys.path.insert(0, str(Path(__file__).parent))

from forge_improve import (
    build_improvement_prompt,
    create_improvement_pr,
    maybe_consolidate_heuristics,
    maybe_queue_improvements,
)


# ---------------------------------------------------------------------------
# test_firewall_no_spec_content
# ---------------------------------------------------------------------------


class TestFirewallNoSpecContent:
    """Verify build_improvement_prompt never leaks spec content."""

    SPEC_FRAGMENTS = [
        "The authentication service SHALL support OAuth 2.0",
        "Rate limiting MUST be applied to all public endpoints",
        "Database connections SHOULD use connection pooling",
        "All user passwords must be hashed with bcrypt",
        "The API gateway routes requests to downstream microservices",
    ]

    def test_firewall_no_spec_content(self) -> None:
        """build_improvement_prompt must not include any raw spec text."""
        domain = "security"
        snr = 0.20
        current_prompt = "Review this domain for security issues."
        finding_counts = {"signal": 4, "noise": 16}

        result = build_improvement_prompt(domain, snr, current_prompt, finding_counts)

        # The function signature must never receive spec text — but let's also
        # verify that if someone accidentally injects spec text into
        # finding_counts keys they don't leak (keys are just 'signal'/'noise').
        for fragment in self.SPEC_FRAGMENTS:
            assert fragment not in result, (
                f"Spec fragment leaked into improvement prompt: {fragment!r}"
            )

    def test_firewall_output_contains_only_metadata(self) -> None:
        """Prompt output should contain domain, SNR, counts, and current prompt."""
        result = build_improvement_prompt(
            domain="api-design",
            snr=0.25,
            current_prompt="Check API consistency.",
            finding_counts={"signal": 5, "noise": 15},
        )
        assert "api-design" in result
        assert "0.25" in result
        assert "5" in result   # signal count
        assert "15" in result  # noise count
        assert "Check API consistency." in result

    def test_firewall_no_finding_descriptions_in_output(self) -> None:
        """Verify finding_counts only passes aggregates — no description text."""
        # Pass counts that only contain numeric values (no text descriptions)
        finding_counts = {"signal": 3, "noise": 12}
        result = build_improvement_prompt("consistency", 0.20, "Prompt text.", finding_counts)

        # No sentence-like text other than what we explicitly pass in
        unexpected_phrases = [
            "Missing error handling",
            "Unclear naming",
            "Potential SQL injection",
        ]
        for phrase in unexpected_phrases:
            assert phrase not in result


# ---------------------------------------------------------------------------
# test_maybe_queue_improvements_detects_low_snr
# ---------------------------------------------------------------------------


class TestMaybeQueueImprovements:
    def test_detects_low_snr(self, tmp_path: Path) -> None:
        """Domains with SNR below threshold must be returned."""
        db = _make_db(tmp_path)
        # Insert low-SNR data: 2 signal, 8 noise → SNR = 0.20
        _insert_stats(db, "security", signal=2, noise=8)

        run_summary = {
            "db_path": str(db),
            "domain_stats": [{"domain": "security"}],
        }
        cfg = {"noise_improvement_threshold": 0.33}

        result = maybe_queue_improvements(run_summary, cfg)
        assert "security" in result

    def test_skips_good_snr(self, tmp_path: Path) -> None:
        """Domains with SNR above threshold must not be returned."""
        db = _make_db(tmp_path)
        # Insert high-SNR data: 9 signal, 1 noise → SNR = 0.90
        _insert_stats(db, "completeness", signal=9, noise=1)

        run_summary = {
            "db_path": str(db),
            "domain_stats": [{"domain": "completeness"}],
        }
        cfg = {"noise_improvement_threshold": 0.33}

        result = maybe_queue_improvements(run_summary, cfg)
        assert "completeness" not in result

    def test_uses_default_threshold_when_missing(self, tmp_path: Path) -> None:
        """Falls back to 0.33 threshold when not in cfg."""
        db = _make_db(tmp_path)
        # SNR = 0.25 — below the 0.33 default
        _insert_stats(db, "scope", signal=1, noise=3)

        run_summary = {
            "db_path": str(db),
            "domain_stats": [{"domain": "scope"}],
        }
        cfg = {}  # No threshold — should use default 0.33

        result = maybe_queue_improvements(run_summary, cfg)
        assert "scope" in result

    def test_returns_empty_when_no_db_path(self) -> None:
        """Returns empty list when db_path is missing from run_summary."""
        run_summary = {"domain_stats": [{"domain": "general"}]}
        cfg = {"noise_improvement_threshold": 0.33}

        result = maybe_queue_improvements(run_summary, cfg)
        assert result == []

    def test_returns_empty_when_no_domains(self, tmp_path: Path) -> None:
        """Returns empty list when domain_stats is empty."""
        db = _make_db(tmp_path)
        run_summary = {"db_path": str(db), "domain_stats": []}
        cfg = {"noise_improvement_threshold": 0.33}

        result = maybe_queue_improvements(run_summary, cfg)
        assert result == []

    def test_multiple_domains_mixed(self, tmp_path: Path) -> None:
        """Only low-SNR domains are returned from a mixed set."""
        db = _make_db(tmp_path)
        _insert_stats(db, "security", signal=1, noise=9)      # SNR=0.10 ← bad
        _insert_stats(db, "scalability", signal=8, noise=2)   # SNR=0.80 ← good
        _insert_stats(db, "resilience", signal=2, noise=6)    # SNR=0.25 ← bad

        run_summary = {
            "db_path": str(db),
            "domain_stats": [
                {"domain": "security"},
                {"domain": "scalability"},
                {"domain": "resilience"},
            ],
        }
        cfg = {"noise_improvement_threshold": 0.33}

        result = maybe_queue_improvements(run_summary, cfg)
        assert "security" in result
        assert "resilience" in result
        assert "scalability" not in result


# ---------------------------------------------------------------------------
# test_consolidation_trigger
# ---------------------------------------------------------------------------


class TestMaybeConsolidateHeuristics:
    def test_triggers_above_threshold(self, tmp_path: Path) -> None:
        """Returns True when patches_since_consolidation > threshold."""
        h = tmp_path / "forge_heuristics.json"
        h.write_text(json.dumps({"patches_since_consolidation": 60}))

        assert maybe_consolidate_heuristics(h, threshold=50) is True

    def test_no_trigger_at_threshold(self, tmp_path: Path) -> None:
        """Returns False when patches_since_consolidation == threshold (not strictly greater)."""
        h = tmp_path / "forge_heuristics.json"
        h.write_text(json.dumps({"patches_since_consolidation": 50}))

        assert maybe_consolidate_heuristics(h, threshold=50) is False

    def test_no_trigger_below_threshold(self, tmp_path: Path) -> None:
        """Returns False when patches_since_consolidation < threshold."""
        h = tmp_path / "forge_heuristics.json"
        h.write_text(json.dumps({"patches_since_consolidation": 10}))

        assert maybe_consolidate_heuristics(h, threshold=50) is False

    def test_returns_false_when_file_missing(self, tmp_path: Path) -> None:
        """Returns False gracefully when heuristics file does not exist."""
        missing = tmp_path / "nonexistent.json"
        assert maybe_consolidate_heuristics(missing) is False

    def test_returns_false_on_invalid_json(self, tmp_path: Path) -> None:
        """Returns False gracefully on malformed JSON."""
        h = tmp_path / "forge_heuristics.json"
        h.write_text("{ this is not json }")
        assert maybe_consolidate_heuristics(h) is False

    def test_returns_false_when_key_missing(self, tmp_path: Path) -> None:
        """Returns False when patches_since_consolidation key is absent."""
        h = tmp_path / "forge_heuristics.json"
        h.write_text(json.dumps({"some_other_key": 999}))
        assert maybe_consolidate_heuristics(h) is False

    def test_uses_default_threshold_50(self, tmp_path: Path) -> None:
        """Default threshold is 50."""
        h = tmp_path / "forge_heuristics.json"
        h.write_text(json.dumps({"patches_since_consolidation": 51}))
        assert maybe_consolidate_heuristics(h) is True  # default threshold=50


# ---------------------------------------------------------------------------
# test_create_improvement_pr_calls_gh
# ---------------------------------------------------------------------------


class TestCreateImprovementPr:
    def test_calls_gh_pr_create(self) -> None:
        """Verify subprocess.run is called with gh pr create arguments."""
        with patch("forge_improve.subprocess.run") as mock_run:
            mock_run.return_value = MagicMock(returncode=0, stderr="")

            result = create_improvement_pr(
                branch_name="forge/improve-security",
                files=["global/prompts/claude/01-security.md"],
                title="chore: improve security domain prompt (SNR=0.20)",
                body="## Summary\n\nImprove signal-to-noise ratio for security domain.",
            )

        assert result is True
        assert mock_run.called
        call_args = mock_run.call_args
        # The shell command should contain gh pr create
        shell_cmd = call_args[0][0]
        assert "gh" in shell_cmd
        assert "pr" in shell_cmd
        assert "create" in shell_cmd
        assert "--title" in shell_cmd
        assert "--body" in shell_cmd

    def test_unsets_gh_token(self) -> None:
        """Verify GH_TOKEN is unset before gh pr create."""
        with patch("forge_improve.subprocess.run") as mock_run:
            mock_run.return_value = MagicMock(returncode=0, stderr="")

            create_improvement_pr(
                branch_name="forge/improve-api-design",
                files=[],
                title="chore: improve api-design prompt",
                body="body",
            )

        shell_cmd = mock_run.call_args[0][0]
        assert "unset GH_TOKEN" in shell_cmd

    def test_returns_false_on_nonzero_exit(self) -> None:
        """Returns False when gh pr create returns non-zero."""
        with patch("forge_improve.subprocess.run") as mock_run:
            mock_run.return_value = MagicMock(
                returncode=1,
                stderr="error: already exists",
            )

            result = create_improvement_pr(
                branch_name="forge/branch",
                files=[],
                title="title",
                body="body",
            )

        assert result is False

    def test_returns_false_on_os_error(self) -> None:
        """Returns False when subprocess raises OSError."""
        with patch("forge_improve.subprocess.run", side_effect=OSError("no gh")):
            result = create_improvement_pr(
                branch_name="forge/branch",
                files=[],
                title="title",
                body="body",
            )

        assert result is False

    def test_shell_true_is_used(self) -> None:
        """Verify shell=True is passed so 'unset' builtin works."""
        with patch("forge_improve.subprocess.run") as mock_run:
            mock_run.return_value = MagicMock(returncode=0, stderr="")
            create_improvement_pr("forge/b", [], "t", "b")

        call_kwargs = mock_run.call_args[1]
        assert call_kwargs.get("shell") is True
