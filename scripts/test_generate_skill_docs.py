"""Tests for SKILL.md parser."""
import json
import random
import shutil
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from generate_skill_docs import (
    parse_skill_md, SkillData, discover_skills,
    validate_html, sanitize_html, build_generation_prompt, VizResult,
    screenshot_html, build_evaluation_prompt, parse_evaluation_scores,
    compute_weighted_average, select_winner, FACTOR_WEIGHTS,
)

FIXTURE = Path(__file__).parent.parent / "skill" / "stark-session" / "SKILL.md"


def test_parse_extracts_name():
    data = parse_skill_md(FIXTURE)
    assert data.name == "stark-session"


def test_parse_extracts_description():
    data = parse_skill_md(FIXTURE)
    assert "session" in data.description.lower()


def test_parse_extracts_argument_hint():
    data = parse_skill_md(FIXTURE)
    assert "start" in data.argument_hint or "end" in data.argument_hint


def test_parse_complexity_simple():
    fixture = Path(__file__).parent.parent / "skill" / "stark-metrics" / "SKILL.md"
    data = parse_skill_md(fixture)
    assert data.complexity == "simple"
    assert data.line_count < 100


def test_parse_complexity_complex():
    fixture = Path(__file__).parent.parent / "skill" / "stark-phase-execute" / "SKILL.md"
    data = parse_skill_md(fixture)
    assert data.complexity == "complex"
    assert data.line_count > 400


def test_parse_includes_raw_md():
    data = parse_skill_md(FIXTURE)
    assert "## Start Mode" in data.raw_md
    assert len(data.raw_md) > 100


def test_parse_to_json_roundtrip():
    data = parse_skill_md(FIXTURE)
    j = data.to_json()
    parsed = json.loads(j)
    assert parsed["name"] == "stark-session"
    assert "raw_md" in parsed


def test_parse_handles_missing_frontmatter():
    """If frontmatter is missing, use directory name as fallback."""
    import tempfile
    with tempfile.NamedTemporaryFile(suffix=".md", mode="w", delete=False) as f:
        f.write("# No frontmatter\nJust content.")
        f.flush()
        data = parse_skill_md(Path(f.name))
        assert data.name  # should not crash
        assert data.raw_md == "# No frontmatter\nJust content."


def test_discover_skills_all():
    skill_dir = Path(__file__).parent.parent / "skill"
    skills = discover_skills(skill_dir)
    assert all((s / "SKILL.md").exists() for s in skills)
    assert len(skills) >= 19


def test_discover_skills_filter():
    skill_dir = Path(__file__).parent.parent / "skill"
    skills = discover_skills(skill_dir, filter_name="stark-session")
    assert len(skills) == 1
    assert skills[0].name == "stark-session"


def test_discover_skills_filter_nonexistent():
    skill_dir = Path(__file__).parent.parent / "skill"
    skills = discover_skills(skill_dir, filter_name="nonexistent")
    assert len(skills) == 0


# ── HTML validation & sanitization tests ───────────────────────────────


def test_validate_html_valid():
    html = '<html><body><div class="node-phase">Phase 1</div></body></html>'
    assert validate_html(html) is True


def test_sanitize_strips_scripts():
    html = '<html><body><script>alert("xss")</script><div class="node-phase">ok</div></body></html>'
    cleaned = sanitize_html(html)
    assert "<script>" not in cleaned
    assert "node-phase" in cleaned


def test_sanitize_strips_event_handlers():
    html = '<html><body><img onerror="alert(1)" class="node-phase"></body></html>'
    cleaned = sanitize_html(html)
    assert "onerror" not in cleaned


def test_sanitize_strips_dangerous_tags():
    html = '<html><body><iframe srcdoc="bad"></iframe><object data="x"></object><embed src="y"><meta http-equiv="refresh"><div class="node-phase">ok</div></body></html>'
    cleaned = sanitize_html(html)
    assert "<iframe" not in cleaned
    assert "<object" not in cleaned
    assert "<embed" not in cleaned
    assert "<meta" not in cleaned


def test_validate_html_rejects_no_html_tag():
    assert validate_html("just some text") is False


def test_validate_html_rejects_external_urls_in_attributes():
    html = '<html><body><link href="https://fonts.googleapis.com/css" rel="stylesheet"><div class="node-phase"></div></body></html>'
    assert validate_html(html) is False


def test_validate_html_allows_urls_in_comments():
    html = '<html><body><!-- based on https://example.com --><div class="node-phase">ok</div></body></html>'
    assert validate_html(html) is True


def test_validate_html_rejects_protocol_relative_urls():
    html = '<html><body><link href="//fonts.google.com/css" rel="stylesheet"><div class="node-phase"></div></body></html>'
    assert validate_html(html) is False


