# Spec: `/stark-review` Claude Code Skill

**Date:** 2026-03-16
**Status:** Draft (rev 4 — aligns verification model with approved design)
**Author:** Aryeh + Claude

## Problem

The stark-review system (3 LLMs × configurable domains = parallel sub-agent reviews) exists as a Python orchestrator (`multi_review.py`) and a set of prompts, but there's no way to trigger it as a single command from any Claude Code terminal. The fix-review loop described in `orchestrator.md` requires manual intervention. We need a skill that runs the full cycle autonomously.

## Solution

A Claude Code skill at `~/.claude/skills/stark-review/SKILL.md` that:

1. Creates an isolated worktree for the PR (never touches the operator's checkout)
2. Runs `multi_review.py --pr N --json-only --dry-run` to dispatch sub-agents
3. Claude Code fixes all findings at or above the configured fix threshold
4. Commits, pushes, re-runs review
5. Repeats for up to 3 rounds (configurable)
6. Posts a single consolidated summary to the PR at the end
7. Persists history per-round for crash recovery and prompt improvement analysis

## Invocation

```
/stark-review [PR_NUMBER] [--rounds N] [--repo ORG/REPO] [--dry-run]
```

- `PR_NUMBER` — auto-detected from current branch via `gh pr view --json number --jq .number` if omitted. If that fails, error: "No open PR for current branch. Specify a PR number."
- `--rounds N` — max review-fix cycles, default 3. Skill-only flag (not passed to multi_review.py).
- `--repo ORG/REPO` — override repo detection. The skill still needs a local clone to create a worktree from; if no local clone exists under `~/git/`, error with instructions.
- `--dry-run` — review only, no fixes, no GitHub posting, no commits

## Workflow

### Phase 1: Setup

1. **Detect repo** from `git remote get-url origin` (or use `--repo` override).
2. **Authenticate**: `GH_TOKEN=$(SCRIPTS/github_app.py --app stark-claude token)`. If auth fails, error: "stark-claude GitHub App not configured for this repo."
3. **Fetch PR metadata** via `gh api repos/{repo}/pulls/{number}` — extract `title`, `body`, `base.ref`, `head.ref`, `head.sha`, `head.repo.full_name`.
4. **Determine if writable**:
   - Same-repo PR (`head.repo.full_name == repo`): writable = true → fix loop enabled
   - Fork PR: writable = false → **review-only mode** (no fix loop, no commits, no push). Audit note: "Fork PR — review only."
5. **Create isolated worktree** (per approved system design):
   ```bash
   git fetch origin refs/pull/{number}/head
   git worktree add /tmp/review-{repo_slug}-pr{number} -b review/pr-{number} FETCH_HEAD
   cd /tmp/review-{repo_slug}-pr{number}
   git fetch origin {base.ref}
   merge_base=$(git merge-base origin/{base.ref} HEAD)
   ```
   All subsequent work happens inside this worktree. The operator's checkout is never touched.
6. **Resolve diff base** from PR metadata — `merge_base` computed above. This is passed to `multi_review.py --base {merge_base}`. No branch-name heuristics.
7. **Determine mode** based on merged config (global → org → repo):
   - `test_command` configured → **full mode**: review + fix loop + verification. Capture baseline test result by running `test_command` and recording failing test identifiers (parse output for test names, e.g., `pytest --tb=line -q` produces `FAILED tests/test_foo.py::test_bar`, `pnpm test` produces `FAIL src/tests/foo.test.ts`). Store as a set of test identifiers for regression comparison.
   - `test_command` not configured → **review-only mode**: run one review round, post findings, no fix loop, no commits. Same as fork PR behavior. Per approved design: "The fix loop does not run without at least `test_command` configured."

### Phase 2: Review-Fix Loop (up to N rounds)

Each call to `multi_review.py` runs exactly one review round and returns JSON. The loop is managed by the skill, not multi_review.py.

For each round:

**2a. Review** — Run the orchestrator with `--dry-run` (suppress GitHub posts) and `--json-only` (strict JSON mode: payload to stdout only, all logs to stderr):

```bash
SCRIPTS/multi_review.py --pr <N> --base {merge_base} --json-only --dry-run
```

This runs inside the worktree (cwd = worktree path). Dispatches sub-agents in parallel (ThreadPoolExecutor). Agent/domain selection respects merged config (`agents`, `disabled_domains`, `extra_domains`).

Parse the JSON output. Contract (stdout, no other content):

```json
{
  "repo": "org/name",
  "pr": 91,
  "base": "abc1234",
  "agents": ["claude", "codex", "gemini"],
  "domains": ["architecture", "accessibility", ...],
  "rounds": [{
    "round": 1,
    "results": [{
      "agent": "claude",
      "domain": "architecture",
      "findings": [{"severity": "...", "file": "...", "line": 42, "title": "...", "description": "...", "suggestion": "..."}],
      "error": null,
      "duration_s": 45.2
    }]
  }],
  "summary": {"total_findings": 14, "critical": 2, "high": 3, "medium": 5, "clean": false}
}
```

**2b. Classify findings** — For each finding, Claude Code reads the referenced file+line in the worktree and assigns a lifecycle status:

| Status | Criteria |
|--------|----------|
| `fix` | Severity >= `fix_threshold` (default: medium). Claude Code verifies the issue exists in the code before accepting. |
| `recurring` | Matched a finding from a previous round. Match = same file + overlapping line range (±5 lines) + same domain. |
| `false_positive` | Claude Code reads the referenced code and determines the finding is factually wrong — the described problem doesn't exist. |
| `noise` | Valid observation but not actionable: style preference, subjective opinion, or a finding from only 1 agent that contradicts the other 2. |
| `ignored` | Below `fix_threshold`. |

Cross-reference: findings flagged by 2+ agents on the same file+region get `high_confidence` tag. Single-agent subjective findings → likely noise.

**2c. Fix** — Claude Code edits code directly in the worktree to address all `fix` and `recurring` findings. Skipped for fork PRs.

**2d. Test** — Run `test_command` inside the worktree (`test_command` is guaranteed to be configured — the fix loop only runs in full mode). Compare against Phase 1 baseline: only failures whose test identifiers are **not** in the baseline set are treated as regressions to fix.

**2e. Commit + push** (same-repo PRs only):

```bash
git add <changed files>
git commit -m "fix: address review findings (round N)"
git push origin review/pr-{number}:{head.ref}
```

**2f. Persist round** — After every completed round, write round data to local history (see Phase 4b). This ensures crash recovery — completed rounds are durable even if a later round fails.

**2g. Stop check**:
- Zero findings at or above `fix_threshold` + verification passes → stop early (clean)
- All findings classified as false_positive/noise/ignored with none as `fix` → stop (nothing fixable)
- Round >= max rounds → stop (max reached)
- Otherwise → next round

### Phase 3: Final Summary

After all rounds complete, generate a comprehensive summary covering:

#### 3a. All Findings Table

| # | Round | Agent(s) | Domain | Severity | File | Title | Outcome |
|---|-------|----------|--------|----------|------|-------|---------|
| 1 | 1 | claude, gemini | security | critical | routes.py:42 | SQL injection | fixed (round 1) |
| 2 | 1,2 | codex | type-safety | high | schema.py:10 | Missing type | recurring → fixed (round 2) |
| 3 | 1 | gemini | architecture | medium | utils.py:5 | Unused import | false_positive |

#### 3b. Fixed

Findings that were fixed, grouped by round. For each: finding title, file, and commit SHA that fixed it.

#### 3c. Recurring

Findings that appeared in 2+ rounds or from 2+ agents. Note which round finally resolved them (or if they persisted through all rounds).

#### 3d. False Positives & Noise

Findings classified as false_positive or noise. One-line reasoning for each. These feed the prompt improvement analysis.

#### 3e. Ignored

Findings below fix threshold. Listed for completeness.

#### 3f. Prompt Improvement Assessment

Analyze patterns across all rounds:

| Pattern | Diagnosis | Recommended Level | File |
|---------|-----------|-------------------|------|
| Agent X consistently produces false positives in domain Y | Agent's domain prompt too aggressive | Agent-domain | `global/prompts/{agent}/{NN-domain}.md` |
| All agents miss same real issue discovered during fixing | Domain prompt gap | Global (all agents) | `global/prompts/*/NN-{domain}.md` |
| Findings irrelevant to this repo's stack | Wrong domain enabled | Repo config | `{repo}/.code-review/config.json` disabled_domains |
| Agent produces unparseable output (error in results) | Agent preamble broken | Agent preamble | `global/prompts/{agent}/agent.md` |
| Recurring false positives for a specific code pattern | Domain prompt needs exclusion rule | Org or repo config | `severity_overrides` in org or repo `config.json` |

Do NOT auto-modify prompts — recommend only.

### Phase 4: Post & Persist

**4a. Post to PR** — Single consolidated summary comment posted as `stark-claude[bot]` using the repo-owned `github_app.py`:

```bash
SCRIPTS/github_app.py --app stark-claude pr review {number} --comment --body "$summary_body"
```

Or via Python API:

```python
import sys
sys.path.insert(0, "SCRIPTS_DIR")
from github_app import pr_review
pr_review("org/repo", PR_NUMBER, event="COMMENT", body=summary_body)
```

`SCRIPTS_DIR` = `~/.claude/code-review/scripts/` (installed by this repo). No dependency on external `~/git/Evinced/scripts/stark_claude.py`.

If posting fails, print the summary to terminal and warn. Do not fail the entire skill.

**4b. Save history** — Write to `~/.claude/code-review/history/{org}/{repo}/{pr}/`:

| File | Content | When Written |
|------|---------|-------------|
| `round-{N}.json` | Single round: all findings, classifications, agent results | After each completed round (Phase 2f) |
| `summary.md` | Human-readable final summary (same as PR comment) | After all rounds (Phase 4) |
| `rounds.json` | All rounds aggregated, all findings, all outcomes | After all rounds (Phase 4) |
| `prompt-assessment.md` | Prompt improvement recommendations with file paths | After all rounds (Phase 4) |

Per-round persistence (`round-{N}.json`) written after every round ensures crash recovery. The final aggregated files are written at the end.

Create directories on demand. If saving fails, warn but don't fail.

### Phase 5: Cleanup

```bash
cd /original/working/dir
git worktree remove /tmp/review-{repo_slug}-pr{number}
git branch -D review/pr-{number}
```

Cleanup runs even on error (best-effort). If a crashed session left a worktree, the next invocation detects it and reuses it (deterministic branch name `review/pr-{number}`).

## Model Configuration

The orchestrator passes maximum-power flags to each CLI tool:

| Agent | CLI Flags | Model/Effort |
|-------|-----------|--------------|
| Claude | `--model claude-opus-4-6 --max-tokens 16384` | Opus 4.6, max output |
| Codex | `-c 'model_reasoning_effort="xhigh"'` | Maximum reasoning effort |
| Gemini | `--model gemini-2.5-pro` | Pro model |

## Changes Required

### 1. New file: `skill/SKILL.md` (in this repo)

The skill file — narrative instructions for Claude Code to follow when `/stark-review` is invoked. `install.sh` symlinks it to `~/.claude/skills/stark-review/SKILL.md`.

### 2. Update: `scripts/multi_review.py`

**a) Fix PROMPTS_DIR.** Currently hardcoded to `~/git/Personal/Prompts/CodeReviews` (line 50). Must resolve via config hierarchy:

```python
# Resolution order (first match wins, per agent × domain):
# 1. Repo:   {cwd}/.code-review/prompts/{agent}/{NN-domain}.md
# 2. Org:    walk parent dirs up to ~ looking for .code-review/prompts/
# 3. Global: ~/.claude/code-review/prompts/{agent}/{NN-domain}.md
```

**b) Add `--base` flag.** Currently `_run_subagent()` uses the `base` parameter but the main CLI only auto-detects via `detect_base_branch()` (line 205). Add `--base` CLI argument that accepts a branch name or commit SHA and passes it through to all sub-agents. When provided, skip auto-detection entirely.

**c) Add `--json-only` flag.** Currently `--json` still prints banners (line 391) and progress lines (line 556) to stdout alongside the JSON payload (line 690). Add a `--json-only` mode where:
- All human-readable output (banners, progress, summary table) goes to **stderr**
- **stdout** contains only the JSON payload
- This is the mode the skill uses for machine-parsing

**d) Add model/effort CLI flags** to `_run_subagent()`:

```python
if agent == "claude":
    cmd = ["claude", "-p", prompt, "--output-format", "text",
           "--model", "claude-opus-4-6", "--max-tokens", "16384"]
elif agent == "codex":
    cmd = ["codex", "review", "-c", 'model_reasoning_effort="xhigh"', "--base", base, full_prompt]
elif agent == "gemini":
    cmd = ["gemini", "--model", "gemini-2.5-pro", "-p", full_prompt]
```

