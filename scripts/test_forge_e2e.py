#!/usr/bin/env python3
"""End-to-end acceptance tests for the stark-forge pipeline.

All external calls (git worktree, subprocess) are mocked.
Tests use temporary git repos via tmp_path fixtures.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path
from unittest.mock import MagicMock, call, patch

import pytest

# Ensure scripts/ is on the path for direct imports
sys.path.insert(0, str(Path(__file__).parent))

from forge_orchestrator import (
    ForgeProgress,
    derive_branch_name,
    init_state,
    load_state,
    run_forge,
    write_state_atomic,
)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


def _init_git_repo(path: Path) -> None:
    """Initialise a bare-minimum git repo with an initial commit."""
    subprocess.run(["git", "init", str(path)], capture_output=True, check=True)
    subprocess.run(
        ["git", "-C", str(path), "config", "user.email", "test@example.com"],
        capture_output=True, check=True,
    )
    subprocess.run(
        ["git", "-C", str(path), "config", "user.name", "Test"],
        capture_output=True, check=True,
    )
    # Create an initial commit so HEAD exists
    readme = path / "README.md"
    readme.write_text("# test\n")
    subprocess.run(
        ["git", "-C", str(path), "add", "README.md"],
        capture_output=True, check=True,
    )
    subprocess.run(
        ["git", "-C", str(path), "commit", "-m", "init"],
        capture_output=True, check=True,
    )


def _create_spec(path: Path, name: str = "spec.md") -> Path:
    """Write a minimal spec file and return its path."""
    spec = path / name
    spec.write_text("# Spec\n\nThis is a test specification.\n")
    return spec


# ---------------------------------------------------------------------------
# test_main_branch_rejection
# ---------------------------------------------------------------------------


class TestMainBranchRejection:
    """forge refuses to run on main/master with exit code 3."""

    def test_rejects_main(self, tmp_path: Path) -> None:
        _init_git_repo(tmp_path)
        spec = _create_spec(tmp_path)

        with patch("forge_orchestrator._git_current_branch", return_value="main"):
            code = run_forge(spec)

        assert code == 3

    def test_rejects_master(self, tmp_path: Path) -> None:
        _init_git_repo(tmp_path)
        spec = _create_spec(tmp_path)

        with patch("forge_orchestrator._git_current_branch", return_value="master"):
            code = run_forge(spec)

        assert code == 3

    def test_allows_feature_branch(self, tmp_path: Path) -> None:
        """A non-main branch should not return exit code 3 for the branch guard."""
        _init_git_repo(tmp_path)
        spec = _create_spec(tmp_path)

        # Patch both branch name and git root + worktree so we don't need a
        # real worktree environment.
        worktree = tmp_path / ".worktrees" / "forge-spec"
        worktree.mkdir(parents=True)

        with (
            patch("forge_orchestrator._git_current_branch", return_value="feature/x"),
            patch("forge_orchestrator._git_root", return_value=str(tmp_path)),
            patch("forge_orchestrator._setup_worktree", return_value=(worktree, "forge/spec")),
            patch("forge_orchestrator.acquire_lock", return_value=True),
            patch("forge_orchestrator.release_lock"),
        ):
            code = run_forge(spec)

        # Should not be 3 (branch guard); may be 0 (success) or 1 (other err)
        assert code != 3


# ---------------------------------------------------------------------------
# test_dry_run_no_commits
# ---------------------------------------------------------------------------


class TestDryRunNoCommits:
    """dry_run=True must not create any git commits."""

    def test_no_git_commits_in_dry_run(self, tmp_path: Path) -> None:
        _init_git_repo(tmp_path)
        spec = _create_spec(tmp_path)

        # Capture all subprocess calls
        commit_calls: list[list[str]] = []

        def fake_run(cmd, *args, **kwargs):
            if isinstance(cmd, list) and "commit" in cmd:
                commit_calls.append(cmd)
            result = MagicMock()
            result.returncode = 0
            result.stdout = ""
            result.stderr = ""
            return result

        worktree = tmp_path / ".worktrees" / "forge-spec"
        worktree.mkdir(parents=True)

        with (
            patch("forge_orchestrator._git_current_branch", return_value="feature/dry"),
            patch("forge_orchestrator._git_root", return_value=str(tmp_path)),
            patch("forge_orchestrator._setup_worktree", return_value=(worktree, "forge/spec")),
            patch("forge_orchestrator.acquire_lock", return_value=True),
            patch("forge_orchestrator.release_lock"),
            patch("subprocess.run", side_effect=fake_run),
        ):
            run_forge(spec, dry_run=True)

        assert commit_calls == [], (
            f"Expected no git commits in dry_run mode, got: {commit_calls}"
        )

    def test_dry_run_writes_state(self, tmp_path: Path) -> None:
        """dry_run should still write state files (for resume support)."""
        _init_git_repo(tmp_path)
        spec = _create_spec(tmp_path)

        worktree = tmp_path / ".worktrees" / "forge-spec"
        worktree.mkdir(parents=True)

        with (
            patch("forge_orchestrator._git_current_branch", return_value="feature/dry"),
            patch("forge_orchestrator._git_root", return_value=str(tmp_path)),
            patch("forge_orchestrator._setup_worktree", return_value=(worktree, "forge/spec")),
            patch("forge_orchestrator.acquire_lock", return_value=True),
            patch("forge_orchestrator.release_lock"),
        ):
            run_forge(spec, dry_run=True)

        state_path = worktree / ".forge-state.json"
        assert state_path.exists(), "State file should exist after dry_run"


# ---------------------------------------------------------------------------
# test_worktree_isolation
# ---------------------------------------------------------------------------


class TestWorktreeIsolation:
    """Changes in the forge worktree must not affect the user's main checkout."""

    def test_state_written_to_worktree_not_main(self, tmp_path: Path) -> None:
        """State files appear in the worktree directory, not the main checkout."""
        _init_git_repo(tmp_path)
        spec = _create_spec(tmp_path)

        worktree = tmp_path / ".worktrees" / "forge-spec"
        worktree.mkdir(parents=True)

        with (
            patch("forge_orchestrator._git_current_branch", return_value="feature/iso"),
            patch("forge_orchestrator._git_root", return_value=str(tmp_path)),
            patch("forge_orchestrator._setup_worktree", return_value=(worktree, "forge/spec")),
            patch("forge_orchestrator.acquire_lock", return_value=True),
            patch("forge_orchestrator.release_lock"),
        ):
            run_forge(spec)

        # State file is in the worktree
        worktree_state = worktree / ".forge-state.json"
        assert worktree_state.exists()

        # No forge state file in the main checkout root
        main_state = tmp_path / ".forge-state.json"
        assert not main_state.exists()

    def test_spec_copied_to_worktree(self, tmp_path: Path) -> None:
        """The spec file is accessed via the worktree path (via _setup_worktree)."""
        _init_git_repo(tmp_path)
        spec = _create_spec(tmp_path)

        worktree = tmp_path / ".worktrees" / "forge-spec"
        worktree.mkdir(parents=True)

        setup_calls: list[tuple] = []

        def fake_setup(git_root, branch_name, spec_path):
            setup_calls.append((git_root, branch_name, spec_path))
            return worktree, "forge/spec"

        with (
            patch("forge_orchestrator._git_current_branch", return_value="feature/iso"),
            patch("forge_orchestrator._git_root", return_value=str(tmp_path)),
            patch("forge_orchestrator._setup_worktree", side_effect=fake_setup),
            patch("forge_orchestrator.acquire_lock", return_value=True),
            patch("forge_orchestrator.release_lock"),
        ):
            run_forge(spec)

        assert len(setup_calls) == 1
        _, _, passed_spec = setup_calls[0]
        # The spec path passed to setup is the original spec path
        assert passed_spec == spec


