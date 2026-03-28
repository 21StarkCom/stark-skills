#!/usr/bin/env python3
"""Plan/spec document review dispatch — parallel multi-agent review orchestrator.

Runs 3 CLI agents (Claude, Codex, Gemini) × N domain specializations for
reviewing plan and specification documents (not code PRs).

Prompts loaded from ~/.claude/code-review/prompts/plan-review/{agent}/
with repo-level overrides from .code-review/plan-prompts/{agent}/.
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

from claude_utils import build_claude_cmd
from codex_utils import CODEX_MODEL, CODEX_REASONING_EFFORT_HIGH, parse_jsonl_output
from gemini_utils import (
    GEMINI_MODEL, get_gemini_api_key as _get_gemini_api_key,
    log_api_key_fallback as _log_api_key_fallback,
    setup_gemini_home, make_gemini_env, parse_json_output as parse_gemini_output,
)

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
CODEX_REASONING_CONFIG = CODEX_REASONING_EFFORT_HIGH



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
    api_key_fallback: bool = False


DEFAULT_PLAN_REVIEW_CONFIG = {
    "agents": ["claude", "codex"],
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
    config_section: str = "plan_review",
) -> dict[str, Any]:
    """Load a config section from config.json (repo → global).

    Checks:
        1. {repo_dir}/.code-review/config.json  → {config_section}
        2. {global_config_dir}/config.json       → {config_section}
    Merges onto DEFAULT_PLAN_REVIEW_CONFIG.

    Args:
        config_section: JSON key to read (default: "plan_review").
            E.g., "design_review" when --prompts-dir is "design-review".
    """
    config = dict(DEFAULT_PLAN_REVIEW_CONFIG)

    if global_config_dir is None:
        global_config_dir = str(Path.home() / ".claude" / "code-review")

    # Load global first (lower priority)
    global_cfg_path = Path(global_config_dir) / "config.json"
    if global_cfg_path.exists():
        try:
            data = json.loads(global_cfg_path.read_text())
            section = data.get(config_section, {})
            config.update(section)
        except (json.JSONDecodeError, OSError):
            pass

    # Load repo config (higher priority, overwrites global)
    if repo_dir:
        repo_cfg_path = Path(repo_dir) / ".code-review" / "config.json"
        if repo_cfg_path.exists():
            try:
                data = json.loads(repo_cfg_path.read_text())
                section = data.get(config_section, {})
                config.update(section)
            except (json.JSONDecodeError, OSError):
                pass

    return config


# ── Sub-agent dispatch ────────────────────────────────────────────────


def _parse_plan_findings(
    agent: str, domain: str, raw: str,
) -> list[PlanFinding]:
    """Parse JSON array of findings from raw agent output.

    Handles multiple output formats:
    - Raw JSON array
    - JSON wrapped in markdown code fences (with optional preamble/postamble)
    - JSON with escaped newlines (Gemini -o json double-encoding)
    Returns [] on any parse failure.
    """
    text = raw.strip()

    # Strip markdown code fences anywhere in the text (not just at start)
    fence_match = re.search(r"```(?:json)?\s*\n(.*?)```", text, re.DOTALL)
    if fence_match:
        text = fence_match.group(1).strip()

    # Handle Gemini double-encoded JSON (escaped newlines/quotes inside a string)
    if "\\n" in text and text.startswith('"'):
        try:
            text = json.loads(text)  # un-escape the string
        except (json.JSONDecodeError, ValueError):
            pass

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

    stdin_input = None
    gemini_home = None

    # Build CLI command per agent
    if agent == "claude":
        cmd = build_claude_cmd()
        stdin_input = full_prompt
    elif agent == "codex":
        cmd = [
            "codex", "exec",
            "-m", CODEX_MODEL,
            "-c", CODEX_REASONING_CONFIG,
            "--ephemeral", "--json",
            "-s", "read-only",
            "-",
        ]
        stdin_input = full_prompt
    elif agent == "gemini":
        gemini_home = setup_gemini_home(
            "gemini-plan-review-", os.getcwd(), "review", approval_mode="plan",
        )
        cmd = [
            "gemini",
            "-m", GEMINI_MODEL,
            "-p", prompt_text or "Review this plan document.",
            "-o", "json",
        ]
        stdin_input = plan_content  # piped as context via stdin
    else:
        result.error = "unknown_agent"
        return result

    def _cleanup_temp():
        if gemini_home and os.path.isdir(gemini_home):
            shutil.rmtree(gemini_home, ignore_errors=True)

    # Codex is slower due to reasoning mode; give it 2x the timeout
    effective_timeout = timeout * 2 if agent == "codex" else timeout
    run_kwargs: dict[str, Any] = {
        "capture_output": True, "text": True, "timeout": effective_timeout,
    }
    if stdin_input is not None:
        run_kwargs["input"] = stdin_input
    if gemini_home:
        run_kwargs["env"] = make_gemini_env(gemini_home)

    max_attempts = 2
    t0 = time.monotonic()
    used_api_key_fallback = False
    for attempt in range(1, max_attempts + 1):
        try:
            proc = subprocess.run(cmd, **run_kwargs)

            if proc.returncode != 0:
                stderr_snippet = proc.stderr[:500]
                print(
                    f"  [{agent}:{domain_key}] CLI error (exit {proc.returncode}): "
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
                result.duration_s = time.monotonic() - t0
                result.error = "cli_error"
                return result

            raw = proc.stdout or ""

            if agent == "codex":
                raw = parse_jsonl_output(raw)

            if gemini_home:
                raw = parse_gemini_output(raw)
                _cleanup_temp()

            if not raw.strip():
                print(f"  [{agent}:{domain_key}] Empty output", file=sys.stderr)
                _cleanup_temp()
                result.duration_s = time.monotonic() - t0
                result.error = "empty_output"
                return result

            result.raw_output = raw
            break
        except subprocess.TimeoutExpired:
            if attempt < max_attempts:
                print(
                    f"    {agent}:{domain_key} timed out, retrying ({attempt}/{max_attempts})...",
                    file=sys.stderr,
                )
                continue
            _cleanup_temp()
            result.duration_s = time.monotonic() - t0
            result.error = "timeout"
            return result
        except FileNotFoundError:
            _cleanup_temp()
            result.duration_s = time.monotonic() - t0
            result.error = "agent_unavailable"
            return result

    result.duration_s = time.monotonic() - t0
    result.api_key_fallback = used_api_key_fallback
    result.findings = _parse_plan_findings(agent, domain_key, result.raw_output)

    # If we got non-trivial output but couldn't parse findings, flag it
    if not result.findings and result.raw_output.strip() and result.raw_output.strip() != "[]":
        result.error = "parse_error"
        preview = result.raw_output.strip()[:500]
        print(
            f"  [{agent}:{domain_key}] parse_error — raw output preview:\n    {preview}",
            file=sys.stderr,
        )
        # Persist full raw output for debugging
        debug_dir = Path.home() / ".claude" / "code-review" / "history" / "parse-errors"
        debug_dir.mkdir(parents=True, exist_ok=True)
        debug_file = debug_dir / f"{agent}-{domain_key}-{int(time.time())}.txt"
        debug_file.write_text(result.raw_output)

    return result


# ── Parallel dispatch ─────────────────────────────────────────────────

MAX_WORKERS = 21


def dispatch_plan_review(
    plan_content: str,
    round_num: int,
    repo_dir: str | None = None,
    global_prompts_dir: str | None = None,
    agents: list[str] | None = None,
    disabled_domains: list[str] | None = None,
    timeout: int = DEFAULT_TIMEOUT,
) -> dict[str, Any]:
    """Dispatch plan review across agents × domains in parallel.

    Returns structured dict with round, agents, domains, results, and summary.
    """
    if global_prompts_dir is None:
        global_prompts_dir = str(GLOBAL_PROMPTS_DIR)
    if agents is None:
        agents = list(AGENTS)
    if disabled_domains is None:
        disabled_domains = []

    # Discover and filter domains
    domains = _discover_plan_domains(global_prompts_dir=global_prompts_dir)
    for dd in disabled_domains:
        domains.pop(dd, None)

    domain_keys = sorted(domains.keys(), key=lambda k: domains[k].get("order", "99"))

    # Build work items: (agent, domain_key, prompt_text)
    work_items = []
    for agent in agents:
        for dk in domain_keys:
            preamble = resolve_plan_prompt(
                agent, "agent.md",
                repo_dir=repo_dir, global_prompts_dir=global_prompts_dir,
            )
            domain_prompt = resolve_plan_prompt(
                agent, domains[dk]["filename"],
                repo_dir=repo_dir, global_prompts_dir=global_prompts_dir,
            )
            prompt_text = f"{preamble}\n\n{domain_prompt}\n\n{FINDINGS_FORMAT}".strip()
            work_items.append((agent, dk, prompt_text))

    # Dispatch in parallel
    results: list[PlanSubAgentResult] = []
    total = len(work_items)
    completed = 0

    with ThreadPoolExecutor(max_workers=min(MAX_WORKERS, total or 1)) as pool:
        futures = {
            pool.submit(
                _run_plan_subagent,
                agent=agent,
                domain_key=dk,
                plan_content=plan_content,
                prompt_text=prompt_text,
                timeout=timeout,
            ): (agent, dk)
            for agent, dk, prompt_text in work_items
        }

        for future in as_completed(futures):
            agent, dk = futures[future]
            completed += 1
            try:
                sub_result = future.result()
            except Exception as exc:
                sub_result = PlanSubAgentResult(
                    agent=agent, domain=dk, error=str(exc),
                )
            results.append(sub_result)
            print(
                f"  [{completed}/{total}] {agent}:{dk} "
                f"({'OK' if not sub_result.error else sub_result.error})",
                file=sys.stderr,
            )

    # Check coverage
    valid_count = sum(1 for r in results if not r.error)
    if total > 0 and valid_count / total < 0.5:
        print(
            f"  Low coverage warning: only {valid_count}/{total} sub-agents succeeded.",
            file=sys.stderr,
        )

    # Build summary
    severity_counts: dict[str, int] = {}
    all_findings: list[dict[str, Any]] = []
    for r in results:
        for f in r.findings:
            severity_counts[f.severity] = severity_counts.get(f.severity, 0) + 1
            fd = asdict(f)
            fd["_agent"] = r.agent  # tag for cross-domain dedup
            all_findings.append(fd)

    # Cross-agent dedup: remove findings with identical (section, title) from
    # the same agent across different domains.  Keep the first occurrence
    # (domain order is deterministic).
    pre_dedup = len(all_findings)
    seen_keys: set[tuple[str, str, str]] = set()
    deduped_findings: list[dict[str, Any]] = []
    for f in all_findings:
        key = (f.get("section", ""), f.get("title", ""), f.get("_agent", ""))
        if key not in seen_keys:
            seen_keys.add(key)
            deduped_findings.append(f)
    all_findings = deduped_findings

    # Recount after dedup
    severity_counts = {}
    for f in all_findings:
        severity_counts[f.get("severity", "?")] = severity_counts.get(f.get("severity", "?"), 0) + 1

    # Serialize results
    serialized_results = []
    for r in results:
        entry: dict[str, Any] = {
            "agent": r.agent,
            "domain": r.domain,
            "duration_s": r.duration_s,
            "findings_count": len(r.findings),
        }
        if r.error:
            entry["error"] = r.error
        if r.findings:
            entry["findings"] = [asdict(f) for f in r.findings]
        serialized_results.append(entry)

    return {
        "round": round_num,
        "agents": agents,
        "domains": domain_keys,
        "results": serialized_results,
        "findings": all_findings,
        "summary": {
            "total_sub_agents": total,
            "succeeded": valid_count,
            "failed": total - valid_count,
            "total_findings": len(all_findings),
            "by_severity": severity_counts,
        },
    }


# ── CLI ───────────────────────────────────────────────────────────────


def main():
    parser = argparse.ArgumentParser(description="Plan review dispatch")
    parser.add_argument("--file", required=True, help="Path to plan/spec file")
    parser.add_argument("--round", type=int, default=1, help="Review round number")
    parser.add_argument("--timeout", type=int, default=DEFAULT_TIMEOUT, help="Per-agent timeout (s)")
    parser.add_argument("--repo-dir", help="Repository root for config/prompt overrides")
    parser.add_argument("--agents", help="Comma-separated list of agents")
    parser.add_argument("--disabled-domains", help="Comma-separated domains to skip")
    parser.add_argument(
        "--prompts-dir",
        help="Prompt directory name under ~/.claude/code-review/prompts/ (default: plan-review)",
        default="plan-review",
    )
    parser.add_argument(
        "--config-section",
        help="Config JSON key to read (default: derived from --prompts-dir, e.g. 'design-review' → 'design_review')",
        default=None,
    )
    args = parser.parse_args()

    # Derive config section from --prompts-dir if not explicitly set
    config_section = args.config_section or args.prompts_dir.replace("-", "_")

    # Load config, merge with CLI overrides
    config = _load_plan_review_config(args.repo_dir, config_section=config_section)
    agents = args.agents.split(",") if args.agents else config.get("agents")
    disabled = (
        args.disabled_domains.split(",")
        if args.disabled_domains
        else config.get("disabled_domains")
    )
    timeout = args.timeout if args.timeout != DEFAULT_TIMEOUT else config.get("timeout", DEFAULT_TIMEOUT)

    global_prompts_dir = str(
        Path.home() / ".claude" / "code-review" / "prompts" / args.prompts_dir
    )

    plan_content = Path(args.file).read_text()
    result = dispatch_plan_review(
        plan_content=plan_content,
        round_num=args.round,
        repo_dir=args.repo_dir,
        agents=agents,
        disabled_domains=disabled,
        timeout=timeout,
        global_prompts_dir=global_prompts_dir,
    )
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
