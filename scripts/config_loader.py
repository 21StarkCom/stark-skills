#!/usr/bin/env python3
from __future__ import annotations

import json
import sys
from copy import deepcopy
from functools import lru_cache
from pathlib import Path
from typing import Any

CONFIG_PATH = Path.home() / ".claude" / "code-review" / "config.json"

DEFAULT_MODELS = {
    "claude": {"enabled": True, "model_id": "claude-sonnet-4-6"},
    "codex": {"enabled": True, "model_id": "gpt-5.4"},
    "gemini": {"enabled": False, "model_id": "gemini-2.5-pro"},
}
DEFAULT_RUNTIME = {
    "lock_ttl_minutes": 30,
    "subagent_env_allowlist": [
        "PATH",
        "HOME",
        "USER",
        "SHELL",
        "LANG",
        "TERM",
        "CLAUDE_CODE_USE_VERTEX",
        "ANTHROPIC_VERTEX_PROJECT_ID",
        "CLOUD_ML_REGION",
        "GOOGLE_APPLICATION_CREDENTIALS",
    ],
    "max_concurrent_agents": 3,
    "temp_dir_prefix": "stark-env",
}
DEFAULT_SELF_HEAL = {
    "enabled": True,
    "mode": "suggest",
    "max_auto_retries": 0,
    "patterns_file": "healer_patterns.json",
    "circuit_breaker_threshold": 3,
    "auto_patterns": [],
}
DEFAULT_VALIDATION_GATE = {
    "enabled": True,
    "run_on": ["implementation", "autopilot"],
    "skip_domains": [],
    "timeout_seconds": 60,
}
DEFAULT_SKILL_ACTIVATION = {
    "enabled": True,
    "suggest_after_review_rounds": 3,
    "max_suggestions": 2,
    "cooldown_hours": 24,
    "suppressed_skills": [],
    "activation_signals": ["review_finding", "correction", "skill_invocation"],
}
DEFAULT_CONTEXT_COMPACTION = {
    "enabled": True,
    "checkpoint_interval_minutes": 15,
    "max_checkpoint_size_kb": 50,
    "include_file_summaries": True,
}
DEFAULT_COST = {
    "weekly_budget_usd": 50.0,
    "daily_alert_usd": 15.0,
    "hard_stop_usd": 100.0,
    "track_rolling_7d": True,
}


def _warn(message: str) -> None:
    print(f"config_loader: {message}", file=sys.stderr)


def _merge_dict(defaults: dict[str, Any], overrides: Any) -> dict[str, Any]:
    """Deep-merge *overrides* into a copy of *defaults*.

    Nested dicts are merged recursively so that partial overrides
    (e.g. ``{"claude": {"enabled": false}}``) don't clobber sibling
    keys in the defaults (e.g. ``model_id``).
    """
    merged = deepcopy(defaults)
    if isinstance(overrides, dict):
        for key, value in overrides.items():
            if key in merged and isinstance(merged[key], dict) and isinstance(value, dict):
                merged[key] = _merge_dict(merged[key], value)
            else:
                merged[key] = deepcopy(value)
    return merged


@lru_cache(maxsize=1)
def load_config() -> dict[str, Any]:
    if not CONFIG_PATH.exists():
        _warn(f"config file not found at {CONFIG_PATH}")
        return {}

    try:
        with CONFIG_PATH.open("r", encoding="utf-8") as handle:
            loaded = json.load(handle)
    except (OSError, json.JSONDecodeError) as exc:
        _warn(f"failed to load {CONFIG_PATH}: {exc}")
        return {}

    if not isinstance(loaded, dict):
        _warn(f"expected top-level object in {CONFIG_PATH}")
        return {}
    return loaded


def get_models_config() -> dict[str, Any]:
    return _merge_dict(DEFAULT_MODELS, load_config().get("models"))


def get_runtime_config() -> dict[str, Any]:
    return _merge_dict(DEFAULT_RUNTIME, load_config().get("runtime"))


def get_self_heal_config() -> dict[str, Any]:
    return _merge_dict(DEFAULT_SELF_HEAL, load_config().get("self_heal"))


def get_validation_gate_config() -> dict[str, Any]:
    return _merge_dict(DEFAULT_VALIDATION_GATE, load_config().get("validation_gate"))


def get_skill_activation_config() -> dict[str, Any]:
    return _merge_dict(DEFAULT_SKILL_ACTIVATION, load_config().get("skill_activation"))


def get_context_compaction_config() -> dict[str, Any]:
    return _merge_dict(DEFAULT_CONTEXT_COMPACTION, load_config().get("context_compaction"))


def get_cost_config() -> dict[str, Any]:
    return _merge_dict(DEFAULT_COST, load_config().get("cost"))


def is_agent_enabled(agent: str) -> bool:
    model_config = get_models_config().get(agent)
    if not isinstance(model_config, dict):
        return False
    return bool(model_config.get("enabled"))


def get_model_id(agent: str) -> str | None:
    model_config = get_models_config().get(agent)
    if not isinstance(model_config, dict):
        return None
    model_id = model_config.get("model_id")
    return model_id if isinstance(model_id, str) else None


if __name__ == "__main__":
    print(json.dumps(load_config(), indent=2))
