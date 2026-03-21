# `/stark-review-plan` Skill Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a `/stark-review-plan` Claude Code skill that reviews design documents using 3 LLMs × 7 domains in parallel, auto-fixes findings, and iterates until clean or max rounds.

**Architecture:** The skill is a SKILL.md that Claude Code follows. It calls `plan_review_dispatch.py` (new script) once per round to dispatch 21 parallel sub-agent reviews via ThreadPoolExecutor. The main Claude instance fixes the plan between rounds. All work happens in place (no worktree).

**Tech Stack:** Python 3 (plan_review_dispatch.py), Markdown (SKILL.md + 24 prompt files), Bash (install.sh)

**Spec:** `docs/specs/2026-03-17-stark-review-plan-design.md`

---

## File Structure

| Action | File | Responsibility |
|--------|------|---------------|
| Create | `scripts/plan_review_dispatch.py` | Parallel dispatch: read plan, resolve prompts, run 21 CLI calls, return JSON |
| Create | `scripts/test_plan_review_dispatch.py` | Tests for dispatch script |
| Create | `skill/stark-review-plan/SKILL.md` | Skill definition — narrative workflow for Claude Code |
| Create | `global/prompts/plan-review/claude/agent.md` | Claude preamble for plan review |
| Create | `global/prompts/plan-review/claude/00-general.md` | General/holistic review |
| Create | `global/prompts/plan-review/claude/01-feasibility.md` | Feasibility review |
| Create | `global/prompts/plan-review/claude/02-completeness.md` | Completeness review |
| Create | `global/prompts/plan-review/claude/03-security.md` | Security & compliance review |
| Create | `global/prompts/plan-review/claude/04-operability.md` | Operability review |
| Create | `global/prompts/plan-review/claude/05-scope.md` | Scope & complexity review |
| Create | `global/prompts/plan-review/claude/06-api-design.md` | API & interface design review |
| Create | `global/prompts/plan-review/codex/agent.md` | Codex preamble |
| Create | `global/prompts/plan-review/codex/00-general.md` through `06-api-design.md` | Codex domain prompts (7 files) |
| Create | `global/prompts/plan-review/gemini/agent.md` | Gemini preamble |
| Create | `global/prompts/plan-review/gemini/00-general.md` through `06-api-design.md` | Gemini domain prompts (7 files) |
| Modify | `install.sh` | Add skill symlink for stark-review-plan |
| Modify | `CLAUDE.md` | Document `/stark-review-plan` skill |

---

## Chunk 1: Dispatch Script — Core

### Task 1: Scaffold `plan_review_dispatch.py` with prompt resolution

**Files:**
- Create: `scripts/plan_review_dispatch.py`
- Create: `scripts/test_plan_review_dispatch.py`

- [ ] **Step 1: Write failing test for prompt resolution**

```python
# scripts/test_plan_review_dispatch.py
"""Tests for plan_review_dispatch.py."""

import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent))


class TestPromptResolution:
    """Plan review prompts resolve: repo → global."""

    def test_global_prompt_found(self, tmp_path):
        """Global prompt is used when no repo override exists."""
        global_dir = tmp_path / "global" / "plan-review" / "claude"
        global_dir.mkdir(parents=True)
        (global_dir / "01-feasibility.md").write_text("Global feasibility prompt")

        from plan_review_dispatch import resolve_plan_prompt

        result = resolve_plan_prompt(
            "claude",
            "01-feasibility.md",
            repo_dir=str(tmp_path / "repo"),
            global_prompts_dir=str(tmp_path / "global" / "plan-review"),
        )
        assert result == "Global feasibility prompt"

    def test_repo_overrides_global(self, tmp_path):
        """Repo-level prompt wins over global."""
        global_dir = tmp_path / "global" / "plan-review" / "claude"
        global_dir.mkdir(parents=True)
        (global_dir / "01-feasibility.md").write_text("Global feasibility prompt")

        repo_dir = tmp_path / "repo"
        repo_prompts = repo_dir / ".code-review" / "plan-prompts" / "claude"
        repo_prompts.mkdir(parents=True)
        (repo_prompts / "01-feasibility.md").write_text("Repo feasibility prompt")

        from plan_review_dispatch import resolve_plan_prompt

        result = resolve_plan_prompt(
            "claude",
            "01-feasibility.md",
            repo_dir=str(repo_dir),
            global_prompts_dir=str(tmp_path / "global" / "plan-review"),
        )
        assert result == "Repo feasibility prompt"

    def test_no_prompt_returns_empty(self, tmp_path):
        """Missing prompt returns empty string."""
        from plan_review_dispatch import resolve_plan_prompt

        result = resolve_plan_prompt(
            "claude",
            "99-nonexistent.md",
            repo_dir=str(tmp_path),
            global_prompts_dir=str(tmp_path / "global"),
        )
        assert result == ""
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/aryeh/git/Evinced/stark-skills && python3 -m pytest scripts/test_plan_review_dispatch.py::TestPromptResolution -v`
Expected: FAIL — `plan_review_dispatch` not found

- [ ] **Step 3: Create `plan_review_dispatch.py` with prompt resolution**

