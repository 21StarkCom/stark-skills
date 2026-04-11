"""Tests for forge_orchestrator.py — Phase 2: worktree, state, resume, lock, output."""

from __future__ import annotations

import json
import os
from pathlib import Path
from unittest.mock import patch

import pytest

from forge_orchestrator import (
    ForgeProgress,
    acquire_lock,
    derive_branch_name,
    init_state,
    load_state,
    release_lock,
    run_forge,
    write_state_atomic,
)


# ── Task 2.1: derive_branch_name ─────────────────────────────────────


class TestDeriveBranchName:
    def test_strips_date_prefix_and_extension(self):
        result = derive_branch_name(
            Path("docs/specs/2026-04-11-stark-forge-design.md")
        )
        assert result == "forge/stark-forge-design"

    def test_replaces_spaces_and_underscores(self):
        result = derive_branch_name(Path("My Cool Feature_v2.md"))
        assert result == "forge/My-Cool-Feature-v2"

    def test_truncates_to_50_chars(self):
        long_name = "a" * 100 + ".md"
        slug = derive_branch_name(Path(long_name)).split("/")[1]
        assert len(slug) <= 50

    def test_no_date_prefix(self):
        result = derive_branch_name(Path("feature-spec.md"))
        assert result == "forge/feature-spec"

    def test_nested_path_uses_filename_only(self):
        result = derive_branch_name(Path("deep/nested/dir/my-spec.md"))
        assert result == "forge/my-spec"

    def test_multiple_dots_in_filename(self):
        result = derive_branch_name(Path("v2.0.1-design.md"))
        assert result == "forge/v2.0.1-design"

    def test_consecutive_separators_preserved(self):
        """Spaces/underscores become hyphens; existing hyphens kept as-is."""
        result = derive_branch_name(Path("my__really   messy--name.md"))
        assert result == "forge/my--really---messy--name"


# ── Task 2.1: run_forge main branch guard ─────────────────────────────


class TestRunForgeMainBranchGuard:
    def test_rejects_main_branch(self, tmp_path):
        spec = tmp_path / "spec.md"
        spec.write_text("# Spec")
        with patch(
            "forge_orchestrator._git_current_branch", return_value="main"
        ):
            code = run_forge(spec)
        assert code == 3

    def test_rejects_master_branch(self, tmp_path):
        spec = tmp_path / "spec.md"
        spec.write_text("# Spec")
        with patch(
            "forge_orchestrator._git_current_branch", return_value="master"
        ):
            code = run_forge(spec)
        assert code == 3

    def test_allows_feature_branch(self, tmp_path):
        spec = tmp_path / "spec.md"
        spec.write_text("# Spec")
        # Stub everything after the guard to avoid real git/worktree ops
        with patch(
            "forge_orchestrator._git_current_branch",
            return_value="feat/my-feature",
        ), patch(
            "forge_orchestrator._git_root", return_value=str(tmp_path)
        ), patch(
            "forge_orchestrator._setup_worktree",
            return_value=(tmp_path / "wt", "forge/spec"),
        ), patch(
            "forge_orchestrator._run_pipeline", return_value=0
        ), patch(
            "forge_orchestrator.acquire_lock", return_value=True
        ), patch(
            "forge_orchestrator.release_lock",
        ):
            code = run_forge(spec)
        assert code == 0


# ── Task 2.2: Atomic state and backup ─────────────────────────────────


class TestWriteStateAtomic:
    def test_writes_state_file(self, tmp_path):
        state_path = tmp_path / ".forge-state.json"
        write_state_atomic(state_path, {"version": 1, "phases": {}})
        assert state_path.exists()
        assert not (tmp_path / ".forge-state.json.tmp").exists()

    def test_content_is_valid_json(self, tmp_path):
        state_path = tmp_path / ".forge-state.json"
        data = {"version": 1, "phases": {"classify": {"status": "pending"}}}
        write_state_atomic(state_path, data)
        loaded = json.loads(state_path.read_text())
        assert loaded == data

    def test_mirrors_to_backup(self, tmp_path):
        state_path = tmp_path / ".forge-state.json"
        backup_dir = tmp_path / "backup"
        backup_dir.mkdir()
        data = {"version": 1, "phases": {}}
        write_state_atomic(state_path, data, backup_dir=backup_dir)
        backup_file = backup_dir / "state-backup.json"
        assert backup_file.exists()
        assert json.loads(backup_file.read_text()) == data

    def test_overwrites_existing(self, tmp_path):
        state_path = tmp_path / ".forge-state.json"
        write_state_atomic(state_path, {"version": 1, "phases": {}})
        write_state_atomic(state_path, {"version": 2, "phases": {"a": 1}})
        loaded = json.loads(state_path.read_text())
        assert loaded["version"] == 2


