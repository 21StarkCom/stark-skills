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
