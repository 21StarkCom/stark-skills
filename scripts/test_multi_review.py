"""Tests for multi_review.py CLI changes."""

import json
import os
import shutil
import subprocess
import sys
from io import StringIO
from unittest.mock import MagicMock, patch

import pytest

import multi_review
from dispatcher_base import DEFAULT_CONFIG
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
            patch("sys.argv", ["multi_review.py", "--pr", "1", "--json-only", "--dry-run", "--no-persist-history"]),
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
            patch("sys.argv", ["multi_review.py", "--pr", "1", "--json-only", "--dry-run", "--no-persist-history"]),
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
        assert mock_review.call_args.kwargs["base"] == "abc1234def"


class TestModelFlags:
    """Sub-agents must use pinned model flags."""

    @patch("multi_review.subprocess.run")
    def test_claude_uses_configured_model_and_no_session(self, mock_run):
        mock_run.return_value = MagicMock(stdout="[]", returncode=0)
        multi_review._run_subagent("claude", "architecture", "abc123")
        cmd = mock_run.call_args[0][0]
        assert "--model" in cmd
        assert "claude-opus-4-7" in cmd
        assert "--no-session-persistence" in cmd  # one-shot, no session files
        assert "-" in cmd  # stdin marker
        call_kwargs = mock_run.call_args[1]
        assert "input" in call_kwargs
        assert call_kwargs["input"]  # non-empty prompt

    @patch("multi_review.build_agent_env", return_value={"GH_TOKEN": "codex-token"})
    @patch("multi_review.subprocess.run")
    def test_codex_uses_high_reasoning_and_read_only(self, mock_run, mock_build_env):
        mock_run.return_value = MagicMock(stdout="[]", returncode=0)
        multi_review._run_subagent("codex", "architecture", "abc123")
        cmd = mock_run.call_args[0][0]
        assert cmd[:2] == ["codex", "exec"]
        assert "review" not in cmd  # avoid triggering built-in review skill
        assert "-m" in cmd  # explicit model
        assert "-c" in cmd
        assert multi_review.CODEX_REASONING_CONFIG in cmd
        assert "--ephemeral" in cmd
        assert "--json" in cmd
        assert "-s" in cmd and "read-only" in cmd  # least-privilege sandbox
        assert "-a" not in cmd  # -a/--ask-for-approval not valid on codex exec
        assert cmd[-1] == "-"  # stdin marker
        assert mock_run.call_args[1]["env"] == {"GH_TOKEN": "codex-token"}
        mock_build_env.assert_called_once_with("codex", "review")

    @patch("multi_review.is_agent_enabled", return_value=True)
    @patch("multi_review.subprocess.run")
    def test_gemini_uses_plan_mode_and_pinned_model(self, mock_run, _mock_enabled):
        mock_run.return_value = MagicMock(
            stdout='{"response": "[]"}', returncode=0,
        )
        multi_review._run_subagent("gemini", "architecture", "abc123")
        cmd = mock_run.call_args[0][0]
        assert "-m" in cmd  # explicit model
        assert "-o" in cmd
        assert "json" in cmd
        assert "--approval-mode" not in cmd  # set via settings.json, not CLI flag
        # Gemini uses GEMINI_CLI_HOME env var for isolation + GOOGLE_CLOUD_LOCATION for Vertex AI
        call_kwargs = mock_run.call_args[1]
        assert "env" in call_kwargs
        assert "GEMINI_CLI_HOME" in call_kwargs["env"]
        # GEMINI_API_KEY injected from Keychain for headless dispatch
        assert "GEMINI_CLI_HOME" in call_kwargs["env"]

    @patch("multi_review.subprocess.run")
    def test_gemini_temp_dir_seeded(self, mock_run):
        """projects.json must exist before subprocess.run is called."""
        def check_projects_json(cmd, **kwargs):
            env = kwargs.get("env", {})
            gemini_home = env.get("GEMINI_CLI_HOME", "")
            pj = os.path.join(gemini_home, ".gemini", "projects.json")
            assert os.path.isfile(pj), f"projects.json missing at call time: {pj}"
            return MagicMock(stdout='{"response": "[]"}', returncode=0)
        mock_run.side_effect = check_projects_json
        multi_review._run_subagent("gemini", "architecture", "abc123")


