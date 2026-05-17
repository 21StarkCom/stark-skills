"""Tests for red_team config loading and locked-field enforcement."""

from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path
from unittest.mock import patch

import config_loader


_REPO_ROOT = Path(__file__).resolve().parent.parent
_EMIT_QUEUE_CLI = _REPO_ROOT / "tools" / "emit_queue_cli.ts"


def _assert_event_validates(event_type: str, payload: dict, tmp_dir: Path) -> None:
    """Round-trip a captured event through the TS lib's enqueue (which calls
    validate internally) against an isolated STARK_QUEUE_DIR. A non-zero
    exit means the event_type or payload shape was rejected — the same
    regression the deleted real-validator check used to catch.
    """
    env = {**os.environ, "STARK_QUEUE_DIR": str(tmp_dir)}
    result = subprocess.run(
        [
            "node", "--experimental-strip-types", "--no-warnings",
            str(_EMIT_QUEUE_CLI), "enqueue",
            "--type", event_type,
            "--payload", json.dumps(payload, default=str),
        ],
        env=env,
        capture_output=True,
        timeout=15,
    )
    assert result.returncode == 0, (
        f"TS enqueue rejected event_type={event_type!r}: "
        f"stderr={result.stderr.decode('utf-8', 'replace')[:400]}"
    )


def test_get_red_team_config_returns_defaults(tmp_path):
    with patch.object(config_loader, "CONFIG_PATH", tmp_path / "nope.json"):
        config_loader.load_config.cache_clear()
        cfg = config_loader.get_red_team_config()
    assert cfg["enabled"] is True
    assert cfg["agent"] == "codex"
    assert cfg["model"] == "gpt-5.5-pro"
    assert cfg["max_rounds"] == 2
    assert cfg["stages"]["design"]["enabled"] is True
    assert cfg["stages"]["plan"]["enabled"] is False
    assert len(cfg["personas"]) == 5
    assert "security-trust" in cfg["personas"]
    assert cfg["per_run_budget_usd"] == 30.00
    assert cfg["fix_plan"] == {
        "enabled": False,
        "model": "gpt-5.5-pro",
        "reasoning_effort": "xhigh",
        "timeout_s": 1200,
        "min_moves": 2,
        "max_moves": 6,
        "max_input_chars": 200_000,
    }


def test_get_red_team_config_backfills_fix_plan_defaults_for_pre_v12_config(tmp_path):
    cfg_file = tmp_path / "config.json"
    cfg_file.write_text(json.dumps({
        "red_team": {
            "enabled": True,
            "model": "gpt-5.5-pro",
            "per_run_budget_usd": 15.0,
        }
    }))
    with patch.object(config_loader, "CONFIG_PATH", cfg_file):
        config_loader.load_config.cache_clear()
        cfg = config_loader.get_red_team_config()
    assert cfg["fix_plan"]["model"] == "gpt-5.5-pro"
    assert cfg["fix_plan"] == {
        "enabled": False,
        "model": "gpt-5.5-pro",
        "reasoning_effort": "xhigh",
        "timeout_s": 1200,
        "min_moves": 2,
        "max_moves": 6,
        "max_input_chars": 200_000,
    }


def test_get_red_team_config_merges_partial_v12_fix_plan_config(tmp_path):
    cfg_file = tmp_path / "config.json"
    cfg_file.write_text(json.dumps({
        "red_team": {
            "fix_plan": {
                "enabled": True,
                "timeout_s": 900,
            }
        }
    }))
    with patch.object(config_loader, "CONFIG_PATH", cfg_file):
        config_loader.load_config.cache_clear()
        cfg = config_loader.get_red_team_config()
    assert cfg["fix_plan"]["enabled"] is True
    assert cfg["fix_plan"]["timeout_s"] == 900
    assert cfg["fix_plan"]["model"] == "gpt-5.5-pro"
    assert cfg["fix_plan"]["reasoning_effort"] == "xhigh"
    assert cfg["fix_plan"]["min_moves"] == 2
    assert cfg["fix_plan"]["max_moves"] == 6
    assert cfg["fix_plan"]["max_input_chars"] == 200_000


