# `/stark-review` Skill Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a `/stark-review` Claude Code skill that orchestrates 3 LLMs × N domains of parallel code review, auto-fixes findings, and iterates until clean or max rounds.

**Architecture:** The skill is a narrative SKILL.md that Claude Code follows. It calls the existing `multi_review.py` orchestrator (updated with new flags) once per round, parses JSON output, fixes code, commits, and loops. All work happens in an isolated git worktree.

**Tech Stack:** Python 3 (multi_review.py), Bash (install.sh), Markdown (SKILL.md), GitHub API (github_app.py)

**Spec:** `docs/specs/2026-03-16-stark-review-skill-design.md`

---

## File Structure

| Action | File | Responsibility |
|--------|------|---------------|
| Create | `skill/SKILL.md` | Skill definition — narrative workflow for Claude Code |
| Modify | `scripts/multi_review.py` | Add `--json-only`, `--base`, model flags, config discovery |
| Modify | `scripts/multi_review.py` | Fix PROMPTS_DIR from hardcoded to hierarchical resolution |
| Create | `scripts/test_multi_review.py` | Tests for new multi_review.py functionality |
| Create | `scripts/conftest.py` | Pytest config: adds scripts/ to sys.path for imports |
| Modify | `install.sh` | Add skill symlink step |
| Modify | `CLAUDE.md` | Document `/stark-review` skill availability |

---

## Chunk 1: multi_review.py — Strict JSON mode and --base flag

### Task 1: Add `--json-only` flag

The current `--json` flag still prints banners and progress to stdout. The skill needs machine-parseable JSON on stdout only.

**Files:**
- Modify: `scripts/multi_review.py:648-692` (argparse + main)
- Modify: `scripts/multi_review.py:544-645` (review_pr function)
- Create: `scripts/test_multi_review.py`

- [ ] **Step 1: Create `scripts/conftest.py` for module imports**

All test files need `multi_review` importable. Create `scripts/conftest.py`:

```python
# scripts/conftest.py
"""Pytest config: adds scripts/ to sys.path so `import multi_review` works."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
```

- [ ] **Step 2: Write failing test for `--json-only` output purity**

```python
# scripts/test_multi_review.py
"""Tests for multi_review.py CLI changes."""

import json
import sys
from io import StringIO
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

import multi_review
from multi_review import (
    DEFAULT_CONFIG,
    ReviewRound,
    SubAgentResult,
)


class TestJsonOnlyFlag:
    """--json-only must produce pure JSON on stdout, logs on stderr."""

    @patch("multi_review.run_review_round")
    @patch("multi_review.discover_config", return_value=DEFAULT_CONFIG)
    @patch("multi_review.detect_repo", return_value="GetEvinced/test")
    def test_stdout_is_pure_json(self, mock_repo, mock_config, mock_round):
        """stdout must contain only parseable JSON, no banners."""
        mock_round.return_value = ReviewRound(round_num=1)
        captured_stdout = StringIO()
        captured_stderr = StringIO()

        with (
            patch("sys.stdout", captured_stdout),
            patch("sys.stderr", captured_stderr),
            patch("sys.argv", ["multi_review.py", "--pr", "1", "--json-only", "--dry-run"]),
        ):
            multi_review.main()

        stdout_text = captured_stdout.getvalue()
        # Must be valid JSON
        parsed = json.loads(stdout_text)
        assert "repo" in parsed
        assert "summary" in parsed
        # Banners must NOT be in stdout
        assert "Multi-Agent Review" not in stdout_text
        assert "Review Round" not in stdout_text

    @patch("multi_review.run_review_round")
    @patch("multi_review.discover_config", return_value=DEFAULT_CONFIG)
    @patch("multi_review.detect_repo", return_value="GetEvinced/test")
    def test_banners_go_to_stderr(self, mock_repo, mock_config, mock_round):
        """Human-readable output must be on stderr in json-only mode."""
        mock_round.return_value = ReviewRound(round_num=1)
        captured_stderr = StringIO()

        with (
            patch("sys.stdout", StringIO()),
            patch("sys.stderr", captured_stderr),
            patch("sys.argv", ["multi_review.py", "--pr", "1", "--json-only", "--dry-run"]),
        ):
            multi_review.main()

        stderr_text = captured_stderr.getvalue()
        assert "Multi-Agent Review" in stderr_text
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd /Users/aryeh/git/Evinced/stark-skills && python3 -m pytest scripts/test_multi_review.py::TestJsonOnlyFlag -v`
Expected: FAIL — `--json-only` not recognized or `discover_config` not found

