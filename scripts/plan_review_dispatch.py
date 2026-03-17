#!/usr/bin/env python3
"""Plan/spec document review dispatch — parallel multi-agent review orchestrator.

Runs 3 CLI agents (Claude, Codex, Gemini) × N domain specializations for
reviewing plan and specification documents (not code PRs).

Prompts loaded from ~/.claude/code-review/prompts/plan-review/{agent}/
with repo-level overrides from .code-review/plan-prompts/{agent}/.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

# ── Config ──────────────────────────────────────────────────────────────

SCRIPTS_DIR = Path(__file__).parent
GLOBAL_PROMPTS_DIR = Path.home() / ".claude" / "code-review" / "prompts" / "plan-review"

AGENTS = ["claude", "codex", "gemini"]

FINDINGS_FORMAT = (
    "Output findings as a JSON array. Each finding: "
    '{"severity": "critical|high|medium|low", "section": "section name or heading", '
    '"title": "short title", "description": "what is wrong", '
    '"suggestion": "how to fix it"}. '
    "If no issues found, return an empty array []. "
    "Output ONLY the JSON array, no other text."
)

DEFAULT_TIMEOUT = 300



@dataclass
class PlanFinding:
    agent: str
    domain: str
    severity: str
    section: str
    title: str
    description: str
    suggestion: str


@dataclass
class PlanSubAgentResult:
    agent: str
    domain: str
    raw_output: str = ""
    findings: list[PlanFinding] = field(default_factory=list)
    error: str | None = None
    duration_s: float = 0.0


DEFAULT_PLAN_REVIEW_CONFIG = {
    "agents": ["claude", "codex", "gemini"],
    "fix_threshold": "medium",
    "disabled_domains": [],
    "max_rounds": 3,
}


# ── Prompt loading ─────────────────────────────────────────────────────


def resolve_plan_prompt(
    agent: str,
    filename: str,
    repo_dir: str | None = None,
    global_prompts_dir: str | None = None,
) -> str:
    """Resolve a plan review prompt file: repo → global.

    Resolution order:
        1. {repo_dir}/.code-review/plan-prompts/{agent}/{filename}
        2. {global_prompts_dir}/{agent}/{filename}
    """
    # Check repo-level override
    if repo_dir:
        repo_path = Path(repo_dir) / ".code-review" / "plan-prompts" / agent / filename
        if repo_path.exists():
            return repo_path.read_text().strip()

    # Fall back to global
    if global_prompts_dir is None:
        global_prompts_dir = str(GLOBAL_PROMPTS_DIR)
    global_path = Path(global_prompts_dir) / agent / filename
    if global_path.exists():
        return global_path.read_text().strip()

    return ""


# ── Domain discovery ───────────────────────────────────────────────────


def _discover_plan_domains(
    global_prompts_dir: str | None = None,
) -> dict[str, dict[str, Any]]:
    """Discover plan review domains from prompt files.

    Scans the first agent directory found for [0-9]*.md files.
    Returns dict keyed by domain slug (e.g. "completeness").
    """
    if global_prompts_dir is None:
        global_prompts_dir = str(GLOBAL_PROMPTS_DIR)

    prompts_path = Path(global_prompts_dir)
    domains: dict[str, dict[str, Any]] = {}

    for agent in AGENTS:
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

    return domains


# ── Config loading ─────────────────────────────────────────────────────


def _load_plan_review_config(
    repo_dir: str | None = None,
    global_config_dir: str | None = None,
) -> dict[str, Any]:
    """Load plan_review section from config.json (repo → global).

    Checks:
        1. {repo_dir}/.code-review/config.json  → plan_review section
        2. {global_config_dir}/config.json       → plan_review section
    Merges onto DEFAULT_PLAN_REVIEW_CONFIG.
    """
    config = dict(DEFAULT_PLAN_REVIEW_CONFIG)

    if global_config_dir is None:
        global_config_dir = str(Path.home() / ".claude" / "code-review")

    # Load global first (lower priority)
    global_cfg_path = Path(global_config_dir) / "config.json"
    if global_cfg_path.exists():
        try:
            data = json.loads(global_cfg_path.read_text())
            plan_section = data.get("plan_review", {})
            config.update(plan_section)
        except (json.JSONDecodeError, OSError):
            pass

    # Load repo config (higher priority, overwrites global)
    if repo_dir:
        repo_cfg_path = Path(repo_dir) / ".code-review" / "config.json"
        if repo_cfg_path.exists():
            try:
                data = json.loads(repo_cfg_path.read_text())
                plan_section = data.get("plan_review", {})
                config.update(plan_section)
            except (json.JSONDecodeError, OSError):
                pass

    return config


# ── Sub-agent dispatch ────────────────────────────────────────────────


def _parse_plan_findings(
    agent: str, domain: str, raw: str,
) -> list[PlanFinding]:
    """Parse JSON array of findings from raw agent output.

    Strips markdown fences and locates the outermost JSON array brackets.
    Returns [] on any parse failure.
    """
    text = raw.strip()
    # Strip markdown code fences
    if text.startswith("```"):
        lines = text.splitlines()
        # Remove first and last fence lines
        if lines and lines[0].startswith("```"):
            lines = lines[1:]
        if lines and lines[-1].strip() == "```":
            lines = lines[:-1]
        text = "\n".join(lines).strip()

    # Find outermost [ ... ]
    start = text.find("[")
    end = text.rfind("]")
    if start == -1 or end == -1 or end <= start:
        return []

    try:
        items = json.loads(text[start : end + 1])
    except (json.JSONDecodeError, ValueError):
        return []

    if not isinstance(items, list):
        return []

    findings = []
    for item in items:
        if not isinstance(item, dict):
            continue
        findings.append(
            PlanFinding(
                agent=agent,
                domain=domain,
                severity=item.get("severity", "medium"),
                section=item.get("section", ""),
                title=item.get("title", ""),
                description=item.get("description", ""),
                suggestion=item.get("suggestion", ""),
            )
        )
    return findings


def _run_plan_subagent(
    agent: str,
    domain_key: str,
    plan_content: str,
    prompt_text: str = "",
    timeout: int = DEFAULT_TIMEOUT,
) -> PlanSubAgentResult:
    """Run a single sub-agent CLI and return parsed results.

    Builds the appropriate CLI command per agent, captures output,
    parses findings JSON, and handles timeouts / missing agents.
    """
    full_prompt = f"{prompt_text}\n\n{plan_content}".strip() if prompt_text else plan_content
    result = PlanSubAgentResult(agent=agent, domain=domain_key)

    # Build CLI command per agent
    if agent == "claude":
        cmd = [
            "claude", "-p", full_prompt,
            "--output-format", "text",
            "--model", "claude-opus-4-6",
            "--max-tokens", "16384",
        ]
    elif agent == "codex":
        cmd = ["codex", "--effort", "xhigh", "-p", full_prompt]
    elif agent == "gemini":
        cmd = ["gemini", "--model", "gemini-2.5-pro", "-p", full_prompt]
    else:
        result.error = "unknown_agent"
        return result

    t0 = time.monotonic()
    try:
        proc = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=timeout,
        )
        result.raw_output = proc.stdout or ""
    except subprocess.TimeoutExpired:
        result.duration_s = time.monotonic() - t0
        result.error = "timeout"
        return result
    except FileNotFoundError:
        result.duration_s = time.monotonic() - t0
        result.error = "agent_unavailable"
        return result

    result.duration_s = time.monotonic() - t0
    result.findings = _parse_plan_findings(agent, domain_key, result.raw_output)

    # If we got non-trivial output but couldn't parse findings, flag it
    if not result.findings and result.raw_output.strip() and result.raw_output.strip() != "[]":
        result.error = "parse_error"

    return result