def test_validate_html_rejects_data_uris_in_attributes():
    html = '<html><body><img src="data:text/html,<script>alert(1)</script>"><div class="node-phase"></div></body></html>'
    assert validate_html(html) is False


def test_validate_html_rejects_javascript_urls():
    html = '<html><body><a href="javascript:alert(1)">x</a><div class="node-phase"></div></body></html>'
    assert validate_html(html) is False


def test_build_generation_prompt():
    FIXTURE = Path(__file__).parent.parent / "skill" / "stark-session" / "SKILL.md"
    data = parse_skill_md(FIXTURE)
    css = "body { color: black; }"
    prompt = build_generation_prompt(data, audience="usage", css=css)
    assert "usage" in prompt.lower()
    assert "standalone HTML" in prompt
    assert data.name in prompt
    assert "mermaid" in prompt.lower()


def test_build_generation_prompt_internals():
    FIXTURE = Path(__file__).parent.parent / "skill" / "stark-session" / "SKILL.md"
    data = parse_skill_md(FIXTURE)
    css = "body { color: black; }"
    prompt = build_generation_prompt(data, audience="internals", css=css)
    assert "internals" in prompt.lower() or "contributor" in prompt.lower()
    assert "mermaid" in prompt.lower()


# ── Screenshot tests ───────────────────────────────────────────────────


def test_screenshot_html_creates_png(tmp_path, monkeypatch):
    html_path = tmp_path / "test.html"
    html_path.write_text("<html><body><h1>Test</h1></body></html>")
    png_path = tmp_path / "test.png"

    def mock_run(cmd, **kwargs):
        out_path = Path(cmd[-1])
        out_path.write_bytes(b'\x89PNG\r\n\x1a\n' + b'\x00' * 100)
        return subprocess.CompletedProcess(cmd, 0)

    monkeypatch.setattr(shutil, "which", lambda x: "/usr/bin/npx")
    monkeypatch.setattr(subprocess, "run", mock_run)
    result = screenshot_html(html_path, png_path)
    assert result is True
    assert png_path.exists()


def test_screenshot_html_skips_when_no_npx(tmp_path, monkeypatch):
    html_path = tmp_path / "test.html"
    html_path.write_text("<html><body><h1>Test</h1></body></html>")
    png_path = tmp_path / "test.png"
    monkeypatch.setattr(shutil, "which", lambda x: None)
    result = screenshot_html(html_path, png_path)
    assert result is False
    assert not png_path.exists()


# ── Evaluation tests ──────────────────────────────────────────────────


def test_build_evaluation_prompt():
    prompt = build_evaluation_prompt(skill_name="stark-session", audience="usage", num_candidates=3)
    assert "visual_clarity" in prompt
    assert "accuracy" in prompt
    assert "audience_fit" in prompt
    assert "JSON" in prompt


def test_parse_evaluation_scores():
    raw = '{"scores": [{"agent": "claude", "visual_clarity": 8, "completeness": 9, "info_architecture": 7, "accuracy": 9, "design_quality": 7, "audience_fit": 8}, {"agent": "codex", "visual_clarity": 7, "completeness": 8, "info_architecture": 8, "accuracy": 8, "design_quality": 6, "audience_fit": 7}, {"agent": "gemini", "visual_clarity": 9, "completeness": 7, "info_architecture": 8, "accuracy": 7, "design_quality": 8, "audience_fit": 9}]}'
    scores = parse_evaluation_scores(raw)
    assert len(scores) == 3


def test_compute_weighted_average():
    scores = {"visual_clarity": 8, "completeness": 9, "info_architecture": 7, "accuracy": 9, "design_quality": 7, "audience_fit": 8}
    avg = compute_weighted_average(scores, FACTOR_WEIGHTS)
    assert abs(avg - 8.15) < 0.1


def test_select_winner():
    agent_scores = {"claude": 8.15, "codex": 7.5, "gemini": 8.15}
    accuracy_scores = {"claude": 9.0, "codex": 8.0, "gemini": 8.5}
    winner = select_winner(agent_scores, accuracy_scores)
    assert winner == "claude"


def test_select_winner_random_on_full_tie():
    agent_scores = {"claude": 8.0, "codex": 8.0, "gemini": 8.0}
    accuracy_scores = {"claude": 8.0, "codex": 8.0, "gemini": 8.0}
    random.seed(42)
    winner_a = select_winner(agent_scores, accuracy_scores)
    random.seed(99)
    winner_b = select_winner(agent_scores, accuracy_scores)
    assert winner_a in ("claude", "codex", "gemini")
    assert winner_b in ("claude", "codex", "gemini")
    assert not (winner_a == "claude" and winner_b == "claude"), "Tie-breaking appears alphabetical, not random"
