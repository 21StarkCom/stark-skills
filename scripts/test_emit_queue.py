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
        "payload": {"skill": "stark-team-review", "duration_s": 120},
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

    def test_v2_event_type_names_are_accepted(self):
        """The workflow-improvement design doc defines context_compaction,
        learning_captured, and skill_recommendation. validate() must accept
        those alongside the pre-v2 aliases so the migration doesn't reject
        spec-compliant producers."""
        for event_type in (
            "context_compaction",
            "learning_captured",
            "skill_recommendation",
            # Legacy aliases stay valid during migration.
            "learning_capture",
            "skill_suggestion",
        ):
            assert emit_queue.validate(_make_event(type=event_type)) == [], event_type

    def test_non_string_required_fields_are_rejected(self):
        """type/timestamp/cli/source must be strings; numbers or dicts were
        previously accepted by the field-presence check and slipped into
        pending, where the v2 TEXT NOT NULL column would reject them late."""
        for field in ("type", "timestamp", "cli", "source"):
            for bad in (42, 3.14, {"nested": "dict"}, ["list"]):
                event = _make_event()
                event[field] = bad
                errors = emit_queue.validate(event)
                assert any(field in e for e in errors), (field, bad, errors)

    def test_empty_required_strings_are_rejected(self):
        """type/timestamp/cli/source present-but-empty must not slip through
        the missing-field check and reach drain(); v2 declares those columns
        NOT NULL and the backend would reject the POST late."""
        for field in ("type", "timestamp", "cli", "source"):
            event = _make_event()
            event[field] = ""
            errors = emit_queue.validate(event)
            assert any(field in e for e in errors), (field, errors)

    def test_event_id_when_present_must_be_non_empty_string(self):
        for bad in (42, "", None, []):
            event = _make_event(event_id=bad)
            errors = emit_queue.validate(event)
            assert any("event_id" in e for e in errors), (bad, errors)

    def test_event_id_absent_is_accepted(self):
        """event_id is optional — legacy producers that never set it stay
        valid. make_event() generates one, but validate() must not punish
        rows queued by older producers that pre-date the uuid4 contract."""
        event = _make_event()
        event.pop("event_id", None)
        assert emit_queue.validate(event) == []


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

    def test_retry_dead_letters_skips_buffer_source(self):
        """Buffer-path dead letters must not be requeued onto the HTTP path.

        drain_to_buffer quarantines poison rows and permanent sqlite errors
        into dead_letter with source_path='buffer'. A later successful drain()
        auto-calls retry_dead_letters, so without a filter a bad row rejected
        by the buffer sink would be re-POSTed to the API.
        """
        db = emit_queue._get_db()
        db.execute(
            "INSERT INTO dead_letter "
            "(dedupe_key, event_json, created_at, retries, last_error, source_path) "
            "VALUES ('buffer-key', '{}', '2026-04-01T00:00:00Z', 3, 'poison', 'buffer')"
        )
        db.execute(
            "INSERT INTO dead_letter "
            "(dedupe_key, event_json, created_at, retries, last_error, source_path) "
            "VALUES ('http-key', '{}', '2026-04-01T00:00:00Z', 3, 'network', 'http')"
        )
        db.commit()
        db.close()

        moved = emit_queue.retry_dead_letters()
        assert moved == 1

        db = emit_queue._get_db()
        remaining = db.execute(
            "SELECT dedupe_key, source_path FROM dead_letter"
        ).fetchall()
        pending = db.execute(
            "SELECT dedupe_key FROM pending"
        ).fetchall()
        db.close()

        assert remaining == [("buffer-key", "buffer")]
        assert pending == [("http-key",)]

    def test_retry_buffer_dead_letters_leaves_row_when_write_fails(
        self, isolated_queue
    ):
        """If _write_event_to_buffer raises inside retry_buffer_dead_letters,
        the dead_letter row must stay put — otherwise a refactor that DELETEs
        before the insert is confirmed would silently drop the event."""
        buffer_path = isolated_queue / "buffer.db"
        _init_v2_buffer(buffer_path)
        db = emit_queue._get_db()
        db.execute(
            "INSERT INTO dead_letter "
            "(dedupe_key, event_json, created_at, retries, last_error, source_path) "
            "VALUES ('poison-key', '{}', '2026-04-01T00:00:00Z', 3, 'x', 'buffer')"
        )
        db.commit()
        db.close()

        def always_fail(buffer_db, dedupe_key, event_json, row_id=None):
            raise ValueError("simulated write failure")

        with patch.object(emit_queue, "BUFFER_PATH", buffer_path), \
             patch.object(emit_queue, "_write_event_to_buffer", always_fail):
            recovered = emit_queue.retry_buffer_dead_letters()
        assert recovered == 0

        db = emit_queue._get_db()
        row = db.execute(
            "SELECT dedupe_key FROM dead_letter WHERE dedupe_key = 'poison-key'"
        ).fetchone()
        db.close()
        assert row == ("poison-key",), (
            "failed retry must leave dead_letter row in place for next attempt"
        )

    def test_write_event_to_buffer_falls_back_to_event_id(self, isolated_queue):
        """When an event has no dedupe_key, _write_event_to_buffer must fall
        back to event_id (not the row-id-only drain tag) so two unkeyed
        rows with distinct event_ids don't collapse onto one dedupe."""
        buffer_path = isolated_queue / "buffer.db"
        _init_v2_buffer(buffer_path)
        import uuid as _uuid_mod
        bdb = sqlite3.connect(str(buffer_path))
        try:
            for i in range(2):
                event_json = json.dumps({
                    "type": "skill_invocation",
                    "timestamp": "2026-04-01T00:00:00Z",
                    "cli": "claude",
                    "source": "skill",
                    "payload": {},
                    "event_id": f"event-{i}",
                })
                emit_queue._write_event_to_buffer(bdb, None, event_json)
            bdb.commit()
            rows = bdb.execute(
                "SELECT dedupe_key FROM events ORDER BY dedupe_key"
            ).fetchall()
        finally:
            bdb.close()
        assert rows == [("event-0",), ("event-1",)], rows

    def test_retry_buffer_dead_letters_moves_only_buffer_rows_and_drains(
        self, isolated_queue
    ):
        """retry_buffer_dead_letters is the operator-triggered recovery path
        for intermittent buffer-sink failures. It must requeue buffer rows,
        drain them to the buffer immediately so drain() (HTTP) can't pick
        them up, and leave HTTP rows in dead_letter alone.
        """
        buffer_path = isolated_queue / "buffer.db"
        _init_v2_buffer(buffer_path)
        db = emit_queue._get_db()
        # Craft a valid event JSON so drain_to_buffer accepts it on replay.
        import uuid as _uuid
        event_json = json.dumps({
            "type": "skill_invocation",
            "timestamp": "2026-04-01T00:00:00Z",
            "cli": "claude",
            "source": "skill",
            "schema_version": 2,
            "payload": {"skill": "stark-team-review"},
            "dedupe_key": "buffer-key",
            "event_id": str(_uuid.uuid4()),
        })
        db.execute(
            "INSERT INTO dead_letter "
            "(dedupe_key, event_json, created_at, retries, last_error, source_path) "
            "VALUES ('buffer-key', ?, '2026-04-01T00:00:00Z', 3, 'disk i/o', 'buffer')",
            (event_json,),
        )
        db.execute(
            "INSERT INTO dead_letter "
            "(dedupe_key, event_json, created_at, retries, last_error, source_path) "
            "VALUES ('http-key', '{}', '2026-04-01T00:00:00Z', 3, 'network', 'http')"
        )
        db.commit()
        db.close()

        with patch.object(emit_queue, "BUFFER_PATH", buffer_path):
            moved = emit_queue.retry_buffer_dead_letters()
        assert moved == 1

        db = emit_queue._get_db()
        remaining_dead = db.execute(
            "SELECT dedupe_key, source_path FROM dead_letter"
        ).fetchall()
        pending = db.execute(
            "SELECT dedupe_key FROM pending"
        ).fetchall()
        db.close()
        # HTTP row untouched; buffer row was requeued AND drained so pending
        # must be empty — the HTTP path never sees it.
        assert remaining_dead == [("http-key", "http")]
        assert pending == []
        bdb = sqlite3.connect(str(buffer_path))
        events = bdb.execute(
            "SELECT dedupe_key FROM events WHERE dedupe_key = 'buffer-key'"
        ).fetchall()
        bdb.close()
        assert events == [("buffer-key",)]

    def test_migration_populates_source_path_for_legacy_rows(self, isolated_queue):
        """Pre-migration dead_letter rows must survive the ALTER TABLE and be
        retryable as HTTP — otherwise a schema upgrade would silently strand
        every dead letter already on disk."""
        queue_db_path = isolated_queue / "queue.db"
        # Create a pre-migration schema (no source_path column) bypassing
        # emit_queue._get_db so the migration hasn't run yet.
        legacy = sqlite3.connect(str(queue_db_path))
        legacy.executescript(
            """
            CREATE TABLE pending (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                dedupe_key TEXT UNIQUE, event_json TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
                retries INTEGER NOT NULL DEFAULT 0, last_error TEXT
            );
            CREATE TABLE dead_letter (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                dedupe_key TEXT, event_json TEXT NOT NULL,
                created_at TEXT NOT NULL,
                failed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
                retries INTEGER NOT NULL, last_error TEXT
            );
            """
        )
        legacy.execute(
            "INSERT INTO dead_letter (dedupe_key, event_json, created_at, retries) "
            "VALUES ('legacy-key', '{}', '2026-04-01T00:00:00Z', 3)"
        )
        legacy.commit()
        legacy.close()

        # Force re-init so _get_db's migration block runs against the legacy
        # table instead of the fresh schema the fixture would otherwise see.
        emit_queue._db_initialized.clear()

        db = emit_queue._get_db()
        row = db.execute(
            "SELECT dedupe_key, source_path FROM dead_letter"
        ).fetchone()
        db.close()
        assert row == ("legacy-key", "http")

        moved = emit_queue.retry_dead_letters()
        assert moved == 1
        assert emit_queue.pending_count() == 1


