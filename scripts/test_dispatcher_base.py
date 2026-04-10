"""Tests for dispatcher_base.py — shared config / prompt / domain utilities."""

from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import patch

import pytest

import dispatcher_base
from dispatcher_base import (
    DEFAULT_CONFIG,
    discover_config,
    resolve_model,
    AGENTS,
    discover_domains,
    resolve_prompt,
)


# ── discover_config ───────────────────────────────────────────────────


class TestDiscoverConfig:
    def test_defaults_returned_when_no_config_files(self, tmp_path):
        """With no config files present, we get DEFAULT_CONFIG."""
        result = discover_config(cwd=str(tmp_path), global_dir=str(tmp_path / "global"))
        assert result["agents"] == DEFAULT_CONFIG["agents"]
        assert result["fix_threshold"] == DEFAULT_CONFIG["fix_threshold"]

    def test_global_config_applied(self, tmp_path):
        """Global config.json is merged on top of defaults."""
        global_dir = tmp_path / "global"
        global_dir.mkdir()
        (global_dir / "config.json").write_text(
            json.dumps({"fix_threshold": "high", "extra_domains": ["custom"]})
        )
        result = discover_config(cwd=str(tmp_path), global_dir=str(global_dir))
        assert result["fix_threshold"] == "high"
        assert "custom" in result["extra_domains"]

    def test_repo_config_overrides_global(self, tmp_path):
        """Repo .code-review/config.json wins over global config."""
        global_dir = tmp_path / "global"
        global_dir.mkdir()
        (global_dir / "config.json").write_text(
            json.dumps({"fix_threshold": "low"})
        )

        repo_dir = tmp_path / "repo"
        code_review_dir = repo_dir / ".code-review"
        code_review_dir.mkdir(parents=True)
        (code_review_dir / "config.json").write_text(
            json.dumps({"fix_threshold": "critical"})
        )

        result = discover_config(cwd=str(repo_dir), global_dir=str(global_dir))
        assert result["fix_threshold"] == "critical"

    def test_additive_field_merges_uniquely(self, tmp_path):
        """extra_domains from repo + global are unioned without duplicates."""
        global_dir = tmp_path / "global"
        global_dir.mkdir()
        (global_dir / "config.json").write_text(
            json.dumps({"extra_domains": ["security"]})
        )

        repo_dir = tmp_path / "repo"
        code_review_dir = repo_dir / ".code-review"
        code_review_dir.mkdir(parents=True)
        (code_review_dir / "config.json").write_text(
            json.dumps({"extra_domains": ["security", "perf"]})
        )

        result = discover_config(cwd=str(repo_dir), global_dir=str(global_dir))
        assert set(result["extra_domains"]) == {"security", "perf"}

    def test_deep_merge_field_preserves_sibling_keys(self, tmp_path):
        """Deep-merge fields (e.g. github_apps) preserve unoverridden sibling keys."""
        global_dir = tmp_path / "global"
        global_dir.mkdir()
        # Override only 'gemini' github_app, claude and codex should stay
        (global_dir / "config.json").write_text(
            json.dumps({"github_apps": {"gemini": "custom-gemini-app"}})
        )

        result = discover_config(cwd=str(tmp_path), global_dir=str(global_dir))
        assert result["github_apps"]["gemini"] == "custom-gemini-app"
        assert result["github_apps"]["claude"] == "stark-claude"
        assert result["github_apps"]["codex"] == "stark-codex"

    def test_broken_json_file_is_skipped(self, tmp_path):
        """A malformed config.json is silently skipped, defaults used."""
        global_dir = tmp_path / "global"
        global_dir.mkdir()
        (global_dir / "config.json").write_text("{not valid json}")

        result = discover_config(cwd=str(tmp_path), global_dir=str(global_dir))
        assert result["fix_threshold"] == DEFAULT_CONFIG["fix_threshold"]

    def test_multi_layer_chain(self, tmp_path):
        """Org-level config is between global and repo in the chain."""
        global_dir = tmp_path / "global"
        global_dir.mkdir()
        (global_dir / "config.json").write_text(
            json.dumps({"fix_threshold": "low"})
        )

        # org level (parent of repo)
        org_dir = tmp_path / "org"
        (org_dir / ".code-review").mkdir(parents=True)
        (org_dir / ".code-review" / "config.json").write_text(
            json.dumps({"fix_threshold": "medium"})
        )

        # repo (child of org)
        repo_dir = org_dir / "repo"
        (repo_dir / ".code-review").mkdir(parents=True)
        (repo_dir / ".code-review" / "config.json").write_text(
            json.dumps({"fix_threshold": "high"})
        )

        result = discover_config(cwd=str(repo_dir), global_dir=str(global_dir))
        assert result["fix_threshold"] == "high"


