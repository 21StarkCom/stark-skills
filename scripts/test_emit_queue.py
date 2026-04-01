"""Tests for emit_queue.py — durable SQLite event queue."""

import json
import os
import sqlite3
import tempfile
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from threading import Thread
from unittest.mock import patch

import pytest

import emit_queue


@pytest.fixture(autouse=True)
def isolated_queue(tmp_path):
    """Each test gets its own queue directory."""
    with patch.object(emit_queue, "QUEUE_DIR", tmp_path), \
         patch.object(emit_queue, "QUEUE_DB", tmp_path / "queue.db"), \
         patch.object(emit_queue, "TOKEN_PATH", tmp_path / "api-token"), \
         patch.object(emit_queue, "LAST_TOOL_PATH", tmp_path / "last-tool"):
        (tmp_path / "api-token").write_text("test-token")
        yield tmp_path


def _make_event(**overrides) -> dict:
    defaults = {
        "type": "skill_invocation",
        "timestamp": "2026-04-01T14:30:00Z",
        "cli": "claude",
        "source": "skill",
        "schema_version": 1,
        "payload": {"skill": "stark-review", "duration_s": 120},
    }
    defaults.update(overrides)
    return defaults


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------

class TestValidation:
    def test_valid_event(self):
        assert emit_queue.validate(_make_event()) == []

    def test_missing_required_field(self):
        event = _make_event()
        del event["type"]
        errors = emit_queue.validate(event)
        assert any("type" in e for e in errors)

    def test_invalid_type(self):
        errors = emit_queue.validate(_make_event(type="bogus"))
        assert any("invalid type" in e for e in errors)

    def test_invalid_cli(self):
        errors = emit_queue.validate(_make_event(cli="chatgpt"))
        assert any("invalid cli" in e for e in errors)

    def test_invalid_source(self):
        errors = emit_queue.validate(_make_event(source="magic"))
        assert any("invalid source" in e for e in errors)

    def test_invalid_schema_version(self):
        errors = emit_queue.validate(_make_event(schema_version=0))
        assert any("schema_version" in e for e in errors)

    def test_payload_must_be_dict(self):
        errors = emit_queue.validate(_make_event(payload="not a dict"))
        assert any("payload" in e for e in errors)


# ---------------------------------------------------------------------------
# Enqueue
# ---------------------------------------------------------------------------

class TestEnqueue:
    def test_enqueue_returns_row_id(self):
        row_id = emit_queue.enqueue(_make_event())
        assert row_id is not None and row_id > 0

    def test_enqueue_increments_pending_count(self):
        assert emit_queue.pending_count() == 0
        emit_queue.enqueue(_make_event(dedupe_key="a"))
        emit_queue.enqueue(_make_event(dedupe_key="b"))
        assert emit_queue.pending_count() == 2

    def test_duplicate_dedupe_key_is_ignored(self):
        emit_queue.enqueue(_make_event(dedupe_key="same"))
        result = emit_queue.enqueue(_make_event(dedupe_key="same"))
        assert result is None
        assert emit_queue.pending_count() == 1

    def test_null_dedupe_key_allows_duplicates(self):
        emit_queue.enqueue(_make_event())
        emit_queue.enqueue(_make_event())
        assert emit_queue.pending_count() == 2

    def test_invalid_event_raises_value_error(self):
        with pytest.raises(ValueError, match="Invalid event"):
            emit_queue.enqueue({"type": "bogus"})

    def test_event_persists_across_connections(self, isolated_queue):
        emit_queue.enqueue(_make_event(dedupe_key="persist"))
        # New connection via pending_count
        assert emit_queue.pending_count() == 1


# ---------------------------------------------------------------------------
# Drain
# ---------------------------------------------------------------------------

