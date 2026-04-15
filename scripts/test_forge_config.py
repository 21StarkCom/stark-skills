"""Tests for forge config integration in config_loader."""

from __future__ import annotations

import json
from unittest.mock import patch

import pytest

import config_loader
from config_loader import get_forge_config, load_config, DEFAULT_FORGE


@pytest.fixture(autouse=True)
def _clear_cache():
    """Clear lru_cache before and after each test."""
    load_config.cache_clear()
    yield
    load_config.cache_clear()


class TestForgeConfigDefaults:
    """Verify DEFAULT_FORGE is returned when no config file exists."""

    def test_returns_defaults_when_no_config(self, tmp_path):
        with patch.object(config_loader, "CONFIG_PATH", tmp_path / "missing.json"):
            cfg = get_forge_config()
        assert cfg["max_rounds"] == 3
        assert cfg["workers"] == 3
        assert cfg["fix_threshold"] == "medium"
        assert cfg["consensus_threshold"] == 2
        assert cfg["noise_improvement_threshold"] == 0.33
        assert cfg["heuristic_consolidation_threshold"] == 50
        assert cfg["review_timeout"] == 300
        assert cfg["fix_timeout"] == 900

    def test_timeout_overrides_merge_through_get_forge_config(self, tmp_path):
        """User-supplied review_timeout / fix_timeout in the config file
        must override the ``DEFAULT_FORGE`` defaults via ``get_forge_config``.
        Guards against regressions where a new timeout key is added to
        defaults but not wired through the merge path."""
        config_file = tmp_path / "config.json"
        config_file.write_text(
            json.dumps({
                "forge": {"review_timeout": 450, "fix_timeout": 1200},
            })
        )
        with patch.object(config_loader, "CONFIG_PATH", config_file):
            cfg = get_forge_config()
        assert cfg["review_timeout"] == 450
        assert cfg["fix_timeout"] == 1200
        # Untouched defaults must still be present after the merge.
        assert cfg["max_rounds"] == 3

    def test_domain_routing_has_all_12_domains(self):
        assert len(DEFAULT_FORGE["domain_routing"]) == 12

    def test_plan_review_routing_has_all_10_domains(self):
        assert len(DEFAULT_FORGE["plan_review_routing"]) == 10

    def test_agent_fallback_order(self):
        assert DEFAULT_FORGE["agent_fallback_order"] == ["claude", "codex", "gemini"]

    def test_consensus_domains_include_security(self):
        assert "security" in DEFAULT_FORGE["consensus_domains"]


class TestForgeConfigMerge:
    """Verify user overrides are merged correctly."""

    def test_partial_override_preserves_defaults(self, tmp_path):
        config_file = tmp_path / "config.json"
        config_file.write_text(json.dumps({"forge": {"max_rounds": 5}}))
        with patch.object(config_loader, "CONFIG_PATH", config_file):
            cfg = get_forge_config()
        assert cfg["max_rounds"] == 5
        # Other defaults preserved
        assert cfg["workers"] == 3
        assert cfg["fix_threshold"] == "medium"
        assert cfg["domain_routing"]["general"] == "claude"

    def test_domain_routing_override_merges(self, tmp_path):
        config_file = tmp_path / "config.json"
        config_file.write_text(json.dumps({
            "forge": {"domain_routing": {"security": "claude"}}
        }))
        with patch.object(config_loader, "CONFIG_PATH", config_file):
            cfg = get_forge_config()
        # Override applied
        assert cfg["domain_routing"]["security"] == "claude"
        # Other routing entries preserved
        assert cfg["domain_routing"]["general"] == "claude"
        assert cfg["domain_routing"]["api-design"] == "codex"


class TestForgeFixThreshold:
    """Verify fix_threshold enum values."""

    def test_default_is_medium(self):
        assert DEFAULT_FORGE["fix_threshold"] == "medium"

    @pytest.mark.parametrize("value", ["low", "medium", "high", "critical"])
    def test_valid_thresholds_accepted(self, tmp_path, value):
        config_file = tmp_path / "config.json"
        config_file.write_text(json.dumps({"forge": {"fix_threshold": value}}))
        with patch.object(config_loader, "CONFIG_PATH", config_file):
            cfg = get_forge_config()
        assert cfg["fix_threshold"] == value

class TestForgeHaltRound:
    """halt_round is always max_rounds + 1 — computed, not stored."""

    def test_halt_round_not_in_defaults(self):
        assert "halt_round" not in DEFAULT_FORGE

    def test_halt_round_computed_from_max_rounds(self, tmp_path):
        config_file = tmp_path / "config.json"
        config_file.write_text(json.dumps({"forge": {"max_rounds": 5}}))
        with patch.object(config_loader, "CONFIG_PATH", config_file):
            cfg = get_forge_config()
        # halt_round is not stored; consumers compute it as max_rounds + 1
        assert "halt_round" not in cfg
        assert cfg["max_rounds"] + 1 == 6

    def test_halt_round_default_is_4(self, tmp_path):
        with patch.object(config_loader, "CONFIG_PATH", tmp_path / "missing.json"):
            cfg = get_forge_config()
        assert cfg["max_rounds"] + 1 == 4
