#!/usr/bin/env python3
from __future__ import annotations

import json
import sys
from copy import deepcopy
from functools import lru_cache
from pathlib import Path
from typing import Any

CONFIG_PATH = Path.home() / ".claude" / "code-review" / "config.json"

try:  # emit_queue is best-effort — config loading must not fail if it's
    # unavailable (e.g. partial install, missing optional dep). Tests
    # monkeypatch _EMIT_QUEUE to capture events.
    import emit_queue as _EMIT_QUEUE  # type: ignore[assignment]
except ImportError:  # pragma: no cover
    _EMIT_QUEUE = None  # type: ignore[assignment]

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
        "completeness": "claude",
        "security": "codex",
        "scope": "claude",
        "api-design": "codex",
        "data-modeling": "codex",
        "consistency": "claude",
        "accessibility": "claude",
        "test-plan": "codex",
    },
    "plan_review_routing": {
        "completeness": "claude",
        "security": "codex",
        "sequencing": "claude",
        "viability": "codex",
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
        "behavior":              {"leader": "codex",  "second": "claude"},
        "type-safety":           {"leader": "codex",  "second": "gemini"},
        "security":              {"leader": "gemini", "second": "codex"},
        "test-coverage":         {"leader": "codex",  "second": "gemini"},
        "spec-conformance":      {"leader": "claude", "second": "codex"},
    },
    "always_on_domains": ["behavior"],
    "triage_agent": "claude",
    "delta_rereview": True,
    "auto_merge_when_clean": True,
}
DEFAULT_RED_TEAM = {
    "enabled": True,
    "agent": "codex",
    # gpt-5.5-pro is the default red-team model (was o3 in v0). Substantive
    # comparison on the spec fixture: gpt-5.5-pro caught structurally
    # important findings o3 missed (lock-surface meta-finding, fail-open
    # `clean` semantics, round-local-ID identity bug). See
    # docs/calibration/2026-04-27-red-team-v1-calibration-{o3,gpt-5-5-pro}.findings.json
    # for the side-by-side. Both transports verified live via Responses API.
    "model": "gpt-5.5-pro",
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
    # Sized for gpt-5.5-pro at ~$2/round × 2 rounds + verification + design
    # regen, with ~50% headroom. Tighten once 5–10 calibration runs land.
    "per_run_budget_usd": 30.00,
    "stability_overlap_jaccard_min": 0.4,
    "max_input_chars": 200_000,
    "allow_human_review_halt": True,
    "fix_plan": {
        "enabled": False,
        "model": "gpt-5.5-pro",
        "reasoning_effort": "xhigh",
        "timeout_s": 1200,
        "min_moves": 2,
        "max_moves": 6,
        "max_input_chars": 200_000,
    },
    # FU-rt6 — Raw finding text is sensitive audit data. Default is to store a
    # short redacted excerpt + SHA-256 hash; full-text retention requires an
    # explicit org/repo policy flag. Excerpt length is capped to keep
    # accidental secret echoes short. Both fields are locked so a downstream
    # repo cannot silently re-enable full-text retention.
    "audit": {
        "retain_full_text": False,
        "excerpt_max_chars": 240,
    },
}

DEFAULT_MODEL_RATES = {
    "o3": {"input_per_1m_usd": 15.00, "output_per_1m_usd": 60.00},
    "claude-opus-4-7": {"input_per_1m_usd": 15.00, "output_per_1m_usd": 75.00},
    "gpt-5.4": {"input_per_1m_usd": 5.00, "output_per_1m_usd": 15.00},
    "gpt-5.5": {"input_per_1m_usd": 5.00, "output_per_1m_usd": 15.00},
    # rt_b7 — pro-tier rates required for red_team preflight when
    # red_team.model is gpt-5.{4,5}-pro. Placeholders within the published
    # pro-tier band; verify against OpenAI's pricing page before relying
    # on cost ceilings.
    "gpt-5.4-pro": {"input_per_1m_usd": 20.00, "output_per_1m_usd": 80.00},
    "gpt-5.5-pro": {"input_per_1m_usd": 25.00, "output_per_1m_usd": 100.00},
    "_fallback": {"input_per_1m_usd": 100.00, "output_per_1m_usd": 300.00},
}

