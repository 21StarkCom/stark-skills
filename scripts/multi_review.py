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

Prompts loaded from ~/git/Personal/Prompts/CodeReviews/{agent}/:
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
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

# ── Config ──────────────────────────────────────────────────────────────

SCRIPTS_DIR = Path(__file__).parent
PYTHON = str(SCRIPTS_DIR / ".venv" / "bin" / "python3")
GITHUB_APP = str(SCRIPTS_DIR / "github_app.py")
PROMPTS_DIR = Path.home() / "git" / "Personal" / "Prompts" / "CodeReviews"

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


def _discover_domains() -> dict[str, dict[str, Any]]:
    """Discover domains from prompt files in any agent directory.

    Scans the first agent directory to find numbered domain files like
    01-architecture.md and builds the domain registry.
    """
    domains: dict[str, dict[str, Any]] = {}
    # Use any agent dir as reference — they all have the same domain files
    for agent in AGENTS:
        agent_dir = PROMPTS_DIR / agent
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
            break  # Found domains from first agent dir
    return domains


DOMAINS = _discover_domains()

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


@dataclass
class ReviewRound:
    round_num: int
    results: list[SubAgentResult] = field(default_factory=list)
    tests_pass: bool = False
    test_output: str = ""


# ── Prompt loading ─────────────────────────────────────────────────────


def _load_agent_preamble(agent: str) -> str:
    """Load the agent-specific preamble (agent.md)."""
    path = PROMPTS_DIR / agent / "agent.md"
    if path.exists():
        return path.read_text().strip()
    return ""


def _load_domain_prompt(agent: str, domain_key: str) -> str:
    """Load the domain-specific review prompt for a given agent."""
    domain = DOMAINS.get(domain_key)
    if not domain:
        return f"Review this code for {domain_key} issues. {FINDINGS_FORMAT}"
    path = PROMPTS_DIR / agent / domain["filename"]
    if path.exists():
        return path.read_text().strip()
    # Fallback: try another agent's prompt
    for fallback_agent in AGENTS:
        fallback_path = PROMPTS_DIR / fallback_agent / domain["filename"]
        if fallback_path.exists():
            print(f"  [!] Using {fallback_agent}'s prompt for {agent}/{domain_key}", file=sys.stderr)
            return fallback_path.read_text().strip()
    print(f"  [!] No prompt file found for {agent}/{domain_key}", file=sys.stderr)
    return f"Review this code for {domain_key} issues. {FINDINGS_FORMAT}"


# ── Repo detection ─────────────────────────────────────────────────────


def detect_repo(cwd: str | None = None) -> str:
    """Detect GitHub org/repo from git remote origin."""
    try:
        result = subprocess.run(
            ["git", "remote", "get-url", "origin"],
            capture_output=True, text=True, timeout=5, cwd=cwd,
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
            capture_output=True, text=True, timeout=5, cwd=cwd,
        )
        if result.returncode == 0:
            return "main"
        result = subprocess.run(
            ["git", "rev-parse", "--verify", "master"],
            capture_output=True, text=True, timeout=5, cwd=cwd,
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
        capture_output=True, text=True, env=env, timeout=30,
    )
    if result.returncode != 0:
        return []
    numbers = [int(n) for n in result.stdout.strip().split("\n") if n.strip()]

    prs = []
    for num in numbers:
        pr_result = subprocess.run(
            ["gh", "api", f"repos/{repo}/pulls/{num}"],
            capture_output=True, text=True, env=env, timeout=30,
        )
        if pr_result.returncode == 0:
            prs.append(json.loads(pr_result.stdout))
    return prs


# ── GitHub App auth ────────────────────────────────────────────────────


def _get_gh_token(app: str) -> str:
    result = subprocess.run(
        [PYTHON, GITHUB_APP, "--app", app, "token"],
        capture_output=True, text=True, timeout=15,
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
            "gh", "api", f"repos/{repo}/pulls/{pr_number}/reviews",
            "--method", "POST",
            "-f", "event=COMMENT",
            "-f", f"body={body}",
        ],
        capture_output=True, text=True, env=env, timeout=30,
    )
    if result.returncode != 0:
        print(f"  [!] Failed to post review as {app}: {result.stderr}", file=sys.stderr)
        return False
    return True


# ── Findings parser ────────────────────────────────────────────────────


