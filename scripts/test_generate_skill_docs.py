"""Tests for SKILL.md parser."""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from generate_skill_docs import (
    parse_skill_md, SkillData, discover_skills,
    validate_html, sanitize_html, build_generation_prompt, VizResult,
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