**e) Add config discovery and merge.** Currently agents/domains are hardcoded (lines 53, 386). Implement:
- Config file discovery: `{cwd}/.code-review/config.json` → parent dirs → `~/.claude/code-review/config.json`
- Merge rules per approved design: `agents`/`disabled_domains`/`test_command` = replace (most specific wins), `extra_domains` = additive, `severity_overrides`/`github_apps` = deep merge
- Domain selection: filter `DOMAINS` by `disabled_domains`, add `extra_domains`
- Agent selection: use `agents` from merged config
- Severity normalization: apply `severity_overrides` per-domain to findings after parsing

**f) Ensure `--dry-run` suppresses all GitHub posts.** Currently it does (line 576 conditional), but verify no other posting paths exist.

### 3. Update: `install.sh`

Add symlink for the skill file:

```bash
mkdir -p ~/.claude/skills/stark-review
ln -sf "$REPO_DIR/skill/SKILL.md" ~/.claude/skills/stark-review/SKILL.md
```

### 4. History directory

Already created by `install.sh` at `~/.claude/code-review/history/`. Subdirectories created on demand per `{org}/{repo}/{pr}/`.

## What the Skill Does NOT Do

- Does not modify prompts automatically (recommends only)
- Does not merge the PR
- Does not post per-round comments (only final summary via Phase 4)
- Does not pause between rounds (fully autonomous)
- Does not run on repos where GitHub Apps aren't installed (fails fast)
- Does not touch the operator's checkout (isolated worktree)
- Does not run the fix loop on fork PRs (review-only)
- Does not run the fix loop without explicit `test_command` in config (review-only). Per approved design: zero-config repos get review + findings posted, not auto-fix.