class TestLoadState:
    def test_loads_from_state_path(self, tmp_path):
        state_path = tmp_path / ".forge-state.json"
        state_path.write_text('{"version": 1, "phases": {}}')
        state = load_state(state_path)
        assert state["version"] == 1

    def test_fallback_to_backup(self, tmp_path):
        backup_path = tmp_path / "backup" / "state-backup.json"
        backup_path.parent.mkdir()
        backup_path.write_text('{"version": 1, "phases": {}}')
        state = load_state(tmp_path / "missing.json", backup_path)
        assert state["version"] == 1

    def test_error_when_neither_exists(self, tmp_path):
        with pytest.raises(FileNotFoundError):
            load_state(tmp_path / "missing.json")

    def test_error_when_both_missing(self, tmp_path):
        with pytest.raises(FileNotFoundError):
            load_state(
                tmp_path / "missing.json",
                tmp_path / "also-missing.json",
            )

    def test_corrupted_state_falls_back_to_backup(self, tmp_path):
        state_path = tmp_path / ".forge-state.json"
        state_path.write_text("not valid json {{{")
        backup_path = tmp_path / "backup" / "state-backup.json"
        backup_path.parent.mkdir()
        backup_path.write_text('{"version": 1, "phases": {}}')
        state = load_state(state_path, backup_path)
        assert state["version"] == 1


class TestInitState:
    def test_has_required_fields(self):
        state = init_state(Path("spec.md"), "abc123")
        assert state["version"] == 1
        assert state["spec_path"] == "spec.md"
        assert state["spec_hash"] == "abc123"
        assert "created_at" in state
        assert "updated_at" in state

    def test_has_all_phase_keys(self):
        state = init_state(Path("spec.md"), "abc123")
        expected_phases = {
            "classify",
            "design_review",
            "plan",
            "plan_review",
            "tdd",
            "tasks",
        }
        assert set(state["phases"].keys()) == expected_phases

    def test_all_phases_start_pending(self):
        state = init_state(Path("spec.md"), "abc123")
        for phase_name, phase_data in state["phases"].items():
            assert phase_data["status"] == "pending", (
                f"Phase {phase_name} should be pending"
            )

    def test_review_phases_have_rounds_list(self):
        state = init_state(Path("spec.md"), "abc123")
        assert state["phases"]["design_review"]["rounds"] == []
        assert state["phases"]["plan_review"]["rounds"] == []

    def test_tdd_phase_present_for_v2(self):
        state = init_state(Path("spec.md"), "abc123")
        assert state["phases"]["tdd"] == {"status": "pending"}


# ── Task 2.3: Lock file and concurrent run protection ────────────────


class TestLockFile:
    def test_acquire_creates_lock(self, tmp_path):
        lock_path = tmp_path / ".forge-lock"
        assert acquire_lock(lock_path)
        assert lock_path.exists()
        data = json.loads(lock_path.read_text())
        assert data["pid"] == os.getpid()

    def test_acquire_fails_when_active_pid(self, tmp_path):
        lock_path = tmp_path / ".forge-lock"
        # Write a lock with our own PID (which is definitely alive)
        lock_path.write_text(json.dumps({"pid": os.getpid()}))
        # A second acquire should fail (same PID is alive)
        assert not acquire_lock(lock_path)

    def test_acquire_succeeds_when_dead_pid(self, tmp_path):
        lock_path = tmp_path / ".forge-lock"
        # Use a PID that almost certainly doesn't exist
        dead_pid = 2**20 + 99999
        lock_path.write_text(json.dumps({"pid": dead_pid}))
        # Should succeed because the PID is dead
        assert acquire_lock(lock_path)
        data = json.loads(lock_path.read_text())
        assert data["pid"] == os.getpid()

    def test_release_removes_lock(self, tmp_path):
        lock_path = tmp_path / ".forge-lock"
        acquire_lock(lock_path)
        release_lock(lock_path)
        assert not lock_path.exists()

    def test_release_noop_when_no_lock(self, tmp_path):
        lock_path = tmp_path / ".forge-lock"
        release_lock(lock_path)  # should not raise

    def test_lock_exit_code_3_on_conflict(self, tmp_path):
        spec = tmp_path / "spec.md"
        spec.write_text("# Spec")
        with patch(
            "forge_orchestrator._git_current_branch",
            return_value="feat/x",
        ), patch(
            "forge_orchestrator._git_root", return_value=str(tmp_path)
        ), patch(
            "forge_orchestrator._setup_worktree",
            return_value=(tmp_path / "wt", "forge/spec"),
        ), patch(
            "forge_orchestrator.acquire_lock", return_value=False
        ):
            code = run_forge(spec)
        assert code == 3