# ---------------------------------------------------------------------------
# test_crash_resume
# ---------------------------------------------------------------------------


class TestCrashResume:
    """Write 'starting' state, verify resume skips 'completed' and reruns 'starting'."""

    def test_resume_skips_completed_reruns_starting(self, tmp_path: Path) -> None:
        """A phase in 'completed' is skipped; a phase in 'starting' is re-run."""
        _init_git_repo(tmp_path)
        spec = _create_spec(tmp_path)

        worktree = tmp_path / ".worktrees" / "forge-spec"
        worktree.mkdir(parents=True)

        # Write a crash state: classify=completed, design_review=starting
        crash_state = {
            "version": 1,
            "spec_path": str(spec),
            "spec_hash": "abc123",
            "phases": {
                "classify": {"status": "completed"},
                "design_review": {"status": "starting", "rounds": []},
                "plan": {"status": "pending"},
                "plan_review": {"status": "pending", "rounds": []},
                "tdd": {"status": "pending"},
                "tasks": {"status": "pending"},
            },
            "created_at": "2026-01-01T00:00:00+00:00",
            "updated_at": "2026-01-01T00:01:00+00:00",
        }
        state_path = worktree / ".forge-state.json"
        state_path.write_text(json.dumps(crash_state, indent=2))

        phases_run: list[str] = []
        real_write = write_state_atomic

        def tracking_write(path, state, **kwargs):
            # Track which phases transition to 'starting' (i.e. are about to run)
            for phase, data in state.get("phases", {}).items():
                if data.get("status") == "starting" and phase not in phases_run:
                    phases_run.append(phase)
            real_write(path, state, **kwargs)

        with (
            patch("forge_orchestrator._git_current_branch", return_value="feature/resume"),
            patch("forge_orchestrator._git_root", return_value=str(tmp_path)),
            patch("forge_orchestrator._find_existing_worktree", return_value=worktree),
            patch("forge_orchestrator._setup_worktree", return_value=(worktree, "forge/spec")),
            patch("forge_orchestrator.acquire_lock", return_value=True),
            patch("forge_orchestrator.release_lock"),
            patch("forge_orchestrator.write_state_atomic", side_effect=tracking_write),
        ):
            code = run_forge(spec, resume=True)

        assert code == 0
        # 'classify' was completed — it should NOT have been re-run
        assert "classify" not in phases_run, (
            "'classify' is completed and should have been skipped"
        )
        # 'design_review' was 'starting' — it should have been re-run
        assert "design_review" in phases_run, (
            "'design_review' was 'starting' (crash) and should have been resumed"
        )

    def test_fresh_start_runs_all_phases(self, tmp_path: Path) -> None:
        """Without --resume, all phases run from the beginning."""
        _init_git_repo(tmp_path)
        spec = _create_spec(tmp_path)

        worktree = tmp_path / ".worktrees" / "forge-spec"
        worktree.mkdir(parents=True)

        phases_run: list[str] = []
        real_write = write_state_atomic

        def tracking_write(path, state, **kwargs):
            for phase, data in state.get("phases", {}).items():
                if data.get("status") == "starting" and phase not in phases_run:
                    phases_run.append(phase)
            real_write(path, state, **kwargs)

        with (
            patch("forge_orchestrator._git_current_branch", return_value="feature/fresh"),
            patch("forge_orchestrator._git_root", return_value=str(tmp_path)),
            patch("forge_orchestrator._setup_worktree", return_value=(worktree, "forge/spec")),
            patch("forge_orchestrator.acquire_lock", return_value=True),
            patch("forge_orchestrator.release_lock"),
            patch("forge_orchestrator.write_state_atomic", side_effect=tracking_write),
        ):
            code = run_forge(spec)

        assert code == 0
        # All phases should have run
        expected = ["classify", "design_review", "plan", "plan_review", "tdd", "tasks"]
        for phase in expected:
            assert phase in phases_run, f"Phase '{phase}' should have run in fresh start"


