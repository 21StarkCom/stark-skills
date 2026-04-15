"""Locks in the behavior of ``install.sh``'s Python-dependency check.

PR #312 migrated forge fix-dispatch from the Claude CLI to the Anthropic
Python SDK, so ``anthropic`` became a hard runtime requirement. Without
an automated test, a regression in the ``check_python_deps`` bash helper
(or its call sites in ``install()``/``interactive()``/``status()``) could
silently return the system to the old failure mode where missing SDK
deps halt every fix round with no diagnostic.

These tests exercise the shell helper directly by sourcing ``install.sh``
into a subshell and calling ``check_python_deps`` with a scratch venv,
asserting the installed/missing branches both work and that the emitted
remediation includes each package.
"""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import pytest


REPO_ROOT = Path(__file__).resolve().parents[1]
INSTALL_SCRIPT = REPO_ROOT / "install.sh"


def _run_dep_check(scratch_repo: Path) -> subprocess.CompletedProcess[str]:
    """Source install.sh and call ``check_python_deps`` with a custom
    ``REPO_DIR`` pointing at ``scratch_repo``. Returns the completed
    process so tests can inspect stdout/stderr/returncode."""
    wrapper = (
        f'export REPO_DIR="{scratch_repo}"\n'
        # Stub the colorized helpers so output is grep-friendly.
        'info()  { echo "INFO: $1"; }\n'
        'warn()  { echo "WARN: $1"; }\n'
        'error() { echo "ERROR: $1"; }\n'
        # Source install.sh while suppressing the top-level dispatcher at
        # the bottom of the file. The ``case`` block runs with ``$1``
        # unset, so we route it to a no-op by redefining install/status/etc.
        'install() { :; }\n'
        'uninstall() { :; }\n'
        'status() { :; }\n'
        'interactive() { :; }\n'
        f'source "{INSTALL_SCRIPT}"\n'
        'check_python_deps\n'
    )
    return subprocess.run(
        ["bash", "-c", wrapper],
        capture_output=True,
        text=True,
        timeout=30,
    )


@pytest.fixture
def scratch_repo(tmp_path: Path) -> Path:
    """Create a fake stark-skills repo layout with a minimal scripts
    directory but no venv — ``check_python_deps`` must warn cleanly."""
    (tmp_path / "scripts").mkdir()
    return tmp_path


@pytest.fixture
def scratch_repo_with_venv(tmp_path: Path) -> Path:
    """Create a fake stark-skills repo with a real Python venv so
    ``check_python_deps`` can probe imports against it."""
    (tmp_path / "scripts").mkdir()
    venv = tmp_path / "scripts" / ".venv"
    subprocess.run(
        [sys.executable, "-m", "venv", str(venv)],
        check=True,
        timeout=60,
    )
    return tmp_path


class TestCheckPythonDeps:
    def test_warns_when_venv_missing(self, scratch_repo: Path):
        result = _run_dep_check(scratch_repo)
        assert result.returncode != 0, (
            "check_python_deps must return non-zero when venv is absent"
        )
        assert "No venv at scripts/.venv/" in result.stdout
        # The remediation must mention every required package.
        for pkg in ("PyJWT", "requests", "anthropic"):
            assert pkg in result.stdout, (
                f"no-venv remediation message missing {pkg}"
            )

    def test_reports_missing_packages(self, scratch_repo_with_venv: Path):
        # The fresh venv has none of PyJWT/requests/anthropic installed.
        result = _run_dep_check(scratch_repo_with_venv)
        assert result.returncode != 0, (
            "check_python_deps must return non-zero when any dep is missing"
        )
        # Each missing package must be called out individually with its
        # pip install hint.
        for pkg in ("PyJWT", "requests", "anthropic"):
            assert f"ERROR: [✗]   {pkg}: missing" in result.stdout or \
                   f"{pkg}: missing" in result.stdout, (
                f"missing-dep message not emitted for {pkg}: {result.stdout}"
            )
            assert f"pip install {pkg}" in result.stdout, (
                f"pip install hint missing for {pkg}: {result.stdout}"
            )

    def test_reports_installed_packages(self, scratch_repo_with_venv: Path):
        # Install all three deps into the scratch venv and re-check.
        venv_pip = scratch_repo_with_venv / "scripts" / ".venv" / "bin" / "pip"
        subprocess.run(
            [str(venv_pip), "install", "--quiet", "PyJWT", "requests", "anthropic"],
            check=True,
            timeout=300,
        )
        result = _run_dep_check(scratch_repo_with_venv)
        assert result.returncode == 0, (
            f"check_python_deps must return 0 when all deps present; "
            f"stdout={result.stdout!r} stderr={result.stderr!r}"
        )
        for pkg in ("PyJWT", "requests", "anthropic"):
            assert f"{pkg}: installed" in result.stdout, (
                f"installed confirmation missing for {pkg}: {result.stdout}"
            )

    def test_anthropic_is_checked_alongside_legacy_deps(
        self, scratch_repo_with_venv: Path,
    ):
        """Regression guard: ``anthropic`` was added in PR #312 to the
        dep list. If a future refactor drops it from the pair loop,
        forge fix-dispatch silently breaks on fresh installs. The test
        above (``test_reports_missing_packages``) already covers this
        via the full-triple assertion, but we keep this narrower test
        so the signal is unambiguous when it fires."""
        result = _run_dep_check(scratch_repo_with_venv)
        assert "anthropic" in result.stdout, (
            "anthropic package is not being checked by check_python_deps"
        )