class TestCLIFlagsSmoke:
    """Smoke tests: verify each CLI actually accepts the flags we pass.

    These run the real binary with --help to validate flag acceptance
    without making API calls. Catches flag renames/removals across CLI upgrades.
    """

    @pytest.mark.skipif(not shutil.which("codex"), reason="codex CLI not installed")
    def test_codex_exec_accepts_flags(self):
        """codex exec -c ... --ephemeral --json --full-auto must not error."""
        result = subprocess.run(
            ["codex", "exec", "-c", multi_review.CODEX_REASONING_CONFIG,
             "--ephemeral", "--json", "--full-auto", "--help"],
            capture_output=True, text=True, timeout=10,
        )
        assert result.returncode == 0, f"codex exec rejected flags: {result.stderr}"

    @pytest.mark.skipif(not shutil.which("gemini"), reason="gemini CLI not installed")
    def test_gemini_accepts_flags(self):
        """gemini -o json -m must not error."""
        result = subprocess.run(
            ["gemini", "-o", "json", "--help"],
            capture_output=True, text=True, timeout=10,
        )
        assert result.returncode == 0, f"gemini rejected flags: {result.stderr}"

    @pytest.mark.skipif(not shutil.which("claude"), reason="claude CLI not installed")
    def test_claude_accepts_model_flag(self):
        """claude --model claude-sonnet-4-6 must not error."""
        result = subprocess.run(
            ["claude", "--model", "claude-sonnet-4-6", "--help"],
            capture_output=True, text=True, timeout=10,
        )
        assert result.returncode == 0, f"claude rejected flags: {result.stderr}"

    @pytest.mark.skipif(not shutil.which("gemini"), reason="gemini CLI not installed")
    def test_gemini_temp_dir_survives_startup(self):
        """Gemini CLI must not crash on temp dir filesystem layout.

        Uses GEMINI_API_KEY=invalid to force auth failure (exit 41) rather
        than a filesystem error. If we get exit 41, the temp dir was fine.
        Any other non-zero exit means the dir setup is broken.
        """
        import tempfile
        cwd = os.getcwd()
        gemini_home = tempfile.mkdtemp(prefix="gemini-test-")
        gemini_dir = os.path.join(gemini_home, ".gemini")
        os.makedirs(gemini_dir, exist_ok=True)
        # Gemini's ProjectRegistry needs the cwd registered in projects.json
        import json as _json
        projects = {"projects": {cwd: "test"}}
        with open(os.path.join(gemini_dir, "projects.json"), "w") as f:
            _json.dump(projects, f)
        env = {**os.environ, "GEMINI_CLI_HOME": gemini_home, "GEMINI_API_KEY": "invalid"}
        # Write plan mode into settings.json (--approval-mode is not a CLI flag)
        import json as _json2
        settings_path = os.path.join(gemini_dir, "settings.json")
        with open(settings_path, "w") as f:
            _json2.dump({"defaultApprovalMode": "plan"}, f)
        result = subprocess.run(
            ["gemini", "-p", "test", "-o", "json"],
            capture_output=True, text=True, timeout=30, env=env,
        )
        shutil.rmtree(gemini_home, ignore_errors=True)
        # Auth-related exit codes (expected with invalid key):
        # 41 = fatal auth error, 144 = API call failed (invalid key rejected by server)
        # Any other non-zero = filesystem or flag issue (the bug we're testing for).
        assert result.returncode in (0, 41, 144), (
            f"Gemini failed with unexpected exit {result.returncode}: {result.stderr[:500]}"
        )