class TestDrain:
    def test_drain_sends_and_removes(self):
        emit_queue.enqueue(_make_event(dedupe_key="drain-1"))
        received = []

        def handler_factory(received_list):
            class Handler(BaseHTTPRequestHandler):
                def do_POST(self):
                    length = int(self.headers.get("Content-Length", 0))
                    body = self.rfile.read(length)
                    received_list.append(json.loads(body))
                    self.send_response(200)
                    self.end_headers()

                def log_message(self, *args):
                    pass  # suppress logs
            return Handler

        server = HTTPServer(("127.0.0.1", 0), handler_factory(received))
        port = server.server_address[1]
        thread = Thread(target=server.handle_request, daemon=True)
        thread.start()

        with patch.object(emit_queue, "API_URL", f"http://127.0.0.1:{port}/events"):
            stats = emit_queue.drain()

        thread.join(timeout=5)
        server.server_close()

        assert stats["sent"] == 1
        assert stats["failed"] == 0
        assert emit_queue.pending_count() == 0
        assert len(received) == 1
        assert received[0]["type"] == "skill_invocation"

    def test_drain_empty_queue(self):
        stats = emit_queue.drain()
        assert stats["sent"] == 0
        assert stats["failed"] == 0
        assert stats["dead_lettered"] == 0

    def test_drain_failure_increments_retries(self):
        emit_queue.enqueue(_make_event(dedupe_key="fail-1"))

        with patch.object(emit_queue, "API_URL", "http://127.0.0.1:1/nope"):
            stats = emit_queue.drain()

        assert stats["failed"] == 1
        assert emit_queue.pending_count() == 1

        # Verify retry count incremented
        db = emit_queue._get_db()
        row = db.execute("SELECT retries, last_error FROM pending WHERE dedupe_key = 'fail-1'").fetchone()
        db.close()
        assert row[0] == 1
        assert row[1] is not None

    def test_dead_letter_after_max_retries(self):
        emit_queue.enqueue(_make_event(dedupe_key="doomed"))

        # Set retries to MAX_RETRIES - 1 so next failure triggers dead-letter
        db = emit_queue._get_db()
        db.execute("UPDATE pending SET retries = ?", (emit_queue.MAX_RETRIES - 1,))
        db.commit()
        db.close()

        with patch.object(emit_queue, "API_URL", "http://127.0.0.1:1/nope"):
            stats = emit_queue.drain()

        assert stats["dead_lettered"] == 1
        assert emit_queue.pending_count() == 0
        assert emit_queue.dead_letter_count() == 1


# ---------------------------------------------------------------------------
# Dead letter recovery
# ---------------------------------------------------------------------------

class TestDeadLetterRecovery:
    def test_drain_auto_recovers_dead_letters_on_success(self):
        """When drain succeeds, dead letters should be moved back to pending."""
        # Put one event in dead letter
        emit_queue.enqueue(_make_event(dedupe_key="was-dead"))
        db = emit_queue._get_db()
        db.execute("UPDATE pending SET retries = ?", (emit_queue.MAX_RETRIES - 1,))
        db.commit()
        db.close()

        with patch.object(emit_queue, "API_URL", "http://127.0.0.1:1/nope"):
            emit_queue.drain()  # sends to dead letter

        assert emit_queue.dead_letter_count() == 1

        # Now enqueue a new event and drain with a working API
        emit_queue.enqueue(_make_event(dedupe_key="fresh"))
        received = []

        from http.server import BaseHTTPRequestHandler, HTTPServer
        from threading import Thread

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                length = int(self.headers.get("Content-Length", 0))
                received.append(self.rfile.read(length))
                self.send_response(200)
                self.end_headers()

            def log_message(self, *args):
                pass

        server = HTTPServer(("127.0.0.1", 0), Handler)
        port = server.server_address[1]
        # Handle multiple requests: the fresh event + recovered dead letter
        thread = Thread(target=lambda: [server.handle_request() for _ in range(2)], daemon=True)
        thread.start()

        with patch.object(emit_queue, "API_URL", f"http://127.0.0.1:{port}/events"):
            stats = emit_queue.drain()

        thread.join(timeout=5)
        server.server_close()

        assert stats["sent"] >= 1
        assert stats.get("recovered", 0) == 1
        assert emit_queue.dead_letter_count() == 0

    def test_retry_dead_letters_moves_to_pending(self):
        emit_queue.enqueue(_make_event(dedupe_key="recover"))

        # Force into dead letter
        db = emit_queue._get_db()
        db.execute("UPDATE pending SET retries = ?", (emit_queue.MAX_RETRIES - 1,))
        db.commit()
        db.close()

        with patch.object(emit_queue, "API_URL", "http://127.0.0.1:1/nope"):
            emit_queue.drain()

        assert emit_queue.dead_letter_count() == 1
        assert emit_queue.pending_count() == 0

        moved = emit_queue.retry_dead_letters()
        assert moved == 1
        assert emit_queue.dead_letter_count() == 0
        assert emit_queue.pending_count() == 1


# ---------------------------------------------------------------------------
# make_event helper
# ---------------------------------------------------------------------------