```python
#!/usr/bin/env python3
"""Plan review dispatch — parallel sub-agent reviews for design documents.

Dispatches 3 agents (Claude, Codex, Gemini) × 7 domains in parallel using
ThreadPoolExecutor. Returns structured JSON on stdout.

Usage:
    plan_review_dispatch.py --file path/to/plan.md --round 1
    plan_review_dispatch.py --file path/to/plan.md --round 1 --timeout 300
"""

from __future__ import annotations

import argparse
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
    '{"severity": "critical|high|medium|low", "section": "heading text", '
    '"title": "short title", "description": "what is wrong", '
    '"suggestion": "how to fix it"}. '
    "If no issues found, return an empty array []. "
    "Output ONLY the JSON array, no other text."
)

DEFAULT_TIMEOUT = 300  # 5 minutes per sub-agent


# ── Prompt resolution ─────────────────────────────────────────────────


def resolve_plan_prompt(
    agent: str,
    filename: str,
    repo_dir: str | None = None,
    global_prompts_dir: str | None = None,
) -> str:
    """Resolve a plan review prompt: repo → global (2 levels)."""
    if global_prompts_dir is None:
        global_prompts_dir = str(GLOBAL_PROMPTS_DIR)

    # 1. Repo override
    if repo_dir:
        candidate = Path(repo_dir) / ".code-review" / "plan-prompts" / agent / filename
        if candidate.exists():
            return candidate.read_text().strip()

    # 2. Global
    global_path = Path(global_prompts_dir) / agent / filename
    if global_path.exists():
        return global_path.read_text().strip()

    return ""


def _load_plan_review_config(repo_dir: str | None = None) -> dict:
    """Load plan_review config section from hierarchical config files."""
    defaults = {
        "agents": ["claude", "codex", "gemini"],
        "fix_threshold": "medium",
        "disabled_domains": [],
        "max_rounds": 3,
    }
    # Check repo config, then global config
    paths = []
    if repo_dir:
        p = Path(repo_dir) / ".code-review" / "config.json"
        if p.exists():
            paths.append(p)
    global_cfg = Path.home() / ".claude" / "code-review" / "config.json"
    if global_cfg.exists():
        paths.append(global_cfg)

    # Apply: global first, then repo (repo wins)
    for cfg_path in reversed(paths):
        try:
            data = json.loads(cfg_path.read_text())
            plan_cfg = data.get("plan_review", {})
            for k, v in plan_cfg.items():
                defaults[k] = v
        except (json.JSONDecodeError, OSError):
            continue
    return defaults


def _discover_plan_domains(global_prompts_dir: str | None = None) -> dict[str, str]:
    """Discover plan review domains from prompt files.

    Returns: {domain_key: filename} e.g. {"general": "00-general.md"}
    """
    if global_prompts_dir is None:
        global_prompts_dir = str(GLOBAL_PROMPTS_DIR)

    domains: dict[str, str] = {}
    # Scan first agent directory that exists
    for agent in AGENTS:
        agent_dir = Path(global_prompts_dir) / agent
        if not agent_dir.exists():
            continue
        for f in sorted(agent_dir.glob("[0-9]*.md")):
            key = f.stem.split("-", 1)[1] if "-" in f.stem else f.stem
            if key not in domains:
                domains[key] = f.name
        if domains:
            break
    return domains
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/aryeh/git/Evinced/stark-skills && python3 -m pytest scripts/test_plan_review_dispatch.py::TestPromptResolution -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/plan_review_dispatch.py scripts/test_plan_review_dispatch.py
git commit -m "feat: add plan_review_dispatch.py with prompt resolution"
```

---

### Task 2: Add sub-agent dispatch with timeout and error handling

**Depends on:** Task 1

**Files:**
- Modify: `scripts/plan_review_dispatch.py`
- Modify: `scripts/test_plan_review_dispatch.py`

- [ ] **Step 1: Write failing test for sub-agent dispatch**