# rt1 + rt2 — locked fields cannot be overridden below the global config
# level. Originally this was just {personas, model} (rt1: prevent silent
# prompt-source swaps and silent model downgrades). The 2026-04-27 red-team
# review (rt2) flagged that locking only those two left the substance-vs-
# appearance failure mode wide open in other dimensions: a compromised repo
# could still make the gate non-blocking by setting `enabled: false`,
# `halt_on_unresolved: false`, or raising `min_severity_to_block` past
# every real finding, while the audit log still showed an intentional
# configuration change rather than an attempted bypass.
#
# Each lock has the same justification as the original two: it preserves
# substance. A repo that needs a stricter posture (e.g. a security-critical
# repo wanting to block on "medium") opens a PR against stark-skills to set
# the global default — same friction as a legitimate persona addition. A
# repo that wants a *weaker* posture is the failure mode we're locking out.
_RED_TEAM_LOCKED_FIELDS: frozenset[tuple[str, ...]] = frozenset({
    ("personas",),
    ("model",),
    ("enabled",),
    ("agent",),
    ("min_severity_to_block",),
    ("halt_on_unresolved",),
    ("allow_human_review_halt",),
    # Locking the whole `stages` dict closes the round-1 review bypass:
    # without it, a repo could disable a globally-enabled stage via
    # `stages.design.enabled: false` and skip the gate entirely. Adding a
    # new stage now requires a global config change — same friction as a
    # legitimate persona addition.
    ("stages",),
    ("fix_plan", "enabled"),
    ("fix_plan", "model"),
    ("fix_plan", "reasoning_effort"),
    ("fix_plan", "min_moves"),
    ("fix_plan", "max_moves"),
    # FU-rt6 — Lock retention posture. A compromised repo flipping
    # ``audit.retain_full_text`` back to True would silently turn the
    # metrics DB into a sensitive-document store. ``excerpt_max_chars``
    # is locked alongside (PR #430 review finding #8) — without it, a
    # repo could set the cap to 999_999 and persist nearly-full raw text
    # under "excerpt" mode, defeating the redaction split.
    ("audit", "retain_full_text"),
    ("audit", "excerpt_max_chars"),
})


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
    section_name: str,
    *,
    source: str | None = None,
) -> dict[str, Any]:
    """Remove locked fields from an override dict.

    Each rejection produces both a stderr warning (operator visibility) and
    a `red_team.config.override_rejected` audit event (so a downstream
    audit pipeline can detect bypass attempts that an operator might miss
    in the noise of routine config loading). The event payload is
    deliberately minimal and avoids embedding the override value, since
    that value is attacker-controlled in the threat model and we don't
    want to round-trip it through the durable event queue.
    """
    cleaned, rejected_paths = _drop_locked_overrides(override)
    for path in rejected_paths:
        source_suffix = f" in {source}" if source else ""
        _warn(
            f"{section_name}.{path} is locked to global config and cannot be "
            f"overridden{source_suffix}"
        )
        _emit_override_rejected(section_name, path.split(".")[-1], source, path=path)
    return cleaned


_RED_TEAM_LOCKED_PARENTS: frozenset[tuple[str, ...]] = frozenset(
    p[: i + 1]
    for p in _RED_TEAM_LOCKED_FIELDS
    for i in range(len(p) - 1)
)


def _drop_locked_overrides(
    override: dict[str, Any],
    base_path: tuple[str, ...] = (),
) -> tuple[dict[str, Any], list[str]]:
    """Drop locked dotted paths from a lower-precedence red_team override.

    A locked PARENT (e.g. ``fix_plan``) whose override value is not a dict
    is also rejected: a non-dict override would replace the entire locked
    structure (and its locked children) wholesale, defeating the lock.
    """
    cleaned: dict[str, Any] = {}
    rejected_paths: list[str] = []
    for key, value in override.items():
        path = (*base_path, key)
        if path in _RED_TEAM_LOCKED_FIELDS:
            rejected_paths.append(".".join(path))
            continue
        if path in _RED_TEAM_LOCKED_PARENTS and not isinstance(value, dict):
            # e.g. setting `fix_plan: "off"` would replace the dict and
            # bypass the per-leaf lock checks that follow. Reject the
            # entire override at this path.
            rejected_paths.append(".".join(path))
            continue
        if isinstance(value, dict):
            nested, nested_rejected = _drop_locked_overrides(value, path)
            cleaned[key] = nested
            rejected_paths.extend(nested_rejected)
        else:
            cleaned[key] = value
    return cleaned, rejected_paths


def _emit_override_rejected(
    section_name: str, field: str, source: str | None, *, path: str | None = None,
) -> None:
    if _EMIT_QUEUE is None:
        return
    try:
        event = _EMIT_QUEUE.make_event(
            "red_team_override_rejected",
            {
                "section": section_name,
                "field": field,
                "path": path or field,
                "source": source or "",
            },
        )
        _EMIT_QUEUE.enqueue(event)
    except Exception as exc:  # noqa: BLE001 — emitting must never break load
        _warn(f"failed to enqueue override_rejected event: {exc}")


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