class TestMakeEvent:
    def test_defaults(self):
        event = emit_queue.make_event("skill_invocation", {"skill": "test"})
        assert event["type"] == "skill_invocation"
        assert event["cli"] == "claude"
        assert event["source"] == "skill"
        assert event["schema_version"] == 1
        assert event["payload"] == {"skill": "test"}
        assert "timestamp" in event

    def test_session_id_generates_dedupe_key(self):
        event = emit_queue.make_event(
            "skill_invocation", {}, session_id="sess-1"
        )
        assert event["dedupe_key"].startswith("skill_invocation:sess-1:")

    def test_explicit_dedupe_key_wins(self):
        event = emit_queue.make_event(
            "skill_invocation", {},
            session_id="sess-1",
            dedupe_key="custom-key",
        )
        assert event["dedupe_key"] == "custom-key"

    def test_optional_fields_omitted_when_none(self):
        event = emit_queue.make_event("prompt", {})
        assert "session_id" not in event
        assert "project" not in event
        assert "user_id" not in event


# ---------------------------------------------------------------------------
# Session cost tracking
# ---------------------------------------------------------------------------

class TestSessionCost:
    def test_add_and_get_cost(self):
        emit_queue.add_cost(input_tokens=100_000, output_tokens=5_000)
        inp, out, cost = emit_queue.get_session_cost()
        assert inp == 100_000
        assert out == 5_000
        assert cost > 0

    def test_cost_accumulates(self):
        emit_queue.add_cost(input_tokens=50_000)
        emit_queue.add_cost(input_tokens=50_000, output_tokens=10_000)
        inp, out, cost = emit_queue.get_session_cost()
        assert inp == 100_000
        assert out == 10_000

    def test_zero_tokens_is_noop(self):
        emit_queue.add_cost(input_tokens=0, output_tokens=0)
        inp, out, cost = emit_queue.get_session_cost()
        assert inp == 0 and out == 0 and cost == 0.0

    def test_empty_session_cost(self):
        inp, out, cost = emit_queue.get_session_cost()
        assert inp == 0 and out == 0 and cost == 0.0


# ---------------------------------------------------------------------------
# Inflight queries
# ---------------------------------------------------------------------------

class TestInflightQueries:
    def test_inflight_count(self):
        assert emit_queue.inflight_count() == 0
        emit_queue.start_tool("iq-1", "Read")
        emit_queue.start_tool("iq-2", "Bash")
        assert emit_queue.inflight_count() == 2
        emit_queue.end_tool("iq-1")
        assert emit_queue.inflight_count() == 1

    def test_longest_inflight(self):
        assert emit_queue.longest_inflight() is None
        emit_queue.start_tool("li-1", "Agent")
        import time; time.sleep(0.02)
        emit_queue.start_tool("li-2", "Read")
        result = emit_queue.longest_inflight()
        assert result is not None
        assert result[0] == "Agent"  # started first = longest
        emit_queue.end_tool("li-1")
        emit_queue.end_tool("li-2")


# ---------------------------------------------------------------------------
# Context velocity
# ---------------------------------------------------------------------------

class TestContextVelocity:
    def test_first_recording_returns_empty(self, isolated_queue):
        with patch.object(emit_queue, "CTX_HISTORY_PATH", isolated_queue / "ctx-history"):
            trend = emit_queue.record_context_pct(10.0)
            assert trend == ""

    def test_fast_growth_returns_arrow(self, isolated_queue):
        with patch.object(emit_queue, "CTX_HISTORY_PATH", isolated_queue / "ctx-history"):
            emit_queue.record_context_pct(10.0)
            trend = emit_queue.record_context_pct(20.0)  # +10% jump
            assert trend == "\u25b2"  # ▲

    def test_stable_returns_empty(self, isolated_queue):
        with patch.object(emit_queue, "CTX_HISTORY_PATH", isolated_queue / "ctx-history"):
            emit_queue.record_context_pct(50.0)
            trend = emit_queue.record_context_pct(50.5)  # barely moved
            assert trend == ""


# ---------------------------------------------------------------------------
# Status snapshot
# ---------------------------------------------------------------------------

class TestStatusSnapshot:
    def test_write_and_read_snapshot(self, isolated_queue):
        with patch.object(emit_queue, "STATUS_PATH", isolated_queue / "status"):
            emit_queue.start_tool("ss-1", "Agent")
            emit_queue.add_cost(input_tokens=200_000, output_tokens=10_000)
            emit_queue.write_status_snapshot()
            content = (isolated_queue / "status").read_text()
            assert "inflight=1" in content
            assert "cost=" in content
            assert "longest_tool=Agent" in content
            emit_queue.end_tool("ss-1")