```python
from unittest.mock import MagicMock, patch


class TestSubAgentDispatch:
    """Sub-agent dispatch with timeout and error handling."""

    @patch("plan_review_dispatch.subprocess.run")
    def test_claude_dispatch(self, mock_run):
        """Claude is dispatched with correct CLI flags."""
        mock_run.return_value = MagicMock(
            stdout='[{"severity":"medium","section":"Auth","title":"test","description":"d","suggestion":"s"}]',
            returncode=0,
        )
        from plan_review_dispatch import _run_plan_subagent

        result = _run_plan_subagent("claude", "feasibility", "Test plan content", timeout=300)
        cmd = mock_run.call_args[0][0]
        assert cmd[0] == "claude"
        assert "--model" in cmd
        assert "claude-opus-4-6" in cmd
        assert len(result.findings) == 1
        assert result.error is None

    @patch("plan_review_dispatch.subprocess.run")
    def test_codex_dispatch(self, mock_run):
        """Codex is dispatched with effort xhigh."""
        mock_run.return_value = MagicMock(stdout="[]", returncode=0)
        from plan_review_dispatch import _run_plan_subagent

        result = _run_plan_subagent("codex", "general", "Test plan", timeout=300)
        cmd = mock_run.call_args[0][0]
        assert cmd[0] == "codex"
        assert "-c" in cmd
        assert 'model_reasoning_effort="xhigh"' in cmd

    @patch("plan_review_dispatch.subprocess.run")
    def test_gemini_dispatch(self, mock_run):
        """Gemini is dispatched with pro model."""
        mock_run.return_value = MagicMock(stdout="[]", returncode=0)
        from plan_review_dispatch import _run_plan_subagent

        result = _run_plan_subagent("gemini", "security", "Test plan", timeout=300)
        cmd = mock_run.call_args[0][0]
        assert cmd[0] == "gemini"
        assert "--model" in cmd
        assert "gemini-2.5-pro" in cmd

    @patch("plan_review_dispatch.subprocess.run")
    def test_timeout_recorded(self, mock_run):
        """Timeout produces error result, not crash."""
        mock_run.side_effect = subprocess.TimeoutExpired(cmd=["claude"], timeout=300)
        from plan_review_dispatch import _run_plan_subagent

        result = _run_plan_subagent("claude", "feasibility", "Test plan", timeout=300)
        assert result.error == "timeout"
        assert len(result.findings) == 0

    @patch("plan_review_dispatch.subprocess.run")
    def test_malformed_json_recorded(self, mock_run):
        """Malformed output produces parse_error, not crash."""
        mock_run.return_value = MagicMock(stdout="This is not JSON at all", returncode=0)
        from plan_review_dispatch import _run_plan_subagent

        result = _run_plan_subagent("claude", "general", "Test plan", timeout=300)
        assert result.error == "parse_error"
        assert len(result.findings) == 0
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/aryeh/git/Evinced/stark-skills && python3 -m pytest scripts/test_plan_review_dispatch.py::TestSubAgentDispatch -v`
Expected: FAIL — `_run_plan_subagent` not found

- [ ] **Step 3: Implement `_run_plan_subagent` and data structures**

Add to `scripts/plan_review_dispatch.py`:

```python
# ── Data structures ────────────────────────────────────────────────────


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


# ── Sub-agent dispatch ─────────────────────────────────────────────────


def _parse_plan_findings(agent: str, domain: str, raw: str) -> list[PlanFinding]:
    """Parse JSON findings from sub-agent output."""
    # Strip markdown fences if present
    text = raw.strip()
    if text.startswith("```"):
        lines = text.split("\n")
        text = "\n".join(lines[1:-1] if lines[-1].strip() == "```" else lines[1:])

    # Find the JSON array in the output
    start = text.find("[")
    end = text.rfind("]")
    if start == -1 or end == -1:
        return []

    try:
        items = json.loads(text[start : end + 1])
    except json.JSONDecodeError:
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
    """Run a single sub-agent: one CLI tool × one domain."""
    t0 = time.time()

    full_prompt = f"{prompt_text}\n\n---\n\nDOCUMENT TO REVIEW:\n\n{plan_content}" if prompt_text else (
        f"Review this design document for issues. {FINDINGS_FORMAT}\n\n"
        f"DOCUMENT TO REVIEW:\n\n{plan_content}"
    )

    if agent == "claude":
        cmd = [
            "claude", "-p", "-", "--output-format", "text",
            "--model", "claude-opus-4-6",
        ]
    elif agent == "codex":
        cmd = ["codex", "exec", "-c", 'model_reasoning_effort="xhigh"', full_prompt]
    elif agent == "gemini":
        cmd = ["gemini", "--model", "gemini-2.5-pro", "-p", full_prompt]
    else:
        return PlanSubAgentResult(
            agent=agent, domain=domain_key, error=f"Unknown agent: {agent}",
        )

    try:
        result = subprocess.run(
            cmd, capture_output=True, text=True, timeout=timeout,
        )
        raw = result.stdout
        findings = _parse_plan_findings(agent, domain_key, raw)
        if not findings and raw.strip() and raw.strip() != "[]":
            return PlanSubAgentResult(
                agent=agent, domain=domain_key, raw_output=raw,
                error="parse_error", duration_s=time.time() - t0,
            )
        return PlanSubAgentResult(
            agent=agent, domain=domain_key, raw_output=raw,
            findings=findings, duration_s=time.time() - t0,
        )
    except subprocess.TimeoutExpired:
        return PlanSubAgentResult(
            agent=agent, domain=domain_key,
            error="timeout", duration_s=time.time() - t0,
        )
    except FileNotFoundError:
        return PlanSubAgentResult(
            agent=agent, domain=domain_key,
            error="agent_unavailable", duration_s=time.time() - t0,
        )
    except Exception as e:
        return PlanSubAgentResult(
            agent=agent, domain=domain_key,
            error=str(e), duration_s=time.time() - t0,
        )
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/aryeh/git/Evinced/stark-skills && python3 -m pytest scripts/test_plan_review_dispatch.py::TestSubAgentDispatch -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/plan_review_dispatch.py scripts/test_plan_review_dispatch.py
git commit -m "feat: add sub-agent dispatch with timeout and error handling"
```

---

### Task 3: Add parallel dispatch orchestration and CLI

**Depends on:** Task 2

**Files:**
- Modify: `scripts/plan_review_dispatch.py`
- Modify: `scripts/test_plan_review_dispatch.py`

- [ ] **Step 1: Write failing test for parallel dispatch**

```python
class TestParallelDispatch:
    """Full parallel dispatch returns structured JSON."""

    @patch("plan_review_dispatch._run_plan_subagent")
    def test_dispatches_all_agent_domain_combinations(self, mock_sub, tmp_path):
        """Should dispatch agents × domains sub-agents."""
        from plan_review_dispatch import PlanSubAgentResult, dispatch_plan_review

        # Create minimal prompt files for 2 domains
        for agent in ["claude", "codex", "gemini"]:
            d = tmp_path / "prompts" / agent
            d.mkdir(parents=True)
            (d / "agent.md").write_text(f"{agent} preamble")
            (d / "00-general.md").write_text("General prompt")
            (d / "01-feasibility.md").write_text("Feasibility prompt")

        mock_sub.return_value = PlanSubAgentResult(
            agent="claude", domain="general", raw_output="[]",
        )

        result = dispatch_plan_review(
            plan_content="Test plan",
            round_num=1,
            global_prompts_dir=str(tmp_path / "prompts"),
        )

        # 3 agents × 2 domains = 6 calls
        assert mock_sub.call_count == 6
        assert result["round"] == 1

    @patch("plan_review_dispatch._run_plan_subagent")
    def test_partial_failure_still_returns(self, mock_sub, tmp_path):
        """If some sub-agents fail, still return partial results."""
        from plan_review_dispatch import PlanSubAgentResult, dispatch_plan_review

        for agent in ["claude", "codex", "gemini"]:
            d = tmp_path / "prompts" / agent
            d.mkdir(parents=True)
            (d / "agent.md").write_text(f"{agent} preamble")
            (d / "00-general.md").write_text("General prompt")

        def side_effect(agent, domain, content, prompt_text="", timeout=300):
            if agent == "codex":
                return PlanSubAgentResult(agent=agent, domain=domain, error="timeout")
            return PlanSubAgentResult(agent=agent, domain=domain, raw_output="[]")

        mock_sub.side_effect = side_effect

        result = dispatch_plan_review(
            plan_content="Test plan",
            round_num=1,
            global_prompts_dir=str(tmp_path / "prompts"),
        )

        # Should still have results for all agents
        errors = [r for r in result["results"] if r.get("error")]
        assert len(errors) == 1  # codex failed
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/aryeh/git/Evinced/stark-skills && python3 -m pytest scripts/test_plan_review_dispatch.py::TestParallelDispatch -v`
Expected: FAIL — `dispatch_plan_review` not found

- [ ] **Step 3: Implement `dispatch_plan_review` and `main`**

Add to `scripts/plan_review_dispatch.py`:

```python
# ── Orchestration ──────────────────────────────────────────────────────

