#!/usr/bin/env python3
"""Vertex-compatible skill description optimizer.

The skill-creator plugin's run_loop.py couples its improvement step to
`anthropic.Anthropic()`, which requires ANTHROPIC_API_KEY. On Vertex
(the Evinced stack) that key isn't available, so the loop crashes
before the first iteration. This script is a local replacement for the
improve-half of that loop: it takes a skill path and an eval set,
shells out to `claude -p` for both the scoring and improvement steps
(which use whatever auth Claude Code is already configured with —
Vertex, Anthropic direct, or Bedrock), and iterates until either the
pass rate crosses a threshold or max_iterations is exhausted.

For scoring, it reuses the skill-creator plugin's run_eval.py module
which already uses `claude -p` subprocess correctly.

Usage:
    python3 scripts/optimize_skill_description.py \\
        --skill-path skill/stark-forged-review \\
        --eval-set path/to/trigger_eval.json \\
        --model claude-opus-4-6 \\
        --max-iterations 3 \\
        --out-json /tmp/optimize-results.json

Output:
    A JSON report with per-iteration scores, the best description
    found, and how that compares to the current description.

Design notes:

- This script does NOT modify the skill's SKILL.md on its own. It
  produces a report and a proposed description. The operator reviews
  and applies manually (consistent with the iteration-2 eval report's
  policy of never silently rewriting descriptions).
- The improvement prompt to `claude -p` is kept small and self-contained
  so it works with any model size.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

# The skill-creator plugin's run_eval module — we import it by path so
# we don't have to depend on the plugin being on PYTHONPATH.
_SKILL_CREATOR_PLUGIN_PATH = (
    Path.home()
    / ".claude"
    / "plugins"
    / "cache"
    / "claude-plugins-official"
    / "skill-creator"
    / "unknown"
    / "skills"
    / "skill-creator"
)


IMPROVE_PROMPT_TEMPLATE = """\
You are optimizing a Claude Code skill's YAML frontmatter description
so that Claude reliably triggers the skill for the right queries and
does not trigger it for adjacent ones.

Skill name: {skill_name}

Current description:
---
{current_description}
---

