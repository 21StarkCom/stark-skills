"""Tests for forge_fix_loop — fix-application dispatcher for review loops."""
from __future__ import annotations

from unittest.mock import patch

from forge_fix_loop import (
    _DOC_BEGIN,
    _DOC_END,
    apply_fixes,
    build_fix_prompt,
    extract_updated_document,
)


# ── extract_updated_document ─────────────────────────────────────────────


class TestExtractUpdatedDocument:
    def test_extracts_body_between_markers(self):
        raw = f"prose\n{_DOC_BEGIN}\n# New\nBody\n{_DOC_END}\nmore prose"
        assert extract_updated_document(raw) == "# New\nBody"

    def test_returns_none_when_begin_marker_missing(self):
        assert extract_updated_document(f"hi {_DOC_END}") is None

    def test_returns_none_when_end_marker_missing(self):
        assert extract_updated_document(f"hi {_DOC_BEGIN} hello") is None

    def test_returns_none_when_body_empty(self):
        raw = f"{_DOC_BEGIN}\n\n{_DOC_END}"
        assert extract_updated_document(raw) is None

    def test_returns_none_when_no_markers_at_all(self):
        assert extract_updated_document("just some text") is None

    def test_strips_only_outer_newlines(self):
        raw = f"{_DOC_BEGIN}\n  indented\n  body\n{_DOC_END}"
        assert extract_updated_document(raw) == "  indented\n  body"


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

    def test_includes_markers_in_instructions(self):
        prompt = build_fix_prompt(
            artifact_kind="implementation plan",
            artifact_text="# Plan",
            findings=[],
            round_num=1,
        )
        assert _DOC_BEGIN in prompt
        assert _DOC_END in prompt

    def test_formats_findings(self):
        prompt = build_fix_prompt(
            artifact_kind="design spec",
            artifact_text="# Spec",
            findings=[
                {
                    "section": "API",
                    "title": "Missing pagination",
                    "severity": "high",
                    "description": "Add cursor-based pagination",
                },
                {
                    "section": "Storage",
                    "title": "Schema undefined",
                    "severity": "medium",
                },
            ],
            round_num=1,
        )
        assert "API :: Missing pagination" in prompt
        assert "[high]" in prompt
        assert "Storage :: Schema undefined" in prompt
        assert "[medium]" in prompt

    def test_findings_block_says_none_when_empty(self):
        prompt = build_fix_prompt(
            artifact_kind="design spec",
            artifact_text="# Spec",
            findings=[],
            round_num=1,
        )
        assert "(none)" in prompt

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
    def test_empty_findings_returns_unchanged_no_dispatch(self, tmp_path):
        spec = tmp_path / "spec.md"
        spec.write_text("# Hello")
        with patch("forge_fix_loop._dispatch_fix_agent") as mock_dispatch:
            text, changed = apply_fixes(
                spec, [], artifact_kind="design spec", round_num=1,
            )
        assert text == "# Hello"
        assert changed is False
        mock_dispatch.assert_not_called()
        # File untouched
        assert spec.read_text() == "# Hello"

    def test_successful_rewrite_writes_back(self, tmp_path):
        spec = tmp_path / "spec.md"
        spec.write_text("# Old")
        new_body = "# New\nFixed."
        agent_output = f"chatter\n{_DOC_BEGIN}\n{new_body}\n{_DOC_END}\nbye"
        with patch("forge_fix_loop._dispatch_fix_agent", return_value=agent_output):
            text, changed = apply_fixes(
                spec,
                [{"section": "A", "title": "B", "severity": "high"}],
                artifact_kind="design spec",
                round_num=1,
            )
        assert changed is True
        assert text == new_body
        assert spec.read_text() == new_body

    def test_no_op_rewrite_returns_changed_false(self, tmp_path):
        spec = tmp_path / "spec.md"
        spec.write_text("# Same")
        agent_output = f"{_DOC_BEGIN}\n# Same\n{_DOC_END}"
        with patch("forge_fix_loop._dispatch_fix_agent", return_value=agent_output):
            text, changed = apply_fixes(
                spec,
                [{"section": "A", "title": "B", "severity": "high"}],
                artifact_kind="design spec",
                round_num=1,
            )
        assert changed is False
        assert text == "# Same"
        assert spec.read_text() == "# Same"

    def test_missing_markers_refuses_to_commit(self, tmp_path, capsys):
        spec = tmp_path / "spec.md"
        spec.write_text("# Original")
        agent_output = "Sure, here's the updated spec:\n# Updated\nDone."
        with patch("forge_fix_loop._dispatch_fix_agent", return_value=agent_output):
            text, changed = apply_fixes(
                spec,
                [{"section": "A", "title": "B", "severity": "high"}],
                artifact_kind="design spec",
                round_num=1,
            )
        assert changed is False
        assert text == "# Original"
        assert spec.read_text() == "# Original"
        captured = capsys.readouterr()
        assert "markers missing" in captured.err.lower()

    def test_dispatch_failure_returns_unchanged(self, tmp_path):
        spec = tmp_path / "spec.md"
        spec.write_text("# Original")
        with patch("forge_fix_loop._dispatch_fix_agent", return_value=""):
            text, changed = apply_fixes(
                spec,
                [{"section": "A", "title": "B", "severity": "high"}],
                artifact_kind="design spec",
                round_num=1,
            )
        assert changed is False
        assert text == "# Original"
        assert spec.read_text() == "# Original"

    def test_passes_kind_and_round_through_to_prompt(self, tmp_path):
        spec = tmp_path / "spec.md"
        spec.write_text("# Body")
        captured_prompts: list[str] = []

        def fake_dispatch(prompt, *, timeout):
            captured_prompts.append(prompt)
            return f"{_DOC_BEGIN}\n# Edited\n{_DOC_END}"

        with patch("forge_fix_loop._dispatch_fix_agent", side_effect=fake_dispatch):
            apply_fixes(
                spec,
                [{"section": "X", "title": "Y", "severity": "low"}],
                artifact_kind="implementation plan",
                round_num=7,
            )
        assert len(captured_prompts) == 1
        assert "implementation plan" in captured_prompts[0]
        assert "round 7" in captured_prompts[0]
        assert "X :: Y" in captured_prompts[0]