# ---------------------------------------------------------------------------
# make_event helper
# ---------------------------------------------------------------------------

class TestMakeEventDedupe:
    """ADR-0014 pins source-specific dedupe formulas; make_event's fallback
    must match them when the producer doesn't pass an explicit dedupe_key."""

    def test_skill_dedupe_uses_skill_session_start_timestamp(self):
        event = emit_queue.make_event(
            "skill_invocation",
            {"skill": "stark-team-review", "start_timestamp": 1700000000},
            session_id="sess-123",
            source="skill",
        )
        assert event["dedupe_key"] == "stark-team-review:sess-123:1700000000"

    def test_hook_dedupe_uses_cli_session_sequence(self):
        event = emit_queue.make_event(
            "tool_usage",
            {"sequence_number": 42},
            session_id="sess-1",
            source="hook",
            cli="codex",
        )
        assert event["dedupe_key"] == "codex:sess-1:42"

    def test_scraper_dedupe_uses_cli_file_offset(self):
        event = emit_queue.make_event(
            "ci_signal",
            {"file_path": "/var/log/ci.log", "byte_offset": 12345},
            session_id="sess-x",
            source="scraper",
            cli="gemini",
        )
        assert event["dedupe_key"] == "gemini:/var/log/ci.log:12345"

    def test_skill_dedupe_falls_back_when_payload_missing_skill(self):
        event = emit_queue.make_event(
            "skill_invocation",
            {},  # no `skill`
            session_id="s",
            source="skill",
        )
        assert event["dedupe_key"].startswith("skill_invocation:s:")