Scoring on this iteration's eval set:
  - should-trigger queries that FAILED (the skill should have fired but didn't):
{failed_should_trigger}
  - should-not-trigger queries that FAILED (the skill fired when it shouldn't have):
{failed_should_not_trigger}

Constraints for your new description:
1. Maximum 200 characters.
2. Concrete language — name the mechanism (leader+second, dynamic triage, etc.)
   rather than generic phrases like "reviews code".
3. Disambiguate from sibling skills so false-positives drop.
4. Stay honest — don't claim capabilities the skill doesn't have.

Output ONLY the new description text. No prose around it, no quotes,
no code fences. Just the raw description.
"""


def _run_eval(
    eval_set: Path,
    skill_path: Path,
    description: str,
    model: str,
    runs_per_query: int,
    timeout: int,
) -> dict[str, Any]:
    """Score a candidate description against the eval set.

    Delegates to the skill-creator plugin's run_eval.run_eval, which
    already uses claude -p subprocess and doesn't need an Anthropic key.
    """
    if not _SKILL_CREATOR_PLUGIN_PATH.exists():
        raise RuntimeError(
            f"skill-creator plugin not found at {_SKILL_CREATOR_PLUGIN_PATH}. "
            "Install the claude-plugins-official/skill-creator plugin first."
        )
    cmd = [
        sys.executable,
        "-m",
        "scripts.run_eval",
        "--eval-set",
        str(eval_set),
        "--skill-path",
        str(skill_path),
        "--description",
        description,
        "--model",
        model,
        "--runs-per-query",
        str(runs_per_query),
        "--timeout",
        str(timeout),
    ]
    result = subprocess.run(
        cmd,
        cwd=str(_SKILL_CREATOR_PLUGIN_PATH),
        capture_output=True,
        text=True,
        timeout=max(timeout * 2, 300),
    )
    if result.returncode != 0:
        raise RuntimeError(
            f"run_eval failed (exit {result.returncode}): {result.stderr.strip()[:500]}"
        )
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"run_eval output not JSON: {result.stdout[:500]}") from exc


def _propose_improvement(
    skill_name: str,
    current_description: str,
    eval_results: dict[str, Any],
    model: str,
    timeout: int,
) -> str:
    """Ask `claude -p` for a better description based on the eval failures."""
    failed_trigger = [
        r for r in eval_results["results"]
        if r.get("should_trigger") and not r.get("pass")
    ]
    failed_no_trigger = [
        r for r in eval_results["results"]
        if not r.get("should_trigger") and not r.get("pass")
    ]
    prompt = IMPROVE_PROMPT_TEMPLATE.format(
        skill_name=skill_name,
        current_description=current_description,
        failed_should_trigger=(
            "\n".join(f"  * {r['query'][:200]}" for r in failed_trigger) or "  (none)"
        ),
        failed_should_not_trigger=(
            "\n".join(f"  * {r['query'][:200]}" for r in failed_no_trigger) or "  (none)"
        ),
    )
    cmd = ["claude", "-p", prompt, "--model", model]
    result = subprocess.run(
        cmd, capture_output=True, text=True, timeout=timeout,
    )
    if result.returncode != 0:
        raise RuntimeError(
            f"claude -p improve step failed (exit {result.returncode}): "
            f"{result.stderr.strip()[:500]}"
        )
    return result.stdout.strip()


def _parse_skill_description(skill_path: Path) -> tuple[str, str]:
    """Read SKILL.md frontmatter and return (name, description)."""
    text = (skill_path / "SKILL.md").read_text(encoding="utf-8")
    lines = text.splitlines()
    if not lines or lines[0].strip() != "---":
        raise RuntimeError(f"{skill_path}/SKILL.md has no YAML frontmatter")
    name = ""
    description_lines: list[str] = []
    in_description = False
    for line in lines[1:]:
        if line.strip() == "---":
            break
        if line.startswith("name:"):
            name = line.split(":", 1)[1].strip()
            in_description = False
        elif line.startswith("description:"):
            rest = line.split(":", 1)[1].strip()
            in_description = True
            if rest and rest != ">-":
                description_lines.append(rest)
        elif in_description and line.startswith(" "):
            description_lines.append(line.strip())
        else:
            in_description = False
    return name, " ".join(description_lines).strip()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Optimize a skill's description (Vertex-compatible).",
    )
    parser.add_argument("--skill-path", type=Path, required=True)
    parser.add_argument("--eval-set", type=Path, required=True)
    parser.add_argument("--model", default="claude-opus-4-6")
    parser.add_argument("--max-iterations", type=int, default=3)
    parser.add_argument("--runs-per-query", type=int, default=3)
    parser.add_argument("--timeout", type=int, default=180)
    parser.add_argument("--trigger-threshold", type=float, default=0.8,
                        help="Stop when pass rate exceeds this fraction.")
    parser.add_argument("--out-json", type=Path, default=None,
                        help="Path to write the per-iteration report.")
    args = parser.parse_args(argv)

    skill_name, current_desc = _parse_skill_description(args.skill_path)
    print(f"[optimize] skill={skill_name}", file=sys.stderr, flush=True)
    print(f"[optimize] current description ({len(current_desc)} chars): {current_desc}",
          file=sys.stderr, flush=True)

    history: list[dict[str, Any]] = []
    best_description = current_desc
    best_pass_rate = 0.0

    for iteration in range(args.max_iterations + 1):
        label = "current" if iteration == 0 else f"iteration {iteration}"
        print(f"[optimize] scoring {label}…", file=sys.stderr, flush=True)
        t0 = time.time()
        eval_result = _run_eval(
            eval_set=args.eval_set,
            skill_path=args.skill_path,
            description=best_description if iteration == 0 else history[-1]["description"],
            model=args.model,
            runs_per_query=args.runs_per_query,
            timeout=args.timeout,
        )
        elapsed = time.time() - t0
        summary = eval_result.get("summary", {})
        total = summary.get("total", 0)
        passed = summary.get("passed", 0)
        pass_rate = (passed / total) if total else 0.0
        print(
            f"[optimize] {label}: {passed}/{total} = {pass_rate:.0%} "
            f"({elapsed:.0f}s)",
            file=sys.stderr,
            flush=True,
        )

        entry = {
            "iteration": iteration,
            "description": best_description if iteration == 0 else history[-1]["description"],
            "pass_rate": pass_rate,
            "passed": passed,
            "total": total,
            "eval_duration_s": elapsed,
        }
        history.append(entry)

        if pass_rate > best_pass_rate:
            best_pass_rate = pass_rate
            best_description = entry["description"]

        if pass_rate >= args.trigger_threshold:
            print(
                f"[optimize] pass rate {pass_rate:.0%} >= threshold "
                f"{args.trigger_threshold:.0%}, stopping",
                file=sys.stderr,
                flush=True,
            )
            break

        if iteration == args.max_iterations:
            break

        print("[optimize] proposing improved description…", file=sys.stderr, flush=True)
        try:
            new_desc = _propose_improvement(
                skill_name=skill_name,
                current_description=entry["description"],
                eval_results=eval_result,
                model=args.model,
                timeout=args.timeout,
            )
        except RuntimeError as exc:
            print(f"[optimize] improvement failed: {exc}", file=sys.stderr, flush=True)
            break
        history.append({
            "iteration": iteration + 0.5,
            "description": new_desc,
            "proposed_from_iteration": iteration,
        })
        print(f"[optimize] proposed ({len(new_desc)} chars): {new_desc}",
              file=sys.stderr, flush=True)

    report = {
        "skill_name": skill_name,
        "original_description": current_desc,
        "best_description": best_description,
        "best_pass_rate": best_pass_rate,
        "iterations": history,
    }
    print(json.dumps(report, indent=2))
    if args.out_json:
        args.out_json.write_text(json.dumps(report, indent=2), encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
