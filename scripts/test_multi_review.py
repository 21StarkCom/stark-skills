"""Tests for multi_review.py CLI changes."""

import json
import sys
from io import StringIO
from unittest.mock import MagicMock, patch

import pytest

import multi_review
from multi_review import (
    ReviewRound,
    SubAgentResult,
)


FAKE_DOMAINS = {
    "architecture": {"order": "01", "label": "Architecture", "filename": "01-architecture.md"},
}


class TestJsonOnlyFlag:
    """--json-only must produce pure JSON on stdout, logs on stderr."""

    @patch("multi_review.DOMAINS", FAKE_DOMAINS)
    @patch("multi_review.run_review_round")
    @patch("multi_review.detect_repo", return_value="GetEvinced/test")
    def test_stdout_is_pure_json(self, mock_repo, mock_round):
        """stdout must contain only parseable JSON, no banners."""
        mock_round.return_value = ReviewRound(round_num=1)
        captured_stdout = StringIO()
        captured_stderr = StringIO()

        with (
            patch("sys.stdout", captured_stdout),
            patch("sys.stderr", captured_stderr),
            patch("sys.argv", ["multi_review.py", "--pr", "1", "--json-only", "--dry-run"]),
        ):
            multi_review.main()

        stdout_text = captured_stdout.getvalue()
        parsed = json.loads(stdout_text)
        assert "repo" in parsed
        assert "summary" in parsed
        assert "Multi-Agent Review" not in stdout_text
        assert "Review Round" not in stdout_text

    @patch("multi_review.DOMAINS", FAKE_DOMAINS)
    @patch("multi_review.run_review_round")
    @patch("multi_review.detect_repo", return_value="GetEvinced/test")
    def test_banners_go_to_stderr(self, mock_repo, mock_round):
        """Human-readable output must be on stderr in json-only mode."""
        mock_round.return_value = ReviewRound(round_num=1)
        captured_stderr = StringIO()

        with (
            patch("sys.stdout", StringIO()),
            patch("sys.stderr", captured_stderr),
            patch("sys.argv", ["multi_review.py", "--pr", "1", "--json-only", "--dry-run"]),
        ):
            multi_review.main()

        stderr_text = captured_stderr.getvalue()
        assert "Multi-Agent Review" in stderr_text


class TestBaseFlag:
    """--base must accept a commit SHA and pass it through."""

    @patch("multi_review.review_pr", return_value={"summary": {"clean": True}})
    @patch("multi_review.detect_repo", return_value="GetEvinced/test-repo")
    def test_base_sha_passed_through(self, mock_repo, mock_review):
        """When --base is a SHA, it should be passed directly, no auto-detect."""
        with patch("sys.argv", ["multi_review.py", "--pr", "1", "--base", "abc1234def", "--dry-run", "--json-only"]):
            multi_review.main()
        mock_review.assert_called_once()
        assert mock_review.call_args[0][2] == "abc1234def"


class TestModelFlags:
    """Sub-agents must use max-power model flags."""

    @patch("multi_review.subprocess.run")
    def test_claude_uses_opus(self, mock_run):
        mock_run.return_value = MagicMock(stdout="[]", returncode=0)
        multi_review._run_subagent("claude", "architecture", "abc123")
        cmd = mock_run.call_args[0][0]
        assert "--model" in cmd
        assert "claude-opus-4-6" in cmd
        assert "--max-tokens" in cmd

    @patch("multi_review.subprocess.run")
    def test_codex_uses_xhigh(self, mock_run):
        mock_run.return_value = MagicMock(stdout="[]", returncode=0)
        multi_review._run_subagent("codex", "architecture", "abc123")
        cmd = mock_run.call_args[0][0]
        assert "--effort" in cmd
        assert "xhigh" in cmd

    @patch("multi_review.subprocess.run")
    def test_gemini_uses_pro(self, mock_run):
        mock_run.return_value = MagicMock(stdout="[]", returncode=0)
        multi_review._run_subagent("gemini", "architecture", "abc123")
        cmd = mock_run.call_args[0][0]
        assert "--model" in cmd
        assert "gemini-2.5-pro" in cmd


