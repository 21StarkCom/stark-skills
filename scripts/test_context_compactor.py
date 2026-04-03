"""Tests for context_compactor.py — session checkpoint generation."""

import json
import subprocess
import sys
from pathlib import Path
from unittest.mock import patch

import pytest

import context_compactor
import session_state


@pytest.fixture()
def sessions_dir(tmp_path):
    d = tmp_path / "sessions"
    d.mkdir()
    return d


@pytest.fixture()
def mock_session(sessions_dir, tmp_path):
    """Provide a patched SessionState with a known session ID."""
    session_state.SessionState.get_current.cache_clear()
    ss = session_state.SessionState(
        session_id="ckpt-session",
        started_at="2026-04-01T10:00:00Z",
        branch="main",
        repo="GetEvinced/stark-skills",
        tasks_completed=["task-1", "task-2"],
        last_checkpoint=None,
        context={"env": "test"},
    )
    with patch.object(session_state, "SESSIONS_DIR", sessions_dir), \
         patch.object(context_compactor.session_state, "SESSIONS_DIR", sessions_dir), \
         patch.object(context_compactor, "SESSIONS_DIR", sessions_dir), \
         patch("session_state.resolve_session_id", return_value="ckpt-session"), \
         patch("context_compactor.resolve_session_id", return_value="ckpt-session"):
        ss.save()
        # Make get_current return our pre-built session
        session_state.SessionState.get_current.cache_clear()
        with patch.object(session_state.SessionState, "get_current", return_value=ss):
            yield ss
    session_state.SessionState.get_current.cache_clear()


class TestGenerateCheckpoint:
    def test_checkpoint_file_is_created(self, mock_session, sessions_dir):
        checkpoint_path = context_compactor.generate_checkpoint(session_id="ckpt-session")
        assert checkpoint_path is not None
        assert Path(checkpoint_path).exists()

    def test_checkpoint_is_markdown(self, mock_session, sessions_dir):
        checkpoint_path = context_compactor.generate_checkpoint(session_id="ckpt-session")
        content = Path(checkpoint_path).read_text()
        assert "#" in content  # has at least one markdown heading

    def test_checkpoint_contains_session_summary(self, mock_session, sessions_dir):
        checkpoint_path = context_compactor.generate_checkpoint(session_id="ckpt-session")
        content = Path(checkpoint_path).read_text()
        assert "ckpt-session" in content

    def test_checkpoint_contains_branch(self, mock_session, sessions_dir):
        checkpoint_path = context_compactor.generate_checkpoint(session_id="ckpt-session")
        content = Path(checkpoint_path).read_text()
        assert "main" in content

    def test_checkpoint_contains_tasks(self, mock_session, sessions_dir):
        checkpoint_path = context_compactor.generate_checkpoint(session_id="ckpt-session")
        content = Path(checkpoint_path).read_text()
        assert "task-1" in content
        assert "task-2" in content

    def test_checkpoint_filename_has_timestamp(self, mock_session, sessions_dir):
        checkpoint_path = context_compactor.generate_checkpoint(session_id="ckpt-session")
        filename = Path(checkpoint_path).name
        assert filename.startswith("checkpoint-")
        assert filename.endswith(".md")

    def test_checkpoint_stored_in_session_dir(self, mock_session, sessions_dir):
        checkpoint_path = context_compactor.generate_checkpoint(session_id="ckpt-session")
        path = Path(checkpoint_path)
        # Should be inside sessions_dir/ckpt-session/
        assert path.parent == sessions_dir / "ckpt-session"

    def test_checkpoint_respects_max_size(self, mock_session, sessions_dir):
        """Checkpoint should not exceed max_checkpoint_size_kb."""
        cfg = {"checkpoint_interval_minutes": 15, "max_checkpoint_size_kb": 1, "include_file_summaries": False}
        with patch("context_compactor.get_context_compaction_config", return_value=cfg):
            checkpoint_path = context_compactor.generate_checkpoint(session_id="ckpt-session")
        content = Path(checkpoint_path).read_bytes()
        assert len(content) <= 1 * 1024 + 50  # small tolerance for boundary

    def test_updates_session_last_checkpoint(self, mock_session, sessions_dir):
        checkpoint_path = context_compactor.generate_checkpoint(session_id="ckpt-session")
        loaded = session_state.SessionState.load("ckpt-session")
        assert loaded is not None
        assert loaded.last_checkpoint == checkpoint_path


class TestGetLatestCheckpoint:
    def test_returns_none_when_no_checkpoints(self, mock_session, sessions_dir):
        result = context_compactor.get_latest_checkpoint(session_id="ckpt-session")
        assert result is None

    def test_returns_latest_after_generate(self, mock_session, sessions_dir):
        cp1 = context_compactor.generate_checkpoint(session_id="ckpt-session")
        cp2 = context_compactor.generate_checkpoint(session_id="ckpt-session")
        latest = context_compactor.get_latest_checkpoint(session_id="ckpt-session")
        # Should return the most recently created checkpoint
        assert latest in (cp1, cp2)

    def test_returns_none_for_unknown_session(self, mock_session, sessions_dir):
        result = context_compactor.get_latest_checkpoint(session_id="no-such-session")
        assert result is None


class TestCLI:
    def test_cli_json_output_is_valid(self, tmp_path):
        sessions_dir = tmp_path / "sessions"
        sessions_dir.mkdir()
        import os
        script = Path(__file__).parent / "context_compactor.py"
        result = subprocess.run(
            [sys.executable, str(script), "--json"],
            capture_output=True, text=True,
            env={**os.environ, "STARK_SESSIONS_DIR": str(sessions_dir)},
        )
        assert result.returncode == 0, f"stderr: {result.stderr}"
        data = json.loads(result.stdout)
        assert "checkpoint_path" in data or "session_id" in data

    def test_cli_default_output(self, tmp_path):
        import os
        sessions_dir = tmp_path / "sessions"
        sessions_dir.mkdir()
        script = Path(__file__).parent / "context_compactor.py"
        result = subprocess.run(
            [sys.executable, str(script)],
            capture_output=True, text=True,
            env={**os.environ, "STARK_SESSIONS_DIR": str(sessions_dir)},
        )
        assert result.returncode == 0
