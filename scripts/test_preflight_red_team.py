"""Tests for the red_team preflight check."""

from __future__ import annotations

import preflight


def test_check_red_team_model_rates_passes_when_rate_exists(monkeypatch):
    def fake_red_team_config():
        return {"enabled": True, "model": "o3"}

    def fake_model_rates():
        return {"o3": {"input_per_1m_usd": 15.0, "output_per_1m_usd": 60.0}}

    monkeypatch.setattr(preflight, "get_red_team_config", fake_red_team_config, raising=False)
    monkeypatch.setattr(preflight, "get_model_rates", fake_model_rates, raising=False)

    status, message = preflight.check_red_team_model_rates()
    assert status == "pass"


def test_check_red_team_model_rates_fails_when_no_rate(monkeypatch):
    def fake_red_team_config():
        return {"enabled": True, "model": "unknown-model"}

    def fake_model_rates():
        return {"o3": {"input_per_1m_usd": 15.0, "output_per_1m_usd": 60.0},
                "_fallback": {"input_per_1m_usd": 100.0, "output_per_1m_usd": 300.0}}

    monkeypatch.setattr(preflight, "get_red_team_config", fake_red_team_config, raising=False)
    monkeypatch.setattr(preflight, "get_model_rates", fake_model_rates, raising=False)

    status, message = preflight.check_red_team_model_rates()
    assert status == "fail"
    assert "unknown-model" in message


def test_check_red_team_model_rates_skips_when_disabled(monkeypatch):
    def fake_red_team_config():
        return {"enabled": False, "model": "o3"}

    monkeypatch.setattr(preflight, "get_red_team_config", fake_red_team_config, raising=False)

    status, message = preflight.check_red_team_model_rates()
    assert status == "skip"


# Round-3 finding 11: locked Responses-API default model needs an OpenAI
# API key, not just codex-CLI auth. Without this preflight, an install
# that has only Codex auth passes preflight then halts at the design gate.


def test_check_red_team_transport_auth_passes_when_key_set(monkeypatch):
    def fake_cfg():
        return {"enabled": True, "model": "gpt-5.5-pro"}
    monkeypatch.setattr(preflight, "get_red_team_config", fake_cfg, raising=False)
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test")

    status, _ = preflight.check_red_team_transport_auth()
    assert status == "pass"


def test_check_red_team_transport_auth_fails_when_key_missing(monkeypatch):
    def fake_cfg():
        return {"enabled": True, "model": "gpt-5.5-pro"}
    monkeypatch.setattr(preflight, "get_red_team_config", fake_cfg, raising=False)
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    monkeypatch.delenv("OPENAI_API_KEY_FILE", raising=False)
    monkeypatch.delenv("OPENAI_API_KEY_LABEL", raising=False)

    status, message = preflight.check_red_team_transport_auth()
    assert status == "fail"
    assert "OpenAI API key" in message


def test_check_red_team_transport_auth_skips_for_codex_cli_models(monkeypatch):
    """Models not in RESPONSES_API_MODELS (e.g. gpt-5.5) route through the
    codex CLI, which uses the keychain — this check is irrelevant for them."""
    def fake_cfg():
        return {"enabled": True, "model": "gpt-5.5"}
    monkeypatch.setattr(preflight, "get_red_team_config", fake_cfg, raising=False)
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)

    status, _ = preflight.check_red_team_transport_auth()
    assert status == "skip"


def test_check_red_team_transport_auth_skips_when_disabled(monkeypatch):
    def fake_cfg():
        return {"enabled": False, "model": "gpt-5.5-pro"}
    monkeypatch.setattr(preflight, "get_red_team_config", fake_cfg, raising=False)

    status, _ = preflight.check_red_team_transport_auth()
    assert status == "skip"
