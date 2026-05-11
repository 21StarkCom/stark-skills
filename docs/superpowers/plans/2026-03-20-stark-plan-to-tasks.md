# stark-plan-to-tasks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create a skill that decomposes a spec/design document into phased GitHub issues via 3 LLM passes (quality gate → decomposition → validation), extracts knowledge to docs, and deletes the plan.

**Architecture:** SKILL.md (prompt-driven workflow) + Python dispatch script (validation agent orchestration, reusing `plan_review_dispatch.py` patterns) + config extension.

**Tech Stack:** Markdown (SKILL.md), Python 3 (dispatch script), Bash (inline commands), JSON (config, schemas)

**Spec:** `docs/superpowers/specs/2026-03-20-stark-plan-to-tasks-design.md`

---

## File Map

| Action | Path | Purpose |
|--------|------|---------|
| Create | `skill/stark-plan-to-tasks/SKILL.md` | Skill implementation — full 7-step workflow |
| Create | `scripts/plan_to_tasks_validate.py` | Pass 3 validation dispatch (codex/gemini CLI orchestration) |
| Create | `scripts/test_plan_to_tasks_validate.py` | Tests for validation dispatch |
| Modify | `global/config.json` | Add `plan_to_tasks` config section |
| Modify | `CLAUDE.md` | Add skill to skills list |

**install.sh:** No changes needed — auto-discovers `skill/stark-*/` directories.

---

### Task 1: Add `plan_to_tasks` config section

**Files:**
- Modify: `global/config.json`

- [ ] **Step 1: Read current config.json**

Run: `cat global/config.json`

- [ ] **Step 2: Add plan_to_tasks section**

Add to `global/config.json` at the top level, after the `session` block:

```json
"plan_to_tasks": {
  "validation_agents": ["codex"],
  "max_quality_gate_rounds": 3,
  "max_validation_iterations": 2
}
```

- [ ] **Step 3: Validate JSON syntax**

Run: `python3 -c "import json; json.load(open('global/config.json'))"`
Expected: No output (valid JSON)

- [ ] **Step 4: Commit**

```bash
git add global/config.json
git commit -m "config: add plan_to_tasks section with validation_agents default"
```

---

### Task 2: Create validation dispatch script — data models and CLI

**Files:**
- Create: `scripts/plan_to_tasks_validate.py`

- [ ] **Step 1: Write the test file with CLI smoke test**

Create `scripts/test_plan_to_tasks_validate.py`:

```python
"""Tests for plan_to_tasks_validate.py — validation agent dispatch."""

import json
import subprocess
import sys
from pathlib import Path
from unittest.mock import patch

import pytest

SCRIPTS_DIR = Path(__file__).parent
SCRIPT = SCRIPTS_DIR / "plan_to_tasks_validate.py"


class TestCLISmoke:
    """Verify script is importable and CLI flags parse correctly."""

    def test_script_importable(self):
        """Script can be imported without error."""
        import plan_to_tasks_validate  # noqa: F401

    def test_help_flag(self):
        """--help exits cleanly with usage info."""
        result = subprocess.run(
            [sys.executable, str(SCRIPT), "--help"],
            capture_output=True, text=True,
        )
        assert result.returncode == 0
        assert "plan_file" in result.stdout or "usage" in result.stdout.lower()

    def test_missing_required_args(self):
        """Script fails with clear error when required args missing."""
        result = subprocess.run(
            [sys.executable, str(SCRIPT)],
            capture_output=True, text=True,
        )
        assert result.returncode != 0
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/aryeh/Code/Playground/stark-skills && python3 -m pytest scripts/test_plan_to_tasks_validate.py -v -x`
Expected: FAIL (script doesn't exist yet)

- [ ] **Step 3: Create script with data models, config loading, and CLI**

Create `scripts/plan_to_tasks_validate.py`:

```python
#!/usr/bin/env python3
"""Validation dispatch for stark-plan-to-tasks — Pass 3 orchestration.

Dispatches plan + decomposition JSON to configured validation agents
(Codex, Gemini) via their CLI tools. Returns structured validation results.

Reuses dispatch patterns from plan_review_dispatch.py.
"""

from __future__ import annotations

import argparse
import hashlib
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

SCRIPTS_DIR = Path(__file__).parent
GLOBAL_CONFIG = Path.home() / ".claude" / "code-review" / "config.json"

CODEX_REASONING_CONFIG = 'model_reasoning_effort="high"'
DEFAULT_TIMEOUT = 300


@dataclass
class ValidationIssue:
    phase_id: str
    task_id: str
    field: str
    problem: str
    suggestion: str = ""


@dataclass
class ValidationResult:
    agent: str
    approved: bool = False
    issues: list[ValidationIssue] = field(default_factory=list)
    raw_output: str = ""
    error: str | None = None
    duration_s: float = 0.0


def load_config() -> dict:
    """Load plan_to_tasks config with hierarchy: global → repo."""
    defaults = {
        "validation_agents": ["codex"],
        "max_quality_gate_rounds": 3,
        "max_validation_iterations": 2,
    }
    # Global config
    if GLOBAL_CONFIG.exists():
        try:
            data = json.loads(GLOBAL_CONFIG.read_text())
            defaults.update(data.get("plan_to_tasks", {}))
        except (json.JSONDecodeError, OSError):
            pass
    # Repo-level override
    repo_config = Path(".code-review/config.json")
    if repo_config.exists():
        try:
            data = json.loads(repo_config.read_text())
            defaults.update(data.get("plan_to_tasks", {}))
        except (json.JSONDecodeError, OSError):
            pass
    return defaults


def compute_plan_hash(content: str) -> str:
    """SHA-256 hash of plan content."""
    return f"sha256:{hashlib.sha256(content.encode()).hexdigest()}"


# ── CLI ─────────────────────────────────────────────────────────────────


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        description="Dispatch validation agents for plan-to-tasks decomposition.",
    )
    p.add_argument("plan_file", help="Path to the plan markdown file")
    p.add_argument("breakdown_file", help="Path to the decomposition JSON file")
    p.add_argument("--agents", nargs="+", help="Override validation agents")
    p.add_argument("--timeout", type=int, default=DEFAULT_TIMEOUT)
    return p


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()

    config = load_config()
    agents = args.agents or config["validation_agents"]

    plan_path = Path(args.plan_file)
    breakdown_path = Path(args.breakdown_file)

    if not plan_path.exists():
        print(f"Error: plan file not found: {plan_path}", file=sys.stderr)
        return 1
    if not breakdown_path.exists():
        print(f"Error: breakdown file not found: {breakdown_path}", file=sys.stderr)
        return 1

    plan_content = plan_path.read_text()
    breakdown = json.loads(breakdown_path.read_text())
    plan_hash = compute_plan_hash(plan_content)

    results = dispatch_validators(
        plan_content=plan_content,
        breakdown=breakdown,
        plan_hash=plan_hash,
        agents=agents,
        timeout=args.timeout,
    )

    output = {
        "agents": agents,
        "results": [asdict(r) for r in results],
        "all_approved": all(r.approved and not r.error for r in results),
        "all_issues": [
            asdict(issue)
            for r in results
            for issue in r.issues
        ],
    }
    print(json.dumps(output, indent=2))
    return 0 if output["all_approved"] else 1


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/aryeh/Code/Playground/stark-skills && python3 -m pytest scripts/test_plan_to_tasks_validate.py::TestCLISmoke -v`
Expected: 3 tests PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/plan_to_tasks_validate.py scripts/test_plan_to_tasks_validate.py
git commit -m "feat: scaffold plan_to_tasks_validate.py with data models and CLI"
```

---

### Task 3: Implement validation envelope and agent dispatch

**Files:**
- Modify: `scripts/plan_to_tasks_validate.py`
- Modify: `scripts/test_plan_to_tasks_validate.py`

- [ ] **Step 1: Write tests for envelope building and output parsing**

Append to `scripts/test_plan_to_tasks_validate.py`:

```python
from plan_to_tasks_validate import (
    build_validation_envelope,
    parse_validation_output,
    ValidationIssue,
    ValidationResult,
)


class TestEnvelope:
    """Validation envelope construction."""

    def test_envelope_has_required_fields(self):
        envelope = build_validation_envelope(
            plan_content="# My Plan",
            breakdown={"schema_version": 1, "phases": []},
            plan_hash="sha256:abc",
        )
        assert envelope["schema_version"] == 1
        assert envelope["plan_markdown"] == "# My Plan"
        assert envelope["breakdown"]["schema_version"] == 1
        assert envelope["plan_hash"] == "sha256:abc"

    def test_envelope_is_valid_json(self):
        envelope = build_validation_envelope(
            plan_content="# Plan\n```json\n{}\n```",
            breakdown={"schema_version": 1, "phases": []},
            plan_hash="sha256:abc",
        )
        # Should roundtrip through JSON without error
        json.loads(json.dumps(envelope))


class TestOutputParsing:
    """Parse validation agent output into structured results."""

    def test_parse_valid_approved(self):
        raw = json.dumps({"schema_version": 1, "approved": True, "issues": []})
        result = parse_validation_output(raw, agent="codex")
        assert result.approved is True
        assert result.issues == []

    def test_parse_valid_with_issues(self):
        raw = json.dumps({
            "schema_version": 1,
            "approved": False,
            "issues": [{
                "phase_id": "phase-1",
                "task_id": "task-1-1",
                "field": "acceptance_criteria",
                "problem": "Missing validation",
                "suggestion": "Add email check",
            }],
        })
        result = parse_validation_output(raw, agent="codex")
        assert result.approved is False
        assert len(result.issues) == 1
        assert result.issues[0].field == "acceptance_criteria"

    def test_parse_malformed_json(self):
        result = parse_validation_output("not json at all", agent="codex")
        assert result.error is not None
        assert result.approved is False

    def test_parse_codex_jsonl_events(self):
        """Codex wraps output in JSONL events — extract agent_message."""
        events = [
            json.dumps({"type": "agent_message", "content": [
                {"type": "output_text", "text": json.dumps({
                    "schema_version": 1, "approved": True, "issues": []
                })}
            ]}),
        ]
        raw = "\n".join(events)
        result = parse_validation_output(raw, agent="codex")
        assert result.approved is True

    def test_parse_gemini_envelope(self):
        """Gemini wraps output in {"response": "..."} envelope."""
        inner = json.dumps({"schema_version": 1, "approved": True, "issues": []})
        raw = json.dumps({"response": inner})
        result = parse_validation_output(raw, agent="gemini")
        assert result.approved is True
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/aryeh/Code/Playground/stark-skills && python3 -m pytest scripts/test_plan_to_tasks_validate.py::TestEnvelope scripts/test_plan_to_tasks_validate.py::TestOutputParsing -v -x`
Expected: FAIL (functions not defined)

- [ ] **Step 3: Implement envelope builder and output parser**

Add to `scripts/plan_to_tasks_validate.py` after the config section:

```python
# ── Envelope ────────────────────────────────────────────────────────────


def build_validation_envelope(
    plan_content: str,
    breakdown: dict,
    plan_hash: str,
) -> dict:
    """Build the JSON envelope sent to validation agents via stdin."""
    return {
        "schema_version": 1,
        "plan_markdown": plan_content,
        "breakdown": breakdown,
        "plan_hash": plan_hash,
    }


# ── Output parsing ──────────────────────────────────────────────────────

VALIDATION_SCHEMA_FIELDS = {"schema_version", "approved", "issues"}
ISSUE_REQUIRED_FIELDS = {"phase_id", "task_id", "field", "problem"}


def _extract_codex_output(raw: str) -> str:
    """Extract text from Codex JSONL event stream."""
    for line in raw.strip().splitlines():
        try:
            event = json.loads(line)
            if event.get("type") == "agent_message":
                for part in event.get("content", []):
                    if part.get("type") == "output_text":
                        return part["text"]
            # Also handle item.completed format
            if event.get("type") == "item.completed":
                item = event.get("item", {})
                for part in item.get("content", []):
                    if part.get("type") == "output_text":
                        return part.get("text", "")
        except json.JSONDecodeError:
            continue
    return raw  # Fall back to raw if no events found


def _extract_gemini_output(raw: str) -> str:
    """Unwrap Gemini {"response": "..."} envelope."""
    try:
        wrapper = json.loads(raw)
        if isinstance(wrapper, dict) and "response" in wrapper:
            return wrapper["response"]
    except json.JSONDecodeError:
        pass
    return raw


def _strip_markdown_fences(text: str) -> str:
    """Remove ```json ... ``` fences from LLM output."""
    text = text.strip()
    if text.startswith("```"):
        lines = text.splitlines()
        # Remove first line (```json) and last line (```)
        if lines[-1].strip() == "```":
            lines = lines[1:-1]
        else:
            lines = lines[1:]
        text = "\n".join(lines)
    return text.strip()


def parse_validation_output(raw: str, agent: str) -> ValidationResult:
    """Parse raw CLI output into a ValidationResult."""
    result = ValidationResult(agent=agent, raw_output=raw)

    # Agent-specific extraction
    text = raw
    if agent == "codex":
        text = _extract_codex_output(raw)
    elif agent == "gemini":
        text = _extract_gemini_output(raw)

    text = _strip_markdown_fences(text)

    # Parse JSON
    try:
        data = json.loads(text)
    except json.JSONDecodeError as e:
        result.error = f"JSON parse error: {e}"
        return result

    if not isinstance(data, dict):
        result.error = f"Expected JSON object, got {type(data).__name__}"
        return result

    result.approved = bool(data.get("approved", False))

    # Parse issues
    for item in data.get("issues", []):
        if not isinstance(item, dict):
            continue
        if not ISSUE_REQUIRED_FIELDS.issubset(item.keys()):
            continue
        result.issues.append(ValidationIssue(
            phase_id=str(item["phase_id"]),
            task_id=str(item["task_id"]),
            field=str(item["field"]),
            problem=str(item["problem"]),
            suggestion=str(item.get("suggestion", "")),
        ))

    return result
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/aryeh/Code/Playground/stark-skills && python3 -m pytest scripts/test_plan_to_tasks_validate.py::TestEnvelope scripts/test_plan_to_tasks_validate.py::TestOutputParsing -v`
Expected: All PASS

- [ ] **Step 5: Implement agent dispatch function**

Add to `scripts/plan_to_tasks_validate.py`:

```python
# ── Validation prompt ───────────────────────────────────────────────────

VALIDATION_PROMPT = """You are a validation agent for a plan decomposition. You receive a JSON envelope containing:
- plan_markdown: the original spec/design document
- breakdown: the structured task decomposition (phases → tasks)
- plan_hash: SHA-256 of the plan for integrity

Your job is adversarial — try to break the decomposition. Check:
1. Coverage — every requirement in the plan maps to at least one task
2. Self-containment — each task has enough context to implement without reading other issues
3. Dependency correctness — task_id references are valid, no circular deps
4. Overlap — no two tasks describe the same work
5. Sizing — tasks within guardrails (≤5 acceptance criteria, ≤4 files, ≤500 words in how)
6. Review sufficiency — review hints are specific, not generic
7. Metric sanity — story points consistent, risk ratings aligned

Output ONLY a JSON object matching this schema:
{"schema_version": 1, "approved": true/false, "issues": [{"phase_id": "...", "task_id": "...", "field": "...", "problem": "...", "suggestion": "..."}]}

If no issues, return {"schema_version": 1, "approved": true, "issues": []}
Output ONLY the JSON, no other text."""


# ── Agent dispatch ──────────────────────────────────────────────────────


def _run_validation_agent(
    agent: str,
    envelope_json: str,
    timeout: int,
) -> ValidationResult:
    """Dispatch a single validation agent and collect results."""
    start = time.monotonic()
    result = ValidationResult(agent=agent)

    try:
        if agent == "codex":
            prompt = f"{VALIDATION_PROMPT}\n\n{envelope_json}"
            proc = subprocess.run(
                ["codex", "exec",
                 "-c", CODEX_REASONING_CONFIG,
                 "--ephemeral", "--json", "--full-auto", "-"],
                input=prompt,
                capture_output=True, text=True,
                timeout=timeout * 2,  # Codex gets 2x for reasoning
            )
        elif agent == "gemini":
            # Gemini: prompt as -p flag, envelope via stdin
            env = os.environ.copy()
            gemini_home = tempfile.mkdtemp(prefix="stark-gemini-")
            # Copy auth files
            real_home = Path.home() / ".config" / "gemini"
            if real_home.exists():
                shutil.copytree(real_home, Path(gemini_home) / ".config" / "gemini")
            env["GEMINI_CLI_HOME"] = gemini_home

            proc = subprocess.run(
                ["gemini", "-p", VALIDATION_PROMPT,
                 "-o", "json", "--approval-mode", "plan"],
                input=envelope_json,
                capture_output=True, text=True,
                timeout=timeout,
                env=env,
            )
            # Cleanup temp home
            shutil.rmtree(gemini_home, ignore_errors=True)
        else:
            result.error = f"Unknown agent: {agent}"
            return result

        result.duration_s = time.monotonic() - start

        if proc.returncode != 0:
            result.error = f"CLI error (exit {proc.returncode}): {proc.stderr[:500]}"
            result.raw_output = proc.stdout
            return result

        result.raw_output = proc.stdout
        parsed = parse_validation_output(proc.stdout, agent=agent)
        result.approved = parsed.approved
        result.issues = parsed.issues
        if parsed.error:
            result.error = parsed.error

    except FileNotFoundError:
        result.error = f"agent_unavailable: {agent} not found in PATH"
    except subprocess.TimeoutExpired:
        result.error = f"timeout after {timeout}s"
    except Exception as e:
        result.error = f"unexpected error: {e}"

    result.duration_s = time.monotonic() - start
    return result


def dispatch_validators(
    plan_content: str,
    breakdown: dict,
    plan_hash: str,
    agents: list[str],
    timeout: int = DEFAULT_TIMEOUT,
) -> list[ValidationResult]:
    """Dispatch validation to all configured agents in parallel."""
    envelope = build_validation_envelope(plan_content, breakdown, plan_hash)
    envelope_json = json.dumps(envelope)

    results: list[ValidationResult] = []
    with ThreadPoolExecutor(max_workers=len(agents)) as executor:
        futures = {
            executor.submit(_run_validation_agent, agent, envelope_json, timeout): agent
            for agent in agents
        }
        for future in as_completed(futures):
            results.append(future.result())

    return results
```

- [ ] **Step 6: Run all tests**

Run: `cd /Users/aryeh/Code/Playground/stark-skills && python3 -m pytest scripts/test_plan_to_tasks_validate.py -v`
Expected: All PASS

- [ ] **Step 7: Commit**

```bash
git add scripts/plan_to_tasks_validate.py scripts/test_plan_to_tasks_validate.py
git commit -m "feat: implement validation dispatch with envelope, output parsing, and agent orchestration"
```

---

### Task 4: Create SKILL.md — frontmatter, arguments, constants, Step 1 (Setup)

**Files:**
- Create: `skill/stark-plan-to-tasks/SKILL.md`

- [ ] **Step 1: Create the skill directory and SKILL.md with frontmatter through Step 1**

The SKILL.md content is the spec translated into the skill format. Create `skill/stark-plan-to-tasks/SKILL.md` with:
- YAML frontmatter (from spec's "SKILL.md Frontmatter" section)
- Title, description, arguments (`<path-to-spec>`, `--dry-run`, `--cleanup <slug>`)
- Constants section
- Step 1: Setup (all preflight checks from spec — plan file validation, target repo detection with checkout verification, `gh` CLI check, GitHub App auth, repo access probe, validation agent CLI check, re-run detection, docs tree read, labels read)

Follow the exact patterns from `skill/stark-review/SKILL.md` for structure: frontmatter → title → arguments → constants → steps.

- [ ] **Step 2: Verify frontmatter is valid**

Run: `head -12 skill/stark-plan-to-tasks/SKILL.md`
Expected: Shows `---`, `name: stark-plan-to-tasks`, `description:`, `argument-hint:`, `---`

- [ ] **Step 3: Commit**

```bash
git add skill/stark-plan-to-tasks/SKILL.md
git commit -m "feat: scaffold stark-plan-to-tasks SKILL.md with Setup step"
```

---

### Task 5: SKILL.md — Step 2 (Plan Quality Gate) and Step 3 (Decomposition)

**Files:**
- Modify: `skill/stark-plan-to-tasks/SKILL.md`

- [ ] **Step 1: Add Step 2 — Plan Quality Gate (LLM Pass 1)**

Append to SKILL.md:
- The full robustness checklist (8 items from spec)
- Flag-not-fix behavior with user interaction loop (re-read from disk after edits, max 3 rounds)
- Scope restrictions (no architectural challenges, no scope additions)

- [ ] **Step 2: Add Step 3 — Decomposition (LLM Pass 2)**

Append to SKILL.md:
- Phase identification with stable `phase_id`
- Task identification with stable `task_id` and all fields (title, what, why, where, how, acceptance_criteria, dependencies, review_hints)
- Metrics (sp, risk, confidence)
- Sizing guardrails (concrete heuristics)
- Full output schema with `schema_version` and `plan_hash`
- Schema validation requirements (unique IDs, valid dependency refs, no circular deps)
- Temp file creation with `mktemp` and `chmod 600`
- Large plan handling (phases first, then tasks per phase)

- [ ] **Step 3: Commit**

```bash
git add skill/stark-plan-to-tasks/SKILL.md
git commit -m "feat: add quality gate and decomposition steps to SKILL.md"
```

---

### Task 6: SKILL.md — Step 4 (Validation) and Step 5 (Issue Creation)

**Files:**
- Modify: `skill/stark-plan-to-tasks/SKILL.md`

- [ ] **Step 1: Add Step 4 — Validation (LLM Pass 3)**

Append to SKILL.md:
- Plan integrity check (SHA-256 comparison)
- Dispatch command using `plan_to_tasks_validate.py`
- All 8 validation checks from spec
- Validation output schema
- Resolution flow (primary session fixes derived output, re-dispatch, max 2 iterations)
- `--dry-run` exit point (preview to file + terminal, stop before Step 5)

- [ ] **Step 2: Add Step 5 — GitHub Issue Creation**

Append to SKILL.md:
- Token refresh (inline per command)
- Issue body limits and section caps
- Shell injection prevention (`gh api --field`, never interpolate)
- Plan slug derivation algorithm
- Label setup (all label categories with colors)
- Phase tracking issue template
- Task issue template (with task_id in footer)
- 4-pass creation order (phases → tasks with placeholder deps → patch deps → update phases)
- Run manifest for partial failure recovery

- [ ] **Step 3: Commit**

```bash
git add skill/stark-plan-to-tasks/SKILL.md
git commit -m "feat: add validation and issue creation steps to SKILL.md"
```

---

### Task 7: SKILL.md — Step 6 (Knowledge Extraction), Step 7 (Summary), and closing sections

**Files:**
- Modify: `skill/stark-plan-to-tasks/SKILL.md`

- [ ] **Step 1: Add Step 6 — Knowledge Extraction & Doc Enrichment**

Append to SKILL.md:
- Explicit "this is an LLM call" with prompt strategy
- Knowledge types and routing logic (structural detection, not content-based)
- Decision record format (date-prefixed heading, append to `docs/decisions.md`)
- Dirty working tree check
- Commit behavior (specific files, local-only)

- [ ] **Step 2: Add Step 7 — Summary**

Append to SKILL.md:
- Terminal output format (phases, issues, story points, risk/confidence distribution, links)
- Temp file cleanup

- [ ] **Step 3: Add closing sections**

Append to SKILL.md:
- Failure Modes table (all 17 entries from spec)
- Mistakes to Avoid (all 11 items from spec)
- Observability section (task-based progress, timestamps, checkpoints, JSONL persistence, end metrics block)

- [ ] **Step 4: Commit**

```bash
git add skill/stark-plan-to-tasks/SKILL.md
git commit -m "feat: complete SKILL.md with knowledge extraction, summary, and operational sections"
```

---

### Task 8: Update CLAUDE.md with new skill

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Add skill to the skills list in CLAUDE.md**

In the `## Skills` section, add:
```
- `/stark-plan-to-tasks <path> [--dry-run] [--cleanup <slug>]` — decompose plan into phased GitHub issues (3 LLM passes)
```

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: add stark-plan-to-tasks to CLAUDE.md skills list"
```

---

### Task 9: Verify installation and end-to-end smoke test

**Files:**
- No new files

- [ ] **Step 1: Run install.sh and verify symlink**

```bash
./install.sh --status 2>&1 | grep plan-to-tasks
```
Expected: Shows symlink for `stark-plan-to-tasks`

- [ ] **Step 2: Verify skill directory structure**

```bash
ls -la ~/.claude/skills/stark-plan-to-tasks/SKILL.md
```
Expected: Symlink pointing to `skill/stark-plan-to-tasks/SKILL.md`

- [ ] **Step 3: Verify config loads correctly**

```bash
~/.claude/code-review/scripts/.venv/bin/python3 -c "
import sys; sys.path.insert(0, '$HOME/.claude/code-review/scripts')
from plan_to_tasks_validate import load_config
config = load_config()
print(f'validation_agents: {config[\"validation_agents\"]}')
assert config['validation_agents'] == ['codex'], f'Expected [\"codex\"], got {config[\"validation_agents\"]}'
print('OK')
"
```
Expected: `validation_agents: ['codex']` then `OK`

- [ ] **Step 4: Run validation script with --help**

```bash
~/.claude/code-review/scripts/.venv/bin/python3 ~/.claude/code-review/scripts/plan_to_tasks_validate.py --help
```
Expected: Shows usage with `plan_file` and `breakdown_file` positional args

- [ ] **Step 5: Run all tests**

```bash
cd /Users/aryeh/Code/Playground/stark-skills && python3 -m pytest scripts/test_plan_to_tasks_validate.py -v
```
Expected: All tests PASS

- [ ] **Step 6: Commit (if any fixups needed)**

```bash
git add -A && git commit -m "fix: address smoke test issues" || echo "Nothing to commit"
```