def test_get_model_rates_returns_defaults(tmp_path):
    with patch.object(config_loader, "CONFIG_PATH", tmp_path / "nope.json"):
        config_loader.load_config.cache_clear()
        rates = config_loader.get_model_rates()
    assert "o3" in rates
    assert "claude-opus-4-7" in rates
    assert "gpt-5.4" in rates
    assert "gpt-5.5" in rates
    assert "gpt-5.4-pro" in rates
    assert "gpt-5.5-pro" in rates
    assert rates["gpt-5.4"]["input_per_1m_usd"] > 0
    assert rates["gpt-5.5"]["input_per_1m_usd"] > 0
    assert rates["gpt-5.4-pro"]["input_per_1m_usd"] > 0
    assert rates["gpt-5.5-pro"]["input_per_1m_usd"] > 0
    assert rates["o3"]["input_per_1m_usd"] > 0
    assert "_fallback" in rates


def test_default_red_team_model_has_a_rate_entry(tmp_path):
    """rt_b7 preflight requires red_team.model to be in model_rates. A typo
    that decoupled the two would silently pass tests and only surface at
    preflight, where it blocks real runs. Round-2 review (test-coverage)."""
    with patch.object(config_loader, "CONFIG_PATH", tmp_path / "nope.json"):
        config_loader.load_config.cache_clear()
        cfg = config_loader.get_red_team_config()
        rates = config_loader.get_model_rates()
    assert cfg["model"] in rates, (
        f"red_team.model={cfg['model']!r} has no model_rates entry — "
        f"preflight would block all red-team runs"
    )
    assert rates[cfg["model"]]["input_per_1m_usd"] > 0
    assert rates[cfg["model"]]["output_per_1m_usd"] > 0


def test_get_red_team_config_merges_non_locked_overrides(tmp_path):
    cfg_file = tmp_path / "config.json"
    cfg_file.write_text(json.dumps({
        "red_team": {"max_rounds": 3, "per_run_budget_usd": 25.0}
    }))
    with patch.object(config_loader, "CONFIG_PATH", cfg_file):
        config_loader.load_config.cache_clear()
        cfg = config_loader.get_red_team_config()
    assert cfg["max_rounds"] == 3
    assert cfg["per_run_budget_usd"] == 25.0
    assert cfg["model"] == "gpt-5.5-pro"


def test_get_red_team_config_allows_locked_fields_in_global_config(tmp_path, capsys):
    cfg_file = tmp_path / "config.json"
    cfg_file.write_text(json.dumps({
        "red_team": {
            "personas": ["ml-systems"],
            "model": "gpt-5.5",
            "max_rounds": 3,
        }
    }))
    with patch.object(config_loader, "CONFIG_PATH", cfg_file):
        config_loader.load_config.cache_clear()
        cfg = config_loader.get_red_team_config()
    assert cfg["max_rounds"] == 3
    assert cfg["personas"] == ["ml-systems"]
    assert cfg["model"] == "gpt-5.5"
    err = capsys.readouterr().err
    assert "locked to global config" not in err


def test_get_red_team_config_rejects_personas_override_from_repo_config(tmp_path, capsys, monkeypatch):
    global_cfg = tmp_path / "global.json"
    global_cfg.write_text(json.dumps({
        "red_team": {
            "personas": ["security-trust", "reliability-distsys"],
        }
    }))
    repo_dir = tmp_path / "repo"
    repo_cfg = repo_dir / ".code-review" / "config.json"
    repo_cfg.parent.mkdir(parents=True)
    repo_cfg.write_text(json.dumps({
        "red_team": {
            "personas": ["malicious-persona"],
            "max_rounds": 3,
        }
    }))
    monkeypatch.chdir(repo_dir)
    with patch.object(config_loader, "CONFIG_PATH", global_cfg):
        config_loader.load_config.cache_clear()
        cfg = config_loader.get_red_team_config()
    assert cfg["max_rounds"] == 3
    assert cfg["personas"] == ["security-trust", "reliability-distsys"]
    err = capsys.readouterr().err
    assert "personas" in err.lower()
    assert "locked" in err.lower() or "rejected" in err.lower()
    assert str(repo_cfg) in err