class TestInstallEntrypoints:
    """End-to-end smoke tests for the install.sh entrypoints that PR #312
    wired up to ``check_python_deps``. Verifies each entrypoint actually
    invokes the dep check AND that a missing dep degrades gracefully
    (warns) instead of aborting (``set -e`` exit) — that was a real
    regression caught by forged-review round 3."""

    @pytest.fixture
    def stub_settings(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
        """Point ``HOME`` at a tmp dir so ``install`` writes its symlinks
        to a scratch location instead of clobbering the developer's real
        ``~/.claude``. Returns the fake home dir."""
        fake_home = tmp_path / "home"
        fake_home.mkdir()
        (fake_home / ".claude").mkdir()
        (fake_home / ".local" / "bin").mkdir(parents=True)
        # Pre-create settings.json with the repo's content so the
        # link_dir step succeeds without "File exists" conflicts.
        repo_settings = REPO_ROOT / "config" / "settings.json"
        if repo_settings.exists():
            (fake_home / ".claude" / "settings.json").symlink_to(repo_settings)
        monkeypatch.setenv("HOME", str(fake_home))
        return fake_home

    def _run_install_command(self, arg: str) -> subprocess.CompletedProcess[str]:
        """Run ``bash install.sh <arg>`` and return the CompletedProcess.
        ``arg`` may be empty for the default install path."""
        cmd = ["bash", str(INSTALL_SCRIPT)]
        if arg:
            cmd.append(arg)
        return subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=120,
        )

    def test_status_runs_check_python_deps(self, stub_settings: Path):
        result = self._run_install_command("--status")
        assert "Checking Python dependencies..." in result.stdout, (
            "--status must run check_python_deps; "
            f"stdout last 600 chars: {result.stdout[-600:]!r}"
        )

    def test_status_does_not_abort_on_missing_deps(
        self, stub_settings: Path, monkeypatch: pytest.MonkeyPatch,
    ):
        """``--status`` is informational. Even if a dep is missing it
        must reach the end of the function without ``set -e`` aborting.
        We force a missing-dep scenario by pointing the venv lookup at a
        non-existent path via ``REPO_DIR`` override."""
        monkeypatch.setenv("REPO_DIR", "/nonexistent/scratch/repo")
        result = self._run_install_command("--status")
        # The script uses set -e but our || true / || warn guards keep
        # the dep check from terminating it. Exit code may be non-zero
        # for unrelated reasons but the dep section should still print.
        assert "Checking Python dependencies..." in result.stdout
        assert "No venv at scripts/.venv/" in result.stdout

    def test_interactive_uses_warning_guard(
        self, monkeypatch: pytest.MonkeyPatch,
    ):
        """The ``interactive()`` function in install.sh guards
        ``check_python_deps`` with ``|| warn ...``. Verify the source
        still contains that pattern so a future refactor that drops it
        is flagged here. Pure source-level check — interactive() is a
        TUI flow we can't easily exercise end-to-end."""
        source = INSTALL_SCRIPT.read_text()
        assert (
            "check_python_deps || warn" in source
        ), "install() / interactive() must guard check_python_deps with || warn"

    def test_install_calls_check_python_deps(self):
        """Static guard: ``install()`` must contain a ``check_python_deps``
        call so fresh installs surface missing packages. Forged-review
        round 2 caught a regression where the call lived only in
        ``status()``."""
        source = INSTALL_SCRIPT.read_text()
        # Find install() function body and assert it mentions the helper.
        install_match = source.find("\ninstall() {")
        assert install_match != -1, "install() function not found"
        next_func = source.find("\nuninstall() {", install_match)
        install_body = source[install_match:next_func]
        assert "check_python_deps" in install_body, (
            "install() body must call check_python_deps before completing"
        )

    def test_status_call_is_guarded(self):
        """``status()`` calls ``check_python_deps`` with ``|| true`` so
        a missing dep does not abort an informational status check."""
        source = INSTALL_SCRIPT.read_text()
        status_match = source.find("\nstatus() {")
        assert status_match != -1, "status() function not found"
        # status() is the last function before the case dispatcher.
        end_match = source.find("\nif [ \"${BASH_SOURCE", status_match)
        if end_match == -1:
            end_match = len(source)
        status_body = source[status_match:end_match]
        # Either || true or || warn is acceptable.
        assert (
            "check_python_deps || true" in status_body
            or "check_python_deps || warn" in status_body
        ), "status() must call check_python_deps with a || guard"
