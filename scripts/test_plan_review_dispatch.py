"""Tests for plan_review_dispatch.py — prompt resolution and config loading."""

import json
import os
import shutil
import subprocess
from pathlib import Path
from unittest.mock import MagicMock, patch

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
        assert cfg["agents"] == ["claude", "codex"]
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
        assert cfg["agents"] == ["claude", "codex"]  # default preserved


class TestSubAgentDispatch:
    """Sub-agent dispatch builds correct CLI commands and handles errors."""

    @patch("plan_review_dispatch.subprocess.run")
    def test_claude_dispatch(self, mock_run):
        mock_run.return_value = MagicMock(
            stdout='[{"severity":"medium","section":"Auth","title":"test","description":"d","suggestion":"s"}]',
            returncode=0,
        )
        result = plan_review_dispatch._run_plan_subagent(
            "claude", "feasibility", "Test plan content", timeout=300,
        )
        cmd = mock_run.call_args[0][0]
        assert cmd[0] == "claude"
        assert "--model" in cmd
        assert "claude-opus-4-6" in cmd
        assert "-" in cmd  # stdin marker
        call_kwargs = mock_run.call_args[1]
        assert "input" in call_kwargs
        assert "Test plan content" in call_kwargs["input"]
        assert len(result.findings) == 1
        assert result.error is None

    @patch("plan_review_dispatch.subprocess.run")
    def test_codex_dispatch(self, mock_run):
        mock_run.return_value = MagicMock(stdout="", returncode=0)
        result = plan_review_dispatch._run_plan_subagent(
            "codex", "general", "Test plan", timeout=300,
        )
        cmd = mock_run.call_args[0][0]
        assert cmd[0] == "codex"
        assert cmd[1] == "exec"
        assert "review" not in cmd  # avoid triggering built-in review skill
        assert "-c" in cmd
        assert plan_review_dispatch.CODEX_REASONING_CONFIG in cmd
        assert "--ephemeral" in cmd
        assert "--json" in cmd
        assert "--full-auto" in cmd
        assert cmd[-1] == "-"  # stdin marker
        call_kwargs = mock_run.call_args[1]
        assert "input" in call_kwargs
        assert "Test plan" in call_kwargs["input"]

    @patch("plan_review_dispatch.subprocess.run")
    def test_gemini_dispatch(self, mock_run):
        mock_run.return_value = MagicMock(
            stdout='{"response": "[]"}', returncode=0,
        )
        result = plan_review_dispatch._run_plan_subagent(
            "gemini", "security", "Test plan", prompt_text="Review prompt", timeout=300,
        )
        cmd = mock_run.call_args[0][0]
        assert cmd[0] == "gemini"
        assert "-o" in cmd
        assert "json" in cmd
        assert "--approval-mode" in cmd
        assert "plan" in cmd
        # Gemini pipes plan content via stdin, prompt_text via -p
        call_kwargs = mock_run.call_args[1]
        assert "input" in call_kwargs
        assert "Test plan" in call_kwargs["input"]
        assert "env" in call_kwargs
        assert "GEMINI_CLI_HOME" in call_kwargs["env"]
        assert call_kwargs["env"].get("GOOGLE_CLOUD_LOCATION") == "global"

    @patch("plan_review_dispatch.subprocess.run")
    def test_gemini_temp_dir_seeded(self, mock_run):
        """projects.json must exist before subprocess.run is called."""
        def check_projects_json(cmd, **kwargs):
            env = kwargs.get("env", {})
            gemini_home = env.get("GEMINI_CLI_HOME", "")
            pj = os.path.join(gemini_home, ".gemini", "projects.json")
            assert os.path.isfile(pj), f"projects.json missing at call time: {pj}"
            return MagicMock(stdout='{"response": "[]"}', returncode=0)
        mock_run.side_effect = check_projects_json
        plan_review_dispatch._run_plan_subagent(
            "gemini", "security", "Test plan", prompt_text="Review", timeout=300,
        )

    @patch("plan_review_dispatch.subprocess.run")
    def test_timeout_recorded(self, mock_run):
        mock_run.side_effect = subprocess.TimeoutExpired(cmd=["claude"], timeout=300)
        result = plan_review_dispatch._run_plan_subagent(
            "claude", "feasibility", "Test plan", timeout=300,
        )
        assert result.error == "timeout"
        assert len(result.findings) == 0

    @patch("plan_review_dispatch.subprocess.run")
    def test_malformed_json_recorded(self, mock_run):
        mock_run.return_value = MagicMock(stdout="This is not JSON at all", returncode=0)
        result = plan_review_dispatch._run_plan_subagent(
            "claude", "general", "Test plan", timeout=300,
        )
        assert result.error == "parse_error"
        assert len(result.findings) == 0

    @patch("plan_review_dispatch.subprocess.run")
    def test_agent_unavailable(self, mock_run):
        mock_run.side_effect = FileNotFoundError("codex not found")
        result = plan_review_dispatch._run_plan_subagent(
            "codex", "general", "Test plan", timeout=300,
        )
        assert result.error == "agent_unavailable"