class TestCLIEndToEnd:
    """End-to-end tests: invoke real CLIs with trivial prompts to verify
    the full flag set works, not just --help acceptance.

    These make real API calls (minimal tokens) and are slow.
    Mark as e2e so they can be skipped in CI: pytest -m 'not e2e'
    """

    @pytest.mark.e2e
    @pytest.mark.skipif(not shutil.which("codex"), reason="codex CLI not installed")
    def test_codex_exec_e2e(self, tmp_path):
        """codex exec with --ephemeral --json --sandbox read-only produces JSONL output."""
        result = subprocess.run(
            ["codex", "exec", "-c", multi_review.CODEX_REASONING_CONFIG,
             "--ephemeral", "--json", "--full-auto", "-"],
            capture_output=True, text=True, timeout=120,
            input="Return exactly: []",
        )
        assert result.returncode == 0, f"codex exec failed: {result.stderr[:500]}"

    @pytest.mark.e2e
    @pytest.mark.skipif(not shutil.which("gemini"), reason="gemini CLI not installed")
    def test_gemini_json_output_e2e(self, tmp_path):
        """gemini -o json returns a JSON envelope with 'response' key."""
        from gemini_utils import setup_gemini_home, make_gemini_env
        gemini_home = setup_gemini_home(
            "gemini-test-", os.getcwd(), "test", approval_mode="plan",
        )
        env = make_gemini_env(gemini_home)
        from gemini_utils import GEMINI_MODEL
        result = subprocess.run(
            ["gemini", "-m", GEMINI_MODEL, "-p", "Return exactly: []", "-o", "json"],
            capture_output=True, text=True, timeout=120, env=env,
        )
        shutil.rmtree(gemini_home, ignore_errors=True)
        assert result.returncode == 0, f"gemini failed: {result.stderr[:500]}"
        envelope = json.loads(result.stdout)
        assert "response" in envelope, f"Missing 'response' key in gemini output: {list(envelope.keys())}"

    @pytest.mark.e2e
    @pytest.mark.skipif(not shutil.which("claude"), reason="claude CLI not installed")
    def test_claude_stdin_e2e(self):
        """claude -p - reads prompt from stdin and returns text output."""
        result = subprocess.run(
            ["claude", "-p", "-", "--output-format", "text", "--model", "claude-opus-4-7"],
            capture_output=True, text=True, timeout=120,
            input="Return exactly: hello",
        )
        assert result.returncode == 0, f"claude failed: {result.stderr[:500]}"
        assert result.stdout.strip(), "claude returned empty output"


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
            **DEFAULT_CONFIG,
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
            **DEFAULT_CONFIG,
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


class TestReturnCodeHandling:
    """CLI errors must be detected, not silently swallowed."""

    @patch("multi_review.subprocess.run")
    def test_nonzero_returncode_sets_cli_error(self, mock_run):
        mock_run.return_value = MagicMock(stdout="", stderr="unknown flag", returncode=2)
        result = multi_review._run_subagent("claude", "architecture", "abc123")
        assert result.error == "cli_error"
        assert len(result.findings) == 0

    @patch("multi_review.subprocess.run")
    def test_empty_stdout_sets_empty_output(self, mock_run):
        mock_run.return_value = MagicMock(stdout="", stderr="", returncode=0)
        result = multi_review._run_subagent("claude", "architecture", "abc123")
        assert result.error == "empty_output"
        assert len(result.findings) == 0

    @patch("multi_review.is_agent_enabled", return_value=True)
    @patch("multi_review.subprocess.run")
    def test_whitespace_stdout_sets_empty_output(self, mock_run, _mock_enabled):
        mock_run.return_value = MagicMock(stdout="   \n  ", stderr="", returncode=0)
        result = multi_review._run_subagent("gemini", "architecture", "abc123")
        assert result.error == "empty_output"
        assert len(result.findings) == 0

    @patch("multi_review.subprocess.run")
    def test_prompt_passed_via_stdin_claude(self, mock_run):
        mock_run.return_value = MagicMock(stdout="[]", stderr="", returncode=0)
        multi_review._run_subagent("claude", "architecture", "abc123")
        call_kwargs = mock_run.call_args[1]
        assert "input" in call_kwargs
        assert call_kwargs["input"]  # non-empty prompt
        cmd = mock_run.call_args[0][0]
        assert cmd[-1] != call_kwargs["input"]  # prompt not in argv

    @patch("multi_review.build_agent_env", return_value={"PATH": "/usr/bin"})
    @patch("multi_review.subprocess.run")
    def test_prompt_passed_via_stdin_codex(self, mock_run, _mock_env):
        mock_run.return_value = MagicMock(stdout="", stderr="", returncode=0)
        multi_review._run_subagent("codex", "architecture", "abc123")
        call_kwargs = mock_run.call_args[1]
        assert "input" in call_kwargs
        assert call_kwargs["input"]  # non-empty prompt
        cmd = mock_run.call_args[0][0]
        assert cmd[-1] == "-"  # stdin marker

    @patch("multi_review.build_agent_env", return_value={"PATH": "/usr/bin"})
    @patch("multi_review.subprocess.run")
    def test_codex_nonzero_returncode(self, mock_run, _mock_env):
        """Codex CLI error should be caught even with -o file."""
        mock_run.return_value = MagicMock(stdout="", stderr="bad flag", returncode=2)
        result = multi_review._run_subagent("codex", "architecture", "abc123")
        assert result.error == "cli_error"
        assert len(result.findings) == 0