MAX_WORKERS = 21  # 3 agents × 7 domains


def dispatch_plan_review(
    plan_content: str,
    round_num: int,
    repo_dir: str | None = None,
    global_prompts_dir: str | None = None,
    agents: list[str] | None = None,
    disabled_domains: list[str] | None = None,
    timeout: int = DEFAULT_TIMEOUT,
) -> dict[str, Any]:
    """Dispatch all sub-agents in parallel and return structured results."""
    if global_prompts_dir is None:
        global_prompts_dir = str(GLOBAL_PROMPTS_DIR)
    if agents is None:
        agents = list(AGENTS)
    if disabled_domains is None:
        disabled_domains = []

    domains = _discover_plan_domains(global_prompts_dir)
    active_domains = {k: v for k, v in domains.items() if k not in disabled_domains}

    total = len(agents) * len(active_domains)
    print(
        f"  Plan Review Round {round_num} — {len(agents)} agents × "
        f"{len(active_domains)} domains = {total} sub-agents",
        file=sys.stderr,
    )

    results: list[dict[str, Any]] = []

    with ThreadPoolExecutor(max_workers=min(total, MAX_WORKERS)) as pool:
        futures = {}
        for agent in agents:
            for domain_key, domain_filename in active_domains.items():
                preamble = resolve_plan_prompt(
                    agent, "agent.md",
                    repo_dir=repo_dir, global_prompts_dir=global_prompts_dir,
                )
                domain_prompt = resolve_plan_prompt(
                    agent, domain_filename,
                    repo_dir=repo_dir, global_prompts_dir=global_prompts_dir,
                )
                prompt_text = f"{preamble}\n\n{domain_prompt}" if preamble else domain_prompt

                future = pool.submit(
                    _run_plan_subagent, agent, domain_key, plan_content,
                    prompt_text=prompt_text, timeout=timeout,
                )
                futures[future] = (agent, domain_key)

        for future in as_completed(futures):
            agent, domain_key = futures[future]
            try:
                r = future.result()
                results.append(asdict(r))
                status = f"{'✓' if not r.error else '✗'} {r.error or f'{len(r.findings)} findings'}"
            except Exception as e:
                results.append({"agent": agent, "domain": domain_key, "error": str(e)})
                status = f"✗ {e}"
            print(f"  [{agent}/{domain_key}] {status} ({r.duration_s:.1f}s)", file=sys.stderr)

    # Coverage check
    all_findings = []
    for r in results:
        for f in r.get("findings", []):
            all_findings.append(f)
    valid_count = sum(1 for r in results if not r.get("error"))
    if valid_count < total / 2:
        print(
            f"  ⚠ Low coverage: only {valid_count}/{total} sub-agents returned valid results",
            file=sys.stderr,
        )

    return {
        "round": round_num,
        "agents": agents,
        "domains": list(active_domains.keys()),
        "results": results,
        "summary": {
            "total_findings": len(all_findings),
            "critical": sum(1 for f in all_findings if f.get("severity") == "critical"),
            "high": sum(1 for f in all_findings if f.get("severity") == "high"),
            "medium": sum(1 for f in all_findings if f.get("severity") == "medium"),
            "low": sum(1 for f in all_findings if f.get("severity") == "low"),
            "valid_agents": valid_count,
            "total_agents": total,
        },
    }