- [ ] **Step 4: Add `--json-only` flag to argparse**

In `scripts/multi_review.py`, add to the argument parser (after the `--json` line):

```python
parser.add_argument(
    "--json-only", action="store_true", dest="json_only",
    help="Strict JSON mode: stdout is JSON payload only, all logs go to stderr",
)
```

- [ ] **Step 5: Implement output routing in `review_pr`**

Add a `json_only` parameter to `review_pr()` and route all human-readable output to stderr when enabled. At the top of `review_pr()`:

```python
def review_pr(
    repo: str,
    pr_number: int,
    base: str = "main",
    dry_run: bool = False,
    json_output: bool = False,
    json_only: bool = False,
    cwd: str | None = None,
) -> dict[str, Any]:
    out = sys.stderr if json_only else sys.stdout
```

Then replace every `print(...)` in `review_pr` with `print(..., file=out)`. The final JSON output in `main()` stays on stdout.

Pass `json_only` from `main()`:

```python
result = review_pr(
    repo, args.pr, base,
    dry_run=args.dry_run,
    json_output=args.json_output or args.json_only,
    json_only=args.json_only,
    cwd=cwd,
)
```

Also pass `out` through to `run_review_round`. Add `out` parameter and **update the call site in `review_pr`**:

```python
def run_review_round(
    base: str,
    round_num: int,
    agents: list[str] | None = None,
    domains: list[str] | None = None,
    cwd: str | None = None,
    out: Any = None,
) -> ReviewRound:
    if out is None:
        out = sys.stdout
```

In `review_pr`, the existing call `rnd = run_review_round(base, round_num, cwd=cwd)` must become:

```python
rnd = run_review_round(base, round_num, cwd=cwd, out=out)
```

Replace all `print(...)` in `run_review_round` with `print(..., file=out)`.

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd /Users/aryeh/git/Evinced/stark-skills && python3 -m pytest scripts/test_multi_review.py::TestJsonOnlyFlag -v`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add scripts/conftest.py scripts/multi_review.py scripts/test_multi_review.py
git commit -m "feat: add --json-only flag for strict JSON output mode"
```

---

### Task 2: Ensure `--base` accepts a commit SHA

**Depends on:** Task 1 (uses `--json-only` flag in test).

The `--base` flag already exists in argparse but `detect_base_branch()` is still used as fallback. The skill always provides `--base {merge_base}` (a SHA), so this needs to work with both branch names and SHAs.

**Files:**
- Modify: `scripts/test_multi_review.py`

- [ ] **Step 1: Write test verifying --base passes through to review_pr**

```python
class TestBaseFlag:
    """--base must accept a commit SHA and pass it through."""

    @patch("multi_review.review_pr", return_value={"summary": {"clean": True}})
    @patch("multi_review.detect_repo", return_value="GetEvinced/test-repo")
    def test_base_sha_passed_through(self, mock_repo, mock_review):
        """When --base is a SHA, it should be passed directly, no auto-detect."""
        with patch("sys.argv", ["multi_review.py", "--pr", "1", "--base", "abc1234def", "--dry-run", "--json-only"]):
            multi_review.main()
        mock_review.assert_called_once()
        assert mock_review.call_args[0][2] == "abc1234def"  # base arg
```

- [ ] **Step 2: Run test to verify behavior**

Run: `cd /Users/aryeh/git/Evinced/stark-skills && python3 -m pytest scripts/test_multi_review.py::TestBaseFlag -v`

The `--base` flag already exists in argparse (line 672). The code at line 683 is `base = args.base or detect_base_branch()` which short-circuits correctly. This test should pass as-is — just confirm the contract.

- [ ] **Step 3: Commit test**

```bash
git add scripts/test_multi_review.py
git commit -m "test: verify --base SHA passthrough to review_pr"
```

---

### Task 3: Add model/effort flags to sub-agent invocations

**Files:**
- Modify: `scripts/multi_review.py:332-346` (`_run_subagent`)
- Modify: `scripts/test_multi_review.py`

- [ ] **Step 1: Write test for model flags in CLI commands**