# ---------------------------------------------------------------------------
# test_exit_codes
# ---------------------------------------------------------------------------


class TestExitCodes:
    """Verify exit codes 0/1/2/3."""

    def test_exit_0_success(self, tmp_path: Path) -> None:
        """Normal run on a feature branch returns exit code 0."""
        _init_git_repo(tmp_path)
        spec = _create_spec(tmp_path)

        worktree = tmp_path / ".worktrees" / "forge-spec"
        worktree.mkdir(parents=True)

        with (
            patch("forge_orchestrator._git_current_branch", return_value="feature/ok"),
            patch("forge_orchestrator._git_root", return_value=str(tmp_path)),
            patch("forge_orchestrator._setup_worktree", return_value=(worktree, "forge/spec")),
            patch("forge_orchestrator.acquire_lock", return_value=True),
            patch("forge_orchestrator.release_lock"),
        ):
            code = run_forge(spec)

        assert code == 0

    def test_exit_3_main_branch(self, tmp_path: Path) -> None:
        """Running on main returns exit code 3."""
        _init_git_repo(tmp_path)
        spec = _create_spec(tmp_path)

        with patch("forge_orchestrator._git_current_branch", return_value="main"):
            code = run_forge(spec)

        assert code == 3

    def test_exit_3_lock_conflict(self, tmp_path: Path) -> None:
        """Lock conflict (another forge running) returns exit code 3."""
        _init_git_repo(tmp_path)
        spec = _create_spec(tmp_path)

        worktree = tmp_path / ".worktrees" / "forge-spec"
        worktree.mkdir(parents=True)

        with (
            patch("forge_orchestrator._git_current_branch", return_value="feature/locked"),
            patch("forge_orchestrator._git_root", return_value=str(tmp_path)),
            patch("forge_orchestrator._setup_worktree", return_value=(worktree, "forge/spec")),
            patch("forge_orchestrator.acquire_lock", return_value=False),  # Lock conflict
            patch("forge_orchestrator.release_lock"),
        ):
            code = run_forge(spec)

        assert code == 3

    def test_exit_1_no_git_root(self, tmp_path: Path) -> None:
        """Not inside a git repo returns exit code 1."""
        spec = _create_spec(tmp_path)

        with (
            patch("forge_orchestrator._git_current_branch", return_value="feature/no-git"),
            patch("forge_orchestrator._git_root", return_value=""),  # No git root
        ):
            code = run_forge(spec)

        assert code == 1