# ── CLI ────────────────────────────────────────────────────────────────


def main():
    parser = argparse.ArgumentParser(description="Plan review dispatch — parallel sub-agent reviews")
    parser.add_argument("--file", required=True, help="Path to the plan/spec markdown file")
    parser.add_argument("--round", type=int, default=1, help="Round number (for logging)")
    parser.add_argument("--timeout", type=int, default=DEFAULT_TIMEOUT, help="Per-agent timeout in seconds")
    parser.add_argument("--repo-dir", help="Repo directory for prompt overrides")
    parser.add_argument("--agents", help="Comma-separated agent list override")
    parser.add_argument("--disabled-domains", help="Comma-separated disabled domain list")
    args = parser.parse_args()

    plan_path = Path(args.file)
    if not plan_path.exists():
        print(f"Error: file not found: {args.file}", file=sys.stderr)
        sys.exit(1)

    plan_content = plan_path.read_text()

    # Load config from hierarchy (repo → global)
    config = _load_plan_review_config(args.repo_dir)
    agents = args.agents.split(",") if args.agents else config.get("agents")
    disabled = args.disabled_domains.split(",") if args.disabled_domains else config.get("disabled_domains")

    result = dispatch_plan_review(
        plan_content=plan_content,
        round_num=args.round,
        repo_dir=args.repo_dir,
        agents=agents,
        disabled_domains=disabled,
        timeout=args.timeout,
    )

    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
```

- [ ] **Step 4: Run all tests**

Run: `cd /Users/aryeh/git/Evinced/stark-skills && python3 -m pytest scripts/test_plan_review_dispatch.py -v`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/plan_review_dispatch.py scripts/test_plan_review_dispatch.py
git commit -m "feat: add parallel dispatch orchestration and CLI"
```

---

## Chunk 2: Prompt Files (24 files)

### Task 4: Create Claude agent preamble and domain prompts

**Files:**
- Create: `global/prompts/plan-review/claude/agent.md`
- Create: `global/prompts/plan-review/claude/00-general.md`
- Create: `global/prompts/plan-review/claude/01-feasibility.md`
- Create: `global/prompts/plan-review/claude/02-completeness.md`
- Create: `global/prompts/plan-review/claude/03-security.md`
- Create: `global/prompts/plan-review/claude/04-operability.md`
- Create: `global/prompts/plan-review/claude/05-scope.md`
- Create: `global/prompts/plan-review/claude/06-api-design.md`

- [ ] **Step 1: Create directory structure**

```bash
mkdir -p global/prompts/plan-review/claude
```

- [ ] **Step 2: Write Claude agent preamble**

Create `global/prompts/plan-review/claude/agent.md`:

```markdown
# Claude — Plan Review Agent

## Identity
You are reviewing a design document / spec / implementation plan as the **stark-claude** GitHub App bot.

## Strengths to Lean Into
- Nuanced architectural reasoning — you see systemic implications
- Long-context comprehension — you can hold the full document in mind
- Experience identifying gaps between stated goals and actual plans

## How You Receive Context
The full document content is provided inline in this prompt. Read it completely before producing findings.

## Output Rules
- Output ONLY a JSON array of findings
- No preamble, no summary, no markdown — just `[...]`
- If no issues: `[]`
- Each finding: {"severity": "critical|high|medium|low", "section": "heading text", "title": "short title", "description": "what is wrong", "suggestion": "how to fix it"}
```

- [ ] **Step 3: Write all 7 Claude domain prompts**

Create each domain prompt file following the pattern from the spec. Each file follows this structure:

```markdown
# {Domain} Review — Design Documents

You are reviewing a design document / spec / implementation plan.

## Checklist
[Domain-specific items — 6-10 items per domain]

## Severity Guide
- critical: Fundamental flaw that would cause project failure
- high: Significant gap that would cause major rework
- medium: Issue that should be addressed but won't block
- low: Minor improvement or style suggestion

## Output Format
JSON array only. No preamble, no summary, no markdown fences.
[{"severity": "...", "section": "...", "title": "...", "description": "...", "suggestion": "..."}]
```

