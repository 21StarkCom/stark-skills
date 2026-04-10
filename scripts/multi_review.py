#!/usr/bin/env python3
"""Multi-agent PR review orchestrator.

Runs up to 3 CLI agents (Claude, Codex, Gemini) across 9 domain
specializations. Each agent posts a consolidated review via its GitHub App,
grouped by domain.

Architecture:
    multi_review.py (orchestrator)
    ├── claude × 9 domains  → stark-claude bot
    ├── codex  × 9 domains  → stark-codex bot
    └── gemini × 9 domains  → stark-gemini bot

Prompts loaded from ~/.claude/code-review/prompts/{agent}/ (with repo/org overrides):
    agent.md          Agent-specific preamble
    01-architecture   Architecture & design patterns
    02-accessibility   WCAG 2.1 AA compliance
    03-correctness    Correctness & logic bugs
    04-type-safety    TypeScript types & API surface
    05-security       Security & error handling
    06-test-coverage  Test coverage & quality
    07-spec-conformance  Spec and acceptance criteria alignment
    08-ui-design-conformance  UI design system and interaction consistency
    09-regression-prevention  Backward compatibility and change safety

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
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

from claude_utils import build_claude_cmd, make_clean_env
from codex_utils import CODEX_MODEL, CODEX_REASONING_EFFORT_HIGH, parse_jsonl_output
from gemini_utils import (
    GEMINI_MODEL, setup_gemini_home, make_gemini_env,
    parse_json_output as parse_gemini_output,
    should_fallback_to_api_key, try_gemini_api_key_fallback,
)
try:
    from runtime_env import build_agent_env
except ImportError:  # pragma: no cover - backward compat for older installs
    build_agent_env = None

from dispatcher_base import (
    DEFAULT_CONFIG,
    AGENTS as _BASE_AGENTS,
    discover_config,
    resolve_model as _resolve_model,
    is_agent_enabled,
    discover_domains as _base_discover_domains,
)

# ── Config ──────────────────────────────────────────────────────────────

SCRIPTS_DIR = Path(__file__).parent
PYTHON = str(SCRIPTS_DIR / ".venv" / "bin" / "python3")
GITHUB_APP = str(SCRIPTS_DIR / "github_app.py")
GLOBAL_PROMPTS_DIR = Path.home() / ".claude" / "code-review" / "prompts"

# AGENTS: filtered by is_agent_enabled, sourced from dispatcher_base
AGENTS = _BASE_AGENTS

CODEX_REASONING_CONFIG = CODEX_REASONING_EFFORT_HIGH  # re-exported for backward compat


def _discover_domains() -> dict[str, dict[str, Any]]:
    """Discover PR review domains — delegates to dispatcher_base.discover_domains."""
    return _base_discover_domains(GLOBAL_PROMPTS_DIR, agents=list(AGENTS))


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


def resolve_context_files(patterns: list[str], cwd: str) -> str | None:
    """Resolve context_files glob patterns and return concatenated content.

    Each pattern is evaluated relative to cwd. Matching files are read and
    concatenated under a header. Returns None if no files matched or the
    patterns list is empty.
    """
    if not patterns:
        return None
    matched: list[tuple[str, str]] = []
    root = Path(cwd)
    for pattern in patterns:
        for p in sorted(root.glob(pattern)):
            if p.is_file() and p.stat().st_size < 200_000:  # skip very large files
                try:
                    matched.append((str(p.relative_to(root)), p.read_text()))
                except (OSError, UnicodeDecodeError):
                    continue
    if not matched:
        return None
    sections = []
    for relpath, content in matched:
        sections.append(f"### {relpath}\n\n{content}")
    return "## Context Files\nThe following files from the repo provide architectural context:\n\n" + "\n\n---\n\n".join(sections)


# ── Graph dependency context ──────────────────────────────────────────────

_GRAPH_SAFE_RE = re.compile(r'^[a-zA-Z0-9_:./-]+$')
_GRAPH_TOKEN_BUDGET = 2000  # target max tokens for graph context section


def _sanitize_graph_field(value: str) -> str:
    """Allowlist filter for repo-derived fields (prompt injection protection)."""
    if _GRAPH_SAFE_RE.match(value):
        return value
    return re.sub(r'[^a-zA-Z0-9_:./-]', '', value)


def _build_graph_dependency_context(
    cwd: str,
    base: str,
    pr_number: int | None,
    config: dict,
) -> str | None:
    """Run stark_graph.py --stage diff and return a formatted dependency context string.

    Returns None on failure (exit 2, timeout, parse error) — callers degrade gracefully.
    Token budget: ~2000 tokens. Truncates to blast radius edges when exceeded.
    """
    stark_graph = SCRIPTS_DIR / "stark_graph.py"
    cmd = [sys.executable, str(stark_graph), "--stage", "diff", "--repo", cwd, "--base", base]
    if pr_number is not None:
        cmd.extend(["--pr", str(pr_number)])
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=120, cwd=cwd)
    except subprocess.TimeoutExpired:
        print("  [graph] diff timed out — skipping dependency context", file=sys.stderr)
        return None
    except OSError as exc:
        print(f"  [graph] diff failed to start: {exc} — skipping dependency context", file=sys.stderr)
        return None
    if result.returncode == 2:
        print("  [graph] diff exit 2 (setup error) — skipping dependency context", file=sys.stderr)
        return None
    if not result.stdout.strip():
        return None
    try:
        report = json.loads(result.stdout)
    except json.JSONDecodeError:
        return None
    return _format_graph_context(report)


def _format_graph_context(report: dict) -> str:
    """Format a DiffReport dict as a dependency-context section for prompt injection."""
    added_nodes = [_sanitize_graph_field(n) for n in report.get("added_nodes", []) if n]
    removed_nodes = [_sanitize_graph_field(n) for n in report.get("removed_nodes", []) if n]
    added_edges = [_sanitize_graph_field(e) for e in report.get("added_edges", []) if e]
    removed_edges = [_sanitize_graph_field(e) for e in report.get("removed_edges", []) if e]
    blast = report.get("blast_radius", {})
    direct = [_sanitize_graph_field(n) for n in blast.get("direct", []) if n]
    transitive = [_sanitize_graph_field(n) for n in blast.get("transitive", []) if n]
    depth_cap = blast.get("depth_cap_reached", False)
    event_subscribers = [_sanitize_graph_field(n) for n in blast.get("event_subscribers", []) if n]

    lines = ["## Dependency Context", "", "<dependency-context>"]
    if added_nodes:
        lines.append(f"Added nodes: {', '.join(added_nodes)}")
    if removed_nodes:
        lines.append(f"Removed nodes: {', '.join(removed_nodes)}")
    if added_edges:
        lines.append(f"Added edges: {', '.join(added_edges)}")
    if removed_edges:
        lines.append(f"Removed edges: {', '.join(removed_edges)}")
    lines.append("")
    lines.append("Blast radius:")
    if direct:
        lines.append(f"  Direct dependents: {', '.join(direct)}")
    if transitive:
        cap_note = " (depth cap reached)" if depth_cap else ""
        lines.append(f"  Transitive dependents{cap_note}: {', '.join(transitive)}")
    if event_subscribers:
        lines.append(f"  Event subscribers: {', '.join(event_subscribers)}")
    if not direct and not transitive and not event_subscribers:
        lines.append("  No dependents found.")
    lines.append("</dependency-context>")

    full_text = "\n".join(lines)
    # Token budget: ~2000 tokens ≈ 8000 chars (4 chars/token avg)
    if len(full_text) // 4 > _GRAPH_TOKEN_BUDGET:
        edge_lines = [
            "## Dependency Context",
            "",
            "<dependency-context>",
            "Blast radius (truncated to direct dependents due to token budget):",
        ]
        if direct:
            edge_lines.append(f"  Direct dependents: {', '.join(direct[:50])}")
        edge_lines.append("</dependency-context>")
        return "\n".join(edge_lines)
    return full_text


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

MAX_GEMINI_CONCURRENT = 3  # Vertex AI rate-limits under heavy parallel load
_gemini_semaphore = threading.Semaphore(MAX_GEMINI_CONCURRENT)


def _get_diff_stats(base: str, cwd: str | None = None) -> tuple[int, int]:
    """Get diff file count and total changed lines for adaptive timeout.

    Returns (file_count, line_count). Returns (0, 0) on failure.
    """
    try:
        result = subprocess.run(
            ["git", "diff", "--shortstat", f"{base}...HEAD"],
            capture_output=True, text=True, timeout=30,
            cwd=cwd,
        )
        if result.returncode != 0 or not result.stdout.strip():
            return (0, 0)
        text = result.stdout.strip()
        files_m = re.search(r'(\d+)\s+files?\s+changed', text)
        ins_m = re.search(r'(\d+)\s+insertions?', text)
        del_m = re.search(r'(\d+)\s+deletions?', text)
        file_count = int(files_m.group(1)) if files_m else 0
        insertions = int(ins_m.group(1)) if ins_m else 0
        deletions = int(del_m.group(1)) if del_m else 0
        return (file_count, insertions + deletions)
    except (subprocess.TimeoutExpired, OSError):
        return (0, 0)


def _adaptive_timeout(agent: str, file_count: int, line_count: int, config: dict) -> int:
    """Determine sub-agent timeout based on PR size and config.

    Default: 600s (gemini), 900s (claude/codex).
    Large PRs: uses runtime.large_pr_timeout_s from config.
    """
    runtime = config.get("runtime", {})
    file_threshold = runtime.get("large_pr_file_threshold", 40)
    line_threshold = runtime.get("large_pr_line_threshold", 3000)
    large_timeout = runtime.get("large_pr_timeout_s", 1800)

    default_timeout = 600 if agent == "gemini" else 900

    if file_count >= file_threshold or line_count >= line_threshold:
        return max(default_timeout, large_timeout)
    return default_timeout


def _max_worker_budget() -> int:
    """Keep the pool aligned with the currently configured agent/domain matrix."""
    return max(1, len(AGENTS) * max(1, len(DOMAINS)))


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
    # Classification fields — filled by the skill after reviewing each finding.
    classification: str | None = None        # fix, noise, false_positive, ignored
    classification_reason: str | None = None  # why this classification was chosen
    cross_validated_by: list[str] = field(default_factory=list)  # ["claude:security", ...]
    fixed_in_round: int | None = None
    fix_verified: bool | None = None          # tests passed after fix?


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
    # Check shared domains/ directory before falling back to other agents
    domains_path = GLOBAL_PROMPTS_DIR / "domains" / domain["filename"]
    if domains_path.exists():
        return domains_path.read_text().strip()
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
    """Apply severity_overrides: findings below min_severity or matching title_patterns get capped.

    Config format:
        "severity_overrides": {
            "<domain>": {
                "min_severity": "medium",         # findings below this → "low"
                "title_patterns": {               # title substring matches → cap severity
                    "unbounded memory": {"max_severity": "low", "reason": "..."},
                    "global state singleton": {"max_severity": "low", "reason": "..."}
                }
            }
        }
    """
    for f in findings:
        domain_override = overrides.get(f.domain)
        if not domain_override:
            continue
        # min_severity: downgrade findings below threshold
        min_sev = domain_override.get("min_severity")
        if min_sev and SEVERITY_ORDER.get(f.severity, 99) > SEVERITY_ORDER.get(min_sev, 99):
            f.severity = "low"
        # title_patterns: cap severity for known patterns
        title_pats = domain_override.get("title_patterns", {})
        if title_pats:
            title_lower = f.title.lower()
            desc_lower = f.description.lower()
            for pattern, rule in title_pats.items():
                pattern_lower = pattern.lower()
                if pattern_lower in title_lower or pattern_lower in desc_lower:
                    max_sev = rule.get("max_severity", "low")
                    if SEVERITY_ORDER.get(f.severity, 99) < SEVERITY_ORDER.get(max_sev, 99):
                        f.severity = max_sev
                    break  # first match wins
    return findings


# ── Sub-agent runners ──────────────────────────────────────────────────


def _run_subagent(
    agent: str,
    domain_key: str,
    base: str,
    cwd: str | None = None,
    spec_context: str | None = None,
    graph_context: str | None = None,
    override_timeout_s: int | None = None,
    prompt_cache: dict[tuple[str, str], str] | None = None,
) -> SubAgentResult:
    """Run a single sub-agent: one CLI tool × one domain."""
    if agent == "gemini":
        _gemini_semaphore.acquire()
    try:
        return _run_subagent_inner(agent, domain_key, base, cwd, spec_context, graph_context, override_timeout_s, prompt_cache)
    finally:
        if agent == "gemini":
            _gemini_semaphore.release()


def _run_subagent_inner(
    agent: str,
    domain_key: str,
    base: str,
    cwd: str | None = None,
    spec_context: str | None = None,
    graph_context: str | None = None,
    override_timeout_s: int | None = None,
    prompt_cache: dict[tuple[str, str], str] | None = None,
) -> SubAgentResult:
    """Inner implementation — called with gemini semaphore held if needed."""
    t0 = time.time()
    if not is_agent_enabled(agent):
        return SubAgentResult(
            agent=agent,
            domain=domain_key,
            raw_output="",
            error="agent_disabled",
            duration_s=0.0,
        )
    if prompt_cache:
        preamble = prompt_cache.get((agent, "__preamble__"), "")
        domain_prompt = prompt_cache.get((agent, domain_key), "")
    else:
        preamble = _load_agent_preamble(agent, cwd=cwd)
        domain_prompt = _load_domain_prompt(agent, domain_key, cwd=cwd)
    parts = []
    if preamble:
        parts.append(preamble)
    if spec_context:
        parts.append(spec_context)
    if graph_context:
        parts.append(graph_context)
    parts.append(domain_prompt)
    full_prompt = "\n\n".join(parts)

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
            "-m", _resolve_model("codex"),
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
            "-m", _resolve_model("gemini"),
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
    timeout_s = override_timeout_s if override_timeout_s is not None else (600 if agent == "gemini" else 900)
    run_kwargs: dict[str, Any] = {
        "capture_output": True, "text": True,
        "timeout": timeout_s, "cwd": cwd,
    }
    if stdin_input is not None:
        run_kwargs["input"] = stdin_input
    if agent in ("claude", "codex"):
        run_kwargs["env"] = (
            build_agent_env(agent, "review")
            if build_agent_env is not None
            else make_clean_env()
        )
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
                # Persist full stderr to disk for post-mortem debugging
                _err_dir = Path.home() / ".claude" / "code-review" / "logs"
                _err_dir.mkdir(parents=True, exist_ok=True)
                _err_file = _err_dir / f"{agent}-{domain_key}-error.log"
                _err_file.write_text(
                    f"exit_code={result.returncode}\n"
                    f"cmd={' '.join(cmd)}\n"
                    f"attempt={attempt}/{max_attempts}\n"
                    f"stderr:\n{result.stderr}\n"
                    f"stdout:\n{result.stdout[:1000]}\n"
                )
                if (
                    agent == "gemini"
                    and attempt < max_attempts
                    and should_fallback_to_api_key(stderr_snippet)
                    and try_gemini_api_key_fallback(run_kwargs, domain_key, stderr_snippet)
                ):
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
    graph_context: str | None = None,
    enriched_domains: list[str] | None = None,
) -> ReviewRound:
    """Run one round of parallel reviews: agents × domains."""
    if out is None:
        out = sys.stdout
    config = discover_config(cwd=cwd)
    if agents is None:
        agents = [a for a in config.get("agents", list(AGENTS.keys())) if a in AGENTS]
        agents = [a for a in agents if is_agent_enabled(a)]
    if domains is None:
        disabled = set(config.get("disabled_domains", []))
        domains = [d for d in DOMAINS if d not in disabled]
    rnd = ReviewRound(round_num=round_num)
    enriched_set = set(enriched_domains or [])

    # Adaptive timeout for large PRs
    file_count, line_count = _get_diff_stats(base, cwd=cwd)
    if file_count > 0 or line_count > 0:
        print(f"  [diff] {file_count} files, {line_count} lines changed", file=out)

    total = len(agents) * len(domains)
    print(f"\n{'=' * 60}", file=out)
    print(
        f"  Review Round {round_num} — {len(agents)} agents × {len(domains)} domains = {total} sub-agents",
        file=out,
    )
    print(f"{'=' * 60}", file=out)

    if total == 0:
        print("  No enabled agents available for this round.", file=out)
        return rnd

    # Pre-load all prompts (avoids per-worker file I/O)
    prompt_cache: dict[tuple[str, str], str] = {}
    for agent in agents:
        prompt_cache[(agent, "__preamble__")] = _load_agent_preamble(agent, cwd=cwd)
        for domain_key in domains:
            prompt_cache[(agent, domain_key)] = _load_domain_prompt(agent, domain_key, cwd=cwd)

    with ThreadPoolExecutor(max_workers=min(total, _max_worker_budget())) as pool:
        futures = {}
        for agent in agents:
            if not is_agent_enabled(agent):
                print(f"  [{agent}] skipped: disabled in config", file=out)
                continue
            agent_cfg = AGENTS[agent]
            agent_timeout = _adaptive_timeout(agent, file_count, line_count, config)
            for domain_key in domains:
                domain_cfg = DOMAINS[domain_key]
                domain_graph_context = graph_context if domain_key in enriched_set else None
                future = pool.submit(_run_subagent, agent, domain_key, base, cwd, spec_context, domain_graph_context, agent_timeout, prompt_cache)
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


def resolve_domain_agents(
    config: dict,
    domains: list[str],
    override_agent: str | None = None,
) -> dict[str, str]:
    """Build a domain→agent mapping for single-agent review mode.

    Priority: CLI override > config domain_agents > fallback "codex".
    """
    if override_agent:
        return {d: override_agent for d in domains}
    da = config.get("domain_agents", {})
    return {d: da.get(d, "codex") for d in domains}


def run_single_agent_round(
    base: str,
    round_num: int,
    domain_agent_map: dict[str, str],
    cwd: str | None = None,
    out: Any = None,
    spec_context: str | None = None,
    graph_context: str | None = None,
    enriched_domains: list[str] | None = None,
) -> ReviewRound:
    """Run one round dispatching exactly 1 agent per domain."""
    if out is None:
        out = sys.stdout
    config = discover_config(cwd=cwd)
    rnd = ReviewRound(round_num=round_num)
    enriched_set = set(enriched_domains or [])
    total = len(domain_agent_map)

    # Adaptive timeout for large PRs
    file_count, line_count = _get_diff_stats(base, cwd=cwd)
    if file_count > 0 or line_count > 0:
        print(f"  [diff] {file_count} files, {line_count} lines changed", file=out)

    print(f"\n{'=' * 60}", file=out)
    print(
        f"  Review Round {round_num} — {total} domains (1 agent each)",
        file=out,
    )
    print(f"{'=' * 60}", file=out)

    if total == 0:
        print("  No enabled agents available for this round.", file=out)
        return rnd

    with ThreadPoolExecutor(max_workers=min(total, _max_worker_budget())) as pool:
        futures = {}
        for domain_key, agent in domain_agent_map.items():
            if agent not in AGENTS:
                print(f"  [!] Unknown agent '{agent}' for {domain_key}, skipping", file=out)
                continue
            if not is_agent_enabled(agent):
                print(f"  [{agent}] skipped for {domain_key}: disabled in config", file=out)
                continue
            agent_cfg = AGENTS[agent]
            agent_timeout = _adaptive_timeout(agent, file_count, line_count, config)
            domain_cfg = DOMAINS.get(domain_key, {"label": domain_key})
            domain_graph_context = graph_context if domain_key in enriched_set else None
            future = pool.submit(_run_subagent, agent, domain_key, base, cwd, spec_context, domain_graph_context, agent_timeout)
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
    line_bucket = f.line // 5  # bucket to nearest 5 lines
    title_norm = re.sub(r"[^a-z0-9]+", " ", f.title.lower()).strip()
    return (f.file, line_bucket, title_norm)


def _title_words(title: str) -> set[str]:
    """Extract significant words from a finding title for fuzzy matching."""
    norm = re.sub(r"[^a-z0-9]+", " ", title.lower()).strip()
    # Drop common filler words that don't carry semantic meaning
    stop = {"the", "a", "an", "is", "in", "on", "of", "for", "to", "and", "or", "not", "no", "be"}
    return {w for w in norm.split() if w not in stop and len(w) > 1}


def _titles_overlap(a: str, b: str, threshold: float = 0.5) -> bool:
    """Check whether two finding titles are about the same issue.

    Uses Jaccard similarity on significant words. A threshold of 0.5 means
    at least half the words overlap — catches "dual cache inconsistency" vs
    "cache stores duplicate data" while rejecting genuinely different findings.
    """
    wa, wb = _title_words(a), _title_words(b)
    if not wa or not wb:
        return False
    intersection = wa & wb
    union = wa | wb
    return len(intersection) / len(union) >= threshold


def deduplicate_findings(findings: list[Finding]) -> list[Finding]:
    """Collapse duplicate findings across agents/domains.

    Two-pass dedup:
    1. Exact key match: same file, same 5-line bucket, same normalized title.
    2. Fuzzy proximity match: same file, lines within ±5, title word overlap ≥50%.

    Keeps the highest-severity instance and records confirmers.
    """
    # --- Pass 1: exact key grouping ---
    groups: dict[tuple, list[Finding]] = {}
    for f in findings:
        key = _dedup_key(f)
        groups.setdefault(key, []).append(f)

    intermediates: list[list[Finding]] = list(groups.values())

    # --- Pass 2: merge groups that are close in location + similar in title ---
    merged: list[list[Finding]] = []
    used = [False] * len(intermediates)
    for i, group_a in enumerate(intermediates):
        if used[i]:
            continue
        combined = list(group_a)
        rep_a = group_a[0]
        for j in range(i + 1, len(intermediates)):
            if used[j]:
                continue
            rep_b = intermediates[j][0]
            if rep_a.file != rep_b.file:
                continue
            if abs(rep_a.line - rep_b.line) > 5:
                continue
            if _titles_overlap(rep_a.title, rep_b.title):
                combined.extend(intermediates[j])
                used[j] = True
        used[i] = True
        merged.append(combined)

    # --- Pass 3: cross-agent collapse on exact file+line ---
    # Different agents often describe the same bug with very different titles
    # (e.g., "TypeError in actor" vs "ORM object slicing error"). When findings
    # share the exact same file and line from different agents, merge them even
    # if titles don't overlap.
    loc_groups: dict[tuple[str, int], list[int]] = {}
    for idx, group in enumerate(merged):
        rep = group[0]
        loc_key = (rep.file, rep.line)
        loc_groups.setdefault(loc_key, []).append(idx)

    final_merged: list[list[Finding]] = []
    used_final = [False] * len(merged)
    for indices in loc_groups.values():
        if len(indices) > 1:
            # Multiple groups on the same file+line from different agents → merge
            agents_in_groups = set()
            for idx in indices:
                for f in merged[idx]:
                    agents_in_groups.add(f.agent)
            if len(agents_in_groups) > 1:
                combined_group: list[Finding] = []
                for idx in indices:
                    combined_group.extend(merged[idx])
                    used_final[idx] = True
                final_merged.append(combined_group)
                continue
        for idx in indices:
            if not used_final[idx]:
                used_final[idx] = True
                final_merged.append(merged[idx])
    merged = final_merged

    deduped: list[Finding] = []
    for group in merged:
        # Keep the highest-severity finding
        group.sort(key=lambda f: SEVERITY_ORDER.get(f.severity, 99))
        best = group[0]
        if len(group) > 1:
            # Deduplicate confirmer labels (same agent/domain shouldn't appear twice)
            seen_confirmers: set[str] = set()
            confirmers: list[str] = []
            for f in group[1:]:
                label = f"{f.agent}/{f.domain}"
                if label not in seen_confirmers:
                    seen_confirmers.add(label)
                    confirmers.append(label)
            if confirmers:
                best.description += f" (also flagged by: {', '.join(confirmers)})"
                best.cross_validated_by = list(seen_confirmers)
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


# ── History persistence ──────────────────────────────────────────────────

HISTORY_DIR = Path.home() / ".claude" / "code-review" / "history"
HISTORY_SCHEMA_VERSION = 2


def _emit_event(event: dict) -> None:
    """Best-effort enqueue to the durable insights queue."""
    try:
        from emit_queue import enqueue
        enqueue(event)
    except Exception as exc:
        print(f"  [!] Failed to emit event: {exc}", file=sys.stderr)


def _make_event(event_type: str, payload: dict, *, project: str | None = None, dedupe_key: str) -> dict:
    """Build an event envelope for the insights queue."""
    import datetime as _dt
    return {
        "type": event_type,
        "timestamp": _dt.datetime.now(_dt.timezone.utc).isoformat(),
        "cli": "claude",
        "source": "skill",
        "schema_version": 1,
        "project": project,
        "dedupe_key": dedupe_key,
        "payload": payload,
    }


def _history_dir(repo: str, pr_number: int) -> Path:
    """Return history directory for a PR, creating it if needed."""
    parts = repo.split("/")
    d = HISTORY_DIR / parts[0] / parts[1] / str(pr_number) if len(parts) == 2 \
        else HISTORY_DIR / repo / str(pr_number)
    d.mkdir(parents=True, exist_ok=True)
    return d


def _agent_quality(findings: list[Finding], agent: str) -> dict[str, Any]:
    """Compute quality metrics for one agent from classified findings."""
    af = [f for f in findings if f.agent == agent]
    fix = sum(1 for f in af if f.classification == "fix")
    noise = sum(1 for f in af if f.classification == "noise")
    fp = sum(1 for f in af if f.classification == "false_positive")
    ignored = sum(1 for f in af if f.classification == "ignored")
    unclassified = sum(1 for f in af if f.classification is None)
    real = fix  # only "fix" findings are confirmed real
    total_evaluated = real + noise + fp
    return {
        "total": len(af),
        "fix": fix,
        "noise": noise,
        "false_positive": fp,
        "ignored": ignored,
        "unclassified": unclassified,
        "signal_pct": round(real / total_evaluated * 100, 1) if total_evaluated else None,
    }


def save_round_history(
    repo: str,
    pr_number: int,
    rnd: ReviewRound,
    mode: str = "team",
    domain_agents: dict[str, str] | None = None,
) -> Path:
    """Save one round's data to history. Returns the file path.

    Called by the skill after classifying findings. The round's findings
    should have their classification fields populated before calling this.
    """
    import datetime
    d = _history_dir(repo, pr_number)
    path = d / f"round-{rnd.round_num}.json"

    all_f = []
    for res in rnd.results:
        all_f.extend(res.findings)

    data = {
        "schema_version": HISTORY_SCHEMA_VERSION,
        "timestamp": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "repo": repo,
        "pr": pr_number,
        "mode": mode,
        "round": rnd.round_num,
        "domain_agents": domain_agents,
        "results": [
            {
                "agent": res.agent,
                "domain": res.domain,
                "duration_s": res.duration_s,
                "error": res.error,
                "api_key_fallback": res.api_key_fallback,
                "findings": [asdict(f) for f in res.findings],
            }
            for res in rnd.results
        ],
        "classification_summary": {
            "fix": sum(1 for f in all_f if f.classification == "fix"),
            "noise": sum(1 for f in all_f if f.classification == "noise"),
            "false_positive": sum(1 for f in all_f if f.classification == "false_positive"),
            "ignored": sum(1 for f in all_f if f.classification == "ignored"),
            "unclassified": sum(1 for f in all_f if f.classification is None),
            "total": len(all_f),
        },
    }

    path.write_text(json.dumps(data, indent=2))

    # Push events directly to insights queue (best-effort)
    file_key = f"{repo}/{pr_number}/round-{rnd.round_num}"
    finding_idx = 0
    for res in rnd.results:
        _emit_event(_make_event("agent_dispatch", {
            "agent": res.agent, "domain": res.domain,
            "task": f"{res.domain} review", "round": rnd.round_num,
            "duration_s": res.duration_s,
            "success": res.error is None,
            "timeout": "Timed out" in (res.error or ""),
            "finding_count": len(res.findings), "mode": mode,
        }, project=repo, dedupe_key=f"review:{file_key}:agent:{res.agent}:{res.domain}"))

        for f in res.findings:
            _emit_event(_make_event("review_finding", {
                "pr_number": pr_number, "repo": repo,
                "round": rnd.round_num,
                "agent": f.agent, "domain": f.domain,
                "severity": f.severity, "title": f.title,
                "description": f.description,
                "classification": f.classification,
                "classification_reason": f.classification_reason,
                "cross_validated_by": f.cross_validated_by,
                "fixed_in_round": f.fixed_in_round,
                "fix_verified": f.fix_verified,
                "mode": mode,
                "domain_agent": (domain_agents or {}).get(f.domain),
            }, project=repo, dedupe_key=f"review:{file_key}:finding:{finding_idx}"))
            finding_idx += 1

    return path


def save_review_summary(
    repo: str,
    pr_number: int,
    base: str,
    rounds: list[ReviewRound],
    mode: str = "team",
    domain_agents: dict[str, str] | None = None,
) -> Path:
    """Save the full review summary across all rounds. Returns the file path.

    Includes per-agent and per-domain quality metrics for optimization.
    """
    import datetime
    d = _history_dir(repo, pr_number)
    path = d / "rounds.json"

    # Collect all classified findings across all rounds
    all_findings_flat: list[Finding] = []
    for rnd in rounds:
        for res in rnd.results:
            all_findings_flat.extend(res.findings)

    # Per-agent quality
    agents_seen = sorted(set(f.agent for f in all_findings_flat))
    per_agent = {a: _agent_quality(all_findings_flat, a) for a in agents_seen}

    # Per-agent × per-domain quality
    per_agent_domain: dict[str, dict[str, Any]] = {}
    for f in all_findings_flat:
        key = f"{f.agent}:{f.domain}"
        if key not in per_agent_domain:
            per_agent_domain[key] = {"agent": f.agent, "domain": f.domain, "findings": []}
        per_agent_domain[key]["findings"].append(f)

    agent_domain_quality = {}
    for key, info in per_agent_domain.items():
        q = _agent_quality(info["findings"], info["agent"])
        q["domain"] = info["domain"]
        agent_domain_quality[key] = q

    # Per-domain aggregated
    domains_seen = sorted(set(f.domain for f in all_findings_flat))
    per_domain: dict[str, dict[str, Any]] = {}
    for domain in domains_seen:
        df = [f for f in all_findings_flat if f.domain == domain]
        fix = sum(1 for f in df if f.classification == "fix")
        noise = sum(1 for f in df if f.classification in ("noise", "false_positive"))
        per_domain[domain] = {
            "total": len(df),
            "fix": fix,
            "noise": noise,
            "agents_that_found_real": sorted(set(
                f.agent for f in df if f.classification == "fix"
            )),
        }

    # Duration stats per agent
    duration_stats: dict[str, list[float]] = {}
    for rnd in rounds:
        for res in rnd.results:
            if not res.error:
                duration_stats.setdefault(res.agent, []).append(res.duration_s)
    avg_duration = {
        a: round(sum(ds) / len(ds), 1) for a, ds in duration_stats.items()
    }

    # Error counts per agent
    error_counts: dict[str, int] = {}
    for rnd in rounds:
        for res in rnd.results:
            if res.error:
                error_counts[res.agent] = error_counts.get(res.agent, 0) + 1

    total_fix = sum(1 for f in all_findings_flat if f.classification == "fix")
    total_noise = sum(1 for f in all_findings_flat if f.classification in ("noise", "false_positive"))
    total_evaluated = total_fix + total_noise

    data = {
        "schema_version": HISTORY_SCHEMA_VERSION,
        "timestamp": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "repo": repo,
        "pr": pr_number,
        "base": base,
        "mode": mode,
        "domain_agents": domain_agents,
        "agents": agents_seen,
        "domains": list(DOMAINS.keys()),
        "rounds": [
            {
                "round": rnd.round_num,
                "results": [
                    {
                        "agent": res.agent,
                        "domain": res.domain,
                        "findings": [asdict(f) for f in res.findings],
                        "error": res.error,
                        "duration_s": res.duration_s,
                    }
                    for res in rnd.results
                ],
            }
            for rnd in rounds
        ],
        "summary": {
            "total_rounds": len(rounds),
            "total_findings": len(all_findings_flat),
            "total_fix": total_fix,
            "total_noise": total_noise,
            "total_false_positive": sum(1 for f in all_findings_flat if f.classification == "false_positive"),
            "total_ignored": sum(1 for f in all_findings_flat if f.classification == "ignored"),
            "signal_to_noise_pct": round(total_fix / total_evaluated * 100, 1) if total_evaluated else None,
            "clean": not has_actionable_findings(rounds[-1]) if rounds else True,
        },
        "quality": {
            "per_agent": per_agent,
            "per_agent_domain": agent_domain_quality,
            "per_domain": per_domain,
            "avg_duration_s": avg_duration,
            "error_counts": error_counts,
        },
    }

    path.write_text(json.dumps(data, indent=2))

    # Push quality summary to insights queue (best-effort)
    _emit_event(_make_event("review_quality", {
        "pr_number": pr_number, "repo": repo, "mode": mode,
        "domain_agents": domain_agents,
        "total_rounds": len(rounds),
        "signal_to_noise_pct": data["summary"]["signal_to_noise_pct"],
        "per_agent": per_agent,
        "per_agent_domain": agent_domain_quality,
        "per_domain": per_domain,
        "avg_duration_s": avg_duration,
        "error_counts": error_counts,
    }, project=repo, dedupe_key=f"review:{repo}/{pr_number}:quality"))

    return path


# ── Main ───────────────────────────────────────────────────────────────


def review_pr_single(
    repo: str,
    pr_number: int,
    base: str = "main",
    dry_run: bool = False,
    json_output: bool = False,
    json_only: bool = False,
    post_raw: bool = False,
    override_agent: str | None = None,
    domains: str | None = None,
    cwd: str | None = None,
) -> dict[str, Any]:
    """Run single-agent review: 1 agent per domain (from domain_agents config)."""
    out = sys.stderr if json_only else sys.stdout
    config = discover_config(cwd=cwd)
    if domains:
        allowed = set(domains.split(","))
        domains_to_review = {k: v for k, v in DOMAINS.items() if k in allowed}
    else:
        domains_to_review = DOMAINS
    disabled = set(config.get("disabled_domains", []))
    active_domains = [d for d in domains_to_review if d not in disabled]
    sev_overrides = config.get("severity_overrides", {})
    da_map = resolve_domain_agents(config, active_domains, override_agent)

    # Determine which agents are actually used (for posting)
    used_agents = sorted(set(da_map.values()))

    print(f"\n{'#' * 60}", file=out)
    print(f"  Single-Agent Review: {repo} PR #{pr_number}", file=out)
    print(f"  Base: {base}", file=out)
    print(f"  {len(active_domains)} domains, agents: {', '.join(used_agents)}", file=out)
    print(f"{'#' * 60}", file=out)

    if not domains_to_review:
        print("  [!] No domain prompt files found in:", GLOBAL_PROMPTS_DIR, file=sys.stderr)
        sys.exit(1)

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
    else:
        spec_context = None

    # Auto-discover context files (specs, design docs) from config globs
    ctx_files_content = resolve_context_files(config.get("context_files", []), effective_cwd)
    if ctx_files_content:
        spec_context = f"{spec_context}\n\n{ctx_files_content}" if spec_context else ctx_files_content

    # Build graph dependency context for enriched domains
    enriched_domains = config.get("graph_enriched_domains", ["architecture", "correctness", "regression-prevention"])
    graph_context = _build_graph_dependency_context(effective_cwd, base, pr_number, config) if enriched_domains else None
    if graph_context:
        print(f"  [graph] dependency context built ({len(graph_context)} chars)", file=out)

    rnd = run_single_agent_round(base, 1, da_map, cwd=cwd, out=out, spec_context=spec_context, graph_context=graph_context, enriched_domains=enriched_domains)

    if sev_overrides:
        for res in rnd.results:
            apply_severity_overrides(res.findings, sev_overrides)

    # Post per-agent findings grouped by the agents actually used
    if not dry_run or post_raw:
        print(f"\n  Posting findings to PR #{pr_number}...", file=out)
        for agent in used_agents:
            agent_cfg = AGENTS[agent]
            body = format_agent_review_body(agent, rnd)
            if body:
                ok = post_review(repo, pr_number, agent_cfg["app"], body)
                status = "posted" if ok else "FAILED"
                print(f"    {agent_cfg['emoji']} {agent} → {status}", file=out)

    output = {
        "repo": repo,
        "pr": pr_number,
        "base": base,
        "mode": "single",
        "domain_agents": da_map,
        "domains": active_domains,
        "rounds": [
            {
                "round": rnd.round_num,
                "results": [
                    {
                        "agent": res.agent,
                        "domain": res.domain,
                        "findings": [asdict(f) for f in res.findings],
                        "error": res.error,
                        "duration_s": res.duration_s,
                    }
                    for res in rnd.results
                ],
            }
        ],
        "summary": {
            "total_findings": len(all_findings(rnd)),
            "critical": sum(1 for f in all_findings(rnd) if f.severity == "critical"),
            "high": sum(1 for f in all_findings(rnd) if f.severity == "high"),
            "medium": sum(1 for f in all_findings(rnd) if f.severity == "medium"),
            "clean": not has_actionable_findings(rnd),
        },
    }

    if not json_output:
        print(f"\n{'=' * 60}", file=out)
        print("  Summary", file=out)
        print(f"{'=' * 60}", file=out)
        print(format_summary_table([rnd]), file=out)
        print(file=out)

    return output


def review_pr(
    repo: str,
    pr_number: int,
    base: str = "main",
    dry_run: bool = False,
    json_output: bool = False,
    json_only: bool = False,
    post_raw: bool = False,
    domains: str | None = None,
    cwd: str | None = None,
) -> dict[str, Any]:
    """Run the full multi-agent review on a single PR."""
    out = sys.stderr if json_only else sys.stdout
    config = discover_config(cwd=cwd)
    active_agents = [a for a in config.get("agents", list(AGENTS.keys())) if a in AGENTS]
    if domains:
        allowed = set(domains.split(","))
        domains_to_review = {k: v for k, v in DOMAINS.items() if k in allowed}
    else:
        domains_to_review = DOMAINS
    disabled = set(config.get("disabled_domains", []))
    active_domains = [d for d in domains_to_review if d not in disabled]
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

    if not domains_to_review:
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

    # Auto-discover context files (specs, design docs) from config globs
    ctx_files_content = resolve_context_files(config.get("context_files", []), effective_cwd)
    if ctx_files_content:
        spec_context = f"{spec_context}\n\n{ctx_files_content}" if spec_context else ctx_files_content

    # Build graph dependency context for enriched domains
    enriched_domains = config.get("graph_enriched_domains", ["architecture", "correctness", "regression-prevention"])
    graph_context = _build_graph_dependency_context(effective_cwd, base, pr_number, config) if enriched_domains else None
    if graph_context:
        print(f"  [graph] dependency context built ({len(graph_context)} chars)", file=out)

    rounds: list[ReviewRound] = []
    round_num = 0

    while True:
        round_num += 1
        rnd = run_review_round(
            base, round_num, agents=active_agents, domains=active_domains, cwd=cwd, out=out,
            spec_context=spec_context, graph_context=graph_context, enriched_domains=enriched_domains,
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
        "domains": active_domains,
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
            "up to 3 agents (Claude, Codex, Gemini) across 9 review domains"
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
    parser.add_argument(
        "--single",
        action="store_true",
        help="Single-agent mode: 1 agent per domain (from domain_agents config).",
    )
    parser.add_argument(
        "--agent",
        choices=list(AGENTS.keys()),
        help="Override agent for all domains (implies --single).",
    )
    parser.add_argument(
        "--domains",
        help="Comma-separated domain slugs to review (overrides discovery)",
    )

    args = parser.parse_args()
    if args.agent:
        args.single = True

    if args.pr:
        # Resolve git root so sub-agents (especially codex) run inside the repo
        try:
            _git_root = subprocess.run(
                ["git", "rev-parse", "--show-toplevel"],
                capture_output=True, text=True, timeout=5,
            ).stdout.strip() or None
        except (subprocess.TimeoutExpired, FileNotFoundError):
            _git_root = None

        repo = args.repo or detect_repo(cwd=_git_root)
        if not repo:
            print("Could not detect repo. Use --repo.", file=sys.stderr)
            sys.exit(1)
        base = args.base or detect_base_branch(cwd=_git_root)

        review_fn = review_pr_single if args.single else review_pr
        review_kwargs: dict[str, Any] = {
            "repo": repo,
            "pr_number": args.pr,
            "base": base,
            "dry_run": args.dry_run,
            "json_output": args.json_output or args.json_only,
            "json_only": getattr(args, "json_only", False),
            "post_raw": getattr(args, "post_raw", False),
            "domains": args.domains,
            "cwd": _git_root,
        }
        if args.single:
            review_kwargs["override_agent"] = args.agent
        result = review_fn(**review_kwargs)

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
                    domains=args.domains,
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
