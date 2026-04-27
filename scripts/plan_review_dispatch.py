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
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

from claude_utils import build_claude_cmd, make_clean_env
from codex_utils import CODEX_REASONING_EFFORT_XHIGH, parse_jsonl_output
from gemini_utils import (
    setup_gemini_home, make_gemini_env,
    parse_json_output as parse_gemini_output,
    should_fallback_to_api_key, try_gemini_api_key_fallback,
)
try:
    from runtime_env import build_agent_env
except ImportError:  # pragma: no cover - backward compat for older installs
    build_agent_env = None

from dispatcher_base import (
    discover_domains as _base_discover_domains,
    resolve_model as _resolve_model,
    resolve_prompt as _base_resolve_prompt,
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
CODEX_REASONING_CONFIG = CODEX_REASONING_EFFORT_XHIGH



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
    model: str = ""  # resolved model id, e.g. "claude-opus-4-7"
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
    """Resolve a plan review prompt file: repo → global agent → global domains.

    Thin wrapper around dispatcher_base.resolve_prompt with plan-review
    repo_subdir convention (plan-prompts).
    """
    if global_prompts_dir is None:
        global_prompts_dir = str(GLOBAL_PROMPTS_DIR)
    return _base_resolve_prompt(
        agent, filename,
        prompts_dir=global_prompts_dir,
        repo_dir=repo_dir,
        repo_subdir="plan-prompts",
    )


# ── Domain discovery ───────────────────────────────────────────────────


def _discover_plan_domains(
    global_prompts_dir: str | None = None,
) -> dict[str, dict[str, Any]]:
    """Discover plan review domains — delegates to dispatcher_base.discover_domains."""
    if global_prompts_dir is None:
        global_prompts_dir = str(GLOBAL_PROMPTS_DIR)
    return _base_discover_domains(global_prompts_dir, agents=AGENTS)


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


def _agent_model_label(agent: str) -> str:
    """Return the resolved model id for *agent*, or ``""`` on failure.

    Empty-string return is the sentinel for "unresolved" so callers can
    filter it out of model-attribution maps. Returning a string sentinel
    like "<unresolved: …>" would land in dashboards as if it were a
    real model id.
    """
    try:
        return _resolve_model(agent)
    except Exception as exc:  # pragma: no cover - resolution shouldn't fail in practice
        print(
            f"  [!] model resolution failed for {agent!r}: {exc}",
            file=sys.stderr, flush=True,
        )
        return ""


def _safe_repo_relative(file_path: str, repo_dir: str | None) -> str:
    """Normalize *file_path* to a repo-relative identifier suitable for
    PUBLIC-tier telemetry.

    The stark-insights validator hard-rejects absolute paths and parent
    traversal in `agent_dispatch.file` / `review_finding.file`. Producers
    must therefore pass a repo-relative path. If repo_dir is known, we
    use it as the anchor; otherwise we strip a leading "/" and any "../"
    segments so an inconvenient-but-not-malicious caller path doesn't
    bring down telemetry for the whole review.
    """
    if not file_path:
        return file_path
    p = file_path
    if repo_dir:
        try:
            p = os.path.relpath(file_path, repo_dir)
        except ValueError:
            pass
    # Strip any remaining absolute prefix and traversal segments.
    p = p.lstrip("/")
    parts = [seg for seg in p.split("/") if seg and seg != ".."]
    return "/".join(parts) or p


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
    result = PlanSubAgentResult(agent=agent, domain=domain_key, model=_agent_model_label(agent))
    print(
        f"  → start [{agent}:{domain_key}] model={result.model}",
        file=sys.stderr,
        flush=True,
    )

    stdin_input = None
    gemini_home = None

    # Build CLI command per agent
    if agent == "claude":
        cmd = build_claude_cmd()
        stdin_input = full_prompt
    elif agent == "codex":
        cmd = [
            "codex", "exec",
            "-m", _resolve_model("codex"),
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
            "-m", _resolve_model("gemini"),
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
    if agent in ("claude", "codex"):
        run_kwargs["env"] = (
            build_agent_env(agent, "review")
            if build_agent_env is not None
            else make_clean_env()
        )
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


def _emit_plan_dispatch_events(
    results: list[PlanSubAgentResult],
    review_type: str,
    file_path: str,
    round_num: int,
    repo: str | None,
    repo_dir: str | None = None,
) -> None:
    """Best-effort emit ``agent_dispatch`` and ``review_finding`` events to
    the stark-insights queue for design/plan reviews so they're first-class
    in dashboards (mirrors what ``multi_review.save_round_history`` does for
    PR reviews).

    Telemetry must never break the review. The whole emission path is
    wrapped in a broad fail-open handler so any failure (import error,
    disk full, schema mismatch on a single payload, etc.) logs and
    returns instead of bubbling out.

    Envelope ``project`` and payload ``repo`` are populated with the
    actual repo identifier — ``review_type`` lives only in its own
    dedicated payload field. The dedupe key is repo-scoped so two
    repos with the same relative doc path don't collide in the queue.
    """
    try:
        try:
            from emit_queue import enqueue
        except ImportError:
            return

        import datetime as _dt
        now_iso = _dt.datetime.now(_dt.timezone.utc).isoformat()
        repo_label = repo or "unknown"
        safe_file = _safe_repo_relative(file_path, repo_dir)

        def _envelope(event_type: str, payload: dict, dedupe_key: str) -> dict:
            return {
                "type": event_type,
                "timestamp": now_iso,
                "cli": "claude",
                "source": "skill",
                "schema_version": 1,
                "project": repo_label,
                "dedupe_key": dedupe_key,
                "payload": payload,
            }

        file_key = f"{repo_label}:{review_type}:{safe_file}:round-{round_num}"
        finding_idx = 0
        for r in results:
            try:
                enqueue(_envelope("agent_dispatch", {
                    "agent": r.agent,
                    "model": r.model,
                    "domain": r.domain,
                    "task": f"{r.domain} review",
                    "round": round_num,
                    "duration_s": r.duration_s,
                    "success": r.error is None,
                    "timeout": "timeout" in (r.error or ""),
                    "finding_count": len(r.findings),
                    "review_type": review_type,
                    "file": safe_file,
                }, f"doc-review:{file_key}:agent:{r.agent}:{r.domain}"))
            except Exception as exc:  # pragma: no cover
                print(f"  [!] Failed to emit agent_dispatch: {exc}", file=sys.stderr)
            for f in r.findings:
                try:
                    enqueue(_envelope("review_finding", {
                        "pr_number": None,
                        "repo": repo_label,
                        "round": round_num,
                        "agent": f.agent,
                        "domain": f.domain,
                        "severity": f.severity,
                        "title": f.title,
                        "description": f.description,
                        "review_type": review_type,
                        "file": safe_file,
                    }, f"doc-review:{file_key}:finding:{finding_idx}"))
                except Exception as exc:  # pragma: no cover
                    print(f"  [!] Failed to emit review_finding: {exc}", file=sys.stderr)
                finding_idx += 1
    except Exception as exc:  # pragma: no cover
        # Never let telemetry crash a completed review. Catches anything
        # the inner per-event handlers missed (datetime / import-time
        # failures other than ImportError, etc.).
        print(f"  [!] Telemetry emission failed: {exc}", file=sys.stderr)


def dispatch_plan_review(
    plan_content: str,
    round_num: int,
    repo_dir: str | None = None,
    global_prompts_dir: str | None = None,
    agents: list[str] | None = None,
    domains: dict[str, dict[str, Any]] | None = None,
    disabled_domains: list[str] | None = None,
    timeout: int = DEFAULT_TIMEOUT,
    review_type: str | None = None,
    file_path: str | None = None,
    repo: str | None = None,
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
    if domains is None:
        domains = _discover_plan_domains(global_prompts_dir=global_prompts_dir)
    for dd in disabled_domains:
        domains.pop(dd, None)

    domain_keys = sorted(domains.keys(), key=lambda k: domains[k].get("order", "99"))

    total_subagents = len(agents) * len(domain_keys)
    print(
        f"plan_review_dispatch: round {round_num} — "
        f"{len(agents)} agent(s) × {len(domain_keys)} domain(s) = "
        f"{total_subagents} sub-agent(s)",
        file=sys.stderr,
        flush=True,
    )
    print("plan_review_dispatch: models in use:", file=sys.stderr, flush=True)
    for agent in agents:
        print(f"  - {agent}: {_agent_model_label(agent)}", file=sys.stderr, flush=True)
    print(
        f"plan_review_dispatch: domains: {', '.join(domain_keys)}",
        file=sys.stderr,
        flush=True,
    )

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
    dispatch_t0 = time.monotonic()
    print(
        f"plan_review_dispatch: launching {total} sub-agent(s) in parallel "
        f"(timeout={timeout}s, codex 2x)",
        file=sys.stderr,
        flush=True,
    )

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
                    agent=agent, domain=dk, model=_agent_model_label(agent),
                    error=str(exc),
                )
            results.append(sub_result)
            print(
                f"  [{completed}/{total}] {agent}:{dk} "
                f"({'OK' if not sub_result.error else sub_result.error}) "
                f"{sub_result.duration_s:.1f}s "
                f"findings={len(sub_result.findings)}",
                file=sys.stderr,
                flush=True,
            )

    # Check coverage
    valid_count = sum(1 for r in results if not r.error)
    print(
        f"plan_review_dispatch: round {round_num} complete — "
        f"{valid_count}/{total} succeeded "
        f"in {time.monotonic() - dispatch_t0:.1f}s",
        file=sys.stderr,
        flush=True,
    )
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
            fd.setdefault("agent", r.agent)  # ensure agent field for cross-domain dedup
            all_findings.append(fd)

    # Cross-agent dedup: remove findings with identical (section, title) from
    # the same agent across different domains.  Keep the first occurrence
    # (domain order is deterministic).
    seen_keys: set[tuple[str, str, str]] = set()
    deduped_findings: list[dict[str, Any]] = []
    for f in all_findings:
        key = (f.get("section", ""), f.get("title", ""), f.get("agent", ""))
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
            "model": r.model,
            "domain": r.domain,
            "duration_s": r.duration_s,
            "findings_count": len(r.findings),
        }
        if r.error:
            entry["error"] = r.error
        if r.findings:
            entry["findings"] = [asdict(f) for f in r.findings]
        serialized_results.append(entry)

    # Filter empty model labels — empty string is the "unresolved" sentinel
    # from _agent_model_label; a stale "<unresolved: ...>" string would
    # otherwise look like a real model id in {agent: model} maps consumed
    # downstream by triage_orchestrator and stark-insights.
    models_in_use = {
        agent: model
        for agent in agents
        if (model := _agent_model_label(agent))
    }

    if review_type and file_path:
        _emit_plan_dispatch_events(
            results, review_type, file_path, round_num,
            repo=repo, repo_dir=repo_dir,
        )

    return {
        "round": round_num,
        "agents": agents,
        "models": models_in_use,
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
    parser.add_argument(
        "--repo",
        help="Repository identifier (e.g. 'owner/name') for telemetry attribution. "
             "If omitted, falls back to 'unknown' in emitted events.",
    )
    parser.add_argument("--agents", help="Comma-separated list of agents")
    parser.add_argument("--disabled-domains", help="Comma-separated domains to skip")
    parser.add_argument(
        "--domains",
        help="Comma-separated domain slugs to review (overrides discovery)",
    )
    parser.add_argument(
        "--json-only",
        action="store_true",
        dest="json_only",
        help="JSON to stdout, progress to stderr",
    )
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
    domains = _discover_plan_domains(global_prompts_dir=global_prompts_dir)
    if args.domains:
        allowed = set(args.domains.split(","))
        domains = {k: v for k, v in domains.items() if k in allowed}

    plan_content = Path(args.file).read_text()
    # Derive insights review_type from the prompts dir convention:
    # "design-review" → "design", "plan-review" → "plan". Anything else
    # falls through and disables emission (file_path stays None).
    inferred_review_type = (
        "design" if args.prompts_dir == "design-review"
        else "plan" if args.prompts_dir == "plan-review"
        else None
    )
    result = dispatch_plan_review(
        plan_content=plan_content,
        round_num=args.round,
        repo_dir=args.repo_dir,
        agents=agents,
        domains=domains,
        disabled_domains=disabled,
        timeout=timeout,
        global_prompts_dir=global_prompts_dir,
        review_type=inferred_review_type,
        file_path=args.file if inferred_review_type else None,
        repo=args.repo,
    )
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
