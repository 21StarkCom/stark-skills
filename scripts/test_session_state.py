"""Tests for session_state.py — persistent session management."""

import json
import subprocess
import sys
from pathlib import Path
from unittest.mock import patch

import pytest

import session_state


@pytest.fixture()
def sessions_dir(tmp_path):
    """Isolated sessions directory."""
    d = tmp_path / "sessions"
    d.mkdir()
    return d


@pytest.fixture()
def isolated(sessions_dir):
    """Patch SESSIONS_DIR and resolve_session_id for each test, with cache isolation."""
    session_state.SessionState.get_current.cache_clear()
    with patch.object(session_state, "SESSIONS_DIR", sessions_dir), \
         patch("session_state.resolve_session_id", return_value="test-session-id"):
        yield sessions_dir
    session_state.SessionState.get_current.cache_clear()


class TestSessionStateConstruction:
    def test_get_current_creates_new_session(self, isolated):
        ss = session_state.SessionState.get_current()
        assert ss.session_id == "test-session-id"
        assert ss.started_at is not None
        assert isinstance(ss.tasks_completed, list)
        assert ss.tasks_completed == []
        assert ss.last_checkpoint is None
        assert isinstance(ss.context, dict)

    def test_get_current_populates_branch_and_repo(self, isolated):
        ss = session_state.SessionState.get_current()
        # branch and repo come from git — just verify they are strings
        assert isinstance(ss.branch, str)
        assert isinstance(ss.repo, str)

    def test_get_current_returns_same_session_on_reload(self, isolated):
        ss1 = session_state.SessionState.get_current()
        ss1.save()
        # Clear lru_cache so get_current re-loads from disk
        session_state.SessionState.get_current.cache_clear()
        ss2 = session_state.SessionState.get_current()
        assert ss2.session_id == ss1.session_id
        assert ss2.started_at == ss1.started_at


class TestSaveAndLoad:
    def test_save_writes_json_file(self, isolated, sessions_dir):
        ss = session_state.SessionState.get_current()
        ss.save()
        expected_path = sessions_dir / "test-session-id.json"
        assert expected_path.exists()

    def test_load_returns_none_for_missing_session(self, isolated):
        result = session_state.SessionState.load("nonexistent-session")
        assert result is None

    def test_load_returns_session_after_save(self, isolated):
        ss = session_state.SessionState.get_current()
        ss.save()
        loaded = session_state.SessionState.load("test-session-id")
        assert loaded is not None
        assert loaded.session_id == "test-session-id"
        assert loaded.started_at == ss.started_at

    def test_saved_json_is_valid(self, isolated, sessions_dir):
        ss = session_state.SessionState.get_current()
        ss.save()
        path = sessions_dir / "test-session-id.json"
        data = json.loads(path.read_text())
        assert "session_id" in data
        assert "started_at" in data
        assert "tasks_completed" in data
        assert "context" in data

    def test_load_restores_all_fields(self, isolated):
        ss = session_state.SessionState.get_current()
        ss.tasks_completed = ["task-a", "task-b"]
        ss.last_checkpoint = "/some/checkpoint.md"
        ss.context = {"key": "value"}
        ss.save()

        loaded = session_state.SessionState.load("test-session-id")
        assert loaded.tasks_completed == ["task-a", "task-b"]
        assert loaded.last_checkpoint == "/some/checkpoint.md"
        assert loaded.context == {"key": "value"}


class TestMutationMethods:
    def test_add_task_appends_and_saves(self, isolated, sessions_dir):
        ss = session_state.SessionState.get_current()
        ss.add_task("task-1")
        assert "task-1" in ss.tasks_completed
        # Verify it was persisted
        loaded = session_state.SessionState.load("test-session-id")
        assert "task-1" in loaded.tasks_completed

    def test_add_task_accumulates(self, isolated):
        ss = session_state.SessionState.get_current()
        ss.add_task("task-1")
        ss.add_task("task-2")
        assert ss.tasks_completed == ["task-1", "task-2"]

    def test_set_checkpoint_saves(self, isolated, sessions_dir):
        ss = session_state.SessionState.get_current()
        ss.set_checkpoint("/path/to/checkpoint-001.md")
        assert ss.last_checkpoint == "/path/to/checkpoint-001.md"
        loaded = session_state.SessionState.load("test-session-id")
        assert loaded.last_checkpoint == "/path/to/checkpoint-001.md"

    def test_update_context_merges_and_saves(self, isolated):
        ss = session_state.SessionState.get_current()
        ss.update_context("foo", "bar")
        ss.update_context("count", 42)
        assert ss.context["foo"] == "bar"
        assert ss.context["count"] == 42
        loaded = session_state.SessionState.load("test-session-id")
        assert loaded.context["foo"] == "bar"
        assert loaded.context["count"] == 42