# ── resolve_model ─────────────────────────────────────────────────────


class TestResolveModel:
    def test_claude_returns_string(self):
        with patch("dispatcher_base._config_get_model_id", return_value=None):
            result = resolve_model("claude")
        assert isinstance(result, str)
        assert len(result) > 0

    def test_codex_returns_string(self):
        with patch("dispatcher_base._config_get_model_id", return_value=None):
            result = resolve_model("codex")
        assert isinstance(result, str)

    def test_gemini_returns_string(self):
        with patch("dispatcher_base._config_get_model_id", return_value=None):
            result = resolve_model("gemini")
        assert isinstance(result, str)

    def test_config_model_id_overrides_default(self):
        with patch("dispatcher_base._config_get_model_id", return_value="my-custom-model"):
            result = resolve_model("claude")
        assert result == "my-custom-model"

    def test_unknown_agent_raises(self):
        with pytest.raises(ValueError, match="Unknown agent"):
            resolve_model("unknown-agent")


# ── discover_domains ──────────────────────────────────────────────────


class TestDiscoverDomains:
    def test_discovers_from_first_agent_dir(self, tmp_path):
        """Scans the first agent dir that has [0-9]*.md files."""
        claude_dir = tmp_path / "claude"
        claude_dir.mkdir()
        (claude_dir / "01-architecture.md").write_text("arch prompt")
        (claude_dir / "02-security.md").write_text("sec prompt")
        (claude_dir / "agent.md").write_text("preamble")

        result = discover_domains(tmp_path, agents=["claude", "codex"])
        assert "architecture" in result
        assert "security" in result
        assert result["architecture"]["order"] == "01"
        assert result["architecture"]["filename"] == "01-architecture.md"

    def test_falls_back_to_domains_dir(self, tmp_path):
        """When no agent dir has numbered files, uses domains/."""
        # Agent dir exists but has no numbered files
        (tmp_path / "claude").mkdir()
        (tmp_path / "claude" / "agent.md").write_text("preamble")

        shared = tmp_path / "domains"
        shared.mkdir()
        (shared / "01-completeness.md").write_text("completeness prompt")

        result = discover_domains(tmp_path, agents=["claude"])
        assert "completeness" in result

    def test_empty_prompts_dir_returns_empty(self, tmp_path):
        """No agent dirs → empty dict."""
        result = discover_domains(tmp_path, agents=["claude", "codex"])
        assert result == {}

    def test_domain_slug_extraction(self, tmp_path):
        """Slug is the part after the first '-' in the stem."""
        agent_dir = tmp_path / "claude"
        agent_dir.mkdir()
        (agent_dir / "07-spec-conformance.md").write_text("spec prompt")

        result = discover_domains(tmp_path, agents=["claude"])
        assert "spec-conformance" in result
        assert result["spec-conformance"]["label"] == "Spec Conformance"

    def test_default_agents_order(self, tmp_path):
        """With no agents argument, defaults to claude → codex → gemini order."""
        codex_dir = tmp_path / "codex"
        codex_dir.mkdir()
        (codex_dir / "01-arch.md").write_text("codex arch")

        # claude dir doesn't exist, codex is next
        result = discover_domains(tmp_path)
        assert "arch" in result

    def test_label_title_cased(self, tmp_path):
        """Label is title-cased from the slug."""
        agent_dir = tmp_path / "claude"
        agent_dir.mkdir()
        (agent_dir / "03-type-safety.md").write_text("type safety")

        result = discover_domains(tmp_path, agents=["claude"])
        assert result["type-safety"]["label"] == "Type Safety"


# ── resolve_prompt ────────────────────────────────────────────────────