class TestMakeEvent:
    def test_defaults(self):
        event = emit_queue.make_event("skill_invocation", {"skill": "test"})
        assert event["type"] == "skill_invocation"
        assert event["cli"] == "claude"
        assert event["source"] == "skill"
        assert event["schema_version"] == 2
        assert event["payload"] == {"skill": "test"}
        assert "timestamp" in event
        assert "event_id" in event

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
        # session_id is always auto-resolved in v2; project and user_id are optional
        assert "session_id" in event
        assert "project" not in event
        assert "user_id" not in event


# ---------------------------------------------------------------------------
# Session cost from transcript
# ---------------------------------------------------------------------------

class TestTranscriptCost:
    def test_compute_cost_from_transcript(self, isolated_queue):
        transcript = isolated_queue / "test-transcript.jsonl"
        transcript.write_text(
            '{"type":"user","message":{"role":"user"}}\n'
            '{"type":"assistant","message":{"usage":{"input_tokens":1000,"output_tokens":200,"cache_read_input_tokens":50000,"cache_creation_input_tokens":5000}}}\n'
            '{"type":"user","message":{"role":"user"}}\n'
            '{"type":"assistant","message":{"usage":{"input_tokens":2000,"output_tokens":300,"cache_read_input_tokens":60000,"cache_creation_input_tokens":3000}}}\n'
        )
        result = emit_queue.compute_cost_from_transcript(str(transcript))
        assert result is not None
        inp, out, cost = result
        assert inp == 3000 + 110000 + 8000  # input + cache_read + cache_create
        assert out == 500
        assert cost > 0

    def test_missing_transcript(self):
        assert emit_queue.compute_cost_from_transcript("/nonexistent") is None

    def test_empty_transcript(self, isolated_queue):
        transcript = isolated_queue / "empty.jsonl"
        transcript.write_text("")
        assert emit_queue.compute_cost_from_transcript(str(transcript)) is None


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
            emit_queue.write_status_snapshot()
            content = (isolated_queue / "status").read_text()
            assert "inflight=1" in content
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
            [sys.executable, str(stark_emit), "skill_invocation", "skill=stark-team-review", "duration_s=42"],
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
        assert event["payload"]["skill"] == "stark-team-review"
        assert event["payload"]["duration_s"] == 42
        assert event["session_id"] == "test-session"