class TestBackwardCompatibility:
    """Ensure old state files (missing new fields) and future files (extra keys) load safely."""

    def test_name_field_defaults_none_on_old_state(self, isolated, sessions_dir):
        old_data = {
            "session_id": "old-session",
            "started_at": "2025-01-01T00:00:00Z",
            "branch": "main",
            "repo": "org/repo",
            "tasks_completed": [],
            "last_checkpoint": None,
            "context": {},
        }
        (sessions_dir / "old-session.json").write_text(json.dumps(old_data))
        loaded = session_state.SessionState.load("old-session")
        assert loaded is not None
        assert loaded.name is None

    def test_start_head_field_defaults_none_on_old_state(self, isolated, sessions_dir):
        old_data = {
            "session_id": "old-session",
            "started_at": "2025-01-01T00:00:00Z",
            "branch": "main",
            "repo": "org/repo",
            "tasks_completed": [],
            "last_checkpoint": None,
            "context": {},
        }
        (sessions_dir / "old-session.json").write_text(json.dumps(old_data))
        loaded = session_state.SessionState.load("old-session")
        assert loaded is not None
        assert loaded.start_head is None

    def test_unknown_keys_ignored_on_load(self, isolated, sessions_dir):
        future_data = {
            "session_id": "future-session",
            "started_at": "2025-06-01T00:00:00Z",
            "branch": "main",
            "repo": "org/repo",
            "tasks_completed": [],
            "last_checkpoint": None,
            "context": {},
            "some_future_field": "unexpected_value",
            "another_unknown": 42,
        }
        (sessions_dir / "future-session.json").write_text(json.dumps(future_data))
        loaded = session_state.SessionState.load("future-session")
        assert loaded is not None
        assert loaded.session_id == "future-session"


class TestCLI:
    def test_cli_json_output_is_valid(self, isolated):
        script = Path(__file__).parent / "session_state.py"
        result = subprocess.run(
            [sys.executable, str(script), "--json"],
            capture_output=True, text=True,
        )
        assert result.returncode == 0, f"stderr: {result.stderr}"
        data = json.loads(result.stdout)
        assert "session_id" in data

    def test_cli_default_output(self, isolated):
        script = Path(__file__).parent / "session_state.py"
        result = subprocess.run(
            [sys.executable, str(script)],
            capture_output=True, text=True,
        )
        assert result.returncode == 0
        assert "session_id" in result.stdout.lower() or "session" in result.stdout.lower()

    def test_cli_session_id_flag(self, tmp_path):
        # Create a sessions dir with a known session file
        sessions_dir = tmp_path / "sessions"
        sessions_dir.mkdir()
        session_data = {
            "session_id": "known-session",
            "started_at": "2026-01-01T00:00:00Z",
            "branch": "main",
            "repo": "org/repo",
            "tasks_completed": [],
            "last_checkpoint": None,
            "context": {},
        }
        (sessions_dir / "known-session.json").write_text(json.dumps(session_data))

        import os
        script = Path(__file__).parent / "session_state.py"
        result = subprocess.run(
            [sys.executable, str(script), "--session-id", "known-session", "--json"],
            capture_output=True, text=True,
            env={**os.environ, "STARK_SESSIONS_DIR": str(sessions_dir)},
        )
        assert result.returncode == 0, f"stderr: {result.stderr}"
        data = json.loads(result.stdout)
        assert data["session_id"] == "known-session"
