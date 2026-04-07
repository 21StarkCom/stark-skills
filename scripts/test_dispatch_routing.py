#!/usr/bin/env python3
from __future__ import annotations

import os
from types import SimpleNamespace

import autopilot_dispatch
import design_to_plan_dispatch
import generate_skill_docs
import tournament


def _completed(*, stdout: str = "", stderr: str = "", returncode: int = 0) -> SimpleNamespace:
    return SimpleNamespace(stdout=stdout, stderr=stderr, returncode=returncode)


def test_create_worktree_prunes_stale_path_before_retry(monkeypatch, tmp_path):
    repo_root = str(tmp_path)
    branch_name = "autopilot/codex/step-1"
    worktree_dir = os.path.join(repo_root, ".worktrees", "autopilot-codex-step-1")
    calls: list[list[str]] = []
    add_attempts = 0

    def fake_run(cmd, **kwargs):
        nonlocal add_attempts
        calls.append(cmd)
        if cmd[:3] == ["git", "rev-parse", "HEAD"]:
            return _completed(stdout="abc123\n")
        if cmd[:3] == ["git", "worktree", "add"]:
            add_attempts += 1
            if add_attempts == 1:
                return _completed(stderr="already exists", returncode=1)
            return _completed()
        return _completed()

    removed_paths: list[tuple[str, bool]] = []

    monkeypatch.setattr(autopilot_dispatch.subprocess, "run", fake_run)
    monkeypatch.setattr(
        autopilot_dispatch.os.path,
        "exists",
        lambda path: path == worktree_dir,
    )
    monkeypatch.setattr(
        autopilot_dispatch.shutil,
        "rmtree",
        lambda path, ignore_errors=True: removed_paths.append((path, ignore_errors)),
    )

    created = autopilot_dispatch.create_worktree(repo_root, "codex", "step-1")

    assert created == worktree_dir
    assert ["git", "worktree", "remove", "--force", worktree_dir] in calls
    assert ["git", "worktree", "prune"] in calls
    assert ["git", "branch", "-D", branch_name] in calls
    assert removed_paths == [(worktree_dir, True)]


def test_autopilot_codex_uses_agent_specific_env(monkeypatch):
    env_calls: list[tuple[str, str]] = []
    seen_envs: list[dict[str, str] | None] = []

    monkeypatch.setattr(autopilot_dispatch, "is_agent_enabled", lambda agent: True)
    monkeypatch.setattr(
        autopilot_dispatch,
        "build_agent_env",
        lambda agent, operation: env_calls.append((agent, operation)) or {"GH_TOKEN": f"{agent}-token"},
    )
    monkeypatch.setattr(autopilot_dispatch, "collect_diff", lambda worktree_path: ("", [], 0, 0))
    monkeypatch.setattr(autopilot_dispatch, "_run_validation_chain", lambda worktree_path, step_id: True)
    monkeypatch.setattr(autopilot_dispatch, "parse_jsonl_output", lambda raw: raw)

    def fake_run(cmd, **kwargs):
        seen_envs.append(kwargs.get("env"))
        return _completed(stdout="{}", returncode=0)

    monkeypatch.setattr(autopilot_dispatch.subprocess, "run", fake_run)

    result = autopilot_dispatch._run_implementation_agent("codex", "step-1", "prompt", "/tmp/worktree", timeout=1)

    assert env_calls == [("codex", "review")]
    assert seen_envs[0] == {"GH_TOKEN": "codex-token"}
    assert result.error is None


def test_design_to_plan_codex_uses_agent_specific_env(monkeypatch):
    monkeypatch.setattr(
        design_to_plan_dispatch,
        "build_agent_env",
        lambda agent, operation: {"GH_TOKEN": f"{agent}-token"},
    )

    _cmd, run_kwargs, gemini_home = design_to_plan_dispatch._build_cmd_and_kwargs("codex", "prompt")

    assert gemini_home is None
    assert run_kwargs["env"] == {"GH_TOKEN": "codex-token"}


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