```python
class TestModelFlags:
    """Sub-agents must use max-power model flags."""

    @patch("multi_review.subprocess.run")
    def test_claude_uses_opus(self, mock_run):
        mock_run.return_value = MagicMock(stdout="[]", returncode=0)
        from multi_review import _run_subagent
        _run_subagent("claude", "architecture", "abc123")
        cmd = mock_run.call_args[0][0]
        assert "--model" in cmd
        assert "claude-opus-4-6" in cmd
        assert "--model" in cmd

    @patch("multi_review.subprocess.run")
    def test_codex_uses_xhigh(self, mock_run):
        mock_run.return_value = MagicMock(stdout="[]", returncode=0)
        from multi_review import _run_subagent
        _run_subagent("codex", "architecture", "abc123")
        cmd = mock_run.call_args[0][0]
        assert "-c" in cmd
        assert 'model_reasoning_effort="xhigh"' in cmd

    @patch("multi_review.subprocess.run")
    def test_gemini_uses_pro(self, mock_run):
        mock_run.return_value = MagicMock(stdout="[]", returncode=0)
        from multi_review import _run_subagent
        _run_subagent("gemini", "architecture", "abc123")
        cmd = mock_run.call_args[0][0]
        assert "--model" in cmd
        assert "gemini-2.5-pro" in cmd
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/aryeh/git/Evinced/stark-skills && python3 -m pytest scripts/test_multi_review.py::TestModelFlags -v`
Expected: FAIL — no model flags in commands

- [ ] **Step 3: Update `_run_subagent` with model flags**

In `scripts/multi_review.py`, update the command construction in `_run_subagent()`:

```python
if agent == "claude":
    prompt = (
        f"Run 'git diff {base}...HEAD' and read all changed files. "
        f"Then review them according to these instructions:\n\n"
        f"{full_prompt}"
    )
    cmd = [
        "claude", "-p", "-", "--output-format", "text",
        "--model", "claude-opus-4-6",
    ]

elif agent == "codex":
    cmd = ["codex", "review", "-c", 'model_reasoning_effort="xhigh"', "--base", base, full_prompt]

elif agent == "gemini":
    cmd = ["gemini", "--model", "gemini-2.5-pro", "-p", full_prompt]
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/aryeh/git/Evinced/stark-skills && python3 -m pytest scripts/test_multi_review.py::TestModelFlags -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/multi_review.py scripts/test_multi_review.py
git commit -m "feat: add max-power model flags to sub-agent invocations"
```

---

## Chunk 2: multi_review.py — Config discovery and prompt resolution

### Task 4: Implement hierarchical config discovery and merge

**Files:**
- Modify: `scripts/multi_review.py:45-50` (config section)
- Modify: `scripts/test_multi_review.py`

- [ ] **Step 1: Write tests for config discovery**

```python
import tempfile

class TestConfigDiscovery:
    """Config files are discovered and merged: repo → org → global."""

    def test_global_config_only(self, tmp_path):
        """When only global config exists, use it."""
        global_cfg = tmp_path / "global" / "config.json"
        global_cfg.parent.mkdir(parents=True)
        global_cfg.write_text('{"agents": ["claude"], "fix_threshold": "high"}')

        from multi_review import discover_config
        cfg = discover_config(cwd=str(tmp_path), global_dir=str(global_cfg.parent))
        assert cfg["agents"] == ["claude"]
        assert cfg["fix_threshold"] == "high"

    def test_repo_overrides_global(self, tmp_path):
        """Repo config replaces scalar fields."""
        global_dir = tmp_path / "global"
        global_dir.mkdir()
        (global_dir / "config.json").write_text('{"agents": ["claude", "codex", "gemini"], "fix_threshold": "medium"}')

        repo_dir = tmp_path / "repo"
        repo_dir.mkdir()
        (repo_dir / ".code-review").mkdir()
        (repo_dir / ".code-review" / "config.json").write_text('{"fix_threshold": "high"}')

        from multi_review import discover_config
        cfg = discover_config(cwd=str(repo_dir), global_dir=str(global_dir))
        assert cfg["fix_threshold"] == "high"  # repo wins
        assert cfg["agents"] == ["claude", "codex", "gemini"]  # inherited

    def test_extra_domains_additive(self, tmp_path):
        """extra_domains merges additively across levels."""
        global_dir = tmp_path / "global"
        global_dir.mkdir()
        (global_dir / "config.json").write_text('{"extra_domains": ["perf"]}')

        repo_dir = tmp_path / "repo"
        repo_dir.mkdir()
        (repo_dir / ".code-review").mkdir()
        (repo_dir / ".code-review" / "config.json").write_text('{"extra_domains": ["i18n"]}')

        from multi_review import discover_config
        cfg = discover_config(cwd=str(repo_dir), global_dir=str(global_dir))
        assert set(cfg["extra_domains"]) == {"perf", "i18n"}

    def test_severity_overrides_deep_merge(self, tmp_path):
        """severity_overrides deep merges across levels."""
        global_dir = tmp_path / "global"
        global_dir.mkdir()
        (global_dir / "config.json").write_text('{"severity_overrides": {"security": {"min_severity": "high"}}}')

        repo_dir = tmp_path / "repo"
        repo_dir.mkdir()
        (repo_dir / ".code-review").mkdir()
        (repo_dir / ".code-review" / "config.json").write_text(
            '{"severity_overrides": {"accessibility": {"min_severity": "critical"}}}'
        )

        from multi_review import discover_config
        cfg = discover_config(cwd=str(repo_dir), global_dir=str(global_dir))
        assert cfg["severity_overrides"]["security"]["min_severity"] == "high"
        assert cfg["severity_overrides"]["accessibility"]["min_severity"] == "critical"
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/aryeh/git/Evinced/stark-skills && python3 -m pytest scripts/test_multi_review.py::TestConfigDiscovery -v`
Expected: FAIL — `discover_config` doesn't exist