Domain-specific checklists (write full content for each file):

**00-general.md** — Overall coherence, contradictions between sections, consistency of assumptions, unstated dependencies, whether the plan achieves its stated goal.

**01-feasibility.md** — Can this be built as described? Unrealistic assumptions, missing constraints, technical impossibilities, timeline vs complexity mismatch, dependency blockers, technology compatibility.

**02-completeness.md** — Gaps: unhandled edge cases, missing error paths, undefined behavior, ambiguous requirements, missing acceptance criteria, undefined interactions between components, missing states/transitions.

**03-security.md** — Threat model gaps, auth/authz assumptions, data flow issues (PII, sensitive data), input validation gaps, CSRF/XSS/injection risks, supply chain risks, regulatory concerns, secrets management.

**04-operability.md** — Deployment strategy, monitoring/observability, rollback, failure modes, capacity planning, on-call burden, database migration risks, backup/recovery.

**05-scope.md** — YAGNI violations (features defined now but not needed until later), over-engineering, scope creep, unnecessary complexity, features that should be deferred.

**06-api-design.md** — Contract clarity, versioning, backwards compatibility, integration points, error contract consistency, naming consistency, missing endpoints, pagination, data contract issues.

- [ ] **Step 4: Verify prompt files exist and are non-empty**

```bash
ls -la global/prompts/plan-review/claude/
wc -l global/prompts/plan-review/claude/*.md
```

Expected: 8 files, each with 20+ lines.

- [ ] **Step 5: Commit**

```bash
git add global/prompts/plan-review/claude/
git commit -m "feat: add Claude plan review prompts (agent + 7 domains)"
```

---

### Task 5: Create Codex agent preamble and domain prompts

**Files:**
- Create: `global/prompts/plan-review/codex/agent.md`
- Create: `global/prompts/plan-review/codex/00-general.md` through `06-api-design.md`

- [ ] **Step 1: Create directory**

```bash
mkdir -p global/prompts/plan-review/codex
```

- [ ] **Step 2: Write Codex preamble and all 7 domain prompts**

Agent preamble is Codex-specific. **Domain prompts are identical to Claude's** — V1 uses the same checklists across all agents. Per-agent prompt tuning will happen in V2 based on the prompt improvement assessments from real reviews.

`agent.md`:
```markdown
# Codex — Plan Review Agent

## Identity
You are reviewing a design document as the **stark-codex** bot.

## Strengths to Lean Into
- Deep reasoning with high effort — you catch subtle logical flaws
- Implementation-focused — you think about how this will actually be built
- Systematic analysis — you methodically check every claim

## Output Rules
- Output ONLY a JSON array of findings
- No preamble, no summary, no markdown — just `[...]`
- If no issues: `[]`
- Each finding: {"severity": "critical|high|medium|low", "section": "heading text", "title": "short title", "description": "what is wrong", "suggestion": "how to fix it"}
```

Copy all 7 domain prompt files from `claude/` to `codex/` (identical content for V1).

- [ ] **Step 3: Verify and commit**

```bash
ls -la global/prompts/plan-review/codex/
git add global/prompts/plan-review/codex/
git commit -m "feat: add Codex plan review prompts (agent + 7 domains)"
```

---

### Task 6: Create Gemini agent preamble and domain prompts

**Files:**
- Create: `global/prompts/plan-review/gemini/agent.md`
- Create: `global/prompts/plan-review/gemini/00-general.md` through `06-api-design.md`

- [ ] **Step 1: Create directory**

```bash
mkdir -p global/prompts/plan-review/gemini
```

- [ ] **Step 2: Write Gemini preamble and all 7 domain prompts**

`agent.md`:
```markdown
# Gemini — Plan Review Agent

## Identity
You are reviewing a design document as the **stark-gemini** bot.

## Strengths to Lean Into
- Strong at catching inconsistencies in data contracts and API designs
- Good at identifying missing integration points
- Practical operations perspective

## Output Rules
- Output ONLY a JSON array of findings
- No preamble, no summary, no markdown — just `[...]`
- If no issues: `[]`
- Each finding: {"severity": "critical|high|medium|low", "section": "heading text", "title": "short title", "description": "what is wrong", "suggestion": "how to fix it"}
```

Copy all 7 domain prompt files from `claude/` to `gemini/` (identical content for V1). Per-agent tuning deferred to V2.

- [ ] **Step 3: Verify and commit**

```bash
ls -la global/prompts/plan-review/gemini/
git add global/prompts/plan-review/gemini/
git commit -m "feat: add Gemini plan review prompts (agent + 7 domains)"
```

---

## Chunk 3: Skill File and Install

### Task 7: Create the SKILL.md

**Files:**
- Create: `skill/stark-review-plan/SKILL.md`

- [ ] **Step 1: Create directory**

```bash
mkdir -p skill/stark-review-plan
```

- [ ] **Step 2: Write SKILL.md**