# ---------------------------------------------------------------------------
# Unit tests for pure utility functions
# ---------------------------------------------------------------------------


class TestDeriveBranchName:
    def test_strips_date_prefix(self) -> None:
        spec = Path("2026-04-11-my-spec.md")
        assert derive_branch_name(spec) == "forge/my-spec"

    def test_strips_extension(self) -> None:
        spec = Path("feature-spec.md")
        assert derive_branch_name(spec) == "forge/feature-spec"

    def test_replaces_underscores(self) -> None:
        spec = Path("my_big_spec.md")
        assert derive_branch_name(spec) == "forge/my-big-spec"

    def test_replaces_spaces(self) -> None:
        spec = Path("my big spec.md")
        assert derive_branch_name(spec) == "forge/my-big-spec"

    def test_truncates_to_50(self) -> None:
        spec = Path("a" * 60 + ".md")
        result = derive_branch_name(spec)
        slug = result[len("forge/"):]
        assert len(slug) <= 50

    def test_uses_filename_only(self) -> None:
        spec = Path("/some/deep/path/2026-01-01-design.md")
        assert derive_branch_name(spec) == "forge/design"


class TestStateHelpers:
    def test_write_and_load_state(self, tmp_path: Path) -> None:
        """write_state_atomic and load_state are inverse operations."""
        state_path = tmp_path / "state.json"
        state = {"version": 1, "foo": "bar"}
        write_state_atomic(state_path, state)
        loaded = load_state(state_path)
        assert loaded == state

    def test_load_state_falls_back_to_backup(self, tmp_path: Path) -> None:
        """load_state uses backup when primary is missing."""
        primary = tmp_path / "state.json"
        backup = tmp_path / "backup" / "state-backup.json"
        backup.parent.mkdir(parents=True)
        backup.write_text(json.dumps({"version": 1, "source": "backup"}))

        loaded = load_state(primary, backup)
        assert loaded["source"] == "backup"

    def test_load_state_raises_when_both_missing(self, tmp_path: Path) -> None:
        """load_state raises FileNotFoundError when neither file exists."""
        primary = tmp_path / "state.json"
        backup = tmp_path / "backup.json"

        with pytest.raises(FileNotFoundError):
            load_state(primary, backup)

    def test_write_state_atomic_creates_parent_dirs(self, tmp_path: Path) -> None:
        """write_state_atomic creates parent directories if they don't exist."""
        state_path = tmp_path / "deep" / "nested" / "state.json"
        write_state_atomic(state_path, {"ok": True})
        assert state_path.exists()

    def test_write_state_creates_backup(self, tmp_path: Path) -> None:
        """write_state_atomic mirrors to backup_dir when provided."""
        state_path = tmp_path / "state.json"
        backup_dir = tmp_path / "backup"
        write_state_atomic(state_path, {"x": 1}, backup_dir=backup_dir)

        backup_file = backup_dir / "state-backup.json"
        assert backup_file.exists()
        data = json.loads(backup_file.read_text())
        assert data == {"x": 1}

    def test_init_state_schema(self, tmp_path: Path) -> None:
        """init_state returns a valid state dict with all required phases."""
        spec = tmp_path / "spec.md"
        spec.write_text("content")
        state = init_state(spec, "deadbeef")

        assert state["version"] == 1
        assert state["spec_hash"] == "deadbeef"
        expected_phases = {"classify", "design_review", "plan", "plan_review", "tdd", "tasks"}
        assert set(state["phases"].keys()) == expected_phases
        for phase_data in state["phases"].values():
            assert phase_data["status"] == "pending"


class TestForgeProgress:
    def test_summary_contains_events(self) -> None:
        progress = ForgeProgress(is_tty=False)
        progress.ok("classify", "done")
        progress.fail("design_review", "timeout")
        progress.skip("plan", "dry_run")

        summary = progress.summary()
        assert "events" in summary
        assert len(summary["events"]) == 3

    def test_event_structure(self) -> None:
        progress = ForgeProgress(is_tty=False)
        progress.run("plan", "starting agents")

        event = progress.summary()["events"][0]
        assert "label" in event
        assert "phase" in event
        assert "detail" in event
        assert event["phase"] == "plan"
        assert event["detail"] == "starting agents"