- [ ] **Step 3: Implement `discover_config`**

Add to `scripts/multi_review.py` after the imports:

```python
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

REPLACE_FIELDS = {"agents", "fix_threshold", "test_command", "build_command",
                  "verify_before_clean", "disabled_domains"}
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
    # Global is lowest priority
    global_cfg = Path(global_dir) / "config.json"
    if global_cfg.exists():
        chain.append(global_cfg)
    return chain  # most-specific first


def discover_config(cwd: str | None = None, global_dir: str | None = None) -> dict:
    """Discover and merge config: repo → org → global."""
    if cwd is None:
        cwd = os.getcwd()
    if global_dir is None:
        global_dir = str(Path.home() / ".claude" / "code-review")

    chain = _find_config_chain(cwd, global_dir)
    # Merge: start from defaults, apply from least-specific to most-specific
    merged = dict(DEFAULT_CONFIG)
    for cfg_path in reversed(chain):  # global first, then org, then repo
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
                merged[key] = val  # unknown fields: replace
    return merged
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/aryeh/git/Evinced/stark-skills && python3 -m pytest scripts/test_multi_review.py::TestConfigDiscovery -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/multi_review.py scripts/test_multi_review.py
git commit -m "feat: add hierarchical config discovery and merge"
```

---

### Task 5: Implement hierarchical prompt resolution

Replace the hardcoded `PROMPTS_DIR` with a function that resolves prompts via config hierarchy.

**Files:**
- Modify: `scripts/multi_review.py:50` (PROMPTS_DIR)
- Modify: `scripts/multi_review.py:155-178` (prompt loading functions)
- Modify: `scripts/test_multi_review.py`

- [ ] **Step 1: Write tests for prompt resolution**

```python
class TestPromptResolution:
    """Prompts resolve: repo → org → global, per agent × domain."""

    def test_global_prompt_found(self, tmp_path):
        """Global prompt is used when no overrides exist."""
        global_prompts = tmp_path / "global" / "prompts" / "claude"
        global_prompts.mkdir(parents=True)
        (global_prompts / "01-architecture.md").write_text("Global arch prompt")

        from multi_review import resolve_prompt
        result = resolve_prompt("claude", "01-architecture.md",
                                cwd=str(tmp_path / "repo"),
                                global_prompts_dir=str(tmp_path / "global" / "prompts"))
        assert result == "Global arch prompt"

    def test_repo_prompt_overrides_global(self, tmp_path):
        """Repo-level prompt wins over global."""
        global_prompts = tmp_path / "global" / "prompts" / "claude"
        global_prompts.mkdir(parents=True)
        (global_prompts / "01-architecture.md").write_text("Global arch prompt")

        repo_dir = tmp_path / "repo"
        repo_prompts = repo_dir / ".code-review" / "prompts" / "claude"
        repo_prompts.mkdir(parents=True)
        (repo_prompts / "01-architecture.md").write_text("Repo arch prompt")

        from multi_review import resolve_prompt
        result = resolve_prompt("claude", "01-architecture.md",
                                cwd=str(repo_dir),
                                global_prompts_dir=str(tmp_path / "global" / "prompts"))
        assert result == "Repo arch prompt"
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/aryeh/git/Evinced/stark-skills && python3 -m pytest scripts/test_multi_review.py::TestPromptResolution -v`
Expected: FAIL — `resolve_prompt` doesn't exist

