"""Tests for plan_review_dispatch.py — prompt resolution and config loading."""

import json

import pytest

import plan_review_dispatch


class TestPromptResolution:
    """Plan review prompts resolve: repo → global, per agent × domain."""

    def test_global_prompt_found(self, tmp_path):
        """Global prompt is used when no repo override exists."""
        global_prompts = tmp_path / "global" / "prompts" / "claude"
        global_prompts.mkdir(parents=True)
        (global_prompts / "01-completeness.md").write_text("Global completeness prompt")

        result = plan_review_dispatch.resolve_plan_prompt(
            "claude",
            "01-completeness.md",
            repo_dir=str(tmp_path / "repo"),
            global_prompts_dir=str(tmp_path / "global" / "prompts"),
        )
        assert result == "Global completeness prompt"

    def test_repo_overrides_global(self, tmp_path):
        """Repo .code-review/plan-prompts/{agent}/ wins over global."""
        global_prompts = tmp_path / "global" / "prompts" / "claude"
        global_prompts.mkdir(parents=True)
        (global_prompts / "01-completeness.md").write_text("Global completeness prompt")

        repo_dir = tmp_path / "repo"
        repo_prompts = repo_dir / ".code-review" / "plan-prompts" / "claude"
        repo_prompts.mkdir(parents=True)
        (repo_prompts / "01-completeness.md").write_text("Repo completeness prompt")

        result = plan_review_dispatch.resolve_plan_prompt(
            "claude",
            "01-completeness.md",
            repo_dir=str(repo_dir),
            global_prompts_dir=str(tmp_path / "global" / "prompts"),
        )
        assert result == "Repo completeness prompt"

    def test_no_prompt_returns_empty(self, tmp_path):
        """Missing prompt returns empty string."""
        result = plan_review_dispatch.resolve_plan_prompt(
            "claude",
            "99-nonexistent.md",
            repo_dir=str(tmp_path),
            global_prompts_dir=str(tmp_path / "nonexistent"),
        )
        assert result == ""


class TestDiscoverPlanDomains:
    """Domain discovery scans first agent dir for numbered .md files."""

    def test_discovers_domains(self, tmp_path):
        """Finds domains from [0-9]*.md files in first agent dir."""
        claude_dir = tmp_path / "claude"
        claude_dir.mkdir()
        (claude_dir / "01-completeness.md").write_text("prompt")
        (claude_dir / "02-feasibility.md").write_text("prompt")
        (claude_dir / "agent.md").write_text("preamble")  # should be skipped

        domains = plan_review_dispatch._discover_plan_domains(
            global_prompts_dir=str(tmp_path),
        )
        assert "completeness" in domains
        assert "feasibility" in domains
        assert "agent" not in domains
        assert domains["completeness"]["filename"] == "01-completeness.md"
        assert domains["completeness"]["order"] == "01"

    def test_empty_dir_returns_empty(self, tmp_path):
        """No agent dirs → empty dict."""
        domains = plan_review_dispatch._discover_plan_domains(
            global_prompts_dir=str(tmp_path),
        )
        assert domains == {}


class TestLoadPlanReviewConfig:
    """Config loading from plan_review section of config.json."""

    def test_defaults_when_no_config(self, tmp_path):
        """When no config exists, returns defaults."""
        cfg = plan_review_dispatch._load_plan_review_config(
            repo_dir=str(tmp_path),
        )
        assert cfg["agents"] == ["claude", "codex", "gemini"]
        assert cfg["fix_threshold"] == "medium"
        assert cfg["disabled_domains"] == []
        assert cfg["max_rounds"] == 3

    def test_repo_config_overrides(self, tmp_path):
        """Repo config.json plan_review section overrides defaults."""
        repo_dir = tmp_path / "repo"
        cr_dir = repo_dir / ".code-review"
        cr_dir.mkdir(parents=True)
        (cr_dir / "config.json").write_text(json.dumps({
            "plan_review": {
                "agents": ["claude"],
                "fix_threshold": "high",
                "disabled_domains": ["feasibility"],
                "max_rounds": 1,
            }
        }))

        cfg = plan_review_dispatch._load_plan_review_config(
            repo_dir=str(repo_dir),
        )
        assert cfg["agents"] == ["claude"]
        assert cfg["fix_threshold"] == "high"
        assert cfg["disabled_domains"] == ["feasibility"]
        assert cfg["max_rounds"] == 1

    def test_global_config_used(self, tmp_path):
        """Global config.json plan_review section is used as fallback."""
        global_dir = tmp_path / "global"
        global_dir.mkdir()
        (global_dir / "config.json").write_text(json.dumps({
            "plan_review": {
                "max_rounds": 5,
            }
        }))

        cfg = plan_review_dispatch._load_plan_review_config(
            repo_dir=str(tmp_path / "nonexistent"),
            global_config_dir=str(global_dir),
        )
        assert cfg["max_rounds"] == 5
        assert cfg["agents"] == ["claude", "codex", "gemini"]  # default preserved
