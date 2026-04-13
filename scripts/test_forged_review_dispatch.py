"""Tests for forged_review_dispatch.py.

Focuses on pure helpers (JSON extraction, id backfill, prompt path resolution,
fallback triage) and covers dispatch_domain + run_review_round with mocked
run_agent so we don't invoke real CLIs.
"""

from __future__ import annotations

import json

import pytest

import forged_review_dispatch as disp


# ── extract_json ───────────────────────────────────────────────────────


def test_extract_json_plain_object():
    result = disp.extract_json('{"a": 1}', expect_array=False)
    assert result == {"a": 1}


def test_extract_json_plain_array():
    result = disp.extract_json('[{"x": 1}, {"x": 2}]', expect_array=True)
    assert result == [{"x": 1}, {"x": 2}]


def test_extract_json_fenced_code_block():
    raw = 'Sure, here you go:\n\n```json\n{"ok": true}\n```\n\nLet me know!'
    result = disp.extract_json(raw, expect_array=False)
    assert result == {"ok": True}


def test_extract_json_prose_surrounding_array():
    raw = "Here are the findings:\n[{\"severity\":\"high\"}]\nThat's all."
    result = disp.extract_json(raw, expect_array=True)
    assert result == [{"severity": "high"}]


def test_extract_json_empty_returns_correct_default():
    assert disp.extract_json("", expect_array=True) == []
    assert disp.extract_json("", expect_array=False) == {}


def test_extract_json_garbage_returns_default():
    assert disp.extract_json("definitely not json", expect_array=True) == []


# ── _ensure_finding_ids ────────────────────────────────────────────────


def test_ensure_finding_ids_assigns_when_missing():
    findings = [{"title": "a"}, {"title": "b", "id": "f5"}, {"title": "c"}]
    disp._ensure_finding_ids(findings)
    ids = [f["id"] for f in findings]
    assert ids[1] == "f5"
    assert len(set(ids)) == 3  # all unique
    assert all(i.startswith("f") for i in ids)


def test_ensure_finding_ids_skips_collisions():
    findings = [{"id": "f1"}, {"title": "new"}, {"id": "f2"}]
    disp._ensure_finding_ids(findings)
    ids = [f["id"] for f in findings]
    assert ids[0] == "f1"
    assert ids[2] == "f2"
    assert ids[1] not in ("f1", "f2")


# ── _domain_prompt_path ────────────────────────────────────────────────


def test_domain_prompt_path_formatting():
    assert disp._domain_prompt_path("claude", "architecture", "leader") == "claude/01-architecture-leader.md"
    assert disp._domain_prompt_path("codex", "correctness", "second") == "codex/03-correctness-second.md"
    assert disp._domain_prompt_path("gemini", "security", "leader") == "gemini/05-security-leader.md"


def test_domain_prompt_path_unknown_domain_raises():
    with pytest.raises(KeyError):
        disp._domain_prompt_path("claude", "quantum", "leader")


# ── load_prompt ────────────────────────────────────────────────────────


def test_load_prompt_missing_raises_file_not_found(tmp_path, monkeypatch):
    monkeypatch.setattr(disp, "PROMPTS_ROOT", tmp_path)
    with pytest.raises(FileNotFoundError):
        disp.load_prompt("nope.md")


# ── _fallback_triage ───────────────────────────────────────────────────


def test_fallback_triage_selects_all_nine():
    result = disp._fallback_triage("test")
    assert len(result["selected_domains"]) == 9
    assert "correctness" in result["selected_domains"]
    assert all("test" in r for r in result["rationale"].values())


# ── dispatch_triage (mocked) ───────────────────────────────────────────


def test_dispatch_triage_success(monkeypatch, tmp_path):
    fake_prompt = "# triage prompt"
    monkeypatch.setattr(disp, "load_prompt", lambda p: fake_prompt)

    def fake_run(agent, prompt, cwd=None, timeout_s=None):
        return disp.AgentCallResult(
            agent=agent,
            raw_output='{"selected_domains": ["correctness"], "rationale": {"correctness": "always-on"}}',
            duration_s=1.0,
        )

    monkeypatch.setattr(disp, "run_agent", fake_run)
    result = disp.dispatch_triage("diff", ["a.py"], "desc")
    assert result["selected_domains"] == ["correctness"]