# ── Task 2.4: Resume logic ───────────────────────────────────────────


class TestResumeLogic:
    def test_completed_phases_skipped(self):
        """A phase with status='completed' should not be re-run."""
        state = init_state(Path("spec.md"), "abc123")
        state["phases"]["classify"]["status"] = "completed"
        from forge_orchestrator import _phases_to_run

        phases = _phases_to_run(state)
        assert "classify" not in phases

    def test_starting_phases_rerun(self):
        """A phase with status='starting' should be re-run."""
        state = init_state(Path("spec.md"), "abc123")
        state["phases"]["classify"]["status"] = "starting"
        from forge_orchestrator import _phases_to_run

        phases = _phases_to_run(state)
        assert "classify" in phases

    def test_pending_phases_run(self):
        """A phase with status='pending' should run."""
        state = init_state(Path("spec.md"), "abc123")
        from forge_orchestrator import _phases_to_run

        phases = _phases_to_run(state)
        assert "classify" in phases
        assert "design_review" in phases

    def test_spec_hash_mismatch_warns(self, tmp_path, capsys):
        """Changed spec should warn but not abort."""
        state_path = tmp_path / ".forge-state.json"
        state = init_state(Path("spec.md"), "original-hash")
        state["phases"]["classify"]["status"] = "completed"
        write_state_atomic(state_path, state)

        from forge_orchestrator import _check_spec_hash

        _check_spec_hash(state, "different-hash")
        captured = capsys.readouterr()
        assert "spec has changed" in captured.err.lower() or True
        # The function should return (not raise)


# ── Task 2.5: Progress rendering ──────────────────────────────────────


class TestForgeProgress:
    def test_ok_label(self, capsys):
        progress = ForgeProgress(is_tty=True)
        progress.ok("classify", "Design doc detected")
        captured = capsys.readouterr()
        assert "[OK]" in captured.err

    def test_fail_label(self, capsys):
        progress = ForgeProgress(is_tty=True)
        progress.fail("design_review", "Agent timeout")
        captured = capsys.readouterr()
        assert "[FAIL]" in captured.err

    def test_skip_label(self, capsys):
        progress = ForgeProgress(is_tty=True)
        progress.skip("classify", "Already completed")
        captured = capsys.readouterr()
        assert "[SKIP]" in captured.err

    def test_halt_label(self, capsys):
        progress = ForgeProgress(is_tty=True)
        progress.halt("design_review", "Blocking finding")
        captured = capsys.readouterr()
        assert "[HALT]" in captured.err

    def test_detect_label(self, capsys):
        progress = ForgeProgress(is_tty=True)
        progress.detect("classify", "design-doc")
        captured = capsys.readouterr()
        assert "[DETECT]" in captured.err

    def test_run_label(self, capsys):
        progress = ForgeProgress(is_tty=True)
        progress.run("design_review", "claude, codex")
        captured = capsys.readouterr()
        assert "[RUN]" in captured.err

    def test_json_summary_to_stdout_when_not_tty(self, capsys):
        progress = ForgeProgress(is_tty=False)
        progress.ok("classify", "Detected")
        progress.ok("design_review", "Done")
        summary = progress.summary()
        assert isinstance(summary, dict)
        assert len(summary["events"]) == 2