class TestDrainToBuffer:
    """drain_to_buffer writes events from queue.db to buffer.db."""

    def test_events_move_to_buffer(self, isolated_queue):
        buffer_path = isolated_queue / "buffer.db"
        with patch.object(emit_queue, "BUFFER_PATH", buffer_path):
            emit_queue.enqueue(_make_event())
            emit_queue.enqueue(_make_event(
                dedupe_key="second",
                payload={"skill": "stark-session", "duration_s": 30},
            ))
            assert emit_queue.pending_count() == 2

            stats = emit_queue.drain_to_buffer()
            assert stats["sent"] == 2
            assert stats["failed"] == 0
            assert emit_queue.pending_count() == 0

            # Verify events in buffer.db
            db = sqlite3.connect(str(buffer_path))
            rows = db.execute("SELECT type, payload_extra FROM events WHERE synced_at IS NULL").fetchall()
            db.close()
            assert len(rows) == 2
            assert all(r[0] == "skill_invocation" for r in rows)

    def test_empty_queue_noop(self, isolated_queue):
        buffer_path = isolated_queue / "buffer.db"
        with patch.object(emit_queue, "BUFFER_PATH", buffer_path):
            stats = emit_queue.drain_to_buffer()
            assert stats == {"sent": 0, "failed": 0, "dead_lettered": 0}

    def test_dedupe_on_second_drain(self, isolated_queue):
        buffer_path = isolated_queue / "buffer.db"
        with patch.object(emit_queue, "BUFFER_PATH", buffer_path):
            emit_queue.enqueue(_make_event(dedupe_key="same-key"))
            emit_queue.drain_to_buffer()

            # Re-enqueue same dedupe key — buffer UNIQUE constraint dedupes
            emit_queue.enqueue(_make_event(dedupe_key="same-key"))
            emit_queue.drain_to_buffer()

            db = sqlite3.connect(str(buffer_path))
            count = db.execute("SELECT COUNT(*) FROM events").fetchone()[0]
            db.close()
            assert count == 1


# ---------------------------------------------------------------------------
# v2 schema correctness — drain_to_buffer must write to the canonical
# stark-insights v2 events schema (lifted columns, dimension FKs).
# These tests catch the silent breakage class triggered by alembic 007.
# ---------------------------------------------------------------------------


# Minimal v2 events + dimension tables matching stark_insights/db/buffer.py.
# Drift detector test below asserts critical columns present.
V2_BUFFER_SCHEMA = """
CREATE TABLE users (
    id TEXT PRIMARY KEY,
    github_login TEXT NOT NULL UNIQUE,
    display_name TEXT,
    aliases TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL
);
CREATE TABLE projects (
    id TEXT PRIMARY KEY,
    path TEXT NOT NULL UNIQUE,
    repo TEXT,
    workspace_type TEXT NOT NULL,
    parent_project_id TEXT REFERENCES projects(id),
    first_seen_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL
);
CREATE TABLE events (
    id TEXT PRIMARY KEY,
    timestamp TEXT NOT NULL,
    dedupe_key TEXT NOT NULL UNIQUE,
    type TEXT NOT NULL,
    cli TEXT,
    source TEXT,
    schema_version INTEGER NOT NULL DEFAULT 2,
    session_id TEXT,
    user_id TEXT REFERENCES users(id),
    project_id TEXT REFERENCES projects(id),
    tool_name TEXT,
    prompt_text TEXT,
    prompt_length INTEGER,
    is_correction INTEGER,
    skill_name TEXT,
    duration_ms INTEGER,
    success INTEGER,
    error_text TEXT,
    pr_number INTEGER,
    repo TEXT,
    severity TEXT,
    agent_name TEXT,
    domain TEXT,
    action TEXT,
    passed INTEGER,
    score_value REAL,
    won INTEGER,
    payload_extra TEXT NOT NULL DEFAULT '{}',
    synced_at TEXT
);
"""


