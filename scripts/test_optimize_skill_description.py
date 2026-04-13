"""Tests for optimize_skill_description.py.

Focuses on the pure helpers — SKILL.md frontmatter parsing and the
improvement prompt assembly. The _run_eval and _propose_improvement
functions shell out to external processes and are exercised via
integration runs, not unit tests.
"""

from __future__ import annotations

from pathlib import Path

import optimize_skill_description as opt


def _write_skill(tmp_path: Path, frontmatter: str) -> Path:
    skill = tmp_path / "my-skill"
    skill.mkdir()
    (skill / "SKILL.md").write_text(frontmatter + "\n## body\n", encoding="utf-8")
    return skill


def test_parse_skill_description_single_line(tmp_path):
    skill = _write_skill(
        tmp_path,
        "---\nname: my-skill\ndescription: a short description\n---",
    )
    name, desc = opt._parse_skill_description(skill)
    assert name == "my-skill"
    assert desc == "a short description"


def test_parse_skill_description_block_scalar(tmp_path):
    skill = _write_skill(
        tmp_path,
        "---\n"
        "name: stark-forged-review\n"
        "description: >-\n"
        "  Multi-agent PR review with leader + second-opinion per domain, "
        "dynamic triage, and forge-style escalation on non-trivial findings. "
        "Replaces stark-review.\n"
        "model: opus[1m]\n"
        "---",
    )
    name, desc = opt._parse_skill_description(skill)
    assert name == "stark-forged-review"
    assert "leader + second-opinion" in desc
    assert "Replaces stark-review" in desc


def test_parse_skill_description_ignores_other_fields(tmp_path):
    skill = _write_skill(
        tmp_path,
        "---\n"
        "name: x\n"
        "description: just the description\n"
        "argument-hint: \"[ARG]\"\n"
        "model: opus\n"
        "---",
    )
    _, desc = opt._parse_skill_description(skill)
    assert desc == "just the description"


def test_parse_skill_description_raises_without_frontmatter(tmp_path):
    skill = tmp_path / "bad"
    skill.mkdir()
    (skill / "SKILL.md").write_text("no frontmatter here\n", encoding="utf-8")
    import pytest
    with pytest.raises(RuntimeError, match="no YAML frontmatter"):
        opt._parse_skill_description(skill)


def test_improve_prompt_template_mentions_key_constraints():
    # Format the template with the minimum inputs and make sure all the
    # guardrails we care about are there — this is what stops the model
    # from proposing a 500-char marketing blurb.
    rendered = opt.IMPROVE_PROMPT_TEMPLATE.format(
        skill_name="x",
        current_description="current",
        failed_should_trigger="  (none)",
        failed_should_not_trigger="  (none)",
    )
    assert "200 characters" in rendered
    assert "Disambiguate from sibling skills" in rendered
    assert "Output ONLY the new description" in rendered
