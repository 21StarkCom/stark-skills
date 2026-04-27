"""Tests for red_team config loading and locked-field enforcement."""

from __future__ import annotations

import json
from unittest.mock import patch

import config_loader


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
    assert cfg["per_run_budget_usd"] == 15.00


def test_get_model_rates_returns_defaults(tmp_path):
    with patch.object(config_loader, "CONFIG_PATH", tmp_path / "nope.json"):
        config_loader.load_config.cache_clear()
        rates = config_loader.get_model_rates()
    assert "o3" in rates
    assert "claude-opus-4-7" in rates
    assert "gpt-5.4" in rates
    assert "gpt-5.5" in rates
    assert rates["gpt-5.4"]["input_per_1m_usd"] > 0
    assert rates["gpt-5.5"]["input_per_1m_usd"] > 0
    assert rates["o3"]["input_per_1m_usd"] > 0
    assert "_fallback" in rates


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