def test_get_red_team_config_rejects_model_override_from_repo_config(tmp_path, capsys, monkeypatch):
    global_cfg = tmp_path / "global.json"
    global_cfg.write_text(json.dumps({
        "red_team": {"model": "o3"}
    }))
    repo_dir = tmp_path / "repo"
    repo_cfg = repo_dir / ".code-review" / "config.json"
    repo_cfg.parent.mkdir(parents=True)
    repo_cfg.write_text(json.dumps({
        "red_team": {"model": "gpt-3.5-turbo-instruct"}
    }))
    monkeypatch.chdir(repo_dir)
    with patch.object(config_loader, "CONFIG_PATH", global_cfg):
        config_loader.load_config.cache_clear()
        cfg = config_loader.get_red_team_config()
    assert cfg["model"] == "o3"
    err = capsys.readouterr().err
    assert "model" in err.lower()
    assert str(repo_cfg) in err


def test_get_red_team_config_drops_unknown_top_level_override_from_repo_config(tmp_path, capsys, monkeypatch):
    """Defense-in-depth: a smuggled top-level field should not survive into the
    merged config. Otherwise future code could inadvertently consume it.
    """
    global_cfg = tmp_path / "global.json"
    global_cfg.write_text(json.dumps({}))
    repo_dir = tmp_path / "repo"
    repo_cfg = repo_dir / ".code-review" / "config.json"
    repo_cfg.parent.mkdir(parents=True)
    repo_cfg.write_text(json.dumps({
        "red_team": {
            "max_rounds": 3,
            "personas_override": ["smuggled-persona"],
            "secret_backdoor": True,
        }
    }))
    monkeypatch.chdir(repo_dir)
    with patch.object(config_loader, "CONFIG_PATH", global_cfg):
        config_loader.load_config.cache_clear()
        cfg = config_loader.get_red_team_config()
    assert cfg["max_rounds"] == 3
    assert "personas_override" not in cfg
    assert "secret_backdoor" not in cfg
    err = capsys.readouterr().err.lower()
    assert "personas_override" in err or "not a known config key" in err


import pytest


