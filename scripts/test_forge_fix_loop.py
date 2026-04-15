"""Tests for forge_fix_loop — fix-application dispatcher for review loops."""
from __future__ import annotations

import json
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from forge_fix_loop import (
    _PATCHES_BEGIN,
    _PATCHES_END,
    _apply_patches,
    _dispatch_fix_agent,
    apply_fixes,
    build_fix_prompt,
    extract_patches,
)


def _fake_response(text: str, *, stop_reason: str = "end_turn",
                   input_tokens: int = 100, output_tokens: int = 200) -> SimpleNamespace:
    """Build a fake Anthropic messages.create response shape."""
    return SimpleNamespace(
        content=[SimpleNamespace(type="text", text=text)],
        stop_reason=stop_reason,
        usage=SimpleNamespace(
            input_tokens=input_tokens, output_tokens=output_tokens,
        ),
    )


def _fake_client(response_or_exc: object) -> MagicMock:
    """Return a MagicMock client whose messages.create returns the given
    response (if a response) or raises the given exception."""
    client = MagicMock()
    if isinstance(response_or_exc, BaseException):
        client.messages.create.side_effect = response_or_exc
    else:
        client.messages.create.return_value = response_or_exc
    return client


# ── extract_patches ──────────────────────────────────────────────────────


class TestExtractPatches:
    def _wrap(self, body: str) -> str:
        return f"chatter\n{_PATCHES_BEGIN}\n{body}\n{_PATCHES_END}\nbye"

    def test_parses_valid_patch_array(self):
        body = json.dumps([
            {"finding_id": "abc", "old_string": "foo", "new_string": "bar"},
        ])
        result = extract_patches(self._wrap(body))
        assert result == [
            {
                "finding_id": "abc",
                "old_string": "foo",
                "new_string": "bar",
                "note": "",
            },
        ]

    def test_returns_none_when_begin_marker_missing(self):
        assert extract_patches(f"prose {_PATCHES_END} end") is None

    def test_returns_none_when_end_marker_missing(self):
        assert extract_patches(f"{_PATCHES_BEGIN} start") is None

    def test_returns_none_when_no_markers(self):
        assert extract_patches("just text") is None

    def test_returns_empty_list_when_body_is_empty_array(self):
        """Empty array is valid — the model explicitly chose to emit no
        patches (e.g. every finding was unresolvable as a targeted edit)."""
        result = extract_patches(self._wrap("[]"))
        assert result == []

    def test_returns_none_when_json_invalid(self):
        assert extract_patches(self._wrap("not json at all")) is None

    def test_returns_none_when_json_not_an_array(self):
        assert extract_patches(self._wrap('{"x": 1}')) is None

    def test_filters_entries_missing_required_fields(self):
        body = json.dumps([
            {"finding_id": "a", "old_string": "x", "new_string": "y"},
            {"finding_id": "b"},  # missing old_string and new_string
            {"finding_id": "c", "old_string": "m"},  # missing new_string
            {"old_string": "p", "new_string": "q"},  # missing finding_id is OK
        ])
        result = extract_patches(self._wrap(body))
        assert result is not None
        ids = [p["finding_id"] for p in result]
        assert "a" in ids
        assert "" in ids  # the one without finding_id was kept with empty id
        assert "b" not in ids
        assert "c" not in ids

    def test_preserves_note_field(self):
        body = json.dumps([
            {
                "finding_id": "a",
                "old_string": "x",
                "new_string": "y",
                "note": "fix api contract",
            },
        ])
        result = extract_patches(self._wrap(body))
        assert result is not None
        assert result[0]["note"] == "fix api contract"


# ── _apply_patches ───────────────────────────────────────────────────────


