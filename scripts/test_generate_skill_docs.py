"""Tests for SKILL.md parser."""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from generate_skill_docs import parse_skill_md, SkillData, discover_skills

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
