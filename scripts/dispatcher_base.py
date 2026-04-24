#!/usr/bin/env python3
"""Shared base for multi-agent dispatcher scripts.

Provides:
- DEFAULT_CONFIG and merge-field sets
- _deep_merge / _find_config_chain / discover_config
- resolve_model (public alias for _resolve_model)
- AGENTS dict (agent name → app/emoji/label)
- is_agent_enabled (re-exported from config_loader)
- discover_domains(prompts_dir, agents) — scans [0-9]*.md in agent dirs then domains/
- resolve_prompt(agent, filename, prompts_dir, repo_dir, repo_subdir) — agent → domains/ fallback

These are the patterns shared across:
  multi_review.py, plan_review_dispatch.py, design_to_plan_dispatch.py, autopilot_dispatch.py
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import Any

try:
    from claude_utils import CLAUDE_MODEL
except ImportError:  # pragma: no cover - available at runtime
    CLAUDE_MODEL = "claude-opus-4-7"

try:
    from codex_utils import CODEX_MODEL
except ImportError:  # pragma: no cover - available at runtime
    CODEX_MODEL = "gpt-4o"

try:
    from gemini_utils import GEMINI_MODEL
except ImportError:  # pragma: no cover - available at runtime
    GEMINI_MODEL = "gemini-3.1-pro-preview"

try:
    from config_loader import get_model_id as _config_get_model_id, is_agent_enabled
except ImportError:  # pragma: no cover - backward compat for older installs
    def _config_get_model_id(agent: str) -> str | None:  # type: ignore[misc]
        return None

    def is_agent_enabled(agent: str) -> bool:  # type: ignore[misc]
        return True


# ── Agent definitions ─────────────────────────────────────────────────

_ALL_AGENTS: dict[str, dict[str, str]] = {
    "claude": {
        "app": "stark-claude",
        "emoji": "\U0001f9e0",
        "label": "Claude",
    },
    "codex": {
        "app": "stark-codex",
        "emoji": "\U0001f4bb",
        "label": "Codex",
    },
    "gemini": {
        "app": "stark-gemini",
        "emoji": "\u2728",
        "label": "Gemini",
    },
}

AGENTS: dict[str, dict[str, str]] = {
    agent: cfg for agent, cfg in _ALL_AGENTS.items() if is_agent_enabled(agent)
}
if not AGENTS:
    AGENTS = dict(_ALL_AGENTS)


# ── Hierarchical config ───────────────────────────────────────────────

DEFAULT_CONFIG: dict[str, Any] = {
    "agents": ["claude", "codex", "gemini"],
    "fix_threshold": "medium",
    "test_command": None,
    "build_command": None,
    "verify_before_clean": True,
    "disabled_domains": [],
    "extra_domains": [],
    "context_files": [],
    "domain_agents": {},
    "severity_overrides": {},
    "github_apps": {
        "claude": "stark-claude",
        "codex": "stark-codex",
        "gemini": "stark-gemini",
    },
}

REPLACE_FIELDS: set[str] = {
    "agents",
    "fix_threshold",
    "test_command",
    "build_command",
    "verify_before_clean",
    "disabled_domains",
    "context_files",
}
ADDITIVE_FIELDS: set[str] = {"extra_domains"}
DEEP_MERGE_FIELDS: set[str] = {"severity_overrides", "github_apps", "domain_agents", "triage"}


def _deep_merge(base: dict, override: dict) -> dict:
    """Recursively merge *override* into a copy of *base*."""
    result = dict(base)
    for k, v in override.items():
        if k in result and isinstance(result[k], dict) and isinstance(v, dict):
            result[k] = _deep_merge(result[k], v)
        else:
            result[k] = v
    return result


def _find_config_chain(cwd: str, global_dir: str) -> list[Path]:
    """Walk from cwd up to ~ looking for .code-review/config.json, then global."""
    chain: list[Path] = []
    home = Path.home()
    current = Path(cwd).resolve()
    while current != home and current != current.parent:
        cfg = current / ".code-review" / "config.json"
        if cfg.exists():
            chain.append(cfg)
        current = current.parent
    global_cfg = Path(global_dir) / "config.json"
    if global_cfg.exists():
        chain.append(global_cfg)
    return chain


def discover_config(cwd: str | None = None, global_dir: str | None = None) -> dict:
    """Discover and merge config: repo → org → global."""
    if cwd is None:
        cwd = os.getcwd()
    if global_dir is None:
        global_dir = str(Path.home() / ".claude" / "code-review")

    chain = _find_config_chain(cwd, global_dir)
    merged: dict[str, Any] = dict(DEFAULT_CONFIG)
    for cfg_path in reversed(chain):
        try:
            layer = json.loads(cfg_path.read_text())
        except json.JSONDecodeError:
            continue
        except OSError as exc:
            print(f"dispatcher_base: cannot read {cfg_path}: {exc}", file=sys.stderr)
            continue
        for key, val in layer.items():
            if key in REPLACE_FIELDS:
                merged[key] = val
            elif key in ADDITIVE_FIELDS:
                existing = merged.get(key, [])
                if not isinstance(val, list):
                    val = [val] if val is not None else []
                merged[key] = list(set(existing) | set(val))
            elif key in DEEP_MERGE_FIELDS:
                merged[key] = _deep_merge(merged.get(key, {}), val)
            else:
                merged[key] = val
    return merged


# ── Model resolution ──────────────────────────────────────────────────


def resolve_model(agent: str) -> str:
    """Map an agent name to its configured model ID.

    Public API — use this instead of private _resolve_model in each dispatcher.
    """
    if agent == "claude":
        return _config_get_model_id(agent) or CLAUDE_MODEL
    if agent == "codex":
        return _config_get_model_id(agent) or CODEX_MODEL
    if agent == "gemini":
        return _config_get_model_id(agent) or GEMINI_MODEL
    raise ValueError(f"Unknown agent: {agent}")


# ── Domain discovery ─────────────────────────────────────────────────


def discover_domains(
    prompts_dir: str | Path,
    agents: list[str] | None = None,
) -> dict[str, dict[str, Any]]:
    """Discover domains from prompt files under *prompts_dir*.

    Scans the first agent directory (in *agents* order) that contains
    ``[0-9]*.md`` files, then merges in any additional domains from
    ``{prompts_dir}/domains/``.  Agent-specific files take priority over
    shared ones when both define the same domain slug.

    Args:
        prompts_dir: Base prompts directory (e.g. ``~/.claude/code-review/prompts/plan-review``).
        agents: Ordered list of agent names to check.  Defaults to ``["claude", "codex", "gemini"]``.

    Returns:
        Dict keyed by domain slug, e.g.::

            {
                "completeness": {
                    "order": "01",
                    "label": "Completeness",
                    "filename": "01-completeness.md",
                }
            }
    """
    if agents is None:
        agents = ["claude", "codex", "gemini"]

    prompts_path = Path(prompts_dir)
    domains: dict[str, dict[str, Any]] = {}

    for agent in agents:
        agent_dir = prompts_path / agent
        if not agent_dir.exists():
            continue
        for f in sorted(agent_dir.glob("[0-9]*.md")):
            key = f.stem.split("-", 1)[1] if "-" in f.stem else f.stem
            if key not in domains:
                domains[key] = {
                    "order": f.stem.split("-")[0] if "-" in f.stem else "99",
                    "label": key.replace("-", " ").title(),
                    "filename": f.name,
                }
        if domains:
            break

    # Always merge shared domains/ directory (agent-specific files take priority)
    shared_dir = prompts_path / "domains"
    if shared_dir.exists():
        for f in sorted(shared_dir.glob("[0-9]*.md")):
            key = f.stem.split("-", 1)[1] if "-" in f.stem else f.stem
            if key not in domains:
                domains[key] = {
                    "order": f.stem.split("-")[0] if "-" in f.stem else "99",
                    "label": key.replace("-", " ").title(),
                    "filename": f.name,
                }

    return domains


# ── Prompt resolution ─────────────────────────────────────────────────


def resolve_prompt(
    agent: str,
    filename: str,
    prompts_dir: str | Path,
    repo_dir: str | None = None,
    repo_subdir: str = "prompts",
) -> str:
    """Resolve a prompt file from repo override → global agent dir → global domains/.

    Resolution order:
        1. ``{repo_dir}/.code-review/{repo_subdir}/{agent}/{filename}``
        2. ``{prompts_dir}/{agent}/{filename}``
        3. ``{prompts_dir}/domains/{filename}``   (shared, agent-agnostic)

    Args:
        agent: Agent name (``"claude"``, ``"codex"``, ``"gemini"``).
        filename: Prompt filename, e.g. ``"agent.md"`` or ``"01-architecture.md"``.
        prompts_dir: Global prompts base directory for this skill
            (e.g. ``~/.claude/code-review/prompts/plan-review``).
        repo_dir: Repository root to check for repo-level overrides.  When
            ``None``, the repo override step is skipped.
        repo_subdir: Sub-directory under ``{repo_dir}/.code-review/`` that
            contains the per-agent prompt overrides.  Defaults to ``"prompts"``
            so repo paths become ``{repo_dir}/.code-review/prompts/{agent}/{filename}``.
            Pass e.g. ``"plan-prompts"`` for plan-review overrides.

    Returns:
        The prompt text, or ``""`` if no file was found.
    """
    # 1. Repo-level override
    if repo_dir:
        repo_path = Path(repo_dir) / ".code-review" / repo_subdir / agent / filename
        if repo_path.exists():
            return repo_path.read_text().strip()

    # 2. Global agent-specific path
    global_path = Path(prompts_dir) / agent / filename
    if global_path.exists():
        return global_path.read_text().strip()

    # 3. Shared domains/ fallback
    domains_path = Path(prompts_dir) / "domains" / filename
    if domains_path.exists():
        return domains_path.read_text().strip()

    return ""