class TestApplyPatches:
    def test_unique_match_applies(self):
        text = "Hello world"
        patches = [{"old_string": "world", "new_string": "Forge"}]
        new, applied, unapplied = _apply_patches(text, patches)
        assert new == "Hello Forge"
        assert len(applied) == 1
        assert unapplied == []

    def test_ambiguous_match_rejected(self):
        """old_string that appears multiple times is rejected — the LLM did
        not include enough surrounding context to disambiguate."""
        text = "foo foo"
        patches = [{"old_string": "foo", "new_string": "bar"}]
        new, applied, unapplied = _apply_patches(text, patches)
        assert new == "foo foo"
        assert applied == []
        assert len(unapplied) == 1
        assert "ambiguous" in unapplied[0]["reason"].lower()

    def test_zero_match_rejected(self):
        """old_string that doesn't appear in the text is rejected — the LLM
        fabricated content or the patch is stale after an earlier edit."""
        text = "abc"
        patches = [{"old_string": "xyz", "new_string": "q"}]
        new, applied, unapplied = _apply_patches(text, patches)
        assert new == "abc"
        assert applied == []
        assert len(unapplied) == 1
        assert "not found" in unapplied[0]["reason"].lower()

    def test_patches_applied_sequentially(self):
        text = "one two three"
        patches = [
            {"old_string": "one", "new_string": "ONE"},
            {"old_string": "two", "new_string": "TWO"},
        ]
        new, applied, unapplied = _apply_patches(text, patches)
        assert new == "ONE TWO three"
        assert len(applied) == 2
        assert unapplied == []

    def test_later_patch_sees_earlier_edit(self):
        """The second patch operates on the already-patched text, so patches
        can build on each other."""
        text = "Hello World"
        patches = [
            {"old_string": "Hello", "new_string": "Hi"},
            {"old_string": "Hi World", "new_string": "Hi Forge"},
        ]
        new, applied, unapplied = _apply_patches(text, patches)
        assert new == "Hi Forge"
        assert len(applied) == 2
        assert unapplied == []

    def test_one_patch_unapplied_does_not_block_others(self):
        text = "keep\nold\ndrop"
        patches = [
            {"old_string": "old", "new_string": "new"},
            {"old_string": "missing", "new_string": "ignored"},
        ]
        new, applied, unapplied = _apply_patches(text, patches)
        assert "new" in new
        assert len(applied) == 1
        assert len(unapplied) == 1

    def test_empty_old_string_rejected(self):
        text = "abc"
        patches = [{"old_string": "", "new_string": "x"}]
        new, applied, unapplied = _apply_patches(text, patches)
        assert new == "abc"
        assert len(unapplied) == 1
        assert "empty" in unapplied[0]["reason"].lower()


# ── build_fix_prompt ─────────────────────────────────────────────────────


class TestBuildFixPrompt:
    def test_includes_artifact_kind_and_round(self):
        prompt = build_fix_prompt(
            artifact_kind="design spec",
            artifact_text="# Hi",
            findings=[],
            round_num=2,
        )
        assert "design spec" in prompt
        assert "round 2" in prompt

    def test_includes_patch_markers_in_instructions(self):
        prompt = build_fix_prompt(
            artifact_kind="implementation plan",
            artifact_text="# Plan",
            findings=[],
            round_num=1,
        )
        assert _PATCHES_BEGIN in prompt
        assert _PATCHES_END in prompt

    def test_mentions_unique_old_string_requirement(self):
        """The prompt must tell the LLM old_string must be unique / contain
        surrounding context — otherwise every patch becomes ambiguous."""
        prompt = build_fix_prompt(
            artifact_kind="design spec",
            artifact_text="# Spec",
            findings=[],
            round_num=1,
        )
        assert "unique" in prompt.lower() or "exact" in prompt.lower()

    def test_formats_findings_with_ids(self):
        prompt = build_fix_prompt(
            artifact_kind="design spec",
            artifact_text="# Spec",
            findings=[
                {
                    "id": "f1",
                    "section": "API",
                    "title": "Missing pagination",
                    "severity": "high",
                    "description": "Add cursor-based pagination",
                },
                {
                    "id": "f2",
                    "section": "Storage",
                    "title": "Schema undefined",
                    "severity": "medium",
                },
            ],
            round_num=1,
        )
        assert "f1" in prompt
        assert "f2" in prompt
        assert "API :: Missing pagination" in prompt
        assert "[high]" in prompt
        assert "Storage :: Schema undefined" in prompt
        assert "[medium]" in prompt

    def test_includes_artifact_text(self):
        prompt = build_fix_prompt(
            artifact_kind="design spec",
            artifact_text="# Original Document Body",
            findings=[],
            round_num=1,
        )
        assert "# Original Document Body" in prompt


