#!/usr/bin/env python3
"""Multi-agent PR review orchestrator.

Runs 3 CLI agents (Claude, Codex, Gemini) × 6 domain specializations = 18
parallel sub-agent reviews. Each agent posts a consolidated review via its
GitHub App, grouped by domain.

Architecture:
    multi_review.py (orchestrator)
    ├── claude × 6 domains  → stark-claude bot
    ├── codex  × 6 domains  → stark-codex bot
    └── gemini × 6 domains  → stark-gemini bot

Prompts loaded from ~/.claude/code-review/prompts/{agent}/ (with repo/org overrides):
    agent.md          Agent-specific preamble
    01-architecture   Architecture & design patterns
    02-accessibility   WCAG 2.1 AA compliance
    03-correctness    Correctness & logic bugs
    04-type-safety    TypeScript types & API surface
    05-security       Security & error handling
    06-test-coverage  Test coverage & quality

Usage:
    multi_review.py --pr 10
    multi_review.py --pr 10 --repo GetEvinced/design-system-core --base main
    multi_review.py --all-repos ~/git/Evinced/design-system-core ~/git/Evinced/infra-pulse
    multi_review.py --pr 10 --dry-run
    multi_review.py --pr 10 --json
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

from claude_utils import CLAUDE_MODEL, build_claude_cmd
from codex_utils import CODEX_MODEL, CODEX_REASONING_EFFORT_HIGH, parse_jsonl_output
from gemini_utils import (
    GEMINI_MODEL, get_gemini_api_key, log_api_key_fallback,
    setup_gemini_home, make_gemini_env, parse_json_output as parse_gemini_output,
)

# ── Config ──────────────────────────────────────────────────────────────

_get_gemini_api_key = get_gemini_api_key  # backward compat alias
_log_api_key_fallback = log_api_key_fallback  # backward compat alias


SCRIPTS_DIR = Path(__file__).parent
PYTHON = str(SCRIPTS_DIR / ".venv" / "bin" / "python3")
GITHUB_APP = str(SCRIPTS_DIR / "github_app.py")
GLOBAL_PROMPTS_DIR = Path.home() / ".claude" / "code-review" / "prompts"

# Agent definitions — CLI tool + GitHub App mapping
AGENTS = {
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

# ── Hierarchical config ───────────────────────────────────────────────

DEFAULT_CONFIG = {
    "agents": ["claude", "codex", "gemini"],
    "fix_threshold": "medium",
    "test_command": None,
    "build_command": None,
    "verify_before_clean": True,
    "disabled_domains": [],
    "extra_domains": [],
    "severity_overrides": {},
    "github_apps": {
        "claude": "stark-claude",
        "codex": "stark-codex",
        "gemini": "stark-gemini",
    },
}

CODEX_REASONING_CONFIG = CODEX_REASONING_EFFORT_HIGH  # re-exported for backward compat

REPLACE_FIELDS = {
    "agents",
    "fix_threshold",
    "test_command",
    "build_command",
    "verify_before_clean",
    "disabled_domains",
}
ADDITIVE_FIELDS = {"extra_domains"}
DEEP_MERGE_FIELDS = {"severity_overrides", "github_apps"}


def _deep_merge(base: dict, override: dict) -> dict:
    result = dict(base)
    for k, v in override.items():
        if k in result and isinstance(result[k], dict) and isinstance(v, dict):
            result[k] = _deep_merge(result[k], v)
        else:
            result[k] = v
    return result


def _find_config_chain(cwd: str, global_dir: str) -> list[Path]:
    """Walk from cwd up to ~ looking for .code-review/config.json, then global."""
    chain = []
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
    """Discover and merge config: repo -> org -> global."""
    if cwd is None:
        cwd = os.getcwd()
    if global_dir is None:
        global_dir = str(Path.home() / ".claude" / "code-review")

    chain = _find_config_chain(cwd, global_dir)
    merged = dict(DEFAULT_CONFIG)
    for cfg_path in reversed(chain):
        try:
            layer = json.loads(cfg_path.read_text())
        except (json.JSONDecodeError, OSError):
            continue
        for key, val in layer.items():
            if key in REPLACE_FIELDS:
                merged[key] = val
            elif key in ADDITIVE_FIELDS:
                existing = merged.get(key, [])
                merged[key] = list(set(existing) | set(val))
            elif key in DEEP_MERGE_FIELDS:
                merged[key] = _deep_merge(merged.get(key, {}), val)
            else:
                merged[key] = val
    return merged


def _discover_domains() -> dict[str, dict[str, Any]]:
    """Discover domains from prompt files in any agent directory."""
    domains: dict[str, dict[str, Any]] = {}
    for agent in AGENTS:
        agent_dir = GLOBAL_PROMPTS_DIR / agent
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


DOMAINS = _discover_domains()



# ── Spec extraction ───────────────────────────────────────────────────


def extract_spec_link(pr_body: str | None) -> str | None:
    """Extract spec link from PR description. Returns path/URL, 'N/A', or None."""
    if not pr_body:
        return None
    match = re.search(r'##\s*Spec:\s*(.+)', pr_body)
    if not match:
        return None
    value = match.group(1).strip()
    if not value or value.startswith('<!--'):
        return None
    return value


def resolve_spec_content(spec_link: str, cwd: str) -> str | None:
    """Read spec file content. Returns content string or None if unresolvable."""
    if spec_link == "N/A":
        return None
    if spec_link.startswith("http"):
        return None
    spec_path = os.path.join(cwd, spec_link)
    if os.path.isfile(spec_path):
        with open(spec_path, 'r') as f:
            return f.read()
    return None


SEVERITY_ORDER = {"critical": 0, "high": 1, "medium": 2, "low": 3}
SEVERITY_ICONS = {
    "critical": "\U0001f534",
    "high": "\U0001f7e0",
    "medium": "\U0001f7e1",
    "low": "\U0001f535",
}

FINDINGS_FORMAT = (
    "Output findings as a JSON array. Each finding: "
    '{"severity": "critical|high|medium|low", "file": "path/to/file", '
    '"line": 42, "title": "short title", "description": "what is wrong", '
    '"suggestion": "how to fix it"}. '
    "If no issues found, return an empty array []. "
    "Output ONLY the JSON array, no other text."
)

MAX_WORKERS = 18  # 3 agents × 6 domains


# ── Data structures ────────────────────────────────────────────────────


@dataclass
class Finding:
    agent: str
    domain: str
    severity: str
    file: str
    line: int
    title: str
    description: str
    suggestion: str


@dataclass
class SubAgentResult:
    agent: str
    domain: str
    raw_output: str
    findings: list[Finding] = field(default_factory=list)
    error: str | None = None
    duration_s: float = 0.0
    api_key_fallback: bool = False


@dataclass
class ReviewRound:
    round_num: int
    results: list[SubAgentResult] = field(default_factory=list)
    tests_pass: bool = False
    test_output: str = ""


# ── Prompt loading ─────────────────────────────────────────────────────


def resolve_prompt(
    agent: str, filename: str, cwd: str | None = None, global_prompts_dir: str | None = None
) -> str:
    """Resolve a prompt file: repo → org → global."""
    if cwd is None:
        cwd = os.getcwd()
    if global_prompts_dir is None:
        global_prompts_dir = str(GLOBAL_PROMPTS_DIR)

    home = Path.home()
    current = Path(cwd).resolve()
    while current != home and current != current.parent:
        candidate = current / ".code-review" / "prompts" / agent / filename
        if candidate.exists():
            return candidate.read_text().strip()
        current = current.parent
    global_path = Path(global_prompts_dir) / agent / filename
    if global_path.exists():
        return global_path.read_text().strip()
    return ""


def _load_agent_preamble(agent: str, cwd: str | None = None) -> str:
    """Load the agent-specific preamble (agent.md)."""
    return resolve_prompt(agent, "agent.md", cwd=cwd)


def _load_domain_prompt(agent: str, domain_key: str, cwd: str | None = None) -> str:
    """Load the domain-specific review prompt for a given agent."""
    domain = DOMAINS.get(domain_key)
    if not domain:
        return f"Review this code for {domain_key} issues. {FINDINGS_FORMAT}"
    content = resolve_prompt(agent, domain["filename"], cwd=cwd)
    if content:
        return content
    for fallback_agent in AGENTS:
        if fallback_agent == agent:
            continue
        content = resolve_prompt(fallback_agent, domain["filename"], cwd=cwd)
        if content:
            print(
                f"  [!] Using {fallback_agent}'s prompt for {agent}/{domain_key}", file=sys.stderr
            )
            return content
    return f"Review this code for {domain_key} issues. {FINDINGS_FORMAT}"


# ── Repo detection ─────────────────────────────────────────────────────


def detect_repo(cwd: str | None = None) -> str:
    """Detect GitHub org/repo from git remote origin."""
    try:
        result = subprocess.run(
            ["git", "remote", "get-url", "origin"],
            capture_output=True,
            text=True,
            timeout=5,
            cwd=cwd,
        )
        if result.returncode != 0:
            return ""
        url = result.stdout.strip()
        m = re.match(r"git@[\w.-]+:(.+?)(?:\.git)?$", url)
        if m:
            return m.group(1)
        m = re.match(r"https://github\.com/(.+?)(?:\.git)?$", url)
        if m:
            return m.group(1)
    except (subprocess.TimeoutExpired, FileNotFoundError):
        pass
    return ""


def detect_base_branch(cwd: str | None = None) -> str:
    """Detect the base branch (main or master)."""
    try:
        result = subprocess.run(
            ["git", "rev-parse", "--verify", "main"],
            capture_output=True,
            text=True,
            timeout=5,
            cwd=cwd,
        )
        if result.returncode == 0:
            return "main"
        result = subprocess.run(
            ["git", "rev-parse", "--verify", "master"],
            capture_output=True,
            text=True,
            timeout=5,
            cwd=cwd,
        )
        if result.returncode == 0:
            return "master"
    except (subprocess.TimeoutExpired, FileNotFoundError):
        pass
    return "main"


def get_open_prs(repo: str) -> list[dict]:
    """Get open PRs for a repo using github_app.py."""
    token = _get_gh_token("stark-claude")
    env = {**os.environ, "GH_TOKEN": token}
    result = subprocess.run(
        ["gh", "api", f"repos/{repo}/pulls", "--jq", ".[].number"],
        capture_output=True,
        text=True,
        env=env,
        timeout=30,
    )
    if result.returncode != 0:
        return []
    numbers = [int(n) for n in result.stdout.strip().split("\n") if n.strip()]

    prs = []
    for num in numbers:
        pr_result = subprocess.run(
            ["gh", "api", f"repos/{repo}/pulls/{num}"],
            capture_output=True,
            text=True,
            env=env,
            timeout=30,
        )
        if pr_result.returncode == 0:
            prs.append(json.loads(pr_result.stdout))
    return prs


# ── GitHub App auth ────────────────────────────────────────────────────


def _get_gh_token(app: str) -> str:
    result = subprocess.run(
        [PYTHON, GITHUB_APP, "--app", app, "token"],
        capture_output=True,
        text=True,
        timeout=15,
    )
    if result.returncode != 0:
        raise RuntimeError(f"Failed to get token for {app}: {result.stderr}")
    return result.stdout.strip()


def post_review(repo: str, pr_number: int, app: str, body: str) -> bool:
    """Post a PR review comment via the specified GitHub App."""
    try:
        token = _get_gh_token(app)
    except RuntimeError as e:
        print(f"  [!] Auth failed for {app}: {e}", file=sys.stderr)
        return False

    env = {**os.environ, "GH_TOKEN": token}
    result = subprocess.run(
        [
            "gh",
            "api",
            f"repos/{repo}/pulls/{pr_number}/reviews",
            "--method",
            "POST",
            "-f",
            "event=COMMENT",
            "-f",
            f"body={body}",
        ],
        capture_output=True,
        text=True,
        env=env,
        timeout=30,
    )
    if result.returncode != 0:
        print(f"  [!] Failed to post review as {app}: {result.stderr}", file=sys.stderr)
        return False
    return True


# ── Findings parser ────────────────────────────────────────────────────


def _parse_findings(agent: str, domain: str, raw: str) -> list[Finding]:
    """Extract JSON findings from reviewer output."""
    cleaned = raw.strip()

    # Strip markdown fences anywhere in the text
    fence_match = re.search(r"```(?:json)?\s*\n(.*?)```", cleaned, re.DOTALL)
    if fence_match:
        cleaned = fence_match.group(1).strip()
    else:
        cleaned = re.sub(r"^```(?:json)?\s*\n?", "", cleaned)
        cleaned = re.sub(r"\n?```\s*$", "", cleaned)

    # Handle Gemini double-encoded JSON (escaped newlines/quotes inside a string)
    if "\\n" in cleaned and cleaned.startswith('"'):
        try:
            cleaned = json.loads(cleaned)
        except (json.JSONDecodeError, ValueError):
            pass

    match = re.search(r"\[.*\]", cleaned, re.DOTALL)
    if not match:
        return []

    try:
        items = json.loads(match.group(0))
    except json.JSONDecodeError:
        return []

    findings = []
    for item in items:
        if not isinstance(item, dict):
            continue
        findings.append(
            Finding(
                agent=agent,
                domain=domain,
                severity=item.get("severity", "medium").lower(),
                file=item.get("file", "unknown"),
                line=int(item.get("line", 0)),
                title=item.get("title", "Untitled"),
                description=item.get("description", ""),
                suggestion=item.get("suggestion", ""),
            )
        )
    return findings


def apply_severity_overrides(
    findings: list[Finding],
    overrides: dict[str, dict],
) -> list[Finding]:
    """Apply severity_overrides: findings below min_severity get downgraded to 'low'."""
    for f in findings:
        domain_override = overrides.get(f.domain)
        if not domain_override:
            continue
        min_sev = domain_override.get("min_severity")
        if min_sev and SEVERITY_ORDER.get(f.severity, 99) > SEVERITY_ORDER.get(min_sev, 99):
            f.severity = "low"
    return findings


# ── Sub-agent runners ──────────────────────────────────────────────────


def _run_subagent(
    agent: str,
    domain_key: str,
    base: str,
    cwd: str | None = None,
    spec_context: str | None = None,
) -> SubAgentResult:
    """Run a single sub-agent: one CLI tool × one domain."""
    t0 = time.time()
    preamble = _load_agent_preamble(agent, cwd=cwd)
    domain_prompt = _load_domain_prompt(agent, domain_key, cwd=cwd)
    if preamble and spec_context:
        full_prompt = f"{preamble}\n\n{spec_context}\n\n{domain_prompt}"
    elif preamble:
        full_prompt = f"{preamble}\n\n{domain_prompt}"
    elif spec_context:
        full_prompt = f"{spec_context}\n\n{domain_prompt}"
    else:
        full_prompt = domain_prompt

    stdin_input = None
    codex_output_file = None
    gemini_home = None

    if agent == "claude":
        prompt = (
            f"Run 'git diff {base}...HEAD' and read all changed files. "
            f"Then review them according to these instructions:\n\n"
            f"{full_prompt}"
        )
        cmd = build_claude_cmd()
        stdin_input = prompt

    elif agent == "codex":
        # Use `codex exec` (NOT `codex exec review`) to avoid triggering
        # Codex's built-in review skill which overrides our domain prompts.
        # --json emits JSONL to stdout; parsed below to extract agent text.
        prompt = (
            f"Run 'git diff {base}...HEAD' and read all changed files. "
            f"ONLY review files that appear in the diff. "
            f"Then review them according to these instructions:\n\n"
            f"{full_prompt}"
        )
        cmd = [
            "codex", "exec",
            "-m", CODEX_MODEL,
            "-c", CODEX_REASONING_CONFIG,
            "--ephemeral", "--json",
            "-s", "read-only",
            "-",
        ]
        stdin_input = prompt

    elif agent == "gemini":
        prompt = (
            f"Run 'git diff {base}...HEAD' and read all changed files. "
            f"ONLY review files that appear in the diff. "
            f"Then review them according to these instructions:\n\n"
            f"{full_prompt}"
        )
        effective_cwd = cwd or os.getcwd()
        gemini_home = setup_gemini_home(
            "gemini-review-", effective_cwd, "review", approval_mode="plan",
        )
        cmd = [
            "gemini",
            "-m", GEMINI_MODEL,
            "-p", prompt,
            "-o", "json",
        ]
        stdin_input = None

    else:
        return SubAgentResult(
            agent=agent,
            domain=domain_key,
            raw_output="",
            error=f"Unknown agent: {agent}",
            duration_s=0.0,
        )

    def _cleanup_temp():
        if codex_output_file and os.path.exists(codex_output_file):
            os.unlink(codex_output_file)
        if gemini_home and os.path.isdir(gemini_home):
            shutil.rmtree(gemini_home, ignore_errors=True)

    max_attempts = 2
    timeout_s = 900
    run_kwargs: dict[str, Any] = {
        "capture_output": True, "text": True,
        "timeout": timeout_s, "cwd": cwd,
    }
    if stdin_input is not None:
        run_kwargs["input"] = stdin_input
    if gemini_home:
        run_kwargs["env"] = make_gemini_env(gemini_home)

    used_api_key_fallback = False
    for attempt in range(1, max_attempts + 1):
        try:
            result = subprocess.run(cmd, **run_kwargs)

            if result.returncode != 0:
                stderr_snippet = result.stderr[:500]
                print(
                    f"  [{agent}:{domain_key}] CLI error (exit {result.returncode}): "
                    f"{stderr_snippet}",
                    file=sys.stderr,
                )
                # Gemini Vertex AI fallback: if auth/model error, retry with API key
                if (
                    agent == "gemini"
                    and attempt < max_attempts
                    and ("ModelNotFound" in stderr_snippet or "403" in stderr_snippet
                         or "PERMISSION_DENIED" in stderr_snippet)
                ):
                    api_key = _get_gemini_api_key()
                    if api_key and "env" in run_kwargs:
                        _log_api_key_fallback(agent, domain_key, stderr_snippet[:120])
                        run_kwargs["env"]["GEMINI_API_KEY"] = api_key
                        used_api_key_fallback = True
                        time.sleep(2)
                        continue
                if attempt < max_attempts:
                    backoff = 5 * attempt
                    print(
                        f"    {agent}:{domain_key} retrying in {backoff}s ({attempt}/{max_attempts})...",
                        file=sys.stderr,
                    )
                    time.sleep(backoff)
                    continue
                _cleanup_temp()
                return SubAgentResult(
                    agent=agent, domain=domain_key, raw_output="",
                    findings=[], error="cli_error",
                    duration_s=time.time() - t0,
                )

            raw = result.stdout

            if agent == "codex":
                raw = parse_jsonl_output(raw)

            if gemini_home:
                raw = parse_gemini_output(raw)
                _cleanup_temp()

            if not raw.strip():
                print(f"  [{agent}:{domain_key}] Empty output", file=sys.stderr)
                _cleanup_temp()
                return SubAgentResult(
                    agent=agent, domain=domain_key, raw_output="",
                    findings=[], error="empty_output",
                    duration_s=time.time() - t0,
                )

            findings = _parse_findings(agent, domain_key, raw)
            return SubAgentResult(
                agent=agent,
                domain=domain_key,
                raw_output=raw,
                findings=findings,
                duration_s=time.time() - t0,
                api_key_fallback=used_api_key_fallback,
            )
        except subprocess.TimeoutExpired:
            if attempt < max_attempts:
                print(
                    f"    {agent}:{domain_key} timed out, retrying ({attempt}/{max_attempts})...",
                    file=sys.stderr,
                )
                continue
            _cleanup_temp()
            return SubAgentResult(
                agent=agent,
                domain=domain_key,
                raw_output="",
                error=f"Timed out after {timeout_s}s (2 attempts)",
                duration_s=time.time() - t0,
            )
        except Exception as e:
            _cleanup_temp()
            return SubAgentResult(
                agent=agent,
                domain=domain_key,
                raw_output="",
                error=str(e),
                duration_s=time.time() - t0,
            )

    # Unreachable, but satisfies type checker
    return SubAgentResult(
        agent=agent, domain=domain_key, raw_output="",
        error="unexpected loop exit", duration_s=time.time() - t0,
    )


# ── Orchestration ──────────────────────────────────────────────────────


def run_review_round(
    base: str,
    round_num: int,
    agents: list[str] | None = None,
    domains: list[str] | None = None,
    cwd: str | None = None,
    out: Any = None,
    spec_context: str | None = None,
) -> ReviewRound:
    """Run one round of parallel reviews: agents × domains."""
    if out is None:
        out = sys.stdout
    if agents is None or domains is None:
        config = discover_config(cwd=cwd)
        if agents is None:
            agents = [a for a in config.get("agents", list(AGENTS.keys())) if a in AGENTS]
        if domains is None:
            disabled = set(config.get("disabled_domains", []))
            domains = [d for d in DOMAINS if d not in disabled]
    rnd = ReviewRound(round_num=round_num)

    total = len(agents) * len(domains)
    print(f"\n{'=' * 60}", file=out)
    print(
        f"  Review Round {round_num} — {len(agents)} agents × {len(domains)} domains = {total} sub-agents",
        file=out,
    )
    print(f"{'=' * 60}", file=out)

    with ThreadPoolExecutor(max_workers=min(total, MAX_WORKERS)) as pool:
        futures = {}
        for agent in agents:
            agent_cfg = AGENTS[agent]
            for domain_key in domains:
                domain_cfg = DOMAINS[domain_key]
                future = pool.submit(_run_subagent, agent, domain_key, base, cwd, spec_context)
                futures[future] = (agent, domain_key)
                print(
                    f"  [{agent_cfg['emoji']}] {agent} × {domain_cfg['label']}...",
                    file=out,
                )

        for future in as_completed(futures):
            agent, domain_key = futures[future]
            agent_cfg = AGENTS[agent]
            result = future.result()
            rnd.results.append(result)

            n = len(result.findings)
            crits = sum(1 for f in result.findings if f.severity == "critical")
            highs = sum(1 for f in result.findings if f.severity == "high")

            if result.error:
                print(
                    f"  [{agent_cfg['emoji']}] {agent} × {domain_key}: ERROR — {result.error}",
                    file=out,
                )
            else:
                print(
                    f"  [{agent_cfg['emoji']}] {agent} × {domain_key}: "
                    f"{n} findings ({crits}C/{highs}H) [{result.duration_s:.1f}s]",
                    file=out,
                )

    return rnd


def format_agent_review_body(agent: str, rnd: ReviewRound) -> str:
    """Format all domain findings for one agent as a GitHub PR review body."""
    agent_cfg = AGENTS[agent]
    agent_results = [r for r in rnd.results if r.agent == agent]
    if not agent_results:
        return ""

    lines = [
        f"## {agent_cfg['emoji']} {agent_cfg['label']} Review (Round {rnd.round_num})",
        "",
        f"*{len(agent_results)} domain sub-agents dispatched*",
        "",
    ]

    total_findings = sum(len(r.findings) for r in agent_results)
    if total_findings == 0 and not any(r.error for r in agent_results):
        lines.append("> No issues found across any domain.")
        return "\n".join(lines)

    # Group results by domain (sorted by domain order)
    agent_results.sort(key=lambda r: DOMAINS.get(r.domain, {}).get("order", "99"))

    for result in agent_results:
        domain_cfg = DOMAINS.get(result.domain, {"label": result.domain})
        lines.append(f"### {domain_cfg['label']}")
        lines.append("")

        if result.error:
            lines.append(f"> **Error:** {result.error}")
            lines.append("")
            continue

        if not result.findings:
            lines.append("> Clean.")
            lines.append("")
            continue

        # Group by severity
        by_severity: dict[str, list[Finding]] = {}
        for f in sorted(result.findings, key=lambda f: SEVERITY_ORDER.get(f.severity, 99)):
            by_severity.setdefault(f.severity, []).append(f)

        for sev, findings in by_severity.items():
            icon = SEVERITY_ICONS.get(sev, "\u26aa")
            for f in findings:
                loc = f"`{f.file}:{f.line}`" if f.line else f"`{f.file}`"
                lines.append(f"- {icon} **[{sev.upper()}]** {f.title} — {loc}")
                lines.append(f"  {f.description}")
                if f.suggestion:
                    lines.append(f"  > **Fix:** {f.suggestion}")
                lines.append("")

    return "\n".join(lines)


def format_summary_table(rounds: list[ReviewRound]) -> str:
    """Format the summary table across all rounds."""
    lines = [
        "| Round | Agent | Domain | Critical | High | Medium | Low | Duration |",
        "|-------|-------|--------|----------|------|--------|-----|----------|",
    ]
    for rnd in rounds:
        # Sort results by agent then domain
        sorted_results = sorted(
            rnd.results,
            key=lambda r: (r.agent, DOMAINS.get(r.domain, {}).get("order", "99")),
        )
        for result in sorted_results:
            counts = {"critical": 0, "high": 0, "medium": 0, "low": 0}
            for f in result.findings:
                counts[f.severity] = counts.get(f.severity, 0) + 1
            lines.append(
                f"| {rnd.round_num} | {result.agent} | {result.domain} | "
                f"{counts['critical']} | {counts['high']} | "
                f"{counts['medium']} | {counts['low']} | "
                f"{result.duration_s:.1f}s |"
            )

        # Round totals
        all_f = all_findings(rnd)
        tc = sum(1 for f in all_f if f.severity == "critical")
        th = sum(1 for f in all_f if f.severity == "high")
        tm = sum(1 for f in all_f if f.severity == "medium")
        tl = sum(1 for f in all_f if f.severity == "low")
        lines.append(
            f"| {rnd.round_num} | **TOTAL** | **all** | "
            f"**{tc}** | **{th}** | **{tm}** | **{tl}** | |"
        )

    return "\n".join(lines)


def _dedup_key(f: Finding) -> tuple[str, int, str]:
    """Generate a dedup key: (file, line_bucket, normalized_title).

    Line numbers within ±5 lines are bucketed together so that findings
    about the same location from different agents/domains collapse.
    """
    line_bucket = (f.line // 10) * 10  # bucket to nearest 10
    title_norm = re.sub(r"[^a-z0-9]+", " ", f.title.lower()).strip()
    return (f.file, line_bucket, title_norm)


def deduplicate_findings(findings: list[Finding]) -> list[Finding]:
    """Collapse duplicate findings across agents/domains.

    When multiple agents or domains report the same issue (same file,
    similar line, similar title), keep the highest-severity instance and
    append confirmation notes from the others.
    """
    groups: dict[tuple, list[Finding]] = {}
    for f in findings:
        key = _dedup_key(f)
        groups.setdefault(key, []).append(f)

    deduped: list[Finding] = []
    for group in groups.values():
        # Keep the highest-severity finding
        group.sort(key=lambda f: SEVERITY_ORDER.get(f.severity, 99))
        best = group[0]
        if len(group) > 1:
            confirmers = [f"{f.agent}/{f.domain}" for f in group[1:]]
            best.description += f" (also flagged by: {', '.join(confirmers)})"
        deduped.append(best)

    return sorted(deduped, key=lambda f: SEVERITY_ORDER.get(f.severity, 99))


def all_findings(rnd: ReviewRound) -> list[Finding]:
    """Get all findings from a round, deduplicated and sorted by severity."""
    findings = []
    for result in rnd.results:
        findings.extend(result.findings)
    return deduplicate_findings(findings)


def has_actionable_findings(rnd: ReviewRound) -> bool:
    """Check if a round has critical, high, or medium findings that need fixing."""
    return any(f.severity in ("critical", "high", "medium") for f in all_findings(rnd))


# ── Main ───────────────────────────────────────────────────────────────


def review_pr(
    repo: str,
    pr_number: int,
    base: str = "main",
    dry_run: bool = False,
    json_output: bool = False,
    json_only: bool = False,
    post_raw: bool = False,
    cwd: str | None = None,
) -> dict[str, Any]:
    """Run the full multi-agent review on a single PR."""
    out = sys.stderr if json_only else sys.stdout
    config = discover_config(cwd=cwd)
    active_agents = [a for a in config.get("agents", list(AGENTS.keys())) if a in AGENTS]
    disabled = set(config.get("disabled_domains", []))
    active_domains = [d for d in DOMAINS if d not in disabled]
    sev_overrides = config.get("severity_overrides", {})
    n_agents = len(active_agents)
    n_domains = len(active_domains)

    print(f"\n{'#' * 60}", file=out)
    print(f"  Multi-Agent Review: {repo} PR #{pr_number}", file=out)
    print(f"  Base: {base}", file=out)
    print(
        f"  {n_agents} agents × {n_domains} domains = {n_agents * n_domains} sub-agents", file=out
    )
    print(f"{'#' * 60}", file=out)

    if not DOMAINS:
        print("  [!] No domain prompt files found in:", GLOBAL_PROMPTS_DIR, file=sys.stderr)
        print("  [!] Expected files like 01-architecture.md", file=sys.stderr)
        sys.exit(1)

    # Fetch PR body and extract spec context
    pr_body = None
    try:
        token = _get_gh_token("stark-claude")
        env = {**os.environ, "GH_TOKEN": token}
        pr_meta = subprocess.run(
            ["gh", "api", f"repos/{repo}/pulls/{pr_number}", "--jq", ".body"],
            capture_output=True, text=True, env=env, timeout=30,
        )
        if pr_meta.returncode == 0:
            pr_body = pr_meta.stdout.strip() or None
    except Exception as e:
        print(f"  [!] Could not fetch PR body: {e}", file=sys.stderr)

    spec_link = extract_spec_link(pr_body)
    effective_cwd = cwd or os.getcwd()
    spec_content = resolve_spec_content(spec_link, effective_cwd) if spec_link else None

    if spec_content:
        spec_context = f"## Design Spec\nThe PR references this spec:\n\n{spec_content}"
    elif spec_link and spec_link != "N/A":
        spec_context = f"## Design Spec\nThe PR references a spec at `{spec_link}` but it could not be resolved. Flag this in your review."
    elif spec_link is None:
        spec_context = None  # Missing spec is a process issue, not a code issue — don't inject into domain prompts
    else:
        # N/A
        spec_context = None

    rounds: list[ReviewRound] = []
    round_num = 0

    while True:
        round_num += 1
        rnd = run_review_round(
            base, round_num, agents=active_agents, domains=active_domains, cwd=cwd, out=out,
            spec_context=spec_context,
        )
        rounds.append(rnd)

        if sev_overrides:
            for res in rnd.results:
                apply_severity_overrides(res.findings, sev_overrides)

        # Post per-agent raw findings to GitHub — one comment per agent under its bot identity.
        # Fires when: (a) not dry_run (normal mode), or (b) --post-raw (orchestrator mode where
        # the LLM skill handles the classified summary but raw data must land on the PR).
        if not dry_run or post_raw:
            print(f"\n  Posting per-agent findings to PR #{pr_number}...", file=out)
            for agent, agent_cfg in AGENTS.items():
                body = format_agent_review_body(agent, rnd)
                if body:
                    ok = post_review(repo, pr_number, agent_cfg["app"], body)
                    status = "posted" if ok else "FAILED"
                    print(f"    {agent_cfg['emoji']} {agent} → {status}", file=out)
                else:
                    # Post a status comment even for 0 findings / failed agents
                    agent_results = [r for r in rnd.results if r.agent == agent]
                    if any(r.error for r in agent_results):
                        errors = "; ".join(r.error for r in agent_results if r.error)
                        status_body = f"## {agent_cfg['emoji']} stark-{agent} review — round {rnd.round_num}\n\n⚠️ Agent failed: {errors}"
                    else:
                        status_body = f"## {agent_cfg['emoji']} stark-{agent} review — round {rnd.round_num}\n\nNo findings."
                    ok = post_review(repo, pr_number, agent_cfg["app"], status_body)
                    status = "posted (empty)" if ok else "FAILED"
                    print(f"    {agent_cfg['emoji']} {agent} → {status}", file=out)

        # Check for actionable findings (critical/high/medium)
        if not has_actionable_findings(rnd):
            print(
                f"\n  Round {round_num}: No critical/high/medium findings. Review clean.", file=out
            )
            break

        actionable = [f for f in all_findings(rnd) if f.severity in ("critical", "high", "medium")]
        print(f"\n  Round {round_num}: {len(actionable)} actionable findings to fix.", file=out)
        print("  Findings require fixing. Outputting for orchestrator...", file=out)
        break

    # Build final output
    output = {
        "repo": repo,
        "pr": pr_number,
        "base": base,
        "agents": list(AGENTS.keys()),
        "domains": list(DOMAINS.keys()),
        "rounds": [
            {
                "round": r.round_num,
                "results": [
                    {
                        "agent": res.agent,
                        "domain": res.domain,
                        "findings": [asdict(f) for f in res.findings],
                        "error": res.error,
                        "duration_s": res.duration_s,
                    }
                    for res in r.results
                ],
            }
            for r in rounds
        ],
        "summary": {
            "total_findings": sum(len(all_findings(r)) for r in rounds),
            "critical": sum(
                sum(1 for f in all_findings(r) if f.severity == "critical") for r in rounds
            ),
            "high": sum(sum(1 for f in all_findings(r) if f.severity == "high") for r in rounds),
            "medium": sum(
                sum(1 for f in all_findings(r) if f.severity == "medium") for r in rounds
            ),
            "clean": not has_actionable_findings(rounds[-1]) if rounds else False,
        },
    }

    if not json_output:
        print(f"\n{'=' * 60}", file=out)
        print("  Summary", file=out)
        print(f"{'=' * 60}", file=out)
        print(format_summary_table(rounds), file=out)
        print(file=out)

    return output


def main() -> None:
    parser = argparse.ArgumentParser(
        description=(
            "Multi-agent PR review orchestrator — "
            "3 agents (Claude, Codex, Gemini) × 6 domains = 18 parallel sub-agent reviews"
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "Examples:\n"
            "  %(prog)s --pr 10                     Review PR #10 in current repo\n"
            "  %(prog)s --pr 10 --dry-run            Review without posting to GitHub\n"
            "  %(prog)s --pr 10 --json               Output JSON for Claude Code\n"
            "  %(prog)s --all-repos ~/git/Evinced/*   Review all open PRs in repos\n"
        ),
    )

    target = parser.add_mutually_exclusive_group(required=True)
    target.add_argument("--pr", type=int, help="PR number to review")
    target.add_argument(
        "--all-repos",
        nargs="+",
        metavar="DIR",
        help="Directories of repos to scan for open PRs",
    )

    parser.add_argument("--repo", help="Override repo (org/name). Default: auto-detect")
    parser.add_argument("--base", help="Base branch. Default: auto-detect (main/master)")
    parser.add_argument("--dry-run", action="store_true", help="Don't post reviews to GitHub")
    parser.add_argument("--json", action="store_true", dest="json_output", help="Output JSON only")
    parser.add_argument(
        "--json-only",
        action="store_true",
        dest="json_only",
        help="Strict JSON mode: stdout is JSON payload only, all logs go to stderr",
    )
    parser.add_argument(
        "--post-raw",
        action="store_true",
        dest="post_raw",
        help="Post per-agent raw findings to PR even in --json-only mode. "
        "The orchestrator handles its own classified summary separately.",
    )

    args = parser.parse_args()

    if args.pr:
        repo = args.repo or detect_repo()
        if not repo:
            print("Could not detect repo. Use --repo.", file=sys.stderr)
            sys.exit(1)
        base = args.base or detect_base_branch()

        result = review_pr(
            repo,
            args.pr,
            base,
            dry_run=args.dry_run,
            json_output=args.json_output or args.json_only,
            json_only=getattr(args, "json_only", False),
            post_raw=getattr(args, "post_raw", False),
        )

        if args.json_output or args.json_only:
            print(json.dumps(result, indent=2))

    elif args.all_repos:
        all_results = []
        for repo_dir in args.all_repos:
            repo_dir = os.path.expanduser(repo_dir)
            if not os.path.isdir(repo_dir):
                print(f"  Skipping {repo_dir} (not a directory)", file=sys.stderr)
                continue

            repo = detect_repo(repo_dir)
            if not repo:
                print(f"  Skipping {repo_dir} (no git remote)", file=sys.stderr)
                continue

            base = detect_base_branch(repo_dir)
            print(f"\n  Scanning {repo} for open PRs...")
            prs = get_open_prs(repo)

            if not prs:
                print(f"  No open PRs in {repo}")
                continue

            for pr in prs:
                pr_num = pr["number"]
                print(f"  Found PR #{pr_num}: {pr['title']}")
                result = review_pr(
                    repo,
                    pr_num,
                    base,
                    dry_run=args.dry_run,
                    json_output=args.json_output,
                    cwd=repo_dir,
                )
                all_results.append(result)

        if args.json_output:
            print(json.dumps(all_results, indent=2))
        else:
            print(f"\n{'#' * 60}")
            print(f"  Reviewed {len(all_results)} PRs across {len(args.all_repos)} repos")
            print(f"{'#' * 60}")


if __name__ == "__main__":
    main()