def test_dispatch_triage_failure_falls_back(monkeypatch):
    monkeypatch.setattr(disp, "load_prompt", lambda p: "# triage")

    def fake_run(agent, prompt, cwd=None, timeout_s=None):
        return disp.AgentCallResult(
            agent=agent, raw_output="", duration_s=0.0, error="boom",
        )

    monkeypatch.setattr(disp, "run_agent", fake_run)
    result = disp.dispatch_triage("diff", [], "")
    assert len(result["selected_domains"]) == 9


def test_dispatch_triage_malformed_output_falls_back(monkeypatch):
    monkeypatch.setattr(disp, "load_prompt", lambda p: "# triage")

    def fake_run(agent, prompt, cwd=None, timeout_s=None):
        return disp.AgentCallResult(
            agent=agent, raw_output="not json at all", duration_s=0.5,
        )

    monkeypatch.setattr(disp, "run_agent", fake_run)
    result = disp.dispatch_triage("diff", [], "")
    assert len(result["selected_domains"]) == 9


# ── dispatch_domain (mocked leader + second) ──────────────────────────


def test_dispatch_domain_merges_leader_and_second(monkeypatch):
    def fake_load(p: str) -> str:
        return f"# prompt: {p}"

    monkeypatch.setattr(disp, "load_prompt", fake_load)

    call_count = {"n": 0}

    def fake_run(agent, prompt, cwd=None, timeout_s=None):
        call_count["n"] += 1
        if call_count["n"] == 1:
            # leader returns 2 findings
            return disp.AgentCallResult(
                agent=agent,
                raw_output=json.dumps([
                    {"id": "f1", "severity": "high", "title": "bug A"},
                    {"id": "f2", "severity": "medium", "title": "bug B"},
                ]),
                duration_s=10.0,
            )
        # second confirms f1, disputes f2, adds a new one
        return disp.AgentCallResult(
            agent=agent,
            raw_output=json.dumps({
                "decisions": [
                    {"id": "f1", "verdict": "confirmed", "reason": "real"},
                    {"id": "f2", "verdict": "disputed", "reason": "false"},
                ],
                "second_only": [{"severity": "high", "title": "bug C"}],
            }),
            duration_s=9.0,
        )

    monkeypatch.setattr(disp, "run_agent", fake_run)
    result = disp.dispatch_domain(
        "correctness", leader_agent="codex", second_agent="claude",
        pr_diff="diff", cwd=None,
    )
    assert len(result.merged["confirmed"]) == 1
    assert len(result.merged["disputed"]) == 1
    assert len(result.merged["second_only"]) == 1
    assert len(result.actionable) == 2  # confirmed + second_only
    assert result.leader_agent == "codex"
    assert result.second_agent == "claude"


def test_dispatch_domain_leader_failure_still_produces_result(monkeypatch):
    monkeypatch.setattr(disp, "load_prompt", lambda p: "# prompt")

    def fake_run(agent, prompt, cwd=None, timeout_s=None):
        return disp.AgentCallResult(
            agent=agent, raw_output="", duration_s=5.0, error="leader_timeout",
        )

    monkeypatch.setattr(disp, "run_agent", fake_run)
    result = disp.dispatch_domain(
        "security", leader_agent="gemini", second_agent="codex",
        pr_diff="diff",
    )
    assert result.leader_error == "leader_timeout"
    assert result.merged == {"confirmed": [], "disputed": [], "leader_only": [], "second_only": []}


# ── run_review_round (mocked dispatch_domain) ─────────────────────────


def test_run_review_round_parallel_dispatch(monkeypatch):
    seen_domains = []

    def fake_dispatch(domain, leader_agent, second_agent, pr_diff, file_scope, cwd, max_diff_chars=0):
        seen_domains.append(domain)
        return disp.DomainResult(
            domain=domain,
            leader_agent=leader_agent,
            second_agent=second_agent,
            merged={"confirmed": [], "disputed": [], "leader_only": [], "second_only": []},
            leader_duration_s=1.0,
            second_duration_s=1.0,
            actionable=[],
        )

    monkeypatch.setattr(disp, "dispatch_domain", fake_dispatch)

    pairs = {
        "correctness": {"leader": "codex", "second": "claude"},
        "security": {"leader": "gemini", "second": "codex"},
    }
    results = disp.run_review_round(
        selected_domains=["correctness", "security"],
        domain_pairs=pairs,
        pr_diff="diff",
    )
    assert set(results.keys()) == {"correctness", "security"}
    assert set(seen_domains) == {"correctness", "security"}