# ── apply_fixes ──────────────────────────────────────────────────────────


class TestApplyFixes:
    def _make_patch_output(self, patches: list[dict]) -> str:
        return f"{_PATCHES_BEGIN}\n{json.dumps(patches)}\n{_PATCHES_END}"

    def test_empty_findings_returns_unchanged_no_dispatch(self, tmp_path):
        spec = tmp_path / "spec.md"
        spec.write_text("# Hello")
        with patch("forge_fix_loop._dispatch_fix_agent") as mock_dispatch:
            text, changed = apply_fixes(
                spec, [],
                artifact_kind="design spec",
                round_num=1,
                log_dir=tmp_path / "logs",
            )
        assert text == "# Hello"
        assert changed is False
        mock_dispatch.assert_not_called()
        assert spec.read_text() == "# Hello"

    def test_applies_unique_patch_writes_back(self, tmp_path):
        spec = tmp_path / "spec.md"
        spec.write_text("Before\nOld line content\nAfter")
        agent_output = self._make_patch_output([
            {
                "finding_id": "a",
                "old_string": "Old line content",
                "new_string": "New line content",
            },
        ])
        with patch("forge_fix_loop._dispatch_fix_agent", return_value=agent_output):
            text, changed = apply_fixes(
                spec,
                [{"id": "a", "section": "S", "title": "T", "severity": "high"}],
                artifact_kind="design spec",
                round_num=1,
                log_dir=tmp_path / "logs",
            )
        assert changed is True
        assert "New line content" in text
        assert spec.read_text() == text

    def test_empty_patch_array_returns_changed_false(self, tmp_path):
        """Model explicitly emitted [] — nothing to commit."""
        spec = tmp_path / "spec.md"
        spec.write_text("# Same")
        agent_output = self._make_patch_output([])
        with patch("forge_fix_loop._dispatch_fix_agent", return_value=agent_output):
            text, changed = apply_fixes(
                spec,
                [{"id": "a", "section": "S", "title": "T", "severity": "high"}],
                artifact_kind="design spec",
                round_num=1,
                log_dir=tmp_path / "logs",
            )
        assert changed is False
        assert spec.read_text() == "# Same"

    def test_all_patches_unapplied_returns_changed_false(self, tmp_path):
        spec = tmp_path / "spec.md"
        spec.write_text("Original")
        agent_output = self._make_patch_output([
            {"finding_id": "a", "old_string": "nonexistent", "new_string": "x"},
        ])
        with patch("forge_fix_loop._dispatch_fix_agent", return_value=agent_output):
            text, changed = apply_fixes(
                spec,
                [{"id": "a", "section": "S", "title": "T", "severity": "high"}],
                artifact_kind="design spec",
                round_num=1,
                log_dir=tmp_path / "logs",
            )
        assert changed is False
        assert text == "Original"
        assert spec.read_text() == "Original"

    def test_partial_apply_commits_and_logs_unapplied(self, tmp_path, capsys):
        spec = tmp_path / "spec.md"
        spec.write_text("Keep\nOld thing\nDrop")
        agent_output = self._make_patch_output([
            {"finding_id": "a", "old_string": "Old thing", "new_string": "New thing"},
            {"finding_id": "b", "old_string": "nonexistent", "new_string": "q"},
        ])
        with patch("forge_fix_loop._dispatch_fix_agent", return_value=agent_output):
            text, changed = apply_fixes(
                spec,
                [
                    {"id": "a", "section": "S", "title": "T", "severity": "high"},
                    {"id": "b", "section": "S", "title": "T", "severity": "high"},
                ],
                artifact_kind="design spec",
                round_num=1,
                log_dir=tmp_path / "logs",
            )
        assert changed is True
        assert "New thing" in text
        captured = capsys.readouterr()
        assert "unapplied" in captured.err.lower() or "did not apply" in captured.err.lower()

    def test_missing_markers_refuses_to_commit(self, tmp_path, capsys):
        spec = tmp_path / "spec.md"
        spec.write_text("# Original")
        agent_output = "Sure, here are my suggestions: edit foo to bar."
        with patch("forge_fix_loop._dispatch_fix_agent", return_value=agent_output):
            text, changed = apply_fixes(
                spec,
                [{"id": "a", "section": "S", "title": "T", "severity": "high"}],
                artifact_kind="design spec",
                round_num=1,
                log_dir=tmp_path / "logs",
            )
        assert changed is False
        assert text == "# Original"
        assert spec.read_text() == "# Original"
        captured = capsys.readouterr()
        err = captured.err.lower()
        assert "marker" in err or "unparseable" in err or "parse" in err

    def test_dispatch_failure_returns_unchanged(self, tmp_path):
        spec = tmp_path / "spec.md"
        spec.write_text("# Original")
        with patch("forge_fix_loop._dispatch_fix_agent", return_value=""):
            text, changed = apply_fixes(
                spec,
                [{"id": "a", "section": "S", "title": "T", "severity": "high"}],
                artifact_kind="design spec",
                round_num=1,
                log_dir=tmp_path / "logs",
            )
        assert changed is False
        assert text == "# Original"

    def test_passes_kind_round_and_finding_id_to_prompt(self, tmp_path):
        spec = tmp_path / "spec.md"
        spec.write_text("# Body")
        captured_prompts: list[str] = []

        def fake_dispatch(prompt, **_kw):
            captured_prompts.append(prompt)
            return self._make_patch_output([])

        with patch("forge_fix_loop._dispatch_fix_agent", side_effect=fake_dispatch):
            apply_fixes(
                spec,
                [{"id": "fid-123", "section": "X", "title": "Y", "severity": "low"}],
                artifact_kind="implementation plan",
                round_num=7,
                log_dir=tmp_path / "logs",
            )
        assert len(captured_prompts) == 1
        assert "implementation plan" in captured_prompts[0]
        assert "round 7" in captured_prompts[0]
        assert "fid-123" in captured_prompts[0]
        assert "X :: Y" in captured_prompts[0]