The skill file translates the spec's phases into imperative instructions for Claude Code. Write the full file with this content:

````markdown
---
name: stark-review-plan
description: >
  Multi-agent design document review using 3 LLMs × 7 domains with autonomous fix loop.
  Use when the user says "review this plan", "review this spec", "review design doc",
  or invokes /stark-review-plan. Also triggers on `/stark-review-plan <path>`.
---

# stark-review-plan

Multi-agent plan/spec review: 3 LLMs (Claude, Codex, Gemini) × 7 domain specializations
dispatched in parallel. Review-fix loop for up to N rounds, then final review-only round.

## Arguments

- `<path>` — path to spec/plan markdown file (required)
- `--rounds N` — max fix cycles (default: 3, from config `plan_review.max_rounds`)
- `--dry-run` — review only, no fixes, no PR posting, no review file
- `--force` — proceed even if plan has uncommitted changes

## Constants

```
SCRIPTS = ~/.claude/code-review/scripts
PYTHON  = $SCRIPTS/.venv/bin/python3
```

To call plan_review_dispatch.py: `$PYTHON $SCRIPTS/plan_review_dispatch.py <args>`
To call github_app.py: `$PYTHON $SCRIPTS/github_app.py <args>`

## Phase 1: Setup

### 1.1 Validate input

- Confirm `<path>` argument was provided. If not, error: "Usage: /stark-review-plan <path>"
- Confirm file exists and is readable.
- Check if file has uncommitted changes:
  ```bash
  git diff --name-only -- "$path"
  ```
  If output is non-empty AND `--force` was not passed, warn: "Plan file has uncommitted changes. Commit or stash first, or use --force." and abort.
- Read file content. Store as `original_content` for diff at the end.

### 1.2 Detect PR context

```bash
pr_number=$(gh pr view --json number --jq .number 2>/dev/null)
```

If on a feature branch with an open PR, store `pr_number` for Phase 5. Not having a PR is fine — the skill still runs.

### 1.3 Authenticate (only if PR detected)

```bash
export GH_TOKEN=$($PYTHON $SCRIPTS/github_app.py --app stark-claude token)
```

Auth failure when PR exists → warn "Could not authenticate stark-claude, skipping PR posting", continue.

### 1.4 Read config

Read `max_rounds` from config (the dispatch script handles agents/disabled_domains internally):

```bash
max_rounds=3  # default
# Override from config if present, or from --rounds argument
```

## Phase 2: Review-Fix Loop

If `--dry-run`: run Phase 2a once (round 1), skip fixing, go to Phase 4.

For round = 1 to max_rounds:

### 2a. Dispatch sub-agents

```bash
$PYTHON $SCRIPTS/plan_review_dispatch.py --file "$path" --round $round --timeout 300
```

Capture stdout as JSON. This dispatches all 21 sub-agents (3 agents × 7 domains) in parallel and returns structured results.

Parse the JSON output. Extract findings from `results[].findings[]`.

### 2b. Classify findings

For each finding in the JSON output, read the referenced section in the plan file. Classify:

| Status | Criteria |
|--------|----------|
| `fix` | Severity >= fix_threshold (default: medium) AND the issue actually exists in the plan |
| `recurring` | Same section + same domain as a finding from a previous round that was supposedly fixed |
| `false_positive` | The described problem doesn't exist in the plan or is already addressed |
| `noise` | Subjective, stylistic, or single-agent finding contradicted by the other 2 |
| `ignored` | Below fix_threshold (low severity when threshold is medium) |

Cross-reference: 2+ agents flagging the same section with the same concern = `high_confidence`.

### 2c. Fix the plan

Edit the plan file directly to address all `fix` and `recurring` findings:
- Add missing sections or details
- Clarify ambiguous requirements
- Add error handling, edge cases, rollback strategies
- Remove over-engineered or out-of-scope content
- Fix contradictions

### 2d. Early termination check

If this round produced zero findings classified as `fix` or `recurring`:
- Skip remaining fix rounds
- Go directly to Phase 3 (final review)

### 2e. Persist round (optional)

Write a temporary `in-progress.json` to `~/.claude/code-review/history/plan-reviews/{plan-filename}/` with the current round's data. This enables crash recovery.

## Phase 3: Final Review

Run one more dispatch:

```bash
$PYTHON $SCRIPTS/plan_review_dispatch.py --file "$path" --round $((max_rounds + 1)) --timeout 300
```

This round is review-only — no fixes applied. The findings from this round represent the final state of the plan.

- Zero findings at or above fix_threshold → plan is clean.
- Findings remain → reported as unresolved in the summary.

## Phase 4: Summary

Generate a consolidated markdown summary with these sections:

### 4a. All Findings Table

| # | Round | Agent(s) | Domain | Severity | Section | Title | Outcome |
|---|-------|----------|--------|----------|---------|-------|---------|

### 4b. Fixed — findings addressed, grouped by round.

### 4c. Recurring — findings in 2+ rounds. Which round resolved them.

### 4d. Unresolved — findings from the final round that remain.

### 4e. False Positives & Noise — one-line reasoning per finding.

