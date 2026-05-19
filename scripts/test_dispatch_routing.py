#!/usr/bin/env python3
from __future__ import annotations

from types import SimpleNamespace

import generate_skill_docs
import tournament


def _completed(*, stdout: str = "", stderr: str = "", returncode: int = 0) -> SimpleNamespace:
    return SimpleNamespace(stdout=stdout, stderr=stderr, returncode=returncode)


def test_tournament_codex_uses_agent_specific_env(monkeypatch):
    env_calls: list[tuple[str, str]] = []
    seen_envs: list[dict[str, str] | None] = []
    skill = generate_skill_docs.SkillData(
        name="demo-skill",
        description="Demo",
        argument_hint="",
        complexity="simple",
        line_count=10,
        raw_md="# Demo",
    )

    monkeypatch.setattr(tournament, "is_agent_enabled", lambda agent: True)
    monkeypatch.setattr(
        tournament,
        "build_agent_env",
        lambda agent, operation: env_calls.append((agent, operation)) or {"GH_TOKEN": f"{agent}-token"},
    )
    monkeypatch.setattr(tournament, "_load_css", lambda: "css")
    monkeypatch.setattr(generate_skill_docs, "build_generation_prompt", lambda skill, audience, css: "prompt")
    monkeypatch.setattr(
        generate_skill_docs,
        "_parse_viz_response",
        lambda raw: {
            "html": "<div>ok</div>",
            "mermaid": "graph TD",
            "doc_content": "doc",
            "alt_text": "alt",
        },
    )
    monkeypatch.setattr(tournament, "parse_jsonl_output", lambda raw: raw)

    def fake_run(cmd, **kwargs):
        seen_envs.append(kwargs.get("env"))
        return _completed(stdout='{"html":"<div>ok</div>"}', returncode=0)

    monkeypatch.setattr(tournament.subprocess, "run", fake_run)

    result = tournament.dispatch_competitor("codex", skill, "usage")

    assert env_calls == [("codex", "review")]
    assert seen_envs[0] == {"GH_TOKEN": "codex-token"}
    assert not result.error
