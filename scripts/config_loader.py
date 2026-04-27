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
    "claude": {"enabled": True, "model_id": "claude-opus-4-7"},
    "codex": {"enabled": True, "model_id": "gpt-5.5"},
    "gemini": {"enabled": True, "model_id": "gemini-3.1-pro-preview"},
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
        "ANTHROPIC_AGENTS",
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
DEFAULT_FORGE = {
    "domain_routing": {
        "general": "claude",
        "completeness": "claude",
        "security": "codex",
        "scope": "claude",
        "api-design": "codex",
        "data-modeling": "codex",
        "consistency": "claude",
        "scalability": "codex",
        "extensibility": "claude",
        "resilience": "codex",
        "accessibility": "codex",
        "implementation-feasibility": "codex",
    },
    "plan_review_routing": {
        "general": "claude",
        "completeness": "claude",
        "security": "codex",
        "feasibility": "codex",
        "operability": "codex",
        "sequencing": "claude",
        "rollback": "codex",
        "risk": "claude",
        "gates": "claude",
        "timeline": "codex",
    },
    "agent_fallback_order": ["claude", "codex", "gemini"],
    "consensus_domains": ["security"],
    "consensus_threshold": 2,
    "max_rounds": 3,
    "workers": 3,
    "fix_threshold": "medium",
    "noise_improvement_threshold": 0.33,
    "heuristic_consolidation_threshold": 50,
    # Per-domain review dispatch budget (single audit of a section).
    "review_timeout": 300,
    # Whole-artifact rewrite budget. Much higher because the fix dispatch
    # has to re-emit the full spec/plan between markers, which scales with
    # artifact size × finding count. 900s comfortably fits ~35k-token
    # rewrites on Opus; smaller rewrites finish in a fraction of that.
    "fix_timeout": 900,
}
DEFAULT_FORGED_REVIEW = {
    "forge_threshold": 4,
    "max_rounds": 3,
    "domain_pairs": {
        "architecture":          {"leader": "claude", "second": "codex"},
        "accessibility":         {"leader": "claude", "second": "gemini"},
        "correctness":           {"leader": "codex",  "second": "claude"},
        "type-safety":           {"leader": "codex",  "second": "gemini"},
        "security":              {"leader": "gemini", "second": "codex"},
        "test-coverage":         {"leader": "codex",  "second": "gemini"},
        "spec-conformance":      {"leader": "claude", "second": "codex"},
        "ui-design-conformance": {"leader": "gemini", "second": "claude"},
        "regression-prevention": {"leader": "gemini", "second": "claude"},
    },
    "always_on_domains": ["correctness", "regression-prevention"],
    "triage_agent": "claude",
    "delta_rereview": True,
    "auto_merge_when_clean": True,
}
DEFAULT_RED_TEAM = {
    "enabled": True,
    "agent": "codex",
    "model": "o3",
    "max_rounds": 2,
    "halt_on_unresolved": True,
    "stages": {
        "design": {"enabled": True},
        "plan": {"enabled": False},
    },
    "personas": [
        "security-trust",
        "reliability-distsys",
        "data",
        "product-dx",
        "cost-ops",
    ],
    "min_severity_to_block": "high",
    "timeout_s": 900,
    "per_run_budget_usd": 10.00,
    "stability_overlap_jaccard_min": 0.4,
    "max_input_chars": 200_000,
    "allow_human_review_halt": True,
}

DEFAULT_MODEL_RATES = {
    "o3": {"input_per_1m_usd": 15.00, "output_per_1m_usd": 60.00},
    "claude-opus-4-7": {"input_per_1m_usd": 15.00, "output_per_1m_usd": 75.00},
    "gpt-5.5": {"input_per_1m_usd": 5.00, "output_per_1m_usd": 15.00},
    "_fallback": {"input_per_1m_usd": 100.00, "output_per_1m_usd": 300.00},
}

# rt1 — locked fields cannot be overridden below the global config level
_RED_TEAM_LOCKED_FIELDS: frozenset[str] = frozenset({"personas", "model"})


def _warn(message: str) -> None:
    print(f"config_loader: {message}", file=sys.stderr)


def _merge_dict(defaults: dict[str, Any], overrides: Any) -> dict[str, Any]:
    """Deep-merge *overrides* into a copy of *defaults*.

    Nested dicts are merged recursively so that partial overrides
    (e.g. ``{"claude": {"enabled": false}}``) don't clobber sibling
    keys in the defaults (e.g. ``model_id``).
    """
    merged = deepcopy(defaults)
    if overrides is None:
        return merged
    if not isinstance(overrides, dict):
        _warn(f"expected dict override, got {type(overrides).__name__!r} — using defaults")
        return merged
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


