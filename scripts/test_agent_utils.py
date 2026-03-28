"""Tests for claude_utils, codex_utils, and gemini_utils."""

from __future__ import annotations

import json
import os
import shutil
from unittest.mock import patch

import pytest

from claude_utils import CLAUDE_MODEL, build_claude_cmd
from codex_utils import (
    CODEX_MODEL, CODEX_REASONING_EFFORT_HIGH, CODEX_REASONING_EFFORT_MEDIUM,
    parse_jsonl_output,
)
from gemini_utils import (
    GEMINI_MODEL, GEMINI_AUTH_ERROR_PATTERNS,
    should_fallback_to_api_key, try_gemini_api_key_fallback,
    setup_gemini_home, gemini_session, make_gemini_env,
    parse_json_output,
)


class TestBuildClaudeCmd:
    def test_default(self):
        cmd = build_claude_cmd()
        assert cmd[0] == "claude"
        assert "-p" in cmd and "-" in cmd
        assert "--model" in cmd and CLAUDE_MODEL in cmd
        assert "--no-session-persistence" in cmd
        assert "--allowedTools" not in cmd

    def test_json_output(self):
        cmd = build_claude_cmd(output_format="json")
        assert cmd[cmd.index("--output-format") + 1] == "json"

    def test_allowed_tools(self):
        cmd = build_claude_cmd(allowed_tools="Edit,Read,Bash")
        assert cmd[cmd.index("--allowedTools") + 1] == "Edit,Read,Bash"


class TestCodexConstants:
    def test_model_is_string(self):
        assert isinstance(CODEX_MODEL, str) and CODEX_MODEL

    def test_reasoning_efforts_are_toml(self):
        assert '"high"' in CODEX_REASONING_EFFORT_HIGH
        assert '"medium"' in CODEX_REASONING_EFFORT_MEDIUM


class TestParseJsonlOutput:
    def test_non_jsonl_passthrough(self):
        assert parse_jsonl_output("hello world") == "hello world"
        assert parse_jsonl_output("") == ""

    def test_agent_message_format(self):
        events = "\n".join([
            json.dumps({"type": "thread.started", "thread_id": "abc"}),
            json.dumps({"type": "item.completed", "item": {"type": "agent_message", "text": "hello"}}),
            json.dumps({"type": "turn.completed", "usage": {}}),
        ])
        assert parse_jsonl_output(events) == "hello"

    def test_legacy_message_format(self):
        event = json.dumps({
            "type": "item.completed",
            "item": {"type": "message", "content": [{"type": "output_text", "text": "legacy"}]},
        })
        assert parse_jsonl_output(event) == "legacy"

    def test_multiple_messages(self):
        events = "\n".join([
            json.dumps({"type": "item.completed", "item": {"type": "agent_message", "text": "p1"}}),
            json.dumps({"type": "item.completed", "item": {"type": "agent_message", "text": "p2"}}),
        ])
        assert parse_jsonl_output(events) == "p1\np2"

    def test_ignores_non_text_items(self):
        events = "\n".join([
            json.dumps({"type": "turn.started"}),
            json.dumps({"type": "item.completed", "item": {"type": "agent_message", "text": "ok"}}),
            json.dumps({"type": "item.completed", "item": {"type": "command_execution", "command": "ls"}}),
        ])
        assert parse_jsonl_output(events) == "ok"


class TestShouldFallbackToApiKey:
    def test_matches_known_errors(self):
        assert should_fallback_to_api_key("Error 403: Forbidden")
        assert should_fallback_to_api_key("PERMISSION_DENIED: access denied")
        assert should_fallback_to_api_key("ModelNotFound: gemini-pro")

    def test_no_match(self):
        assert not should_fallback_to_api_key("Connection timeout")
        assert not should_fallback_to_api_key("")


class TestTryGeminiFallback:
    @patch("gemini_utils.get_gemini_api_key", return_value="test-key")
    @patch("gemini_utils.log_api_key_fallback")
    def test_injects_api_key(self, mock_log, mock_key):
        kw = {"env": {"GEMINI_CLI_HOME": "/tmp/test"}}
        assert try_gemini_api_key_fallback(kw, "task", "403") is True
        assert kw["env"]["GEMINI_API_KEY"] == "test-key"
        mock_log.assert_called_once()

    @patch("gemini_utils.get_gemini_api_key", return_value=None)
    def test_no_key_returns_false(self, mock_key):
        kw = {"env": {}}
        assert try_gemini_api_key_fallback(kw, "task", "403") is False

    @patch("gemini_utils.get_gemini_api_key", return_value="key")
    def test_no_env_returns_false(self, mock_key):
        assert try_gemini_api_key_fallback({}, "task", "403") is False


class TestParseJsonOutput:
    def test_single_envelope(self):
        assert parse_json_output(json.dumps({"response": "hi"})) == "hi"

    def test_array_of_envelopes(self):
        raw = json.dumps([{"response": "a"}, {"response": "b"}])
        assert parse_json_output(raw) == "a\nb"

    def test_passthrough(self):
        assert parse_json_output("text") == "text"
        assert parse_json_output("") == ""

    def test_no_response_key(self):
        raw = json.dumps({"error": "x"})
        assert parse_json_output(raw) == raw


class TestSetupGeminiHome:
    def test_creates_structure(self):
        home = setup_gemini_home("test-", "/tmp/proj", "t")
        try:
            assert os.path.isdir(os.path.join(home, ".gemini"))
            with open(os.path.join(home, ".gemini", "projects.json")) as f:
                assert json.load(f)["projects"]["/tmp/proj"] == "t"
        finally:
            shutil.rmtree(home, ignore_errors=True)

    def test_approval_mode(self):
        home = setup_gemini_home("test-", "/tmp/proj", "t", approval_mode="plan")
        try:
            with open(os.path.join(home, ".gemini", "settings.json")) as f:
                assert json.load(f)["defaultApprovalMode"] == "plan"
        finally:
            shutil.rmtree(home, ignore_errors=True)


class TestGeminiSession:
    def test_creates_and_cleans_up(self):
        with gemini_session("test-", "/tmp/proj", "t") as home:
            assert os.path.isdir(home)
        assert not os.path.isdir(home)

    def test_cleanup_on_exception(self):
        h = None
        with pytest.raises(ValueError):
            with gemini_session("test-", "/tmp/proj", "t") as home:
                h = home
                raise ValueError("boom")
        assert not os.path.isdir(h)


class TestMakeGeminiEnv:
    def test_keys(self):
        env = make_gemini_env("/tmp/h")
        assert env["GEMINI_CLI_HOME"] == "/tmp/h"
        assert env["GOOGLE_CLOUD_LOCATION"] == "global"
        assert "PATH" in env