# rt2 — the lock surface expanded after the 2026-04-27 red-team review
# flagged that locking only personas/model left the substance-vs-appearance
# failure mode wide open: a compromised repo could still make the gate
# non-blocking via enabled, halt_on_unresolved, etc., while audit logs
# showed an intentional configuration change.
@pytest.mark.parametrize(
    ("locked_field", "global_value", "repo_attempted_value"),
    [
        ("enabled", True, False),
        ("agent", "codex", "claude"),
        ("min_severity_to_block", "high", "critical"),
        ("halt_on_unresolved", True, False),
        ("allow_human_review_halt", True, False),
        # `stages` locked as a unit — repo cannot disable a globally-enabled
        # stage via `stages.design.enabled: false`. Closes the bypass that
        # round-1 review (architecture + security domains) flagged: locking
        # `enabled` was insufficient because callers also gate on
        # `stages.<name>.enabled`.
        (
            "stages",
            {"design": {"enabled": True}, "plan": {"enabled": False}},
            {"design": {"enabled": False}, "plan": {"enabled": False}},
        ),
        # PR #430 review finding #16 — FU-rt6 audit retention lock. A repo
        # flipping retain_full_text back to True would silently turn the
        # metrics DB into a sensitive-document store. This test would have
        # caught a future nested-lock regression that lets repo config win.
        (
            "audit",
            {"retain_full_text": False, "excerpt_max_chars": 240},
            {"retain_full_text": True, "excerpt_max_chars": 240},
        ),
        # PR #430 review finding #8 — excerpt_max_chars is also locked, so
        # a repo can't crank the cap up to 999_999 and persist nearly-full
        # raw text under "excerpt" mode (defeating the redaction split).
        (
            "audit",
            {"retain_full_text": False, "excerpt_max_chars": 240},
            {"retain_full_text": False, "excerpt_max_chars": 999_999},
        ),
    ],
)
def test_get_red_team_config_rejects_security_critical_overrides(
    tmp_path, capsys, monkeypatch, locked_field, global_value, repo_attempted_value,
):
    global_cfg = tmp_path / "global.json"
    global_cfg.write_text(json.dumps({"red_team": {locked_field: global_value}}))
    repo_dir = tmp_path / "repo"
    repo_cfg = repo_dir / ".code-review" / "config.json"
    repo_cfg.parent.mkdir(parents=True)
    repo_cfg.write_text(json.dumps({
        "red_team": {locked_field: repo_attempted_value, "max_rounds": 4},
    }))
    monkeypatch.chdir(repo_dir)
    with patch.object(config_loader, "CONFIG_PATH", global_cfg):
        config_loader.load_config.cache_clear()
        cfg = config_loader.get_red_team_config()
    # Non-locked override survives, proving the layer was processed.
    assert cfg["max_rounds"] == 4
    # Locked field stays at the global-config value.
    assert cfg[locked_field] == global_value
    err = capsys.readouterr().err
    assert locked_field in err
    assert "locked" in err.lower() or "rejected" in err.lower()
    assert str(repo_cfg) in err


def test_locked_override_emits_audit_event(tmp_path, capsys, monkeypatch):
    """Spec §6 requires `red_team_override_rejected` for locked org/repo
    overrides. Captures via the new `_EMIT_EVENT` shim attribute — the
    TS lib's `enqueue` does the schema validation, so the test only
    needs to confirm the event type + payload shape reach the emit path."""

    captured: list[dict] = []

    def capture_emit(event_type, payload, **kw):
        # Reconstruct an event-envelope shape so the existing assertions
        # (`e["type"]`, `e["payload"]["field"]`) keep working after the
        # cutover to subprocess-based emission.
        captured.append({"type": event_type, "payload": payload, **kw})

    monkeypatch.setattr(config_loader, "_EMIT_EVENT", capture_emit)

    global_cfg = tmp_path / "global.json"
    global_cfg.write_text(json.dumps({"red_team": {"model": "o3"}}))
    repo_dir = tmp_path / "repo"
    repo_cfg = repo_dir / ".code-review" / "config.json"
    repo_cfg.parent.mkdir(parents=True)
    repo_cfg.write_text(json.dumps({
        "red_team": {
            "personas": ["bypass"],
            "model": "gpt-3.5-turbo",
            "enabled": False,
            "agent": "claude",
            "min_severity_to_block": "critical",
            "halt_on_unresolved": False,
            "allow_human_review_halt": False,
            "stages": {"design": {"enabled": False}},
            "fix_plan": {
                "enabled": True,
                "model": "gpt-5.5",
                "reasoning_effort": "low",
                "min_moves": 1,
                "max_moves": 99,
            },
        },
    }))
    monkeypatch.chdir(repo_dir)
    with patch.object(config_loader, "CONFIG_PATH", global_cfg):
        config_loader.load_config.cache_clear()
        config_loader.get_red_team_config()

    types = [e["type"] for e in captured]
    assert "red_team_override_rejected" in types
    # Round-trip every captured event through the TS lib so a regression
    # that renames `red_team_override_rejected` (or any other captured
    # type) into something validate() rejects fails the test loudly —
    # this is the same invariant the previous real-validator check
    # protected before the cutover to the TS lib.
    validate_dir = tmp_path / "validate_queue"
    validate_dir.mkdir()
    for e in captured:
        _assert_event_validates(e["type"], e["payload"], validate_dir)
    rejected_fields = {
        e["payload"]["field"]
        for e in captured
        if e["type"] == "red_team_override_rejected"
    }
    assert {
        "personas",
        "model",
        "enabled",
        "agent",
        "min_severity_to_block",
        "halt_on_unresolved",
        "allow_human_review_halt",
        "stages",
        "reasoning_effort",
        "min_moves",
        "max_moves",
    }.issubset(rejected_fields)
    rejected_paths = {
        e["payload"]["path"]
        for e in captured
        if e["type"] == "red_team_override_rejected"
    }
    assert {
        "personas",
        "model",
        "enabled",
        "agent",
        "min_severity_to_block",
        "halt_on_unresolved",
        "allow_human_review_halt",
        "stages",
        "fix_plan.enabled",
        "fix_plan.model",
        "fix_plan.reasoning_effort",
        "fix_plan.min_moves",
        "fix_plan.max_moves",
    }.issubset(rejected_paths)
    # Source path is captured for audit forensics.
    sources = {
        e["payload"]["source"]
        for e in captured
        if e["type"] == "red_team_override_rejected"
    }
    assert any(str(repo_cfg) in s for s in sources)