# ---------------------------------------------------------------------------
# Tool duration tracking
# ---------------------------------------------------------------------------

class TestToolDuration:
    def test_start_and_end_returns_duration(self):
        emit_queue.start_tool("tu-1", "Read")
        import time; time.sleep(0.01)  # ensure measurable duration
        result = emit_queue.end_tool("tu-1")
        assert result is not None
        tool_name, duration_ms = result
        assert tool_name == "Read"
        assert duration_ms >= 5  # at least ~10ms of sleep

    def test_end_without_start_returns_none(self):
        assert emit_queue.end_tool("tu-nonexistent") is None

    def test_end_with_empty_id_returns_none(self):
        assert emit_queue.end_tool("") is None

    def test_start_with_empty_id_is_noop(self):
        emit_queue.start_tool("", "Read")
        db = emit_queue._get_db()
        row = db.execute("SELECT COUNT(*) FROM inflight").fetchone()
        db.close()
        assert row[0] == 0

    def test_end_writes_last_tool_file(self, isolated_queue):
        emit_queue.start_tool("tu-file", "Bash")
        emit_queue.end_tool("tu-file")
        last_tool = isolated_queue / "last-tool"
        assert last_tool.exists()
        parts = last_tool.read_text().strip().split("\t")
        assert len(parts) == 3
        assert parts[0] == "Bash"
        assert int(parts[1]) >= 0  # duration_ms
        assert int(parts[2]) > 0  # unix timestamp

    def test_read_last_tool(self, isolated_queue):
        emit_queue.start_tool("tu-read", "Grep")
        emit_queue.end_tool("tu-read")
        result = emit_queue.read_last_tool()
        assert result is not None
        tool_name, duration_ms, ts = result
        assert tool_name == "Grep"
        assert duration_ms >= 0
        assert ts > 0

    def test_duplicate_start_overwrites(self):
        emit_queue.start_tool("tu-dup", "Read")
        emit_queue.start_tool("tu-dup", "Write")
        result = emit_queue.end_tool("tu-dup")
        assert result is not None
        assert result[0] == "Write"

    def test_stale_inflight_pruned(self):
        """Entries older than 10 minutes get pruned on end_tool."""
        db = emit_queue._get_db()
        # Insert a stale entry (started_at far in the past relative to monotonic)
        import time
        stale_time = time.monotonic() - 700  # 11+ minutes ago
        db.execute(
            "INSERT INTO inflight (tool_use_id, tool_name, started_at) VALUES (?, ?, ?)",
            ("tu-stale", "OldTool", stale_time),
        )
        db.commit()
        db.close()

        # Trigger a normal end_tool which should prune stale entries
        emit_queue.start_tool("tu-current", "Read")
        emit_queue.end_tool("tu-current")

        db = emit_queue._get_db()
        row = db.execute("SELECT COUNT(*) FROM inflight WHERE tool_use_id = 'tu-stale'").fetchone()
        db.close()
        assert row[0] == 0


# ---------------------------------------------------------------------------
# stark-emit CLI integration
# ---------------------------------------------------------------------------

class TestStarkEmitCLI:
    def test_stark_emit_enqueues(self, isolated_queue):
        """stark-emit script should enqueue via the module."""
        import subprocess
        stark_emit = Path(__file__).parent.parent / "stark-emit"
        env = os.environ.copy()
        env["STARK_QUEUE_DIR"] = str(isolated_queue)
        env["CLAUDE_SESSION_ID"] = "test-session"
        env["CLAUDE_PROJECT"] = "/test/project"

        result = subprocess.run(
            [sys.executable, str(stark_emit), "skill_invocation", "skill=stark-review", "duration_s=42"],
            env=env,
            capture_output=True,
            text=True,
        )
        assert result.returncode == 0, f"stderr: {result.stderr}"

        # Verify event landed in the queue
        db = sqlite3.connect(str(isolated_queue / "queue.db"))
        rows = db.execute("SELECT event_json FROM pending").fetchall()
        db.close()
        assert len(rows) == 1
        event = json.loads(rows[0][0])
        assert event["type"] == "skill_invocation"
        assert event["payload"]["skill"] == "stark-review"
        assert event["payload"]["duration_s"] == 42
        assert event["session_id"] == "test-session"


import sys