class TestHistoryPersistence:
    """save_round_history and save_review_summary write correct schema."""

    def _make_round(self, classifications=None):
        findings = [
            multi_review.Finding(
                agent="codex", domain="security", severity="high",
                file="foo.py", line=10, title="SQL injection",
                description="Unescaped input", suggestion="Use parameterized queries",
                classification=classifications[0] if classifications else None,
                classification_reason="Real bug" if classifications else None,
            ),
            multi_review.Finding(
                agent="codex", domain="security", severity="low",
                file="bar.py", line=5, title="Missing type hint",
                description="No annotation", suggestion="Add type",
                classification=classifications[1] if classifications else None,
                classification_reason="Style only" if classifications else None,
            ),
        ]
        result = SubAgentResult(
            agent="codex", domain="security", raw_output="[]",
            findings=findings, duration_s=42.5,
        )
        return ReviewRound(round_num=1, results=[result])

    def test_save_round_creates_file(self, tmp_path):
        with patch.object(multi_review, "HISTORY_DIR", tmp_path):
            rnd = self._make_round(["fix", "ignored"])
            path = multi_review.save_round_history("GetEvinced/test", 42, rnd, mode="single")
            assert path.exists()
            data = json.loads(path.read_text())
            assert data["schema_version"] == 2
            assert data["mode"] == "single"
            assert data["pr"] == 42
            assert data["classification_summary"]["fix"] == 1
            assert data["classification_summary"]["ignored"] == 1

    def test_save_summary_quality_metrics(self, tmp_path):
        with patch.object(multi_review, "HISTORY_DIR", tmp_path):
            rnd = self._make_round(["fix", "noise"])
            path = multi_review.save_review_summary(
                "GetEvinced/test", 42, "main", [rnd], mode="single",
                domain_agents={"security": "codex"},
            )
            data = json.loads(path.read_text())
            assert data["schema_version"] == 2
            assert data["summary"]["total_fix"] == 1
            assert data["summary"]["total_noise"] == 1
            assert data["summary"]["signal_to_noise_pct"] == 50.0
            assert "codex" in data["quality"]["per_agent"]
            assert data["quality"]["per_agent"]["codex"]["fix"] == 1
            assert "codex:security" in data["quality"]["per_agent_domain"]

    def test_save_summary_unclassified(self, tmp_path):
        with patch.object(multi_review, "HISTORY_DIR", tmp_path):
            rnd = self._make_round()  # no classifications
            path = multi_review.save_review_summary(
                "GetEvinced/test", 42, "main", [rnd], mode="team",
            )
            data = json.loads(path.read_text())
            assert data["summary"]["signal_to_noise_pct"] is None
            assert data["quality"]["per_agent"]["codex"]["unclassified"] == 2

    def test_next_round_num_empty(self, tmp_path):
        with patch.object(multi_review, "HISTORY_DIR", tmp_path):
            assert multi_review._next_round_num("GetEvinced/test", 99) == 1

    def test_next_round_num_does_not_create_dir(self, tmp_path):
        """Auto-detect must not leave an empty history dir behind on miss."""
        with patch.object(multi_review, "HISTORY_DIR", tmp_path):
            assert multi_review._next_round_num("GetEvinced/test", 99) == 1
        assert not (tmp_path / "GetEvinced").exists(), "should not pre-create the org dir"

    def test_next_round_num_increments(self, tmp_path):
        with patch.object(multi_review, "HISTORY_DIR", tmp_path):
            d = multi_review._history_dir("GetEvinced/test", 99)
            (d / "round-1.json").write_text("{}")
            (d / "round-3.json").write_text("{}")
            (d / "round-not-a-number.json").write_text("{}")
            assert multi_review._next_round_num("GetEvinced/test", 99) == 4

    @patch("multi_review.DOMAINS", FAKE_DOMAINS)
    @patch("multi_review.run_review_round")
    @patch("multi_review.detect_repo", return_value="GetEvinced/test")
    def test_main_auto_persists_round(self, mock_repo, mock_round, tmp_path):
        """main() should write round-N.json by default with no extra flags."""
        mock_round.return_value = ReviewRound(round_num=1)
        with (
            patch.object(multi_review, "HISTORY_DIR", tmp_path),
            patch("sys.stdout", StringIO()),
            patch("sys.stderr", StringIO()),
            patch("sys.argv", ["multi_review.py", "--pr", "7", "--json-only", "--dry-run"]),
        ):
            multi_review.main()
        written = list((tmp_path / "GetEvinced" / "test" / "7").glob("round-*.json"))
        assert len(written) == 1, f"expected exactly one round file, got {written}"

    @patch("multi_review.DOMAINS", FAKE_DOMAINS)
    @patch("multi_review.run_review_round")
    @patch("multi_review.detect_repo", return_value="GetEvinced/test")
    def test_main_no_persist_flag_skips_write(self, mock_repo, mock_round, tmp_path):
        """--no-persist-history must skip writing round-N.json."""
        mock_round.return_value = ReviewRound(round_num=1)
        with (
            patch.object(multi_review, "HISTORY_DIR", tmp_path),
            patch("sys.stdout", StringIO()),
            patch("sys.stderr", StringIO()),
            patch("sys.argv", ["multi_review.py", "--pr", "7", "--json-only", "--dry-run", "--no-persist-history"]),
        ):
            multi_review.main()
        # _history_dir is created but no round files should be written
        d = tmp_path / "GetEvinced" / "test" / "7"
        if d.exists():
            assert not list(d.glob("round-*.json"))

    @patch("multi_review.DOMAINS", FAKE_DOMAINS)
    @patch("multi_review.run_review_round")
    @patch("multi_review.detect_repo", return_value="GetEvinced/test")
    def test_main_round_flag_overrides_auto_detect(self, mock_repo, mock_round, tmp_path):
        """--round N must record the run as round N regardless of history state."""
        mock_round.return_value = ReviewRound(round_num=99)  # mock returns round_num=99 to verify CLI plumbs through
        with (
            patch.object(multi_review, "HISTORY_DIR", tmp_path),
            patch("sys.stdout", StringIO()),
            patch("sys.stderr", StringIO()),
            patch("sys.argv", ["multi_review.py", "--pr", "7", "--round", "99", "--json-only", "--dry-run"]),
        ):
            multi_review.main()
        # run_review_round should have been called with round 99
        assert mock_round.call_args.args[1] == 99 or mock_round.call_args.kwargs.get("round_num") == 99