_SECTION_DEFAULTS: dict[str, dict[str, Any]] = {
    "models": DEFAULT_MODELS,
    "runtime": DEFAULT_RUNTIME,
    "self_heal": DEFAULT_SELF_HEAL,
    "validation_gate": DEFAULT_VALIDATION_GATE,
    "skill_activation": DEFAULT_SKILL_ACTIVATION,
    "context_compaction": DEFAULT_CONTEXT_COMPACTION,
    "cost": DEFAULT_COST,
    "forge": DEFAULT_FORGE,
    "forged_review": DEFAULT_FORGED_REVIEW,
    "red_team": DEFAULT_RED_TEAM,
    "model_rates": DEFAULT_MODEL_RATES,
}


def _get_section(key: str) -> dict[str, Any]:
    return _merge_dict(_SECTION_DEFAULTS[key], load_config().get(key))


def get_models_config() -> dict[str, Any]:           return _get_section("models")
def get_runtime_config() -> dict[str, Any]:          return _get_section("runtime")
def get_self_heal_config() -> dict[str, Any]:        return _get_section("self_heal")
def get_validation_gate_config() -> dict[str, Any]:  return _get_section("validation_gate")
def get_skill_activation_config() -> dict[str, Any]: return _get_section("skill_activation")
def get_context_compaction_config() -> dict[str, Any]: return _get_section("context_compaction")
def get_cost_config() -> dict[str, Any]:             return _get_section("cost")
def get_forge_config() -> dict[str, Any]:            return _get_section("forge")
def get_forged_review_config() -> dict[str, Any]:    return _get_section("forged_review")


def get_red_team_config() -> dict[str, Any]:
    """Return merged red_team config with locked-field override rejection.

    Two-layer defense (spec rt1):
    1. _RED_TEAM_LOCKED_FIELDS (personas, model) are authoritative in the
       global config file and cannot be overridden at org/repo levels.
    2. Any top-level override key NOT present in DEFAULT_RED_TEAM is also
       dropped. This prevents an attacker from smuggling unrecognized fields
       into the merged config that future code might inadvertently read.
       Only the explicitly-defined config surface is acceptable.
    """
    global_cfg = load_config()
    merged = _merge_dict(DEFAULT_RED_TEAM, global_cfg.get("red_team"))

    for cfg_path in _find_red_team_override_chain():
        layer = _load_json_file(cfg_path)
        raw_override = layer.get("red_team")
        if raw_override is None:
            continue
        if not isinstance(raw_override, dict):
            _warn(
                f"expected object at red_team in {cfg_path}, got "
                f"{type(raw_override).__name__!r} — ignoring layer"
            )
            continue
        filtered = _strip_locked_fields(
            raw_override,
            _RED_TEAM_LOCKED_FIELDS,
            "red_team",
            source=str(cfg_path),
        )
        pruned = _prune_unknown_keys(
            filtered,
            set(DEFAULT_RED_TEAM.keys()),
            "red_team",
            source=str(cfg_path),
        )
        merged = _merge_dict(merged, pruned)

    return merged


def get_model_rates() -> dict[str, Any]:
    return _get_section("model_rates")


def _find_red_team_override_chain(cwd: Path | None = None) -> list[Path]:
    """Return repo/org .code-review/config.json files for the current cwd.

    The global config at CONFIG_PATH is authoritative for locked red_team
    fields, so only lower-precedence org/repo layers are returned here.
    """
    if cwd is None:
        cwd = Path.cwd()

    chain: list[Path] = []
    home = Path.home().resolve()
    current = cwd.resolve()
    while current != home and current != current.parent:
        cfg = current / ".code-review" / "config.json"
        if cfg.exists():
            chain.append(cfg)
        current = current.parent
    return list(reversed(chain))


def _load_json_file(path: Path) -> dict[str, Any]:
    try:
        with path.open("r", encoding="utf-8") as handle:
            loaded = json.load(handle)
    except (OSError, json.JSONDecodeError) as exc:
        _warn(f"failed to load {path}: {exc}")
        return {}
    if not isinstance(loaded, dict):
        _warn(f"expected top-level object in {path}")
        return {}
    return loaded


def _strip_locked_fields(
    override: dict[str, Any],
    locked: frozenset[str],
    section_name: str,
    *,
    source: str | None = None,
) -> dict[str, Any]:
    """Remove locked fields from an override dict with a warning to stderr."""
    cleaned = {}
    for k, v in override.items():
        if k in locked:
            source_suffix = f" in {source}" if source else ""
            _warn(
                f"{section_name}.{k} is locked to global config and cannot be "
                f"overridden{source_suffix} — rejecting override value {v!r}"
            )
        else:
            cleaned[k] = v
    return cleaned


def _prune_unknown_keys(
    override: dict[str, Any],
    known_keys: set[str],
    section_name: str,
    *,
    source: str | None = None,
) -> dict[str, Any]:
    """Drop top-level keys not present in the default schema with a warning.

    Defense-in-depth against config injection of unrecognized keys that
    future code might inadvertently consume.
    """
    cleaned = {}
    for k, v in override.items():
        if k not in known_keys:
            source_suffix = f" in {source}" if source else ""
            _warn(
                f"{section_name}.{k} is not a known config key and will be "
                f"ignored{source_suffix} — drop it from your config or add it "
                f"to the schema"
            )
        else:
            cleaned[k] = v
    return cleaned


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