# ── _dispatch_fix_agent logging ──────────────────────────────────────────


class TestDispatchFixAgentLogging:
    """Every fix-dispatch API call writes a log entry with the full prompt,
    elapsed time, status, and response text (or error) so that timeouts and
    silent failures are diagnosable after the fact.

    The dispatcher uses the Anthropic SDK (``messages.create``) directly —
    tests mock ``_make_anthropic_client`` to inject a fake client whose
    ``messages.create`` returns a canned response or raises an exception."""

    def test_success_writes_log_with_prompt_and_response(self, tmp_path):
        response = _fake_response(f"{_PATCHES_BEGIN}\n[]\n{_PATCHES_END}")
        client = _fake_client(response)
        with patch("forge_fix_loop._make_anthropic_client", return_value=client):
            out = _dispatch_fix_agent(
                "the-prompt-body",
                timeout=60,
                log_dir=tmp_path,
                log_name="unit-success",
            )
        assert _PATCHES_BEGIN in out
        assert "[]" in out

        # messages.create was called with the prompt as the user message.
        client.messages.create.assert_called_once()
        call_kwargs = client.messages.create.call_args.kwargs
        assert call_kwargs["messages"] == [
            {"role": "user", "content": "the-prompt-body"},
        ]
        assert call_kwargs["timeout"] == 60

        log_path = tmp_path / "unit-success.txt"
        assert log_path.exists(), "log file must be written on success"
        body = log_path.read_text()
        assert "the-prompt-body" in body, "log must include the full prompt"
        assert "status: success" in body
        assert "end_turn" in body, "log includes stop_reason"
        assert "elapsed_s:" in body
        assert _PATCHES_BEGIN in body, "log must include response text"
        assert "input_tokens=" in body and "output_tokens=" in body

    def test_sdk_error_writes_log_with_exception(self, tmp_path):
        class FakeTimeout(Exception):
            pass

        client = _fake_client(FakeTimeout("call took too long"))
        with patch("forge_fix_loop._make_anthropic_client", return_value=client):
            out = _dispatch_fix_agent(
                "prompt-pre-error",
                timeout=60,
                log_dir=tmp_path,
                log_name="unit-error",
            )
        assert out == ""

        log_path = tmp_path / "unit-error.txt"
        assert log_path.exists()
        body = log_path.read_text()
        assert "prompt-pre-error" in body
        assert "sdk_error:FakeTimeout" in body
        assert "call took too long" in body
        assert "timeout_s: 60" in body

    def test_no_client_returns_empty_and_logs_status(self, tmp_path):
        with patch("forge_fix_loop._make_anthropic_client", return_value=None):
            out = _dispatch_fix_agent(
                "p",
                timeout=60,
                log_dir=tmp_path,
                log_name="unit-noclient",
            )
        assert out == ""
        body = (tmp_path / "unit-noclient.txt").read_text()
        assert "status: no_client" in body

    def test_no_log_when_log_dir_is_none(self, tmp_path):
        response = _fake_response(f"{_PATCHES_BEGIN}\n[]\n{_PATCHES_END}")
        client = _fake_client(response)
        with patch("forge_fix_loop._make_anthropic_client", return_value=client):
            _dispatch_fix_agent("p", timeout=60)
        assert list(tmp_path.iterdir()) == []

    def test_passes_fix_model_env_to_messages_create(self, tmp_path, monkeypatch):
        """FORGE_FIX_MODEL env var overrides the default model."""
        monkeypatch.setenv("FORGE_FIX_MODEL", "claude-sonnet-4-6")
        response = _fake_response(f"{_PATCHES_BEGIN}\n[]\n{_PATCHES_END}")
        client = _fake_client(response)
        with patch("forge_fix_loop._make_anthropic_client", return_value=client):
            _dispatch_fix_agent("p", timeout=60)
        call_kwargs = client.messages.create.call_args.kwargs
        assert call_kwargs["model"] == "claude-sonnet-4-6"

    def test_default_model_is_opus(self, tmp_path, monkeypatch):
        monkeypatch.delenv("FORGE_FIX_MODEL", raising=False)
        response = _fake_response(f"{_PATCHES_BEGIN}\n[]\n{_PATCHES_END}")
        client = _fake_client(response)
        with patch("forge_fix_loop._make_anthropic_client", return_value=client):
            _dispatch_fix_agent("p", timeout=60)
        call_kwargs = client.messages.create.call_args.kwargs
        assert call_kwargs["model"] == "claude-opus-4-6"

    def test_apply_fixes_passes_log_context_through(self, tmp_path):
        """apply_fixes should derive a default log_dir + log_name from
        artifact_kind + round_num and forward them to the dispatcher."""
        spec = tmp_path / "spec.md"
        spec.write_text("# Original")

        received: dict = {}

        def fake_dispatch(prompt, **kwargs):
            received.update(kwargs)
            return f"{_PATCHES_BEGIN}\n[]\n{_PATCHES_END}"

        with patch("forge_fix_loop._dispatch_fix_agent", side_effect=fake_dispatch):
            apply_fixes(
                spec,
                [{"id": "a", "section": "S", "title": "T", "severity": "high"}],
                artifact_kind="design spec",
                round_num=3,
                log_dir=tmp_path / "logs",
            )

        assert received.get("log_dir") == tmp_path / "logs"
        log_name = received.get("log_name") or ""
        assert "design_spec" in log_name or "design-spec" in log_name
        assert "round3" in log_name