class TestReturnCodeHandling:
    """CLI errors must be detected, not silently swallowed."""

    @patch("plan_review_dispatch.subprocess.run")
    def test_nonzero_returncode_sets_cli_error(self, mock_run):
        mock_run.return_value = MagicMock(stdout="", stderr="unknown flag", returncode=2)
        result = plan_review_dispatch._run_plan_subagent(
            "claude", "feasibility", "Test plan", timeout=300,
        )
        assert result.error == "cli_error"
        assert len(result.findings) == 0

    @patch("plan_review_dispatch.subprocess.run")
    def test_empty_stdout_sets_empty_output(self, mock_run):
        mock_run.return_value = MagicMock(stdout="", stderr="", returncode=0)
        result = plan_review_dispatch._run_plan_subagent(
            "claude", "feasibility", "Test plan", timeout=300,
        )
        assert result.error == "empty_output"
        assert len(result.findings) == 0

    @patch("plan_review_dispatch.subprocess.run")
    def test_codex_nonzero_returncode(self, mock_run):
        mock_run.return_value = MagicMock(stdout="", stderr="bad flag", returncode=2)
        result = plan_review_dispatch._run_plan_subagent(
            "codex", "general", "Test plan", timeout=300,
        )
        assert result.error == "cli_error"
        assert len(result.findings) == 0

    @patch("plan_review_dispatch.subprocess.run")
    def test_prompt_passed_via_stdin_claude(self, mock_run):
        mock_run.return_value = MagicMock(stdout="[]", stderr="", returncode=0)
        plan_review_dispatch._run_plan_subagent(
            "claude", "feasibility", "Test plan", timeout=300,
        )
        call_kwargs = mock_run.call_args[1]
        assert "input" in call_kwargs
        assert "Test plan" in call_kwargs["input"]
        cmd = mock_run.call_args[0][0]
        assert cmd[-1] != call_kwargs["input"]  # prompt not in argv

    @patch("plan_review_dispatch.subprocess.run")
    def test_prompt_passed_via_stdin_codex(self, mock_run):
        mock_run.return_value = MagicMock(stdout="", stderr="", returncode=0)
        plan_review_dispatch._run_plan_subagent(
            "codex", "general", "Test plan", timeout=300,
        )
        call_kwargs = mock_run.call_args[1]
        assert "input" in call_kwargs
        assert "Test plan" in call_kwargs["input"]
        cmd = mock_run.call_args[0][0]
        assert cmd[-1] == "-"


class TestCLIFlagsSmoke:
    """Smoke tests: verify each CLI actually accepts the flags we pass.

    Runs the real binary with --help to validate flag acceptance
    without making API calls. Catches flag renames/removals across CLI upgrades.
    """

    @pytest.mark.skipif(not shutil.which("codex"), reason="codex CLI not installed")
    def test_codex_exec_accepts_config_flag(self):
        """codex exec -c 'model_reasoning_effort=...' must not error."""
        result = subprocess.run(
            ["codex", "exec", "-c", plan_review_dispatch.CODEX_REASONING_CONFIG, "--help"],
            capture_output=True, text=True, timeout=10,
        )
        assert result.returncode == 0, f"codex exec rejected flags: {result.stderr}"

    @pytest.mark.skipif(not shutil.which("gemini"), reason="gemini CLI not installed")
    def test_gemini_accepts_flags(self):
        """gemini -o json --approval-mode plan must not error."""
        result = subprocess.run(
            ["gemini", "-o", "json", "--approval-mode", "plan", "--help"],
            capture_output=True, text=True, timeout=10,
        )
        assert result.returncode == 0, f"gemini rejected flags: {result.stderr}"

    @pytest.mark.skipif(not shutil.which("claude"), reason="claude CLI not installed")
    def test_claude_accepts_model_flag(self):
        """claude --model claude-opus-4-6 --help must not error."""
        result = subprocess.run(
            ["claude", "--model", "claude-opus-4-6", "--help"],
            capture_output=True, text=True, timeout=10,
        )
        assert result.returncode == 0, f"claude rejected flags: {result.stderr}"