## Config Integration

The skill respects the hierarchical config (global → org → repo, most specific wins):

- `agents` — which agents to use (default: `["claude", "codex", "gemini"]`). Replace.
- `fix_threshold` — minimum severity to fix (default: `"medium"`). Replace.
- `test_command` — repo's test command (default: null → no verification). Replace.
- `build_command` — repo's build command (default: null). Replace.
- `disabled_domains` — skip specific domains. Replace.
- `extra_domains` — additional domain prompts. Additive.
- `verify_before_clean` — require test pass for clean (default: true, but moot if no test_command). Replace.
- `severity_overrides` — per-domain severity adjustments. Deep merge.
- `github_apps` — agent → app mapping. Deep merge.

## Exit Conditions

1. **Clean** — zero findings at or above `fix_threshold` + verification passes
2. **Nothing fixable** — all findings classified as false_positive/noise/ignored, none as `fix`. Summary still posted.
3. **Max rounds** — reached round limit (default 3). Summary includes unresolved findings.
4. **Fatal error** — orchestrator crash, all agents fail, or auth failure. Partial summary posted if any rounds completed.
5. **Review-only** — fork PR or no `test_command` configured. Single review round, findings posted, no fix loop.

## Alignment with Approved System Design

This spec implements a subset of the approved design (`2026-03-16-multi-agent-code-review-system-design.md`). Deviations:

| Approved Design | This Spec | Reason |
|----------------|-----------|--------|
| Zero-config = review-only, fix loop requires `test_command` | **Aligned** | No deviation. |
| Per-round audit comment upsert on PR | Single summary comment at end | Reduces PR noise. Per-round data persisted locally via `round-{N}.json` for crash recovery. |
| Coverage threshold (min % of successful sub-agents for clean) | Not implemented in v1 | Simplicity. Can add in v2 if partial agent failures cause false cleans. |
| Prompt improvement skill (auto-analyze history) | Recommend only, no auto-modification | Safety. Human reviews recommendations first. |