# ── _make_anthropic_client ───────────────────────────────────────────────


class TestMakeAnthropicClient:
    """Client factory resolution rules:

    1. ``is_agent_enabled("claude") == False`` → ``None`` (short-circuit).
    2. ``CLAUDE_CODE_USE_VERTEX=1`` + project id in Vertex env → ``AnthropicVertex``.
    3. ``ANTHROPIC_API_KEY`` in ``os.environ`` (real process env, not the
       sanitized Vertex env) → direct ``Anthropic``.
    4. Otherwise → ``None``.

    Vertex config comes from ``_read_vertex_env`` (which delegates to
    ``claude_utils.make_clean_env`` in production) because Vertex vars are
    injected by ``runtime_env``. The API key must be read from
    ``os.environ`` directly because ``make_clean_env`` intentionally strips
    it."""

    def test_returns_none_when_no_auth(self):
        from forge_fix_loop import _make_anthropic_client
        with patch("forge_fix_loop._read_vertex_env", return_value={}), \
             patch.dict("os.environ", {}, clear=True):
            assert _make_anthropic_client() is None

    def test_returns_none_when_vertex_flag_but_no_project(self):
        from forge_fix_loop import _make_anthropic_client
        with patch(
            "forge_fix_loop._read_vertex_env",
            return_value={"CLAUDE_CODE_USE_VERTEX": "1"},
        ), patch.dict("os.environ", {}, clear=True):
            assert _make_anthropic_client() is None

    def test_returns_vertex_client_when_vertex_env_present(self):
        from anthropic import AnthropicVertex
        from forge_fix_loop import _make_anthropic_client
        with patch(
            "forge_fix_loop._read_vertex_env",
            return_value={
                "CLAUDE_CODE_USE_VERTEX": "1",
                "ANTHROPIC_VERTEX_PROJECT_ID": "proj",
                "CLOUD_ML_REGION": "global",
            },
        ), patch.dict("os.environ", {}, clear=True):
            client = _make_anthropic_client()
        assert client is not None
        assert isinstance(client, AnthropicVertex)

    def test_returns_direct_client_when_api_key_set_and_no_vertex(self):
        from anthropic import Anthropic
        from forge_fix_loop import _make_anthropic_client
        with patch("forge_fix_loop._read_vertex_env", return_value={}), \
             patch.dict("os.environ", {"ANTHROPIC_API_KEY": "sk-test"}, clear=True):
            client = _make_anthropic_client()
        assert client is not None
        assert isinstance(client, Anthropic)

    def test_vertex_wins_over_api_key_when_both_present(self):
        from anthropic import AnthropicVertex
        from forge_fix_loop import _make_anthropic_client
        with patch(
            "forge_fix_loop._read_vertex_env",
            return_value={
                "CLAUDE_CODE_USE_VERTEX": "1",
                "ANTHROPIC_VERTEX_PROJECT_ID": "proj",
                "CLOUD_ML_REGION": "global",
            },
        ), patch.dict("os.environ", {"ANTHROPIC_API_KEY": "sk-test"}, clear=True):
            client = _make_anthropic_client()
        assert isinstance(client, AnthropicVertex)

    def test_returns_none_when_claude_agent_disabled(self):
        from forge_fix_loop import _make_anthropic_client
        with patch("forge_fix_loop._read_vertex_env", return_value={
            "CLAUDE_CODE_USE_VERTEX": "1",
            "ANTHROPIC_VERTEX_PROJECT_ID": "proj",
        }), patch.dict("os.environ", {"ANTHROPIC_API_KEY": "sk-test"}, clear=True), \
             patch("config_loader.is_agent_enabled", return_value=False):
            assert _make_anthropic_client() is None


class TestResolveFixModel:
    """Model resolution: ``FORGE_FIX_MODEL`` env > ``get_model_id("claude")``
    from config > ``_FIX_MODEL_DEFAULT``."""

    def test_env_override_wins(self):
        from forge_fix_loop import _resolve_fix_model
        with patch.dict("os.environ", {"FORGE_FIX_MODEL": "env-model"}, clear=True), \
             patch("config_loader.get_model_id", return_value="cfg-model"):
            assert _resolve_fix_model() == "env-model"

    def test_config_model_used_when_no_env_override(self):
        from forge_fix_loop import _resolve_fix_model
        with patch.dict("os.environ", {}, clear=True), \
             patch("config_loader.get_model_id", return_value="cfg-model"):
            assert _resolve_fix_model() == "cfg-model"

    def test_falls_back_to_default(self):
        from forge_fix_loop import _FIX_MODEL_DEFAULT, _resolve_fix_model
        with patch.dict("os.environ", {}, clear=True), \
             patch("config_loader.get_model_id", return_value=None):
            assert _resolve_fix_model() == _FIX_MODEL_DEFAULT