def test_truncate_diff_for_prompt_under_limit_unchanged():
    small = "diff --git a/foo b/foo\n" + "x\n" * 100
    assert disp.truncate_diff_for_prompt(small, max_chars=10_000) == small


def test_truncate_diff_for_prompt_over_limit_includes_marker():
    big = "HEAD_MARK\n" + ("x" * 50_000) + "\nTAIL_MARK"
    result = disp.truncate_diff_for_prompt(big, max_chars=1000)
    assert len(result) <= 1000
    assert "stark-forged-review" in result
    assert "HEAD_MARK" in result
    assert "TAIL_MARK" in result


def test_truncate_diff_for_prompt_empty_is_noop():
    assert disp.truncate_diff_for_prompt("", max_chars=1000) == ""


def test_run_review_round_passes_max_diff_chars_to_dispatch(monkeypatch):
    seen_diffs = []

    def fake_dispatch(domain, leader_agent, second_agent, pr_diff, file_scope, cwd, max_diff_chars):
        seen_diffs.append((domain, len(pr_diff), max_diff_chars))
        return disp.DomainResult(
            domain=domain,
            leader_agent=leader_agent,
            second_agent=second_agent,
            merged={"confirmed": [], "disputed": [], "leader_only": [], "second_only": []},
            leader_duration_s=0.1,
            second_duration_s=0.1,
            actionable=[],
        )

    monkeypatch.setattr(disp, "dispatch_domain", fake_dispatch)
    huge = "x" * 200_000
    disp.run_review_round(
        selected_domains=["correctness"],
        domain_pairs={"correctness": {"leader": "codex", "second": "claude"}},
        pr_diff=huge,
        max_diff_chars=10_000,
    )
    assert seen_diffs == [("correctness", 200_000, 10_000)]


def test_dispatch_domain_truncates_diff_before_leader(monkeypatch):
    seen_inputs = []

    def fake_run_agent(agent, prompt, cwd=None, timeout_s=None):
        seen_inputs.append(prompt)
        # Return empty so dispatch_domain doesn't crash parsing.
        return disp.AgentCallResult(agent=agent, raw_output="[]", duration_s=0.1)

    monkeypatch.setattr(disp, "run_agent", fake_run_agent)
    monkeypatch.setattr(disp, "load_prompt", lambda rel: f"PROMPT {rel}")

    huge = "A" * 5000 + "MIDDLE_MARKER" + "B" * 5000
    disp.dispatch_domain(
        domain="correctness",
        leader_agent="codex",
        second_agent="claude",
        pr_diff=huge,
        max_diff_chars=500,
    )
    assert len(seen_inputs) == 2  # leader + second
    for inp in seen_inputs:
        assert "stark-forged-review" in inp  # truncation marker present
        assert "MIDDLE_MARKER" not in inp  # middle elided


def test_run_review_round_emits_heartbeat_on_stderr(monkeypatch, capsys):
    def fake_dispatch(domain, leader_agent, second_agent, pr_diff, file_scope, cwd, max_diff_chars=0):
        return disp.DomainResult(
            domain=domain,
            leader_agent=leader_agent,
            second_agent=second_agent,
            merged={"confirmed": [], "disputed": [], "leader_only": [], "second_only": []},
            leader_duration_s=0.1,
            second_duration_s=0.2,
            actionable=[],
        )

    monkeypatch.setattr(disp, "dispatch_domain", fake_dispatch)
    pairs = {"correctness": {"leader": "codex", "second": "claude"}}
    disp.run_review_round(
        selected_domains=["correctness"],
        domain_pairs=pairs,
        pr_diff="diff",
    )
    err = capsys.readouterr().err
    assert "[forged-review] round: starting" in err
    assert "[forged-review] domain correctness: done" in err
    assert "[forged-review] round: complete" in err


def test_run_review_round_skips_unknown_domains(monkeypatch):
    monkeypatch.setattr(disp, "dispatch_domain", lambda *a, **k: None)  # should not be called

    results = disp.run_review_round(
        selected_domains=["quantum-security"],
        domain_pairs={"correctness": {"leader": "codex", "second": "claude"}},
        pr_diff="",
    )
    assert results == {}
