"""CLI regression tests for stark_graph.py."""
import json
import subprocess
import sys
from pathlib import Path

SCRIPT = Path(__file__).parent / "stark_graph.py"
PYTHON = sys.executable  # use the same python running pytest

# Worktree root — used as a valid git repo for tests that need one
REPO_DIR = str(Path(__file__).parent.parent)

# Fixture directory — small, fast to parse
FIXTURE_DIR = str(Path(__file__).parent.parent / "tests" / "fixtures" / "graph")


def _run(*args, **kwargs):
    """Run stark_graph.py with given args, return CompletedProcess."""
    # Use the small fixture dir for tests that trigger parsing,
    # unless explicitly overridden
    repo = kwargs.pop("repo", FIXTURE_DIR)
    cmd = [PYTHON, str(SCRIPT), "--repo", repo] + list(args)
    kwargs.setdefault("timeout", 30)
    return subprocess.run(cmd, capture_output=True, text=True, **kwargs)


# ── TestHelp ─────────────────────────────────────────────────────────────


class TestHelp:
    def test_help_exits_zero(self):
        result = subprocess.run(
            [PYTHON, str(SCRIPT), "--help"],
            capture_output=True,
            text=True,
        )
        assert result.returncode == 0

    def test_help_contains_flags(self):
        result = subprocess.run(
            [PYTHON, str(SCRIPT), "--help"],
            capture_output=True,
            text=True,
        )
        output = result.stdout + result.stderr
        for flag in ("--stage", "--pr", "--base", "--include"):
            assert flag in output, f"Flag {flag!r} not found in help output"


# ── TestSlugSanitization ─────────────────────────────────────────────────


class TestSlugSanitization:
    def test_path_traversal_blocked(self):
        """--pr ../../../etc/passwd must not escape repo root."""
        result = _run("--pr", "../../../etc/passwd")
        # The script should either exit 2 (blocked) or output workdir that stays inside repo root
        if result.returncode == 2:
            # Security guard fired — check stderr has an error message
            assert "error" in result.stderr.lower() or result.stderr != ""
        else:
            # Succeeded — but the workdir in output must not contain ".."
            assert result.returncode == 0, (
                f"Expected exit 0 or 2, got {result.returncode}\n"
                f"stdout: {result.stdout}\nstderr: {result.stderr}"
            )
            output = json.loads(result.stdout)
            workdir = output["workdir"]
            assert ".." not in workdir, f"workdir contains '..': {workdir!r}"
            real_repo = str(Path(REPO_DIR).resolve())
            assert workdir.startswith(real_repo), (
                f"workdir {workdir!r} escapes repo root {real_repo!r}"
            )


# ── TestBaseValidation ───────────────────────────────────────────────────


class TestBaseValidation:
    def test_base_valid(self):
        result = _run("--base", "main")
        assert result.returncode == 0, (
            f"Expected exit 0\nstdout: {result.stdout}\nstderr: {result.stderr}"
        )

    def test_base_with_slash(self):
        result = _run("--base", "feature/my-branch")
        assert result.returncode == 0, (
            f"Expected exit 0\nstdout: {result.stdout}\nstderr: {result.stderr}"
        )

    def test_base_flag_injection(self):
        """--base --exec starts with '--', does not match allowed pattern."""
        result = _run("--base", "--exec")
        assert result.returncode == 2, (
            f"Expected exit 2 for flag injection attempt\n"
            f"stdout: {result.stdout}\nstderr: {result.stderr}"
        )

    def test_base_semicolon_injection(self):
        """--base 'main;rm -rf /' must fail validation."""
        result = _run("--base", "main;rm -rf /")
        assert result.returncode == 2, (
            f"Expected exit 2 for semicolon injection\n"
            f"stdout: {result.stdout}\nstderr: {result.stderr}"
        )

    def test_base_dollar_injection(self):
        """--base '$HOME' must fail validation (dollar sign not in allowed charset)."""
        result = _run("--base", "$HOME")
        assert result.returncode == 2, (
            f"Expected exit 2 for dollar-sign injection\n"
            f"stdout: {result.stdout}\nstderr: {result.stderr}"
        )


# ── TestIncludeFiltering ─────────────────────────────────────────────────


class TestIncludeFiltering:
    def test_include_single(self):
        result = _run("--include", "*.py")
        assert result.returncode == 0, (
            f"Expected exit 0\nstdout: {result.stdout}\nstderr: {result.stderr}"
        )

    def test_include_multiple(self):
        result = _run("--include", "*.py", "--include", "*.ts")
        assert result.returncode == 0, (
            f"Expected exit 0\nstdout: {result.stdout}\nstderr: {result.stderr}"
        )