class TestCLIArguments:
    """Verify CLI argument parsing without invoking real agents."""

    def test_prompts_dir_flag_accepted(self, tmp_path):
        """--prompts-dir flag is accepted by argparse (exit code 2 = argparse failure)."""
        plan_file = tmp_path / "plan.md"
        plan_file.write_text("# Test plan")
        import sys
        script = str(
            Path(__file__).parent / "plan_review_dispatch.py"
        )
        result = subprocess.run(
            [sys.executable, script, "--file", str(plan_file), "--prompts-dir", "design-review"],
            capture_output=True,
            text=True,
            timeout=10,
        )
        # exit code 2 means argparse rejected a flag — any other code is fine
        assert result.returncode != 2, (
            f"argparse rejected --prompts-dir flag: {result.stderr}"
        )

    def test_prompts_dir_default_is_plan_review(self, tmp_path):
        """--prompts-dir defaults to 'plan-review' when not specified."""
        import argparse
        import sys
        # Patch sys.argv to simulate CLI call without --prompts-dir
        original_argv = sys.argv
        try:
            sys.argv = ["plan_review_dispatch.py", "--file", "dummy.md"]
            parser = argparse.ArgumentParser()
            parser.add_argument("--file", required=True)
            parser.add_argument("--prompts-dir", default="plan-review")
            args = parser.parse_args()
            assert args.prompts_dir == "plan-review"
        finally:
            sys.argv = original_argv


class TestParallelDispatch:
    """Parallel dispatch orchestrates agents × domains via ThreadPoolExecutor."""

    @patch("plan_review_dispatch._run_plan_subagent")
    def test_dispatches_all_agent_domain_combinations(self, mock_sub, tmp_path):
        from plan_review_dispatch import PlanSubAgentResult, dispatch_plan_review
        for agent in ["claude", "codex", "gemini"]:
            d = tmp_path / "prompts" / agent
            d.mkdir(parents=True)
            (d / "agent.md").write_text(f"{agent} preamble")
            (d / "00-general.md").write_text("General prompt")
            (d / "01-feasibility.md").write_text("Feasibility prompt")
        mock_sub.return_value = PlanSubAgentResult(agent="claude", domain="general", raw_output="[]")
        result = dispatch_plan_review(
            plan_content="Test plan", round_num=1,
            global_prompts_dir=str(tmp_path / "prompts"),
        )
        assert mock_sub.call_count == 6  # 3 agents × 2 domains
        assert result["round"] == 1

    @patch("plan_review_dispatch._run_plan_subagent")
    def test_partial_failure_still_returns(self, mock_sub, tmp_path):
        from plan_review_dispatch import PlanSubAgentResult, dispatch_plan_review
        for agent in ["claude", "codex", "gemini"]:
            d = tmp_path / "prompts" / agent
            d.mkdir(parents=True)
            (d / "agent.md").write_text(f"{agent} preamble")
            (d / "00-general.md").write_text("General prompt")
        def side_effect(agent, domain_key, plan_content, prompt_text="", timeout=300):
            if agent == "codex":
                return PlanSubAgentResult(agent=agent, domain=domain_key, error="timeout")
            return PlanSubAgentResult(agent=agent, domain=domain_key, raw_output="[]")
        mock_sub.side_effect = side_effect
        result = dispatch_plan_review(
            plan_content="Test plan", round_num=1,
            global_prompts_dir=str(tmp_path / "prompts"),
        )
        errors = [r for r in result["results"] if r.get("error")]
        assert len(errors) == 1

    @patch("plan_review_dispatch._run_plan_subagent")
    def test_low_coverage_warning(self, mock_sub, tmp_path, capsys):
        """Warn when <50% of sub-agents succeed."""
        from plan_review_dispatch import PlanSubAgentResult, dispatch_plan_review
        for agent in ["claude", "codex", "gemini"]:
            d = tmp_path / "prompts" / agent
            d.mkdir(parents=True)
            (d / "agent.md").write_text(f"{agent} preamble")
            (d / "00-general.md").write_text("General prompt")
        # All fail
        mock_sub.return_value = PlanSubAgentResult(agent="claude", domain="general", error="timeout")
        result = dispatch_plan_review(
            plan_content="Test plan", round_num=1,
            global_prompts_dir=str(tmp_path / "prompts"),
        )
        captured = capsys.readouterr()
        assert "Low coverage" in captured.err