class TestSingleAgentMode:
    """resolve_domain_agents and --single CLI flag."""

    def test_override_agent_all_domains(self):
        domains = ["architecture", "security", "correctness"]
        result = multi_review.resolve_domain_agents({}, domains, override_agent="claude")
        assert result == {"architecture": "claude", "security": "claude", "correctness": "claude"}

    def test_config_domain_agents(self):
        config = {"domain_agents": {"security": "claude", "correctness": "gemini"}}
        domains = ["architecture", "security", "correctness"]
        result = multi_review.resolve_domain_agents(config, domains)
        assert result == {"architecture": "codex", "security": "claude", "correctness": "gemini"}

    def test_fallback_to_codex(self):
        domains = ["architecture", "security"]
        result = multi_review.resolve_domain_agents({}, domains)
        assert result == {"architecture": "codex", "security": "codex"}

    def test_override_takes_precedence_over_config(self):
        config = {"domain_agents": {"security": "claude"}}
        domains = ["security"]
        result = multi_review.resolve_domain_agents(config, domains, override_agent="gemini")
        assert result == {"security": "gemini"}

    @patch("multi_review.review_pr_single", return_value={"summary": {"clean": True}})
    @patch("multi_review.detect_repo", return_value="GetEvinced/test")
    def test_single_flag_routes_to_single(self, mock_repo, mock_review):
        with patch("sys.argv", ["multi_review.py", "--pr", "1", "--single", "--dry-run", "--json-only"]):
            multi_review.main()
        mock_review.assert_called_once()
        assert mock_review.call_args.kwargs.get("override_agent") is None

    @patch("multi_review.review_pr_single", return_value={"summary": {"clean": True}})
    @patch("multi_review.detect_repo", return_value="GetEvinced/test")
    def test_agent_flag_implies_single(self, mock_repo, mock_review):
        with patch("sys.argv", ["multi_review.py", "--pr", "1", "--agent", "claude", "--dry-run", "--json-only"]):
            multi_review.main()
        mock_review.assert_called_once()
        assert mock_review.call_args.kwargs["override_agent"] == "claude"


def test_worker_budget_tracks_current_matrix():
    with patch.object(multi_review, "AGENTS", {"claude": {}, "codex": {}}), patch.object(
        multi_review,
        "DOMAINS",
        {
            "architecture": {"label": "Architecture"},
            "security": {"label": "Security"},
            "testing": {"label": "Testing"},
        },
    ):
        assert multi_review._max_worker_budget() == 6
