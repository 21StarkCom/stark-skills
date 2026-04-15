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
