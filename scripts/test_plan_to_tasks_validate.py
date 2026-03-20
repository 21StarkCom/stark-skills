"""Tests for plan_to_tasks_validate.py — validation agent dispatch."""

import json
import subprocess
import sys
from pathlib import Path
from unittest.mock import patch

import pytest

SCRIPTS_DIR = Path(__file__).parent
SCRIPT = SCRIPTS_DIR / "plan_to_tasks_validate.py"


class TestCLISmoke:
    """Verify script is importable and CLI flags parse correctly."""

    def test_script_importable(self):
        """Script can be imported without error."""
        import plan_to_tasks_validate  # noqa: F401

    def test_help_flag(self):
        """--help exits cleanly with usage info."""
        result = subprocess.run(
            [sys.executable, str(SCRIPT), "--help"],
            capture_output=True, text=True,
        )
        assert result.returncode == 0
        assert "plan_file" in result.stdout or "usage" in result.stdout.lower()

    def test_missing_required_args(self):
        """Script fails with clear error when required args missing."""
        result = subprocess.run(
            [sys.executable, str(SCRIPT)],
            capture_output=True, text=True,
        )
        assert result.returncode != 0


from plan_to_tasks_validate import (
    build_validation_envelope,
    parse_validation_output,
    ValidationIssue,
    ValidationResult,
)


class TestEnvelope:
    def test_envelope_has_required_fields(self):
        envelope = build_validation_envelope(
            plan_content="# My Plan",
            breakdown={"schema_version": 1, "phases": []},
            plan_hash="sha256:abc",
        )
        assert envelope["schema_version"] == 1
        assert envelope["plan_markdown"] == "# My Plan"
        assert envelope["breakdown"]["schema_version"] == 1
        assert envelope["plan_hash"] == "sha256:abc"

    def test_envelope_is_valid_json(self):
        envelope = build_validation_envelope(
            plan_content="# Plan\n```json\n{}\n```",
            breakdown={"schema_version": 1, "phases": []},
            plan_hash="sha256:abc",
        )
        json.loads(json.dumps(envelope))


class TestOutputParsing:
    def test_parse_valid_approved(self):
        raw = json.dumps({"schema_version": 1, "approved": True, "issues": []})
        result = parse_validation_output(raw, agent="codex")
        assert result.approved is True
        assert result.issues == []

    def test_parse_valid_with_issues(self):
        raw = json.dumps({
            "schema_version": 1,
            "approved": False,
            "issues": [{"phase_id": "phase-1", "task_id": "task-1-1",
                        "field": "acceptance_criteria", "problem": "Missing validation",
                        "suggestion": "Add email check"}],
        })
        result = parse_validation_output(raw, agent="codex")
        assert result.approved is False
        assert len(result.issues) == 1
        assert result.issues[0].field == "acceptance_criteria"

    def test_parse_malformed_json(self):
        result = parse_validation_output("not json at all", agent="codex")
        assert result.error is not None
        assert result.approved is False

    def test_parse_codex_item_completed_agent_message(self):
        """Codex primary path: item.completed → item.type=agent_message → item.text."""
        validation_json = json.dumps(
            {"schema_version": 1, "approved": True, "issues": []}
        )
        events = [json.dumps({
            "type": "item.completed",
            "item": {
                "type": "agent_message",
                "text": validation_json,
            },
        })]
        raw = "\n".join(events)
        result = parse_validation_output(raw, agent="codex")
        assert result.approved is True

    def test_parse_codex_item_completed_message(self):
        """Codex secondary path: item.completed → item.type=message → content[].output_text."""
        validation_json = json.dumps(
            {"schema_version": 1, "approved": False, "issues": [
                {"phase_id": "p1", "task_id": "t1", "field": "how", "problem": "vague"}
            ]}
        )
        events = [json.dumps({
            "type": "item.completed",
            "item": {
                "type": "message",
                "content": [{"type": "output_text", "text": validation_json}],
            },
        })]
        raw = "\n".join(events)
        result = parse_validation_output(raw, agent="codex")
        assert result.approved is False
        assert len(result.issues) == 1

    def test_parse_gemini_envelope(self):
        """Gemini wraps output in {"response": "..."} envelope."""
        inner = json.dumps({"schema_version": 1, "approved": True, "issues": []})
        raw = json.dumps({"response": inner})
        result = parse_validation_output(raw, agent="gemini")
        assert result.approved is True

    def test_parse_gemini_with_issues(self):
        """Gemini envelope containing validation issues."""
        inner = json.dumps({
            "schema_version": 1,
            "approved": False,
            "issues": [{"phase_id": "p1", "task_id": "t1",
                        "field": "how", "problem": "Too vague",
                        "suggestion": "Add implementation details"}],
        })
        raw = json.dumps({"response": inner})
        result = parse_validation_output(raw, agent="gemini")
        assert result.approved is False
        assert len(result.issues) == 1
        assert result.issues[0].problem == "Too vague"

    def test_parse_gemini_raw_json_no_envelope(self):
        """Gemini sometimes returns raw JSON without the response envelope."""
        raw = json.dumps({"schema_version": 1, "approved": True, "issues": []})
        result = parse_validation_output(raw, agent="gemini")
        assert result.approved is True

    def test_parse_gemini_markdown_fenced(self):
        """Gemini response containing markdown-fenced JSON."""
        inner_json = json.dumps({"schema_version": 1, "approved": True, "issues": []})
        raw = json.dumps({"response": f"```json\n{inner_json}\n```"})
        result = parse_validation_output(raw, agent="gemini")
        assert result.approved is True