### 4f. Changes Made — diff of plan changes across all fix rounds:

```bash
diff <(echo "$original_content") "$path"
```

### 4g. Prompt Improvement Assessment

Analyze patterns across all rounds:

| Signal | Recommended Level | File |
|--------|-------------------|------|
| Agent X false positives in domain Y across plans | **Global** | `global/prompts/plan-review/{agent}/{domain}.md` |
| Agent X false positives only for this repo | **Repo** | `{repo}/.code-review/plan-prompts/{agent}/{domain}.md` |
| All agents miss same issue found during fixing | **Global** (all agents) | `global/prompts/plan-review/*/{domain}.md` |
| Findings irrelevant to plan type | **Repo config** | `disabled_domains` in config |

Recommend only — do NOT modify prompts.

## Phase 5: Output & Persist

### 5a. Terminal — print the consolidated summary.

### 5b. Review file (skipped in --dry-run)

Write `{plan-name}.review.md` alongside the original plan file.

### 5c. Post to PR (if PR detected and not --dry-run)

```bash
$PYTHON $SCRIPTS/github_app.py --app stark-claude pr review $pr_number --comment --body "$summary"
```

If posting fails, warn but don't fail.

### 5d. Save history

Write to `~/.claude/code-review/history/plan-reviews/{plan-filename}/`:

```bash
mkdir -p ~/.claude/code-review/history/plan-reviews/{plan-filename}
```

| File | Content |
|------|---------|
| `rounds.json` | All rounds: findings, classifications, outcomes |
| `summary.md` | Human-readable summary (same as PR comment) |

Remove `in-progress.json` if it exists.
````

- [ ] **Step 3: Commit**

```bash
git add skill/stark-review-plan/
git commit -m "feat: create /stark-review-plan skill definition"
```

---

### Task 8: Update install.sh

**Files:**
- Modify: `install.sh`

- [ ] **Step 1: Add skill symlink to install function**

After the existing `stark-review-improvement` skill block (~line 125), add:

```bash
mkdir -p "$HOME/.claude/skills/stark-review-plan"
if [ -f "$REPO_DIR/skill/stark-review-plan/SKILL.md" ]; then
    link_dir "$REPO_DIR/skill/stark-review-plan/SKILL.md" "$HOME/.claude/skills/stark-review-plan/SKILL.md" "Skill: stark-review-plan"
else
    warn "Skill file not found at $REPO_DIR/skill/stark-review-plan/SKILL.md"
fi
```

- [ ] **Step 2: Add unlink to uninstall function**

```bash
unlink_dir "$HOME/.claude/skills/stark-review-plan/SKILL.md" "Skill: stark-review-plan"
```

- [ ] **Step 3: Add check to status function**

```bash
check_dir "$HOME/.claude/skills/stark-review-plan/SKILL.md" "Skill: stark-review-plan"
```

- [ ] **Step 4: Run install and verify**

```bash
./install.sh && ./install.sh --status
```

Expected: All items green including "Skill: stark-review-plan".

- [ ] **Step 5: Commit**

```bash
git add install.sh
git commit -m "feat: install.sh symlinks stark-review-plan skill"
```

---

### Task 9: Update CLAUDE.md

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Add skill to Skills section**

After the existing `/stark-review` entry, add:

```markdown
- `/stark-review-plan <path>` — multi-agent plan/spec review (3 LLMs × 7 domains). Review-fix loop with auto-fixes, then final review-only round. Outputs `.review.md` sibling file.
```

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: document /stark-review-plan skill in CLAUDE.md"
```

---

## Chunk 4: Integration Verification

### Task 10: Run install and verify end-to-end

- [ ] **Step 1: Re-run install**

```bash
cd /Users/aryeh/git/Evinced/stark-skills && ./install.sh
```

- [ ] **Step 2: Verify all symlinks**

```bash
./install.sh --status
```

Expected: All items green, including "Skill: stark-review-plan".

- [ ] **Step 3: Verify prompt files are discoverable**

```bash
python3 -c "
import sys; sys.path.insert(0, 'scripts')
from plan_review_dispatch import _discover_plan_domains, GLOBAL_PROMPTS_DIR
domains = _discover_plan_domains()
print(f'Domains found: {len(domains)}')
for k, v in sorted(domains.items()):
    print(f'  {k}: {v}')
assert len(domains) == 7, f'Expected 7 domains, got {len(domains)}'
print('OK')
"
```

Expected: 7 domains listed (general, feasibility, completeness, security, operability, scope, api-design).

- [ ] **Step 4: Verify dispatch script CLI**

```bash
python3 scripts/plan_review_dispatch.py --help
```

Expected: Help text showing `--file`, `--round`, `--timeout`, `--repo-dir`, `--agents`, `--disabled-domains`.

- [ ] **Step 5: Run all tests**

```bash
cd /Users/aryeh/git/Evinced/stark-skills && python3 -m pytest scripts/ -v
```

Expected: ALL PASS (both `test_multi_review.py` and `test_plan_review_dispatch.py`).

- [ ] **Step 6: Final commit if any uncommitted changes remain**

```bash
git status
```