@pytest.mark.parametrize(
    ("key", "global_value", "repo_attempted_value"),
    [
        ("enabled", False, True),
        ("model", "gpt-5.5-pro", "gpt-5.5"),
        ("reasoning_effort", "xhigh", "low"),
        ("min_moves", 2, 1),
        ("max_moves", 6, 20),
    ],
)
def test_get_red_team_config_rejects_locked_fix_plan_overrides(
    tmp_path, capsys, monkeypatch, key, global_value, repo_attempted_value,
):
    captured: list[dict] = []

    def capture_emit(event_type, payload, **kw):
        captured.append({"type": event_type, "payload": payload, **kw})

    monkeypatch.setattr(config_loader, "_EMIT_EVENT", capture_emit)

    global_cfg = tmp_path / "global.json"
    global_cfg.write_text(json.dumps({"red_team": {"fix_plan": {key: global_value}}}))
    repo_dir = tmp_path / "repo"
    repo_cfg = repo_dir / ".code-review" / "config.json"
    repo_cfg.parent.mkdir(parents=True)
    repo_cfg.write_text(json.dumps({
        "red_team": {
            "fix_plan": {
                key: repo_attempted_value,
                "timeout_s": 777,
            }
        },
    }))
    monkeypatch.chdir(repo_dir)
    with patch.object(config_loader, "CONFIG_PATH", global_cfg):
        config_loader.load_config.cache_clear()
        cfg = config_loader.get_red_team_config()

    assert cfg["fix_plan"][key] == global_value
    assert cfg["fix_plan"]["timeout_s"] == 777
    err = capsys.readouterr().err
    assert f"fix_plan.{key}" in err
    paths = [
        e["payload"]["path"]
        for e in captured
        if e["type"] == "red_team_override_rejected"
    ]
    assert f"fix_plan.{key}" in paths


def test_get_red_team_config_warns_on_falsey_non_dict_repo_override(tmp_path, capsys, monkeypatch):
    global_cfg = tmp_path / "global.json"
    global_cfg.write_text(json.dumps({}))
    repo_dir = tmp_path / "repo"
    repo_cfg = repo_dir / ".code-review" / "config.json"
    repo_cfg.parent.mkdir(parents=True)
    repo_cfg.write_text(json.dumps({
        "red_team": False
    }))
    monkeypatch.chdir(repo_dir)
    with patch.object(config_loader, "CONFIG_PATH", global_cfg):
        config_loader.load_config.cache_clear()
        cfg = config_loader.get_red_team_config()
    assert cfg["model"] == "gpt-5.5-pro"
    err = capsys.readouterr().err.lower()
    assert "expected object at red_team" in err