- [ ] **Step 3: Implement `resolve_prompt` and update prompt loading**

```python
GLOBAL_PROMPTS_DIR = Path.home() / ".claude" / "code-review" / "prompts"


def resolve_prompt(agent: str, filename: str, cwd: str | None = None,
                   global_prompts_dir: str | None = None) -> str:
    """Resolve a prompt file: repo → org → global."""
    if cwd is None:
        cwd = os.getcwd()
    if global_prompts_dir is None:
        global_prompts_dir = str(GLOBAL_PROMPTS_DIR)

    home = Path.home()
    current = Path(cwd).resolve()
    # Walk up from cwd looking for .code-review/prompts/{agent}/{filename}
    while current != home and current != current.parent:
        candidate = current / ".code-review" / "prompts" / agent / filename
        if candidate.exists():
            return candidate.read_text().strip()
        current = current.parent
    # Global fallback
    global_path = Path(global_prompts_dir) / agent / filename
    if global_path.exists():
        return global_path.read_text().strip()
    return ""
```

Update `_load_agent_preamble` and `_load_domain_prompt` to use `resolve_prompt` instead of `PROMPTS_DIR`:

```python
def _load_agent_preamble(agent: str, cwd: str | None = None) -> str:
    return resolve_prompt(agent, "agent.md", cwd=cwd)


def _load_domain_prompt(agent: str, domain_key: str, cwd: str | None = None) -> str:
    domain = DOMAINS.get(domain_key)
    if not domain:
        return f"Review this code for {domain_key} issues. {FINDINGS_FORMAT}"
    content = resolve_prompt(agent, domain["filename"], cwd=cwd)
    if content:
        return content
    # Fallback: try another agent's prompt at the same level
    for fallback_agent in AGENTS:
        if fallback_agent == agent:
            continue
        content = resolve_prompt(fallback_agent, domain["filename"], cwd=cwd)
        if content:
            print(f"  [!] Using {fallback_agent}'s prompt for {agent}/{domain_key}", file=sys.stderr)
            return content
    return f"Review this code for {domain_key} issues. {FINDINGS_FORMAT}"
```

Update `_discover_domains` to use `GLOBAL_PROMPTS_DIR` instead of `PROMPTS_DIR`. Full replacement:

```python
GLOBAL_PROMPTS_DIR = Path.home() / ".claude" / "code-review" / "prompts"


def _discover_domains() -> dict[str, dict[str, Any]]:
    """Discover domains from prompt files in any agent directory.

    Scans the first agent directory to find numbered domain files like
    01-architecture.md and builds the domain registry.
    """
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
            break  # Found domains from first agent dir
    return domains
```

Remove the `PROMPTS_DIR` constant (line 50) entirely. `GLOBAL_PROMPTS_DIR` is defined above `_discover_domains`.

- [ ] **Step 4: Run all tests**

