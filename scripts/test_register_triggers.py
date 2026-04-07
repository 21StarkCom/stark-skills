"""Tests for register_triggers.sh."""
import json
import subprocess
import sys
from pathlib import Path

SCRIPT = Path(__file__).parent / "register_triggers.sh"
REPO_ROOT = Path(__file__).parent.parent


def test_script_exists_and_executable():
    assert SCRIPT.exists()
    assert SCRIPT.stat().st_mode & 0o111  # executable


def test_dry_run_lists_triggers():
    result = subprocess.run(
        ["bash", str(SCRIPT), "--dry-run"],
        capture_output=True, text=True, cwd=str(REPO_ROOT),
    )
    assert result.returncode == 0
    assert f"Prompts: {REPO_ROOT / 'automation' / 'prompts'}" in result.stdout
    assert "stark-sentinel" in result.stdout


def test_list_shows_registry():
    result = subprocess.run(
        ["bash", str(SCRIPT), "--list"],
        capture_output=True, text=True, cwd=str(REPO_ROOT),
    )
    assert result.returncode == 0


def test_unknown_trigger_fails():
    result = subprocess.run(
        ["bash", str(SCRIPT), "--trigger", "nonexistent-trigger"],
        capture_output=True, text=True, cwd=str(REPO_ROOT),
    )
    assert result.returncode != 0


def test_all_configured_triggers_have_prompt_files():
    config = json.loads((REPO_ROOT / "global" / "config.json").read_text())
    configured = set(config["automation"]["triggers"].keys())
    prompts = {path.stem for path in (REPO_ROOT / "automation" / "prompts").glob("stark-*.md")}
    assert configured == prompts
