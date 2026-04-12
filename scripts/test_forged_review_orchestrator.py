"""Tests for forged_review.py — orchestrator flow.

Uses monkeypatching to stub out subprocess/gh/dispatch calls so no real
CLIs are invoked.
"""

from __future__ import annotations

import json
from pathlib import Path

import forged_review as orch
import forged_review_dispatch as disp


# ── load_state / save_state ────────────────────────────────────────────


def test_save_and_load_state_roundtrip(tmp_path):
    path = tmp_path / "state.json"
    state = {"run_id": "r1", "pr_number": 42, "rounds": []}
    orch.save_state(path, state)
    loaded = orch.load_state(path)
    assert loaded is not None
    assert loaded["run_id"] == "r1"
    assert loaded["pr_number"] == 42
    assert "updated_at" in loaded  # save_state adds this


def test_load_state_missing_returns_none(tmp_path):
    assert orch.load_state(tmp_path / "nope.json") is None


def test_load_state_corrupt_returns_none(tmp_path):
    path = tmp_path / "corrupt.json"
    path.write_text("{not valid json")
    assert orch.load_state(path) is None


# ── _build_state ───────────────────────────────────────────────────────


def _ctx(tmp_path: Path) -> orch.RunContext:
    return orch.RunContext(
        pr_number=7,
        repo="x/y",
        branch="feat/foo",
        base="main",
        worktree=tmp_path / "wt",
        run_id="run-test",
        started_at=1_700_000_000.0,
        dry_run=False,
        no_escalate=False,
        force_escalate=False,
        state_path=tmp_path / "state.json",
        cfg={
            "forge_threshold": 4,
            "max_rounds": 3,
            "always_on_domains": ["correctness", "regression-prevention"],
            "domain_pairs": {
                "correctness": {"leader": "codex", "second": "claude"},
                "security": {"leader": "gemini", "second": "codex"},
            },
            "auto_merge_when_clean": True,
        },
    )


def test_build_state_contains_required_keys(tmp_path):
    ctx = _ctx(tmp_path)
    state = orch._build_state(
        ctx,
        triage={"selected_domains": ["correctness"], "rationale": {"correctness": "always-on"}},
        selected_domains=["correctness"],
    )
    for key in (
        "version", "run_id", "pr_number", "repo", "branch", "base",
        "worktree", "path", "triage", "selected_domains", "rounds",
        "forge_sub_state", "current_round", "max_rounds", "forge_threshold",
        "status", "started_at",
    ):
        assert key in state


# ── run_round (mocked dispatch) ───────────────────────────────────────


def test_run_round_light_gate_on_zero_findings(monkeypatch, tmp_path):
    ctx = _ctx(tmp_path)

    def fake_dispatch(**kwargs):
        return {
            "correctness": disp.DomainResult(
                domain="correctness",
                leader_agent="codex",
                second_agent="claude",
                merged={"confirmed": [], "disputed": [], "leader_only": [], "second_only": []},
                leader_duration_s=1.0,
                second_duration_s=1.0,
                actionable=[],
            )
        }

    monkeypatch.setattr(disp, "run_review_round", fake_dispatch)
    round_obj = orch.run_round(
        ctx,
        selected_domains=["correctness"],
        pr_diff="",
        round_num=1,
        round_mode="full",
    )
    assert round_obj["actionable_count"] == 0
    assert round_obj["critical_count"] == 0
    assert round_obj["gate_decision"] == "light"


def test_run_round_forge_gate_on_critical(monkeypatch, tmp_path):
    ctx = _ctx(tmp_path)

    def fake_dispatch(**kwargs):
        return {
            "correctness": disp.DomainResult(
                domain="correctness",
                leader_agent="codex",
                second_agent="claude",
                merged={
                    "confirmed": [{"id": "f1", "severity": "critical", "title": "boom"}],
                    "disputed": [],
                    "leader_only": [],
                    "second_only": [],
                },
                leader_duration_s=1.0,
                second_duration_s=1.0,
                actionable=[{"id": "f1", "severity": "critical", "title": "boom"}],
            )
        }

    monkeypatch.setattr(disp, "run_review_round", fake_dispatch)
    round_obj = orch.run_round(
        ctx,
        selected_domains=["correctness"],
        pr_diff="",
        round_num=1,
        round_mode="full",
    )
    assert round_obj["actionable_count"] == 1
    assert round_obj["critical_count"] == 1
    assert round_obj["gate_decision"] == "forge"


def test_run_round_respects_force_escalate(monkeypatch, tmp_path):
    ctx = _ctx(tmp_path)
    ctx.force_escalate = True

    def fake_dispatch(**kwargs):
        return {
            "correctness": disp.DomainResult(
                domain="correctness",
                leader_agent="codex",
                second_agent="claude",
                merged={"confirmed": [], "disputed": [], "leader_only": [], "second_only": []},
                leader_duration_s=0.5,
                second_duration_s=0.5,
                actionable=[],
            )
        }

    monkeypatch.setattr(disp, "run_review_round", fake_dispatch)
    round_obj = orch.run_round(
        ctx,
        selected_domains=["correctness"],
        pr_diff="",
        round_num=1,
        round_mode="full",
    )
    assert round_obj["gate_decision"] == "forge"
    assert "force_escalate" in round_obj["gate_reason"]


# ── _print_result_json ─────────────────────────────────────────────────


def test_print_result_json_clean_needs_merge(tmp_path, capsys):
    ctx = _ctx(tmp_path)
    ctx.rounds = [
        {
            "n": 1, "mode": "full", "actionable_count": 0, "critical_count": 0,
            "gate_decision": "light", "gate_reason": "0 actionable",
            "domain_findings": {}, "fix_commits": [],
        }
    ]
    exit_code = orch._print_result_json(ctx, status="clean")
    captured = capsys.readouterr().out
    payload = json.loads(captured)
    assert payload["status"] == "clean"
    assert payload["needs_merge_confirmation"] is True
    assert payload["pr_number"] == 7
    assert exit_code == 0


def test_print_result_json_dry_run_does_not_request_merge(tmp_path, capsys):
    ctx = _ctx(tmp_path)
    ctx.dry_run = True
    ctx.rounds = [
        {
            "n": 1, "mode": "full", "actionable_count": 0, "critical_count": 0,
            "gate_decision": "light", "gate_reason": "0 actionable",
            "domain_findings": {}, "fix_commits": [],
        }
    ]
    exit_code = orch._print_result_json(ctx, status="dry_run_complete")
    payload = json.loads(capsys.readouterr().out)
    assert payload["status"] == "dry_run_complete"
    assert payload["needs_merge_confirmation"] is False
    assert exit_code == 0


def test_print_result_json_awaiting_fixes_returns_halted(tmp_path, capsys):
    ctx = _ctx(tmp_path)
    ctx.rounds = [
        {
            "n": 1, "mode": "full", "actionable_count": 5, "critical_count": 1,
            "gate_decision": "forge", "gate_reason": "1 critical",
            "domain_findings": {}, "fix_commits": [],
        }
    ]
    exit_code = orch._print_result_json(
        ctx, status="awaiting_fixes", message="apply fixes",
    )
    payload = json.loads(capsys.readouterr().out)
    assert payload["status"] == "awaiting_fixes"
    assert payload["needs_merge_confirmation"] is False
    assert "apply fixes" in payload["message"]
    assert exit_code == 1


# ── main CLI arg rejection ─────────────────────────────────────────────


def test_main_rejects_conflicting_escalate_flags():
    exit_code = orch.main(["--no-escalate", "--force-escalate", "42"])
    assert exit_code == 3  # EXIT_INVALID_INPUT