Run: `cd /Users/aryeh/git/Evinced/stark-skills && python3 -m pytest scripts/test_multi_review.py -v`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/multi_review.py scripts/test_multi_review.py
git commit -m "feat: hierarchical prompt resolution (repo → org → global)"
```

---

### Task 6: Wire config into agent/domain selection and severity normalization

Use `discover_config` to filter agents/domains and apply `severity_overrides` to findings.

**Files:**
- Modify: `scripts/multi_review.py:544-595` (review_pr)
- Modify: `scripts/multi_review.py:288-317` (_parse_findings)
- Modify: `scripts/test_multi_review.py`

- [ ] **Step 1: Write tests for config wiring and severity overrides**

```python
class TestConfigWiring:
    """Config should filter agents/domains and apply severity overrides."""

    @patch("multi_review._run_subagent")
    @patch("multi_review.discover_config")
    def test_disabled_domains_excluded(self, mock_config, mock_sub):
        mock_config.return_value = {
            **DEFAULT_CONFIG,
            "disabled_domains": ["accessibility"],
        }
        mock_sub.return_value = SubAgentResult(
            agent="claude", domain="architecture", raw_output="[]",
        )

        rnd = multi_review.run_review_round("abc123", 1, cwd="/tmp")

        domains_called = {call[0][1] for call in mock_sub.call_args_list}
        assert "accessibility" not in domains_called

    @patch("multi_review._run_subagent")
    @patch("multi_review.discover_config")
    def test_agents_config_respected(self, mock_config, mock_sub):
        mock_config.return_value = {
            **DEFAULT_CONFIG,
            "agents": ["claude"],
        }
        mock_sub.return_value = SubAgentResult(
            agent="claude", domain="architecture", raw_output="[]",
        )

        rnd = multi_review.run_review_round("abc123", 1, cwd="/tmp")

        agents_called = {call[0][0] for call in mock_sub.call_args_list}
        assert agents_called == {"claude"}

    def test_severity_override_applied(self):
        """severity_overrides should reclassify findings below min_severity."""
        from multi_review import apply_severity_overrides, Finding

        findings = [
            Finding(agent="claude", domain="accessibility", severity="medium",
                    file="a.py", line=1, title="t", description="d", suggestion="s"),
            Finding(agent="claude", domain="accessibility", severity="critical",
                    file="b.py", line=2, title="t2", description="d2", suggestion="s2"),
        ]
        overrides = {"accessibility": {"min_severity": "critical"}}
        result = apply_severity_overrides(findings, overrides)
        # medium < critical → downgraded to "low" (below threshold, effectively ignored)
        assert result[0].severity == "low"
        assert result[1].severity == "critical"  # unchanged
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/aryeh/git/Evinced/stark-skills && python3 -m pytest scripts/test_multi_review.py::TestConfigWiring -v`

- [ ] **Step 3: Implement severity overrides and wire config**

Add `apply_severity_overrides` function:

```python
def apply_severity_overrides(
    findings: list[Finding], overrides: dict[str, dict],
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
```

In `review_pr`, call `discover_config` and pass filtered lists:

```python
def review_pr(repo, pr_number, base="main", dry_run=False,
              json_output=False, json_only=False, cwd=None):
    config = discover_config(cwd=cwd)
    active_agents = [a for a in config["agents"] if a in AGENTS]
    disabled = set(config.get("disabled_domains", []))
    active_domains = [d for d in DOMAINS if d not in disabled]
    out = sys.stderr if json_only else sys.stdout
    # ... pass active_agents and active_domains to run_review_round
    rnd = run_review_round(base, round_num, agents=active_agents,
                           domains=active_domains, cwd=cwd, out=out)
    # Apply severity overrides to findings after each round
    for result in rnd.results:
        result.findings = apply_severity_overrides(
            result.findings, config.get("severity_overrides", {}))
```

In `run_review_round`, use the passed agents/domains instead of defaults.

- [ ] **Step 4: Run all tests**

Run: `cd /Users/aryeh/git/Evinced/stark-skills && python3 -m pytest scripts/test_multi_review.py -v`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/multi_review.py scripts/test_multi_review.py
git commit -m "feat: wire config into agent/domain selection"
```

---

## Chunk 3: Skill file and install

### Task 7: Create the SKILL.md

The skill file is the core deliverable — narrative instructions that Claude Code follows when `/stark-review` is invoked.

**Files:**
- Create: `skill/SKILL.md`

- [ ] **Step 1: Create `skill/` directory**

```bash
mkdir -p /Users/aryeh/git/Evinced/stark-skills/skill
```

- [ ] **Step 2: Write SKILL.md**

Create `skill/SKILL.md` with the full skill definition. The content follows the spec workflow (Phases 1-5) translated into imperative instructions for Claude Code. Key sections:

```markdown
---
name: stark-skills
description: >
  Multi-agent PR code review using 3 LLMs × N domains with autonomous fix loop.
  Use when the user says "stark review", "review this PR with all agents",
  "multi-agent review", or invokes /stark-review. Also triggers on
  `/stark-review` or `/stark-review <number>`.
---

# stark-skills

Multi-agent PR review: 3 LLMs (Claude, Codex, Gemini) × 6 domain specializations
dispatched in parallel. Autonomous fix-review loop until clean or max rounds.

## Arguments

- `<number>` — PR number (e.g., `/stark-review 91`)
- `--rounds N` — max fix-review cycles (default: 3)
- `--repo ORG/REPO` — override repo detection
- `--dry-run` — review only, no fixes, no GitHub posting
- If number omitted, detect from current branch: `gh pr view --json number --jq .number`

## Constants

```
SCRIPTS = ~/.claude/code-review/scripts
PYTHON  = $SCRIPTS/.venv/bin/python3
```

To call github_app.py: `$PYTHON $SCRIPTS/github_app.py <args>`
To call multi_review.py: `$PYTHON $SCRIPTS/multi_review.py <args>`

## Phase 1: Setup

### 1.1 Detect repo

(from git remote, or --repo override)

### 1.2 Authenticate

export GH_TOKEN=$($GITHUB_APP --app stark-claude token)

If this fails → error: "stark-claude GitHub App not configured for this repo."

### 1.3 Fetch PR metadata

gh api repos/{repo}/pulls/{number}

Extract: title, body, base.ref, head.ref, head.sha, head.repo.full_name

### 1.4 Determine mode

- Fork PR (head.repo.full_name != repo) → review-only
- Read merged config. If test_command is NOT configured → review-only
- Otherwise → full mode (review + fix loop)

### 1.5 Create isolated worktree

git fetch origin refs/pull/{number}/head
git worktree add /tmp/review-{repo_slug}-pr{number} -b review/pr-{number} FETCH_HEAD
cd /tmp/review-{repo_slug}-pr{number}
git fetch origin {base_ref}
merge_base=$(git merge-base origin/{base_ref} HEAD)

Before creating, check if worktree exists from a crashed session:

```bash
if git worktree list | grep -q "review-{repo_slug}-pr{number}"; then
    # Reuse existing worktree
    cd /tmp/review-{repo_slug}-pr{number}
else
    git worktree add /tmp/review-{repo_slug}-pr{number} -b review/pr-{number} FETCH_HEAD
    cd /tmp/review-{repo_slug}-pr{number}
fi
```

### 1.6 Capture baseline (full mode only)

Run test_command in the worktree. Parse output for failing test identifiers.
Store as baseline_failures set.

## Phase 2: Review-Fix Loop

If review-only mode: run Phase 2a once, skip to Phase 3.

For round = 1 to max_rounds:

### 2a. Run review

$PYTHON $SCRIPTS/multi_review.py --pr {number} --base {merge_base} --json-only --dry-run

Parse stdout as JSON. This is one call per round — multi_review.py runs all
sub-agents in parallel and returns.

### 2b. Classify findings

For each finding in the JSON output, read the referenced file:line in the worktree.
Classify:

- fix: severity >= fix_threshold AND the issue actually exists in the code
- recurring: same file + ±5 lines + same domain as a previous round's finding
- false_positive: the described problem doesn't exist in the code
- noise: subjective, style preference, or single-agent contradicted by others
- ignored: below fix_threshold (low severity)

Cross-reference: 2+ agents flagging same file+region = high_confidence.

### 2c. Fix

Edit code in the worktree to address all fix and recurring findings.

### 2d. Test

Run test_command. Compare failures against baseline_failures.
Only NEW failures (not in baseline) are regressions — fix them.

### 2e. Commit + push

git add <changed files>
git commit -m "fix: address review findings (round {N})"
git push origin review/pr-{number}:{head_ref}

### 2f. Persist round

Write round data to ~/.claude/code-review/history/{org}/{repo}/{pr}/round-{N}.json

### 2g. Stop check

- Zero fix/recurring findings + tests pass → STOP (clean)
- All findings are false_positive/noise/ignored → STOP (nothing fixable)
- round >= max_rounds → STOP (max reached)
- Otherwise → next round

## Phase 3: Final Summary

Generate a markdown summary with these sections:

### All Findings Table
| # | Round | Agent(s) | Domain | Severity | File | Title | Outcome |

### Fixed
Findings fixed, grouped by round. Include title, file, commit SHA.

### Recurring
Findings in 2+ rounds or from 2+ agents. Which round resolved them.

### False Positives & Noise
One-line reasoning per finding. Feeds prompt improvement analysis.

### Ignored
Below fix threshold. Listed for completeness.

### Prompt Improvement Assessment
Analyze patterns:
- Agent X produces false positives in domain Y → tune global/prompts/{agent}/{domain}.md
- All agents miss same issue → gap in global/prompts/*/NN-{domain}.md
- Findings irrelevant to repo stack → add to repo .code-review/config.json disabled_domains
- Agent unparseable output → fix global/prompts/{agent}/agent.md
Recommend only — do NOT modify prompts.

## Phase 4: Post & Persist

### 4a. Post to PR

$GITHUB_APP --app stark-claude pr review {number} --comment --body "$summary"

If posting fails, print summary to terminal and warn.

### 4b. Save history

Write to ~/.claude/code-review/history/{org}/{repo}/{pr}/:
- summary.md (same as PR comment)
- rounds.json (all rounds aggregated)
- prompt-assessment.md (recommendations)

## Phase 5: Cleanup

cd back to original directory
git worktree remove /tmp/review-{repo_slug}-pr{number}
git branch -D review/pr-{number}

Best-effort — don't fail if cleanup fails.
```

- [ ] **Step 3: Commit**

```bash
git add skill/SKILL.md
git commit -m "feat: create /stark-review skill definition"
```

---

### Task 8: Update install.sh to symlink the skill

**Files:**
- Modify: `install.sh:90-115` (install function)
- Modify: `install.sh:156-169` (uninstall function)
- Modify: `install.sh:172-191` (status function)

- [ ] **Step 1: Add skill symlink to install function**

After the "Org config" section (line 111), add:

```bash
# 4. Skill: ~/.claude/skills/stark-review/SKILL.md → repo/skill/SKILL.md
mkdir -p "$HOME/.claude/skills/stark-review"
if [ -f "$REPO_DIR/skill/SKILL.md" ]; then
    link_dir "$REPO_DIR/skill/SKILL.md" "$HOME/.claude/skills/stark-review/SKILL.md" "Skill"
else
    warn "Skill file not found at $REPO_DIR/skill/SKILL.md"
fi
```

- [ ] **Step 2: Add unlink to uninstall function**

```bash
unlink_dir "$HOME/.claude/skills/stark-review/SKILL.md" "Skill"
```

- [ ] **Step 3: Add check to status function**

```bash
check_dir "$HOME/.claude/skills/stark-review/SKILL.md" "Skill"
```

- [ ] **Step 4: Run install and verify**

```bash
cd /Users/aryeh/git/Evinced/stark-skills && ./install.sh --status
```

Expected: All items show green checkmarks including the new "Skill" line.

- [ ] **Step 5: Commit**

```bash
git add install.sh
git commit -m "feat: install.sh symlinks skill to ~/.claude/skills/stark-review/"
```

---

### Task 9: Update CLAUDE.md

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Add skill documentation**

Add after the "Commands" section in `CLAUDE.md`:

```markdown
## Skills

- `/stark-review [PR_NUMBER]` — multi-agent PR review (3 LLMs × 6 domains). Full mode with fix loop requires `test_command` in config. Otherwise review-only.
```

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: document /stark-review skill in CLAUDE.md"
```

---

## Chunk 4: Integration verification

### Task 10: Run install and end-to-end dry-run

- [ ] **Step 1: Re-run install**

```bash
cd /Users/aryeh/git/Evinced/stark-skills && ./install.sh
```

- [ ] **Step 2: Verify all symlinks**

```bash
./install.sh --status
```

Expected: All items green, including "Skill" pointing to `skill/SKILL.md`.

- [ ] **Step 3: Verify skill is discoverable**

From any Claude Code session, type `/stark-review` — it should appear in the skill list.

- [ ] **Step 4: Dry-run test against a real PR**

From a repo with an open PR (e.g., infra-pulse):

```
/stark-review 91 --repo GetEvinced/infra-pulse --dry-run
```

This should: create a worktree, run multi_review.py with `--json-only --dry-run`, parse findings, print summary to terminal, NOT post to GitHub, NOT fix code, clean up worktree.

- [ ] **Step 5: Run all tests**

```bash
cd /Users/aryeh/git/Evinced/stark-skills && python3 -m pytest scripts/test_multi_review.py -v
```

Expected: ALL PASS

- [ ] **Step 6: Final commit (if any uncommitted changes remain)**

```bash
git status
# Stage only relevant files — no git add -A
git commit -m "chore: integration verification complete"
```
