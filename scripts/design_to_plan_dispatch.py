#!/usr/bin/env python3
"""Design-to-plan dispatch — parallel multi-agent plan generation and cross-review.

Phase 1 (generate): 3 agents each independently produce an implementation plan
from a design document.

Phase 2 (cross-review): Each plan is reviewed by the other 2 agents (6 dispatches).
Each reviewer scores the plan on 5 dimensions and provides findings.

Uses the same CLI dispatch patterns as plan_review_dispatch.py.
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

# ── Config ──────────────────────────────────────────────────────────────

_gemini_api_key_cache: str | None = None


def _get_gemini_api_key() -> str | None:
    """Retrieve Gemini API key from macOS Keychain (cached)."""
    global _gemini_api_key_cache
    if _gemini_api_key_cache is not None:
        return _gemini_api_key_cache or None
    try:
        result = subprocess.run(
            ["security", "find-generic-password", "-s", "GEMINI_API_KEY", "-w"],
            capture_output=True, text=True, timeout=5,
        )
        if result.returncode == 0 and result.stdout.strip():
            _gemini_api_key_cache = result.stdout.strip()
            return _gemini_api_key_cache
    except (subprocess.TimeoutExpired, FileNotFoundError):
        pass
    _gemini_api_key_cache = ""
    return None


_RED = "\033[1;31m"
_RED_BG = "\033[1;37;41m"
_RESET = "\033[0m"
_FALLBACK_LOG = Path.home() / ".claude" / "code-review" / "gemini-api-key-fallback.log"


def _log_api_key_fallback(agent: str, task: str, reason: str) -> None:
    """Log API key fallback event."""
    import datetime
    ts = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    border = f"{_RED_BG}{'=' * 60}{_RESET}"
    print(border, file=sys.stderr)
    print(f"{_RED_BG}  GEMINI API KEY FALLBACK  {_RESET}", file=sys.stderr)
    print(f"{_RED}  Agent: {agent}:{task}{_RESET}", file=sys.stderr)
    print(f"{_RED}  Reason: {reason}{_RESET}", file=sys.stderr)
    print(border, file=sys.stderr)
    try:
        _FALLBACK_LOG.parent.mkdir(parents=True, exist_ok=True)
        with open(_FALLBACK_LOG, "a") as f:
            f.write(f"{ts}  {agent}:{task}  reason={reason}\n")
    except OSError:
        pass


SCRIPTS_DIR = Path(__file__).parent
GLOBAL_PROMPTS_DIR = Path.home() / ".claude" / "code-review" / "prompts" / "design-to-plan"

AGENTS = ["claude", "codex", "gemini"]
CODEX_REASONING_CONFIG = 'model_reasoning_effort="high"'
DEFAULT_TIMEOUT = 600  # Plan generation needs more time than review


# ── Data structures ────────────────────────────────────────────────────


@dataclass
class PlanOutput:
    agent: str
    plan_content: str = ""
    raw_output: str = ""
    error: str | None = None
    duration_s: float = 0.0
    api_key_fallback: bool = False


@dataclass
class CrossReviewScore:
    completeness: int = 0
    feasibility: int = 0
    phasing: int = 0
    risk_coverage: int = 0
    testability: int = 0

    @property
    def average(self) -> float:
        scores = [self.completeness, self.feasibility, self.phasing,
                  self.risk_coverage, self.testability]
        return sum(scores) / len(scores) if scores else 0.0


@dataclass
class CrossReviewOutput:
    reviewer: str
    plan_author: str
    scores: CrossReviewScore = field(default_factory=CrossReviewScore)
    strengths: list[str] = field(default_factory=list)
    weaknesses: list[str] = field(default_factory=list)
    raw_output: str = ""
    error: str | None = None
    duration_s: float = 0.0
    api_key_fallback: bool = False


# ── Prompt loading ─────────────────────────────────────────────────────


def _load_prompt(agent: str, filename: str, repo_dir: str | None = None) -> str:
    """Load a prompt file: repo → global."""
    if repo_dir:
        repo_path = Path(repo_dir) / ".code-review" / "design-to-plan-prompts" / agent / filename
        if repo_path.exists():
            return repo_path.read_text().strip()
    global_path = GLOBAL_PROMPTS_DIR / agent / filename
    if global_path.exists():
        return global_path.read_text().strip()
    return ""


# ── CLI dispatch helpers ───────────────────────────────────────────────


def _extract_output(agent: str, raw: str, gemini_home: str | None = None) -> str:
    """Extract text content from agent-specific output formats."""
    # Codex --json emits JSONL events
    if agent == "codex" and raw.strip().startswith("{"):
        parts = []
        for line in raw.splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                ev = json.loads(line)
                if ev.get("type") == "item.completed":
                    item = ev.get("item", {})
                    itype = item.get("type", "")
                    if itype == "agent_message":
                        text = item.get("text", "")
                        if text:
                            parts.append(text)
                    elif itype == "message":
                        for c in item.get("content", []):
                            if c.get("type") == "output_text":
                                parts.append(c.get("text", ""))
            except json.JSONDecodeError:
                continue
        if parts:
            return "\n".join(parts)

    # Gemini -o json wraps in {"response": "..."}
    if agent == "gemini" and raw.strip():
        try:
            envelope = json.loads(raw)
            return envelope.get("response", raw)
        except (json.JSONDecodeError, AttributeError):
            pass

    return raw


def _build_cmd_and_kwargs(
    agent: str,
    prompt: str,
    stdin_content: str | None = None,
    timeout: int = DEFAULT_TIMEOUT,
) -> tuple[list[str], dict[str, Any], str | None]:
    """Build CLI command, run kwargs, and gemini_home for an agent.

    Returns (cmd, run_kwargs, gemini_home).
    """
    gemini_home = None
    run_kwargs: dict[str, Any] = {
        "capture_output": True, "text": True, "timeout": timeout,
    }

    if agent == "claude":
        cmd = [
            "claude", "-p", "-",
            "--output-format", "text",
            "--model", "claude-opus-4-6",
        ]
        run_kwargs["input"] = prompt if stdin_content is None else f"{prompt}\n\n{stdin_content}"

    elif agent == "codex":
        effective_timeout = timeout * 2
        cmd = [
            "codex", "exec",
            "-c", CODEX_REASONING_CONFIG,
            "--ephemeral", "--json",
            "--full-auto",
            "-",
        ]
        run_kwargs["input"] = prompt if stdin_content is None else f"{prompt}\n\n{stdin_content}"
        run_kwargs["timeout"] = effective_timeout

    elif agent == "gemini":
        gemini_home = tempfile.mkdtemp(prefix="gemini-d2p-")
        gemini_dir = os.path.join(gemini_home, ".gemini")
        os.makedirs(gemini_dir, exist_ok=True)
        real_gemini = os.environ.get("GEMINI_CLI_HOME", os.path.expanduser("~"))
        real_gemini_dir = os.path.join(real_gemini, ".gemini")
        for auth_file in ("settings.json", "oauth_creds.json", "google_accounts.json", "installation_id"):
            src = os.path.join(real_gemini_dir, auth_file)
            if os.path.exists(src):
                shutil.copy2(src, os.path.join(gemini_dir, auth_file))
        with open(os.path.join(gemini_dir, "projects.json"), "w") as f:
            json.dump({"projects": {os.getcwd(): "design-to-plan"}}, f)
        cmd = [
            "gemini",
            "-p", prompt,
            "-o", "json",
            "--approval-mode", "plan",
        ]
        if stdin_content:
            run_kwargs["input"] = stdin_content
        run_kwargs["env"] = {
            **os.environ,
            "GEMINI_CLI_HOME": gemini_home,
            "GOOGLE_CLOUD_LOCATION": "global",
        }
    else:
        raise ValueError(f"Unknown agent: {agent}")

    return cmd, run_kwargs, gemini_home


def _run_agent(
    agent: str,
    prompt: str,
    stdin_content: str | None = None,
    task_label: str = "task",
    timeout: int = DEFAULT_TIMEOUT,
) -> tuple[str, float, bool, str | None]:
    """Run an agent CLI and return (output, duration_s, api_key_fallback, error).

    Common dispatch logic shared by generate and cross-review.
    """
    cmd, run_kwargs, gemini_home = _build_cmd_and_kwargs(agent, prompt, stdin_content, timeout)

    def _cleanup():
        if gemini_home and os.path.isdir(gemini_home):
            shutil.rmtree(gemini_home, ignore_errors=True)

    max_attempts = 2
    t0 = time.monotonic()
    used_fallback = False

    for attempt in range(1, max_attempts + 1):
        try:
            proc = subprocess.run(cmd, **run_kwargs)

            if proc.returncode != 0:
                stderr_snippet = proc.stderr[:500]
                print(
                    f"  [{agent}:{task_label}] CLI error (exit {proc.returncode}): {stderr_snippet}",
                    file=sys.stderr,
                )
                # Gemini Vertex AI fallback
                if (
                    agent == "gemini"
                    and attempt < max_attempts
                    and ("ModelNotFound" in stderr_snippet or "403" in stderr_snippet
                         or "PERMISSION_DENIED" in stderr_snippet)
                ):
                    api_key = _get_gemini_api_key()
                    if api_key and "env" in run_kwargs:
                        _log_api_key_fallback(agent, task_label, stderr_snippet[:120])
                        run_kwargs["env"]["GEMINI_API_KEY"] = api_key
                        used_fallback = True
                        time.sleep(2)
                        continue
                if attempt < max_attempts:
                    time.sleep(5 * attempt)
                    continue
                _cleanup()
                return "", time.monotonic() - t0, used_fallback, "cli_error"

            raw = proc.stdout or ""
            output = _extract_output(agent, raw, gemini_home)
            _cleanup()

            if not output.strip():
                return "", time.monotonic() - t0, used_fallback, "empty_output"

            return output, time.monotonic() - t0, used_fallback, None

        except subprocess.TimeoutExpired:
            if attempt < max_attempts:
                print(f"    {agent}:{task_label} timed out, retrying...", file=sys.stderr)
                continue
            _cleanup()
            return "", time.monotonic() - t0, used_fallback, "timeout"
        except FileNotFoundError:
            _cleanup()
            return "", time.monotonic() - t0, used_fallback, "agent_unavailable"

    _cleanup()
    return "", time.monotonic() - t0, used_fallback, "unexpected_loop_exit"


# ── Phase 1: Generate Plans ───────────────────────────────────────────


def generate_plans(
    design_content: str,
    agents: list[str] | None = None,
    repo_dir: str | None = None,
    timeout: int = DEFAULT_TIMEOUT,
) -> dict[str, Any]:
    """Dispatch 3 agents to generate implementation plans from a design doc.

    Returns structured dict with plan outputs per agent.
    """
    if agents is None:
        agents = list(AGENTS)

    results: list[PlanOutput] = []
    total = len(agents)

    print(f"\n{'=' * 60}", file=sys.stderr)
    print(f"  Phase 1: Generate Plans — {total} agents", file=sys.stderr)
    print(f"{'=' * 60}", file=sys.stderr)

    with ThreadPoolExecutor(max_workers=total) as pool:
        futures = {}
        for agent in agents:
            prompt_text = _load_prompt(agent, "generate.md", repo_dir)
            if not prompt_text:
                prompt_text = (
                    "Read the following design document and produce a detailed, "
                    "phased implementation plan. Include phases, tasks, dependencies, "
                    "risk mitigations, and verification criteria for each phase."
                )

            full_prompt = f"{prompt_text}\n\n---\n\n# Design Document\n\n{design_content}"
            future = pool.submit(_run_agent, agent, full_prompt, task_label="generate", timeout=timeout)
            futures[future] = agent
            print(f"  [{agent}] generating plan...", file=sys.stderr)

        for future in as_completed(futures):
            agent = futures[future]
            output, duration, fallback, error = future.result()
            result = PlanOutput(
                agent=agent,
                plan_content=output,
                raw_output=output,
                error=error,
                duration_s=duration,
                api_key_fallback=fallback,
            )
            results.append(result)

            if error:
                print(f"  [{agent}] ERROR: {error} [{duration:.1f}s]", file=sys.stderr)
            else:
                lines = output.strip().count("\n") + 1
                print(f"  [{agent}] done — {lines} lines [{duration:.1f}s]", file=sys.stderr)

    succeeded = [r for r in results if not r.error]
    return {
        "phase": "generate",
        "results": [
            {
                "agent": r.agent,
                "plan_content": r.plan_content,
                "error": r.error,
                "duration_s": r.duration_s,
                "api_key_fallback": r.api_key_fallback,
            }
            for r in results
        ],
        "summary": {
            "total": total,
            "succeeded": len(succeeded),
            "failed": total - len(succeeded),
        },
    }


# ── Phase 2: Cross-Review Plans ──────────────────────────────────────


REVIEW_OUTPUT_FORMAT = (
    "Output your review as a JSON object with these fields:\n"
    '{"scores": {"completeness": 1-10, "feasibility": 1-10, "phasing": 1-10, '
    '"risk_coverage": 1-10, "testability": 1-10}, '
    '"strengths": ["strength 1", ...], '
    '"weaknesses": ["weakness 1", ...]}\n'
    "Output ONLY the JSON object, no other text."
)


def _parse_cross_review(raw: str) -> tuple[CrossReviewScore, list[str], list[str]]:
    """Parse cross-review JSON output into scores, strengths, weaknesses."""
    text = raw.strip()

    # Strip markdown fences
    fence_match = re.search(r"```(?:json)?\s*\n(.*?)```", text, re.DOTALL)
    if fence_match:
        text = fence_match.group(1).strip()

    # Handle double-encoded JSON
    if "\\n" in text and text.startswith('"'):
        try:
            text = json.loads(text)
        except (json.JSONDecodeError, ValueError):
            pass

    # Find outermost { ... }
    start = text.find("{")
    end = text.rfind("}")
    if start == -1 or end == -1:
        return CrossReviewScore(), [], []

    try:
        data = json.loads(text[start:end + 1])
    except json.JSONDecodeError:
        return CrossReviewScore(), [], []

    scores_data = data.get("scores", {})
    score = CrossReviewScore(
        completeness=int(scores_data.get("completeness", 0)),
        feasibility=int(scores_data.get("feasibility", 0)),
        phasing=int(scores_data.get("phasing", 0)),
        risk_coverage=int(scores_data.get("risk_coverage", 0)),
        testability=int(scores_data.get("testability", 0)),
    )
    strengths = data.get("strengths", [])
    weaknesses = data.get("weaknesses", [])
    return score, strengths, weaknesses


def cross_review_plans(
    design_content: str,
    plans: dict[str, str],
    agents: list[str] | None = None,
    repo_dir: str | None = None,
    timeout: int = DEFAULT_TIMEOUT,
) -> dict[str, Any]:
    """Dispatch 6 cross-reviews: each agent reviews the plans it didn't write.

    Args:
        design_content: Original design document
        plans: Dict of {agent_name: plan_content} from Phase 1
        agents: List of agent names (default: all 3)
        repo_dir: Repo root for prompt overrides
        timeout: Per-agent timeout in seconds
    """
    if agents is None:
        agents = list(AGENTS)

    # Build work items: (reviewer, plan_author)
    work_items = []
    for reviewer in agents:
        for author in agents:
            if reviewer != author and author in plans:
                work_items.append((reviewer, author))

    results: list[CrossReviewOutput] = []
    total = len(work_items)

    print(f"\n{'=' * 60}", file=sys.stderr)
    print(f"  Phase 2: Cross-Review — {total} reviews", file=sys.stderr)
    print(f"{'=' * 60}", file=sys.stderr)

    with ThreadPoolExecutor(max_workers=min(total, 6)) as pool:
        futures = {}
        for reviewer, author in work_items:
            prompt_text = _load_prompt(reviewer, "cross-review.md", repo_dir)
            if not prompt_text:
                prompt_text = (
                    "Review the following implementation plan against the original design document. "
                    "Score it on 5 dimensions (1-10 each): completeness, feasibility, phasing, "
                    "risk_coverage, testability. List strengths and weaknesses."
                )

            full_prompt = (
                f"{prompt_text}\n\n{REVIEW_OUTPUT_FORMAT}\n\n"
                f"---\n\n# Original Design Document\n\n{design_content}\n\n"
                f"---\n\n# Implementation Plan (by {author})\n\n{plans[author]}"
            )
            task_label = f"review-{author}"
            future = pool.submit(_run_agent, reviewer, full_prompt, task_label=task_label, timeout=timeout)
            futures[future] = (reviewer, author)
            print(f"  [{reviewer}] reviewing {author}'s plan...", file=sys.stderr)

        for future in as_completed(futures):
            reviewer, author = futures[future]
            output, duration, fallback, error = future.result()
            review = CrossReviewOutput(
                reviewer=reviewer,
                plan_author=author,
                raw_output=output,
                error=error,
                duration_s=duration,
                api_key_fallback=fallback,
            )

            if not error and output:
                scores, strengths, weaknesses = _parse_cross_review(output)
                review.scores = scores
                review.strengths = strengths
                review.weaknesses = weaknesses

            results.append(review)

            if error:
                print(f"  [{reviewer}→{author}] ERROR: {error} [{duration:.1f}s]", file=sys.stderr)
            else:
                print(
                    f"  [{reviewer}→{author}] done — avg {review.scores.average:.1f}/10 [{duration:.1f}s]",
                    file=sys.stderr,
                )

    # Aggregate scores per plan author
    plan_scores: dict[str, list[float]] = {a: [] for a in plans}
    for r in results:
        if not r.error and r.plan_author in plan_scores:
            plan_scores[r.plan_author].append(r.scores.average)

    plan_averages = {
        author: sum(scores) / len(scores) if scores else 0.0
        for author, scores in plan_scores.items()
    }
    winner = max(plan_averages, key=plan_averages.get) if plan_averages else None

    return {
        "phase": "cross-review",
        "results": [
            {
                "reviewer": r.reviewer,
                "plan_author": r.plan_author,
                "scores": asdict(r.scores),
                "strengths": r.strengths,
                "weaknesses": r.weaknesses,
                "error": r.error,
                "duration_s": r.duration_s,
                "api_key_fallback": r.api_key_fallback,
            }
            for r in results
        ],
        "plan_averages": plan_averages,
        "winner": winner,
        "summary": {
            "total": total,
            "succeeded": sum(1 for r in results if not r.error),
            "failed": sum(1 for r in results if r.error),
        },
    }


# ── CLI ───────────────────────────────────────────────────────────────


def main():
    parser = argparse.ArgumentParser(description="Design-to-plan dispatch")
    parser.add_argument("--mode", required=True, choices=["generate", "cross-review"],
                        help="Phase to run")
    parser.add_argument("--design-file", required=True, help="Path to design document")
    parser.add_argument("--plans-json", help="Path to JSON file with plans (for cross-review mode)")
    parser.add_argument("--agents", help="Comma-separated list of agents")
    parser.add_argument("--timeout", type=int, default=DEFAULT_TIMEOUT,
                        help="Per-agent timeout in seconds")
    parser.add_argument("--repo-dir", help="Repository root for prompt overrides")
    args = parser.parse_args()

    agents = args.agents.split(",") if args.agents else None
    design_content = Path(args.design_file).read_text()

    if args.mode == "generate":
        result = generate_plans(
            design_content=design_content,
            agents=agents,
            repo_dir=args.repo_dir,
            timeout=args.timeout,
        )
    elif args.mode == "cross-review":
        if not args.plans_json:
            print("--plans-json required for cross-review mode", file=sys.stderr)
            sys.exit(1)
        plans = json.loads(Path(args.plans_json).read_text())
        result = cross_review_plans(
            design_content=design_content,
            plans=plans,
            agents=agents,
            repo_dir=args.repo_dir,
            timeout=args.timeout,
        )
    else:
        print(f"Unknown mode: {args.mode}", file=sys.stderr)
        sys.exit(1)

    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