def _parse_findings(agent: str, domain: str, raw: str) -> list[Finding]:
    """Extract JSON findings from reviewer output."""
    cleaned = raw.strip()
    cleaned = re.sub(r"^```(?:json)?\s*\n?", "", cleaned)
    cleaned = re.sub(r"\n?```\s*$", "", cleaned)

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
        findings.append(Finding(
            agent=agent,
            domain=domain,
            severity=item.get("severity", "medium").lower(),
            file=item.get("file", "unknown"),
            line=int(item.get("line", 0)),
            title=item.get("title", "Untitled"),
            description=item.get("description", ""),
            suggestion=item.get("suggestion", ""),
        ))
    return findings


# ── Sub-agent runners ──────────────────────────────────────────────────


def _run_subagent(
    agent: str, domain_key: str, base: str, cwd: str | None = None,
) -> SubAgentResult:
    """Run a single sub-agent: one CLI tool × one domain."""
    t0 = time.time()
    preamble = _load_agent_preamble(agent)
    domain_prompt = _load_domain_prompt(agent, domain_key)
    full_prompt = f"{preamble}\n\n{domain_prompt}" if preamble else domain_prompt

    if agent == "claude":
        prompt = (
            f"Run 'git diff {base}...HEAD' and read all changed files. "
            f"Then review them according to these instructions:\n\n"
            f"{full_prompt}"
        )
        cmd = [
            "claude", "-p", prompt, "--output-format", "text",
            "--model", "claude-opus-4-6", "--max-tokens", "16384",
        ]

    elif agent == "codex":
        cmd = ["codex", "--effort", "xhigh", "review", "--base", base, full_prompt]

    elif agent == "gemini":
        cmd = ["gemini", "--model", "gemini-2.5-pro", "-p", full_prompt]

    else:
        return SubAgentResult(
            agent=agent, domain=domain_key, raw_output="",
            error=f"Unknown agent: {agent}", duration_s=0.0,
        )

    try:
        result = subprocess.run(
            cmd, capture_output=True, text=True, timeout=600, cwd=cwd,
        )
        raw = result.stdout
        findings = _parse_findings(agent, domain_key, raw)
        return SubAgentResult(
            agent=agent, domain=domain_key, raw_output=raw,
            findings=findings, duration_s=time.time() - t0,
        )
    except subprocess.TimeoutExpired:
        return SubAgentResult(
            agent=agent, domain=domain_key, raw_output="",
            error="Timed out after 600s", duration_s=time.time() - t0,
        )
    except Exception as e:
        return SubAgentResult(
            agent=agent, domain=domain_key, raw_output="",
            error=str(e), duration_s=time.time() - t0,
        )


# ── Orchestration ──────────────────────────────────────────────────────


def run_review_round(
    base: str,
    round_num: int,
    agents: list[str] | None = None,
    domains: list[str] | None = None,
    cwd: str | None = None,
    out: Any = None,
) -> ReviewRound:
    """Run one round of parallel reviews: agents × domains."""
    if out is None:
        out = sys.stdout
    agents = agents or list(AGENTS.keys())
    domains = domains or list(DOMAINS.keys())
    rnd = ReviewRound(round_num=round_num)

    total = len(agents) * len(domains)
    print(f"\n{'='*60}", file=out)
    print(f"  Review Round {round_num} — {len(agents)} agents × {len(domains)} domains = {total} sub-agents", file=out)
    print(f"{'='*60}", file=out)

    with ThreadPoolExecutor(max_workers=min(total, MAX_WORKERS)) as pool:
        futures = {}
        for agent in agents:
            agent_cfg = AGENTS[agent]
            for domain_key in domains:
                domain_cfg = DOMAINS[domain_key]
                future = pool.submit(_run_subagent, agent, domain_key, base, cwd)
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
                    f"  [{agent_cfg['emoji']}] {agent} × {domain_key}: "
                    f"ERROR — {result.error}",
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
        for f in sorted(
            result.findings, key=lambda f: SEVERITY_ORDER.get(f.severity, 99)
        ):
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


def all_findings(rnd: ReviewRound) -> list[Finding]:
    """Get all findings from a round, sorted by severity."""
    findings = []
    for result in rnd.results:
        findings.extend(result.findings)
    return sorted(findings, key=lambda f: SEVERITY_ORDER.get(f.severity, 99))