class TestConfigDiscovery:
    """Config files are discovered and merged: repo -> org -> global."""

    def test_global_config_only(self, tmp_path):
        """When only global config exists, use it."""
        global_cfg = tmp_path / "global" / "config.json"
        global_cfg.parent.mkdir(parents=True)
        global_cfg.write_text('{"agents": ["claude"], "fix_threshold": "high"}')

        cfg = multi_review.discover_config(cwd=str(tmp_path), global_dir=str(global_cfg.parent))
        assert cfg["agents"] == ["claude"]
        assert cfg["fix_threshold"] == "high"

    def test_repo_overrides_global(self, tmp_path):
        """Repo config replaces scalar fields."""
        global_dir = tmp_path / "global"
        global_dir.mkdir()
        (global_dir / "config.json").write_text('{"agents": ["claude", "codex", "gemini"], "fix_threshold": "medium"}')

        repo_dir = tmp_path / "repo"
        repo_dir.mkdir()
        (repo_dir / ".code-review").mkdir()
        (repo_dir / ".code-review" / "config.json").write_text('{"fix_threshold": "high"}')

        cfg = multi_review.discover_config(cwd=str(repo_dir), global_dir=str(global_dir))
        assert cfg["fix_threshold"] == "high"  # repo wins
        assert cfg["agents"] == ["claude", "codex", "gemini"]  # inherited

    def test_extra_domains_additive(self, tmp_path):
        """extra_domains merges additively across levels."""
        global_dir = tmp_path / "global"
        global_dir.mkdir()
        (global_dir / "config.json").write_text('{"extra_domains": ["perf"]}')

        repo_dir = tmp_path / "repo"
        repo_dir.mkdir()
        (repo_dir / ".code-review").mkdir()
        (repo_dir / ".code-review" / "config.json").write_text('{"extra_domains": ["i18n"]}')

        cfg = multi_review.discover_config(cwd=str(repo_dir), global_dir=str(global_dir))
        assert set(cfg["extra_domains"]) == {"perf", "i18n"}

    def test_severity_overrides_deep_merge(self, tmp_path):
        """severity_overrides deep merges across levels."""
        global_dir = tmp_path / "global"
        global_dir.mkdir()
        (global_dir / "config.json").write_text('{"severity_overrides": {"security": {"min_severity": "high"}}}')

        repo_dir = tmp_path / "repo"
        repo_dir.mkdir()
        (repo_dir / ".code-review").mkdir()
        (repo_dir / ".code-review" / "config.json").write_text(
            '{"severity_overrides": {"accessibility": {"min_severity": "critical"}}}'
        )

        cfg = multi_review.discover_config(cwd=str(repo_dir), global_dir=str(global_dir))
        assert cfg["severity_overrides"]["security"]["min_severity"] == "high"
        assert cfg["severity_overrides"]["accessibility"]["min_severity"] == "critical"

    def test_defaults_when_no_config(self, tmp_path):
        """When no config files exist, DEFAULT_CONFIG is used."""
        cfg = multi_review.discover_config(cwd=str(tmp_path), global_dir=str(tmp_path / "nonexistent"))
        assert cfg["agents"] == ["claude", "codex", "gemini"]
        assert cfg["fix_threshold"] == "medium"


class TestPromptResolution:
    """Prompts resolve: repo → org → global, per agent × domain."""

    def test_global_prompt_found(self, tmp_path):
        """Global prompt is used when no overrides exist."""
        global_prompts = tmp_path / "global" / "prompts" / "claude"
        global_prompts.mkdir(parents=True)
        (global_prompts / "01-architecture.md").write_text("Global arch prompt")

        result = multi_review.resolve_prompt(
            "claude", "01-architecture.md",
            cwd=str(tmp_path / "repo"),
            global_prompts_dir=str(tmp_path / "global" / "prompts"),
        )
        assert result == "Global arch prompt"

    def test_repo_prompt_overrides_global(self, tmp_path):
        """Repo-level prompt wins over global."""
        global_prompts = tmp_path / "global" / "prompts" / "claude"
        global_prompts.mkdir(parents=True)
        (global_prompts / "01-architecture.md").write_text("Global arch prompt")

        repo_dir = tmp_path / "repo"
        repo_prompts = repo_dir / ".code-review" / "prompts" / "claude"
        repo_prompts.mkdir(parents=True)
        (repo_prompts / "01-architecture.md").write_text("Repo arch prompt")

        result = multi_review.resolve_prompt(
            "claude", "01-architecture.md",
            cwd=str(repo_dir),
            global_prompts_dir=str(tmp_path / "global" / "prompts"),
        )
        assert result == "Repo arch prompt"

    def test_no_prompt_returns_empty(self, tmp_path):
        """When no prompt file exists anywhere, return empty string."""
        result = multi_review.resolve_prompt(
            "claude", "99-nonexistent.md",
            cwd=str(tmp_path),
            global_prompts_dir=str(tmp_path / "nonexistent"),
        )
        assert result == ""


class TestConfigWiring:
    """Config should filter agents/domains and apply severity overrides."""

    @patch("multi_review._run_subagent")
    @patch("multi_review.discover_config")
    def test_disabled_domains_excluded(self, mock_config, mock_sub):
        mock_config.return_value = {
            **multi_review.DEFAULT_CONFIG,
            "disabled_domains": ["accessibility"],
        }
        mock_sub.return_value = multi_review.SubAgentResult(
            agent="claude", domain="architecture", raw_output="[]",
        )

        rnd = multi_review.run_review_round("abc123", 1, cwd="/tmp")

        domains_called = {call[0][1] for call in mock_sub.call_args_list}
        assert "accessibility" not in domains_called

    @patch("multi_review._run_subagent")
    @patch("multi_review.discover_config")
    def test_agents_config_respected(self, mock_config, mock_sub):
        mock_config.return_value = {
            **multi_review.DEFAULT_CONFIG,
            "agents": ["claude"],
        }
        mock_sub.return_value = multi_review.SubAgentResult(
            agent="claude", domain="architecture", raw_output="[]",
        )

        rnd = multi_review.run_review_round("abc123", 1, cwd="/tmp")

        agents_called = {call[0][0] for call in mock_sub.call_args_list}
        assert agents_called == {"claude"}

    def test_severity_override_applied(self):
        """severity_overrides should reclassify findings below min_severity."""
        findings = [
            multi_review.Finding(
                agent="claude", domain="accessibility", severity="medium",
                file="a.py", line=1, title="t", description="d", suggestion="s",
            ),
            multi_review.Finding(
                agent="claude", domain="accessibility", severity="critical",
                file="b.py", line=2, title="t2", description="d2", suggestion="s2",
            ),
        ]
        overrides = {"accessibility": {"min_severity": "critical"}}
        result = multi_review.apply_severity_overrides(findings, overrides)
        assert result[0].severity == "low"  # medium < critical -> downgraded
        assert result[1].severity == "critical"  # unchanged