class TestResolvePrompt:
    def test_returns_global_agent_prompt(self, tmp_path):
        """Falls through to global agent dir when no repo override."""
        prompts_dir = tmp_path / "prompts"
        (prompts_dir / "claude").mkdir(parents=True)
        (prompts_dir / "claude" / "agent.md").write_text("Global claude preamble")

        result = resolve_prompt("claude", "agent.md", prompts_dir=prompts_dir)
        assert result == "Global claude preamble"

    def test_repo_override_wins(self, tmp_path):
        """Repo .code-review/prompts/{agent}/ beats global."""
        prompts_dir = tmp_path / "prompts"
        (prompts_dir / "claude").mkdir(parents=True)
        (prompts_dir / "claude" / "01-arch.md").write_text("Global arch")

        repo_dir = tmp_path / "repo"
        repo_prompt_dir = repo_dir / ".code-review" / "prompts" / "claude"
        repo_prompt_dir.mkdir(parents=True)
        (repo_prompt_dir / "01-arch.md").write_text("Repo arch override")

        result = resolve_prompt(
            "claude", "01-arch.md",
            prompts_dir=prompts_dir,
            repo_dir=str(repo_dir),
        )
        assert result == "Repo arch override"

    def test_domains_fallback(self, tmp_path):
        """When agent dir has no file, falls back to domains/."""
        prompts_dir = tmp_path / "prompts"
        (prompts_dir / "claude").mkdir(parents=True)
        # agent dir exists but no domain file

        shared = prompts_dir / "domains"
        shared.mkdir()
        (shared / "01-arch.md").write_text("Shared arch prompt")

        result = resolve_prompt("claude", "01-arch.md", prompts_dir=prompts_dir)
        assert result == "Shared arch prompt"

    def test_agent_beats_domains(self, tmp_path):
        """Agent-specific file takes priority over shared domains/."""
        prompts_dir = tmp_path / "prompts"
        agent_dir = prompts_dir / "claude"
        agent_dir.mkdir(parents=True)
        (agent_dir / "01-arch.md").write_text("Agent arch")

        (prompts_dir / "domains").mkdir()
        (prompts_dir / "domains" / "01-arch.md").write_text("Shared arch")

        result = resolve_prompt("claude", "01-arch.md", prompts_dir=prompts_dir)
        assert result == "Agent arch"

    def test_missing_file_returns_empty(self, tmp_path):
        """Returns empty string when no file is found anywhere."""
        result = resolve_prompt("claude", "99-nope.md", prompts_dir=tmp_path)
        assert result == ""

    def test_custom_repo_subdir(self, tmp_path):
        """repo_subdir parameter controls the override path."""
        prompts_dir = tmp_path / "prompts"
        (prompts_dir / "claude").mkdir(parents=True)
        (prompts_dir / "claude" / "agent.md").write_text("Global preamble")

        repo_dir = tmp_path / "repo"
        # Use "plan-prompts" instead of default "prompts"
        plan_prompt_dir = repo_dir / ".code-review" / "plan-prompts" / "claude"
        plan_prompt_dir.mkdir(parents=True)
        (plan_prompt_dir / "agent.md").write_text("Repo plan preamble")

        result = resolve_prompt(
            "claude", "agent.md",
            prompts_dir=prompts_dir,
            repo_dir=str(repo_dir),
            repo_subdir="plan-prompts",
        )
        assert result == "Repo plan preamble"

    def test_repo_none_skips_repo_check(self, tmp_path):
        """When repo_dir is None, repo override step is skipped."""
        prompts_dir = tmp_path / "prompts"
        (prompts_dir / "claude").mkdir(parents=True)
        (prompts_dir / "claude" / "agent.md").write_text("Global preamble")

        result = resolve_prompt("claude", "agent.md", prompts_dir=prompts_dir, repo_dir=None)
        assert result == "Global preamble"

    def test_prompt_text_stripped(self, tmp_path):
        """Leading/trailing whitespace is stripped from returned prompt."""
        prompts_dir = tmp_path / "prompts"
        (prompts_dir / "claude").mkdir(parents=True)
        (prompts_dir / "claude" / "agent.md").write_text("  \n  Hello World  \n  ")

        result = resolve_prompt("claude", "agent.md", prompts_dir=prompts_dir)
        assert result == "Hello World"