def has_actionable_findings(rnd: ReviewRound) -> bool:
    """Check if a round has critical, high, or medium findings that need fixing."""
    return any(
        f.severity in ("critical", "high", "medium")
        for f in all_findings(rnd)
    )


# ── Main ───────────────────────────────────────────────────────────────


def review_pr(
    repo: str,
    pr_number: int,
    base: str = "main",
    dry_run: bool = False,
    json_output: bool = False,
    json_only: bool = False,
    cwd: str | None = None,
) -> dict[str, Any]:
    """Run the full multi-agent review on a single PR."""
    out = sys.stderr if json_only else sys.stdout
    n_agents = len(AGENTS)
    n_domains = len(DOMAINS)

    print(f"\n{'#'*60}", file=out)
    print(f"  Multi-Agent Review: {repo} PR #{pr_number}", file=out)
    print(f"  Base: {base}", file=out)
    print(f"  {n_agents} agents × {n_domains} domains = {n_agents * n_domains} sub-agents", file=out)
    print(f"{'#'*60}", file=out)

    if not DOMAINS:
        print("  [!] No domain prompt files found in:", PROMPTS_DIR, file=sys.stderr)
        print("  [!] Expected files like 01-architecture.md", file=sys.stderr)
        sys.exit(1)

    rounds: list[ReviewRound] = []
    round_num = 0

    while True:
        round_num += 1
        rnd = run_review_round(base, round_num, cwd=cwd, out=out)
        rounds.append(rnd)

        # Post reviews to GitHub — one review per agent, consolidating all domains
        if not dry_run:
            print(f"\n  Posting reviews to PR #{pr_number}...", file=out)
            for agent, agent_cfg in AGENTS.items():
                body = format_agent_review_body(agent, rnd)
                if body:
                    ok = post_review(repo, pr_number, agent_cfg["app"], body)
                    status = "posted" if ok else "FAILED"
                    print(f"    {agent_cfg['emoji']} {agent} → {status}", file=out)

        # Check for actionable findings (critical/high/medium)
        if not has_actionable_findings(rnd):
            print(f"\n  Round {round_num}: No critical/high/medium findings. Review clean.", file=out)
            break

        actionable = [
            f for f in all_findings(rnd) if f.severity in ("critical", "high", "medium")
        ]
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
                sum(1 for f in all_findings(r) if f.severity == "critical")
                for r in rounds
            ),
            "high": sum(
                sum(1 for f in all_findings(r) if f.severity == "high")
                for r in rounds
            ),
            "medium": sum(
                sum(1 for f in all_findings(r) if f.severity == "medium")
                for r in rounds
            ),
            "clean": not has_actionable_findings(rounds[-1]) if rounds else False,
        },
    }

    if not json_output:
        print(f"\n{'='*60}", file=out)
        print("  Summary", file=out)
        print(f"{'='*60}", file=out)
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
        "--all-repos", nargs="+", metavar="DIR",
        help="Directories of repos to scan for open PRs",
    )

    parser.add_argument("--repo", help="Override repo (org/name). Default: auto-detect")
    parser.add_argument("--base", help="Base branch. Default: auto-detect (main/master)")
    parser.add_argument("--dry-run", action="store_true", help="Don't post reviews to GitHub")
    parser.add_argument("--json", action="store_true", dest="json_output", help="Output JSON only")
    parser.add_argument(
        "--json-only", action="store_true", dest="json_only",
        help="Strict JSON mode: stdout is JSON payload only, all logs go to stderr",
    )

    args = parser.parse_args()

    if args.pr:
        repo = args.repo or detect_repo()
        if not repo:
            print("Could not detect repo. Use --repo.", file=sys.stderr)
            sys.exit(1)
        base = args.base or detect_base_branch()

        result = review_pr(
            repo, args.pr, base,
            dry_run=args.dry_run,
            json_output=args.json_output or args.json_only,
            json_only=getattr(args, 'json_only', False),
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
                    repo, pr_num, base,
                    dry_run=args.dry_run, json_output=args.json_output,
                    cwd=repo_dir,
                )
                all_results.append(result)

        if args.json_output:
            print(json.dumps(all_results, indent=2))
        else:
            print(f"\n{'#'*60}")
            print(f"  Reviewed {len(all_results)} PRs across {len(args.all_repos)} repos")
            print(f"{'#'*60}")


if __name__ == "__main__":
    main()
