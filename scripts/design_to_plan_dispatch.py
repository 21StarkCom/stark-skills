#!/usr/bin/env python3
"""Multi-agent generate-and-cross-review dispatch.

Generic orchestrator for the 3-generate + 6-cross-review pattern:
  - Phase 1 (generate): 3 agents each independently produce a document
  - Phase 2 (cross-review): Each document is reviewed by the other 2 agents

Used by:
  - /stark-design-to-plan (design doc → implementation plan)
  - /stark-design (prompt/requirements → design document)

Prompts are loaded from ~/.claude/code-review/prompts/<prompts-dir>/{agent}/
where prompts-dir is specified via --prompts-dir.
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
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from claude_utils import build_claude_cmd
from codex_utils import CODEX_MODEL, CODEX_REASONING_EFFORT_HIGH, parse_jsonl_output
from gemini_utils import (
    GEMINI_MODEL, setup_gemini_home, make_gemini_env,
    parse_json_output as parse_gemini_output,
    should_fallback_to_api_key, try_gemini_api_key_fallback,
)

# ── Config ──────────────────────────────────────────────────────────────


SCRIPTS_DIR = Path(__file__).parent
DEFAULT_PROMPTS_DIR = "design-to-plan"

AGENTS = ["claude", "codex", "gemini"]
CODEX_REASONING_CONFIG = CODEX_REASONING_EFFORT_HIGH
DEFAULT_TIMEOUT = 600  # Generation needs more time than review


def _get_prompts_dir(prompts_dir: str | None = None) -> Path:
    """Return the prompts directory path."""
    name = prompts_dir or DEFAULT_PROMPTS_DIR
    return Path.home() / ".claude" / "code-review" / "prompts" / name


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
class CrossReviewOutput:
    reviewer: str
    plan_author: str
    scores: dict[str, int] = field(default_factory=dict)
    strengths: list[str] = field(default_factory=list)
    weaknesses: list[str] = field(default_factory=list)
    raw_output: str = ""
    error: str | None = None
    duration_s: float = 0.0
    api_key_fallback: bool = False

    @property
    def average(self) -> float:
        vals = [v for v in self.scores.values() if isinstance(v, (int, float))]
        return sum(vals) / len(vals) if vals else 0.0


# ── Prompt loading ─────────────────────────────────────────────────────


def _load_prompt(
    agent: str,
    filename: str,
    repo_dir: str | None = None,
    prompts_dir: str | None = None,
) -> str:
    """Load a prompt file: repo → global."""
    prompts_dir_name = prompts_dir or DEFAULT_PROMPTS_DIR
    if repo_dir:
        repo_path = Path(repo_dir) / ".code-review" / f"{prompts_dir_name}-prompts" / agent / filename
        if repo_path.exists():
            return repo_path.read_text().strip()
    global_path = _get_prompts_dir(prompts_dir) / agent / filename
    if global_path.exists():
        return global_path.read_text().strip()
    return ""


# ── CLI dispatch helpers ───────────────────────────────────────────────


def _extract_output(agent: str, raw: str, gemini_home: str | None = None) -> str:
    """Extract text content from agent-specific output formats."""
    if agent == "codex":
        return parse_jsonl_output(raw)

    if agent == "gemini":
        parsed = parse_gemini_output(raw)
        if parsed and len(parsed.strip()) > 100:
            return parsed

    # Gemini fallback: if stdout was empty/short, check if it wrote files to the workspace
    if agent == "gemini" and gemini_home and len((raw or "").strip()) < 100:
        import glob as _glob
        for pattern in ("**/*plan*.md", "**/*implementation*.md", "**/*.md"):
            found = _glob.glob(os.path.join(gemini_home, pattern), recursive=True)
            for fpath in sorted(found, key=os.path.getsize, reverse=True):
                try:
                    with open(fpath) as f:
                        content = f.read()
                    if len(content.strip()) > 100:
                        print(f"    gemini: recovered output from {fpath} ({len(content)} chars)",
                              file=sys.stderr)
                        return content
                except OSError:
                    continue

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
        cmd = build_claude_cmd()
        run_kwargs["input"] = prompt if stdin_content is None else f"{prompt}\n\n{stdin_content}"

    elif agent == "codex":
        effective_timeout = timeout * 2
        cmd = [
            "codex", "exec",
            "-m", CODEX_MODEL,
            "-c", CODEX_REASONING_CONFIG,
            "--ephemeral", "--json",
            "--full-auto",
            "-",
        ]
        run_kwargs["input"] = prompt if stdin_content is None else f"{prompt}\n\n{stdin_content}"
        run_kwargs["timeout"] = effective_timeout

    elif agent == "gemini":
        gemini_home = setup_gemini_home(
            "gemini-d2p-", os.getcwd(), "generate-review", approval_mode="plan",
        )
        cmd = [
            "gemini",
            "-m", GEMINI_MODEL,
            "-p", prompt,
            "-o", "json",
        ]
        if stdin_content:
            run_kwargs["input"] = stdin_content
        run_kwargs["env"] = make_gemini_env(gemini_home)
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
    used_api_key_fallback = False

    for attempt in range(1, max_attempts + 1):
        try:
            proc = subprocess.run(cmd, **run_kwargs)

            if proc.returncode != 0:
                stderr_snippet = proc.stderr[:500]
                print(
                    f"  [{agent}:{task_label}] CLI error (exit {proc.returncode}): {stderr_snippet}",
                    file=sys.stderr,
                )
                if (
                    agent == "gemini"
                    and attempt < max_attempts
                    and should_fallback_to_api_key(stderr_snippet)
                    and try_gemini_api_key_fallback(run_kwargs, task_label, stderr_snippet)
                ):
                    used_api_key_fallback = True
                    time.sleep(2)
                    continue
                if attempt < max_attempts:
                    time.sleep(5 * attempt)
                    continue
                _cleanup()
                return "", time.monotonic() - t0, used_api_key_fallback, "cli_error"

            raw = proc.stdout or ""
            output = _extract_output(agent, raw, gemini_home)
            _cleanup()

            if not output.strip():
                return "", time.monotonic() - t0, used_api_key_fallback, "empty_output"

            return output, time.monotonic() - t0, used_api_key_fallback, None

        except subprocess.TimeoutExpired:
            if attempt < max_attempts:
                print(f"    {agent}:{task_label} timed out, retrying...", file=sys.stderr)
                continue
            _cleanup()
            return "", time.monotonic() - t0, used_api_key_fallback, "timeout"
        except FileNotFoundError:
            _cleanup()
            return "", time.monotonic() - t0, used_api_key_fallback, "agent_unavailable"

    _cleanup()
    return "", time.monotonic() - t0, used_api_key_fallback, "unexpected_loop_exit"


# ── Phase 1: Generate Plans ───────────────────────────────────────────


def generate_plans(
    design_content: str,
    agents: list[str] | None = None,
    repo_dir: str | None = None,
    timeout: int = DEFAULT_TIMEOUT,
    prompts_dir: str | None = None,
) -> dict[str, Any]:
    """Dispatch 3 agents to generate documents from input content.

    Returns structured dict with outputs per agent.
    """
    if agents is None:
        agents = list(AGENTS)

    results: list[PlanOutput] = []
    total = len(agents)

    print(f"\n{'=' * 60}", file=sys.stderr)
    print(f"  Phase 1: Generate — {total} agents", file=sys.stderr)
    print(f"{'=' * 60}", file=sys.stderr)

    with ThreadPoolExecutor(max_workers=total) as pool:
        futures = {}
        for agent in agents:
            prompt_text = _load_prompt(agent, "generate.md", repo_dir, prompts_dir)
            if not prompt_text:
                prompt_text = (
                    "Read the following design document and produce a detailed, "
                    "phased implementation plan. Include phases, tasks, dependencies, "
                    "risk mitigations, and verification criteria for each phase."
                )

            full_prompt = f"{prompt_text}\n\n---\n\n# Input Document\n\n{design_content}"
            future = pool.submit(_run_agent, agent, full_prompt, task_label="generate", timeout=timeout)
            futures[future] = agent
            print(f"  [{agent}] generating...", file=sys.stderr)

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
    '{"scores": {"dimension1": 1-10, "dimension2": 1-10, ...}, '
    '"strengths": ["strength 1", ...], '
    '"weaknesses": ["weakness 1", ...]}\n'
    "Output ONLY the JSON object, no other text."
)


def _parse_cross_review(raw: str) -> tuple[dict[str, int], list[str], list[str]]:
    """Parse cross-review JSON output into scores dict, strengths, weaknesses."""
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
        return {}, [], []

    try:
        data = json.loads(text[start:end + 1])
    except json.JSONDecodeError:
        return {}, [], []

    scores_data = data.get("scores", {})
    scores = {k: int(v) for k, v in scores_data.items() if isinstance(v, (int, float, str))}
    strengths = data.get("strengths", [])
    weaknesses = data.get("weaknesses", [])
    return scores, strengths, weaknesses


def cross_review_plans(
    design_content: str,
    plans: dict[str, str],
    agents: list[str] | None = None,
    repo_dir: str | None = None,
    timeout: int = DEFAULT_TIMEOUT,
    prompts_dir: str | None = None,
) -> dict[str, Any]:
    """Dispatch cross-reviews: each agent reviews the documents it didn't write.

    Args:
        design_content: Original input document
        plans: Dict of {agent_name: generated_content} from Phase 1
        agents: List of agent names (default: all 3)
        repo_dir: Repo root for prompt overrides
        timeout: Per-agent timeout in seconds
        prompts_dir: Prompt directory name (e.g. "design-to-plan", "prompt-to-design")
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
            prompt_text = _load_prompt(reviewer, "cross-review.md", repo_dir, prompts_dir)
            if not prompt_text:
                prompt_text = (
                    "Review the following document against the original input. "
                    "Score it on relevant dimensions (1-10 each). "
                    "List strengths and weaknesses."
                )

            full_prompt = (
                f"{prompt_text}\n\n{REVIEW_OUTPUT_FORMAT}\n\n"
                f"---\n\n# Original Input\n\n{design_content}\n\n"
                f"---\n\n# Generated Document (by {author})\n\n{plans[author]}"
            )
            task_label = f"review-{author}"
            future = pool.submit(_run_agent, reviewer, full_prompt, task_label=task_label, timeout=timeout)
            futures[future] = (reviewer, author)
            print(f"  [{reviewer}] reviewing {author}'s output...", file=sys.stderr)

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
                    f"  [{reviewer}→{author}] done — avg {review.average:.1f}/10 [{duration:.1f}s]",
                    file=sys.stderr,
                )

    # Aggregate scores per plan author
    plan_scores: dict[str, list[float]] = {a: [] for a in plans}
    for r in results:
        if not r.error and r.plan_author in plan_scores:
            plan_scores[r.plan_author].append(r.average)

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
                "scores": r.scores,
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
    parser = argparse.ArgumentParser(description="Multi-agent generate-and-cross-review dispatch")
    parser.add_argument("--mode", required=True, choices=["generate", "cross-review"],
                        help="Phase to run")
    parser.add_argument("--design-file", required=True, help="Path to input document")
    parser.add_argument("--plans-json", help="Path to JSON file with generated docs (for cross-review mode)")
    parser.add_argument("--agents", help="Comma-separated list of agents")
    parser.add_argument("--timeout", type=int, default=DEFAULT_TIMEOUT,
                        help="Per-agent timeout in seconds")
    parser.add_argument("--repo-dir", help="Repository root for prompt overrides")
    parser.add_argument("--prompts-dir", default=DEFAULT_PROMPTS_DIR,
                        help=f"Prompt directory name under ~/.claude/code-review/prompts/ (default: {DEFAULT_PROMPTS_DIR})")
    args = parser.parse_args()

    agents = args.agents.split(",") if args.agents else None
    design_content = Path(args.design_file).read_text()

    if args.mode == "generate":
        result = generate_plans(
            design_content=design_content,
            agents=agents,
            repo_dir=args.repo_dir,
            timeout=args.timeout,
            prompts_dir=args.prompts_dir,
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
            prompts_dir=args.prompts_dir,
        )
    else:
        print(f"Unknown mode: {args.mode}", file=sys.stderr)
        sys.exit(1)

    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