def _init_v2_buffer(buffer_path: Path) -> None:
    """Create a buffer.db with the canonical v2 stark-insights schema."""
    db = sqlite3.connect(str(buffer_path))
    db.executescript(V2_BUFFER_SCHEMA)
    db.commit()
    db.close()


class TestDrainToBufferV2:
    """drain_to_buffer must work against the canonical v2 schema."""

    def test_drain_succeeds_against_v2_schema(self, isolated_queue):
        """RED #1: drain INSERT must use v2 columns (payload_extra, project_id)."""
        buffer_path = isolated_queue / "buffer.db"
        _init_v2_buffer(buffer_path)
        with patch.object(emit_queue, "BUFFER_PATH", buffer_path):
            emit_queue.enqueue(_make_event(
                user_id="aryeh",
                project="/Users/test/git/Evinced/stark-skills",
            ))
            stats = emit_queue.drain_to_buffer()
            assert stats["sent"] == 1, f"expected sent=1, got {stats}"
            assert stats["failed"] == 0, f"expected failed=0, got {stats}"

            db = sqlite3.connect(str(buffer_path))
            db.row_factory = sqlite3.Row
            row = db.execute(
                "SELECT user_id, project_id, payload_extra, source FROM events"
            ).fetchone()
            db.close()
            assert row is not None
            assert row["payload_extra"] is not None
            assert row["source"] == "skill"

    def test_drain_resolves_user_id_to_deterministic_uuid(self, isolated_queue):
        """RED #2: same login must map to the same canonical UUID across drains
        (Cloud SQL events.user_id is uuid-typed; joins break if the function
        is swapped for uuid4())."""
        buffer_path = isolated_queue / "buffer.db"
        _init_v2_buffer(buffer_path)
        expected = str(emit_queue._deterministic_user_id("aryeh"))
        with patch.object(emit_queue, "BUFFER_PATH", buffer_path):
            emit_queue.enqueue(_make_event(user_id="aryeh", dedupe_key="u1"))
            emit_queue.drain_to_buffer()
            emit_queue.enqueue(_make_event(user_id="aryeh", dedupe_key="u2"))
            emit_queue.drain_to_buffer()

            db = sqlite3.connect(str(buffer_path))
            rows = db.execute("SELECT user_id FROM events ORDER BY dedupe_key").fetchall()
            db.close()
            assert len(rows) == 2, rows
            assert rows[0][0] == expected, rows[0][0]
            assert rows[1][0] == expected, rows[1][0]

    def test_drain_resolves_project_to_deterministic_uuid(self, isolated_queue):
        """RED #3: same project path must map to the same project_id across
        drains and must upsert into the projects dimension table."""
        buffer_path = isolated_queue / "buffer.db"
        _init_v2_buffer(buffer_path)
        path = "/Users/test/git/Evinced/some-repo"
        expected = str(emit_queue._deterministic_project_id(path))
        with patch.object(emit_queue, "BUFFER_PATH", buffer_path):
            emit_queue.enqueue(_make_event(project=path, dedupe_key="p1"))
            emit_queue.drain_to_buffer()
            emit_queue.enqueue(_make_event(project=path, dedupe_key="p2"))
            emit_queue.drain_to_buffer()

            db = sqlite3.connect(str(buffer_path))
            db.row_factory = sqlite3.Row
            ev_rows = db.execute(
                "SELECT project_id FROM events ORDER BY dedupe_key"
            ).fetchall()
            proj_rows = db.execute(
                "SELECT id, path, repo, workspace_type FROM projects"
            ).fetchall()
            db.close()
            assert [r["project_id"] for r in ev_rows] == [expected, expected]
            assert len(proj_rows) == 1, proj_rows
            assert proj_rows[0]["path"] == path
            assert proj_rows[0]["repo"] == "some-repo"
            assert proj_rows[0]["workspace_type"] == "main"

    def test_drain_resolves_org_repo_project_form(self, isolated_queue):
        """Producers like multi_review.py send project="ORG/REPO"; the repo
        dimension must still be populated for those rows."""
        buffer_path = isolated_queue / "buffer.db"
        _init_v2_buffer(buffer_path)
        with patch.object(emit_queue, "BUFFER_PATH", buffer_path):
            emit_queue.enqueue(_make_event(project="GetEvinced/stark-skills"))
            emit_queue.drain_to_buffer()

            db = sqlite3.connect(str(buffer_path))
            db.row_factory = sqlite3.Row
            proj_row = db.execute(
                "SELECT repo, workspace_type FROM projects WHERE path = ?",
                ("GetEvinced/stark-skills",),
            ).fetchone()
            db.close()
        assert proj_row is not None, "ORG/REPO path was not upserted"
        assert proj_row["repo"] == "stark-skills"
        assert proj_row["workspace_type"] == "main"

    def test_drain_resolves_worktree_project_with_parent(self, isolated_queue):
        """Worktree paths must be classified as workspace_type='worktree' and
        populate parent_project_id pointing at the main repo row."""
        buffer_path = isolated_queue / "buffer.db"
        _init_v2_buffer(buffer_path)
        parent = "/Users/test/git/Evinced/some-repo"
        worktree = f"{parent}/.worktrees/feat-xyz"
        expected_parent = str(emit_queue._deterministic_project_id(parent))
        with patch.object(emit_queue, "BUFFER_PATH", buffer_path):
            emit_queue.enqueue(_make_event(project=worktree))
            emit_queue.drain_to_buffer()

            db = sqlite3.connect(str(buffer_path))
            db.row_factory = sqlite3.Row
            wt_row = db.execute(
                "SELECT id, path, repo, workspace_type, parent_project_id "
                "FROM projects WHERE path = ?",
                (worktree,),
            ).fetchone()
            parent_row = db.execute(
                "SELECT id, path FROM projects WHERE path = ?",
                (parent,),
            ).fetchone()
            db.close()
            assert wt_row is not None, "worktree project was not upserted"
            assert wt_row["workspace_type"] == "worktree"
            assert wt_row["repo"] == "some-repo"
            assert wt_row["parent_project_id"] == expected_parent
            assert parent_row is not None and parent_row["id"] == expected_parent

    def test_drain_resolves_claude_worktree_marker(self, isolated_queue):
        """/.claude/worktrees/ paths must also be classified as worktrees and
        linked to the parent repo project."""
        buffer_path = isolated_queue / "buffer.db"
        _init_v2_buffer(buffer_path)
        parent = "/Users/test/git/Evinced/some-repo"
        worktree = f"{parent}/.claude/worktrees/feat-claude"
        expected_parent = str(emit_queue._deterministic_project_id(parent))
        with patch.object(emit_queue, "BUFFER_PATH", buffer_path):
            emit_queue.enqueue(_make_event(project=worktree))
            emit_queue.drain_to_buffer()

            db = sqlite3.connect(str(buffer_path))
            db.row_factory = sqlite3.Row
            wt_row = db.execute(
                "SELECT workspace_type, repo, parent_project_id FROM projects WHERE path = ?",
                (worktree,),
            ).fetchone()
            db.close()
        assert wt_row is not None
        assert wt_row["workspace_type"] == "worktree"
        assert wt_row["repo"] == "some-repo"
        assert wt_row["parent_project_id"] == expected_parent

    def test_drain_resolves_linux_checkout(self, isolated_queue):
        """Linux/CI checkouts (/home/*/git/<org>/<repo>, /workspace/<org>/<repo>)
        must still populate the repo dimension."""
        buffer_path = isolated_queue / "buffer.db"
        _init_v2_buffer(buffer_path)
        with patch.object(emit_queue, "BUFFER_PATH", buffer_path):
            emit_queue.enqueue(_make_event(project="/home/ci/git/Evinced/some-repo", dedupe_key="lnx"))
            emit_queue.enqueue(_make_event(project="/workspace/acme/payments", dedupe_key="ci"))
            emit_queue.drain_to_buffer()

            db = sqlite3.connect(str(buffer_path))
            db.row_factory = sqlite3.Row
            rows = db.execute(
                "SELECT path, repo, workspace_type FROM projects ORDER BY path"
            ).fetchall()
            db.close()
        paths = {r["path"]: (r["repo"], r["workspace_type"]) for r in rows}
        assert paths["/home/ci/git/Evinced/some-repo"] == ("some-repo", "main"), paths
        assert paths["/workspace/acme/payments"] == ("payments", "main"), paths

    def test_drain_quarantines_legacy_v1_buffer(self, isolated_queue):
        """RED: an existing v1 buffer.db must be moved aside so v2 writes
        don't fail forever on the legacy events(payload, project, ...) table."""
        buffer_path = isolated_queue / "buffer.db"
        # Create legacy v1 schema — mirrors what main branch shipped.
        legacy = sqlite3.connect(str(buffer_path))
        legacy.executescript(
            """
            CREATE TABLE events (
                id TEXT PRIMARY KEY,
                dedupe_key TEXT UNIQUE,
                session_id TEXT,
                normalized_session_id TEXT,
                type TEXT NOT NULL,
                timestamp TEXT NOT NULL,
                cli TEXT,
                user_id TEXT,
                project TEXT,
                payload TEXT NOT NULL,
                schema_version INTEGER DEFAULT 1,
                source TEXT,
                synced_at TEXT
            );
            """
        )
        legacy.execute(
            "INSERT INTO events (id, dedupe_key, type, timestamp, payload) "
            "VALUES ('legacy-1', 'legacy-1', 'skill_invocation', '2026-01-01T00:00:00Z', '{}')"
        )
        legacy.commit()
        legacy.close()

        with patch.object(emit_queue, "BUFFER_PATH", buffer_path):
            # Reset the initialization cache so the test sees a fresh open.
            emit_queue._buffer_db_initialized.pop(str(buffer_path), None)
            emit_queue.enqueue(_make_event(user_id="aryeh", dedupe_key="new-1"))
            stats = emit_queue.drain_to_buffer()

        # Both the freshly-enqueued event AND the replayed legacy row drain.
        assert stats["sent"] == 2, f"drain should replay legacy rows, got {stats}"
        # Legacy file preserved under a v1-* sibling; new buffer.db has v2 cols.
        siblings = list(buffer_path.parent.glob("buffer.v1-*.db"))
        assert siblings, "legacy buffer was not quarantined"
        new_db = sqlite3.connect(str(buffer_path))
        cols = {row[1] for row in new_db.execute("PRAGMA table_info(events)")}
        dedupe_keys = {
            row[0] for row in new_db.execute("SELECT dedupe_key FROM events")
        }
        new_db.close()
        assert {"project_id", "payload_extra"}.issubset(cols), (
            f"new buffer.db is missing v2 columns: {cols}"
        )
        assert {"new-1", "legacy-1"}.issubset(dedupe_keys), (
            f"expected both legacy and new rows in v2 buffer, got {dedupe_keys}"
        )

    def test_legacy_replay_preserves_dedupe_key_in_event_json(self, isolated_queue):
        """Replayed legacy rows must carry their dedupe_key inside the JSON
        payload too (not only in the pending column) so that if drain() hits
        them later the HTTP backend still dedupes correctly."""
        legacy_path = isolated_queue / "buffer.v1-legacy.db"
        legacy = sqlite3.connect(str(legacy_path))
        legacy.executescript(
            """
            CREATE TABLE events (
                id TEXT PRIMARY KEY,
                dedupe_key TEXT UNIQUE,
                session_id TEXT,
                normalized_session_id TEXT,
                type TEXT NOT NULL,
                timestamp TEXT NOT NULL,
                cli TEXT,
                user_id TEXT,
                project TEXT,
                payload TEXT NOT NULL,
                schema_version INTEGER DEFAULT 1,
                source TEXT,
                synced_at TEXT
            );
            """
        )
        legacy.execute(
            "INSERT INTO events (id, dedupe_key, type, timestamp, payload) "
            "VALUES ('x1', 'dedupe-key-xyz', 'skill_invocation', '2026-01-01T00:00:00Z', '{}')"
        )
        legacy.commit()
        legacy.close()

        replayed = emit_queue._replay_legacy_rows_into_queue(legacy_path)
        assert replayed == 1

        qdb = emit_queue._get_db()
        row = qdb.execute(
            "SELECT dedupe_key, event_json FROM pending WHERE dedupe_key = 'dedupe-key-xyz'"
        ).fetchone()
        qdb.close()
        assert row is not None
        event = json.loads(row[1])
        assert event.get("dedupe_key") == "dedupe-key-xyz", event

    def test_drain_dead_letters_poison_rows(self, isolated_queue):
        """Poison rows (malformed JSON) must move to dead_letter after MAX_RETRIES
        so they don't starve newer events in the ORDER BY created_at window."""
        buffer_path = isolated_queue / "buffer.db"
        _init_v2_buffer(buffer_path)
        with patch.object(emit_queue, "BUFFER_PATH", buffer_path):
            qdb = emit_queue._get_db()
            qdb.execute(
                "INSERT INTO pending (dedupe_key, event_json, created_at) "
                "VALUES (?, ?, ?)",
                ("poison", "{not-json", "2026-04-01T00:00:00Z"),
            )
            qdb.commit()
            qdb.close()

            for _ in range(emit_queue.MAX_RETRIES):
                emit_queue.drain_to_buffer()

            qdb = emit_queue._get_db()
            pending = qdb.execute("SELECT COUNT(*) FROM pending").fetchone()[0]
            dead = qdb.execute(
                "SELECT COUNT(*) FROM dead_letter WHERE dedupe_key = 'poison'"
            ).fetchone()[0]
            qdb.close()
        assert pending == 0, "poison row should be removed from pending"
        assert dead == 1, "poison row should be in dead_letter"

    def test_drain_does_not_lose_events_when_buffer_commit_fails(self, isolated_queue):
        """If buffer_db.commit() raises, queue rows must stay in pending
        (fixed by committing buffer before queue)."""
        buffer_path = isolated_queue / "buffer.db"
        _init_v2_buffer(buffer_path)

        class _PoisonedBufferConn:
            def __init__(self, inner):
                self._inner = inner

            def commit(self):
                raise sqlite3.OperationalError("disk full (simulated)")

            def close(self):
                return self._inner.close()

            def __getattr__(self, item):
                return getattr(self._inner, item)

        real_get_buffer_db = emit_queue._get_buffer_db

        def poisoned_get_buffer_db():
            return _PoisonedBufferConn(real_get_buffer_db())

        with patch.object(emit_queue, "BUFFER_PATH", buffer_path):
            emit_queue.enqueue(_make_event(dedupe_key="survive-me"))
            with patch.object(emit_queue, "_get_buffer_db", poisoned_get_buffer_db):
                try:
                    emit_queue.drain_to_buffer()
                except sqlite3.OperationalError:
                    pass

            qdb = emit_queue._get_db()
            pending = qdb.execute(
                "SELECT COUNT(*) FROM pending WHERE dedupe_key = 'survive-me'"
            ).fetchone()[0]
            qdb.close()
        assert pending == 1, "event must remain pending when buffer commit fails"

    def test_drain_logs_failures_instead_of_silently_swallowing(self, isolated_queue):
        """RED #4: when a row fails to insert, the error must be logged
        somewhere observable — not silently incrementing 'failed' counter.

        Forces a json.loads failure by writing malformed JSON directly into
        queue.db.pending — bypasses enqueue's validation.
        """
        buffer_path = isolated_queue / "buffer.db"
        _init_v2_buffer(buffer_path)
        log_path = isolated_queue / "drain-errors.log"

        with patch.object(emit_queue, "BUFFER_PATH", buffer_path):
            # Write malformed JSON directly into pending
            qdb = emit_queue._get_db()
            qdb.execute(
                "INSERT INTO pending (dedupe_key, event_json, created_at) "
                "VALUES (?, ?, ?)",
                ("bad-row", "{not valid json", "2026-04-17T00:00:00Z"),
            )
            qdb.commit()
            qdb.close()

            stats = emit_queue.drain_to_buffer()
            assert stats["failed"] >= 1, f"expected failed>=1, got {stats}"
            # The failure MUST be logged. Without this, schema drift goes
            # undetected for weeks (as happened with alembic 007).
            assert log_path.exists(), (
                f"drain-errors.log not created at {log_path} — silent swallow regressed"
            )


import sys


# ---------------------------------------------------------------------------
# New event types introduced in p1-1 (validation_result, heal_attempt)
# ---------------------------------------------------------------------------


class TestNewEventTypes:
    def _base(self, type_):
        return {
            "type": type_,
            "timestamp": "2026-04-03T10:00:00Z",
            "cli": "claude",
            "source": "skill",
            "schema_version": 1,
            "payload": {},
        }

    def test_validation_result_accepted(self):
        assert emit_queue.validate(self._base("validation_result")) == []

    def test_heal_attempt_accepted(self):
        assert emit_queue.validate(self._base("heal_attempt")) == []
