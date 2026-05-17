"""Tests for emit_queue.py — durable SQLite event queue (producer side)."""

import sqlite3
from unittest.mock import patch

import pytest

import emit_queue


@pytest.fixture(autouse=True)
def isolated_queue(tmp_path):
    """Each test gets its own queue directory."""
    with patch.object(emit_queue, "QUEUE_DIR", tmp_path), \
         patch.object(emit_queue, "QUEUE_DB", tmp_path / "queue.db"):
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

    def test_red_team_event_type_names_are_accepted(self):
        for event_type in (
            "red_team_run",
            "red_team_finding",
            "red_team_fix_plan",
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
        the missing-field check and reach the drain side; v2 declares those
        columns NOT NULL and the backend would reject the row late."""
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

    def test_event_persists_across_connections(self):
        emit_queue.enqueue(_make_event(dedupe_key="persist"))
        # New connection via pending_count
        assert emit_queue.pending_count() == 1

    def test_dead_letter_count_starts_at_zero(self):
        """dead_letter is written by stark-insights' drain; for a fresh
        producer-side DB it stays empty. /stark-session reads this."""
        assert emit_queue.dead_letter_count() == 0

    def test_redact_applied_to_event_json(self, isolated_queue):
        """Secrets in payload must be redacted before persistence."""
        event = _make_event(
            dedupe_key="redact-test",
            payload={"skill": "x", "token": "sk-1234567890abcdef"},
        )
        emit_queue.enqueue(event)
        db = sqlite3.connect(str(isolated_queue / "queue.db"))
        row = db.execute("SELECT event_json FROM pending WHERE dedupe_key = 'redact-test'").fetchone()
        db.close()
        assert "sk-1234567890abcdef" not in row[0]
        assert "sk-[REDACTED]" in row[0]


# ---------------------------------------------------------------------------
# make_event dedupe-key formulas (ADR-0014)
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


# ---------------------------------------------------------------------------
# make_event basic envelope
# ---------------------------------------------------------------------------

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
            assert trend == "▲"  # ▲

    def test_moderate_growth_returns_triangle(self, isolated_queue):
        with patch.object(emit_queue, "CTX_HISTORY_PATH", isolated_queue / "ctx-history"):
            emit_queue.record_context_pct(50.0)
            trend = emit_queue.record_context_pct(52.0)  # +2pp delta
            assert trend == "▸"  # ▸

    def test_stable_returns_empty(self, isolated_queue):
        with patch.object(emit_queue, "CTX_HISTORY_PATH", isolated_queue / "ctx-history"):
            emit_queue.record_context_pct(50.0)
            trend = emit_queue.record_context_pct(50.5)  # barely moved
            assert trend == ""


# ---------------------------------------------------------------------------
# Health CLI
# ---------------------------------------------------------------------------

class TestHealth:
    def test_health_empty_queue(self):
        h = emit_queue._health()
        assert h["pending_count"] == 0
        assert h["max_created_at"] is None

    def test_health_with_rows(self):
        emit_queue.enqueue(_make_event(dedupe_key="h1"))
        emit_queue.enqueue(_make_event(dedupe_key="h2"))
        h = emit_queue._health()
        assert h["pending_count"] == 2
        assert h["max_created_at"] is not None


# ---------------------------------------------------------------------------
# New event types (validation_result, heal_attempt)
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
