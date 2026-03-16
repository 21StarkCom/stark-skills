---
name: stark-review
description: >
  Multi-agent PR code review using 3 LLMs × N domains with autonomous fix loop.
  Use when the user says "stark review", "review this PR with all agents",
  "multi-agent review", or invokes /stark-review. Also triggers on
  `/stark-review` or `/stark-review <number>`.
---

# stark-review

Multi-agent PR review: 3 LLMs (Claude, Codex, Gemini) × 6 domain specializations dispatched in parallel. Autonomous fix-review loop until clean or max rounds.

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

From `git remote get-url origin`, parse org/repo. Or use `--repo` override.

### 1.2 Authenticate

```bash
export GH_TOKEN=$($PYTHON $SCRIPTS/github_app.py --app stark-claude token)
```

If this fails → error: "stark-claude GitHub App not configured for this repo."

### 1.3 Fetch PR metadata

```bash
gh api repos/{repo}/pulls/{number}
```

Extract: `title`, `body`, `base.ref`, `head.ref`, `head.sha`, `head.repo.full_name`

### 1.4 Determine mode

- Fork PR (`head.repo.full_name != repo`) → **review-only**
- Read merged config via `$PYTHON $SCRIPTS/multi_review.py` internals or check for `.code-review/config.json` in repo. If `test_command` is NOT configured → **review-only**
- Otherwise → **full mode** (review + fix loop)

### 1.5 Create isolated worktree

Before creating, check if a worktree exists from a crashed session:

```bash
if git worktree list | grep -q "review-{repo_slug}-pr{number}"; then
    # Reuse existing worktree
    cd /tmp/review-{repo_slug}-pr{number}
else
    git fetch origin refs/pull/{number}/head
    git worktree add /tmp/review-{repo_slug}-pr{number} -b review/pr-{number} FETCH_HEAD
    cd /tmp/review-{repo_slug}-pr{number}
fi
git fetch origin {base_ref}
merge_base=$(git merge-base origin/{base_ref} HEAD)
```

All subsequent work happens inside this worktree. The operator's checkout is never touched.

### 1.6 Capture baseline (full mode only)

Run the configured `test_command` in the worktree. Parse output for failing test identifiers. Store as `baseline_failures` set. Pre-existing failures are not the skill's responsibility.

## Phase 2: Review-Fix Loop

**Review-only mode:** Run Phase 2a once, skip to Phase 3.

**Full mode:** For round = 1 to max_rounds (default 3):

### 2a. Run review

```bash
$PYTHON $SCRIPTS/multi_review.py --pr {number} --base {merge_base} --json-only --dry-run 2>/dev/null
```

Parse stdout as JSON. This is one call per round — `multi_review.py` runs all sub-agents in parallel and returns a JSON object with `rounds[0].results[]` containing findings per agent × domain.

### 2b. Classify findings

For each finding in the JSON output, read the referenced `file:line` in the worktree. Classify:

| Status | Criteria |
|--------|----------|
| `fix` | Severity >= `fix_threshold` (default: medium) AND the issue actually exists in the code |
| `recurring` | Same file + ±5 lines + same domain as a previous round's finding |
| `false_positive` | The described problem doesn't exist in the code |
| `noise` | Subjective, style preference, or single-agent finding contradicted by the other 2 |
| `ignored` | Below `fix_threshold` (low severity) |

Cross-reference: 2+ agents flagging same file+region = `high_confidence`.

### 2c. Fix

Edit code in the worktree to address all `fix` and `recurring` findings.

### 2d. Test

Run `test_command`. Compare failures against `baseline_failures`. Only NEW failures (identifiers not in baseline) are regressions — fix them.

### 2e. Commit + push

```bash
git add <changed files>
git commit -m "fix: address review findings (round {N})"
git push origin review/pr-{number}:{head_ref}
```

### 2f. Persist round

Write round data to `~/.claude/code-review/history/{org}/{repo}/{pr}/round-{N}.json` containing: all findings, their classifications, agent results, and duration.

### 2g. Stop check

- Zero `fix`/`recurring` findings + tests pass → **STOP** (clean)
- All findings are `false_positive`/`noise`/`ignored` → **STOP** (nothing fixable)
- round >= max_rounds → **STOP** (max reached)
- Otherwise → next round

## Phase 3: Final Summary

Generate a markdown summary with these sections:

### All Findings Table

```markdown
| # | Round | Agent(s) | Domain | Severity | File | Title | Outcome |
|---|-------|----------|--------|----------|------|-------|---------|
```

### Fixed

Findings fixed, grouped by round. Include title, file, and commit SHA.

### Recurring

Findings that appeared in 2+ rounds or from 2+ agents. Note which round resolved them (or if they persisted).

### False Positives & Noise

One-line reasoning per finding. These feed the prompt improvement analysis.

### Ignored

Below fix threshold. Listed for completeness.

### Prompt Improvement Assessment

Analyze patterns across all rounds:

| Pattern | Recommendation |
|---------|---------------|
| Agent X consistently produces false positives in domain Y | Tune `global/prompts/{agent}/{NN-domain}.md` |
| All agents miss same real issue found during fixing | Gap in `global/prompts/*/NN-{domain}.md` |
| Findings irrelevant to this repo's stack | Add to repo `.code-review/config.json` `disabled_domains` |
| Agent produces unparseable output | Fix `global/prompts/{agent}/agent.md` |
| Recurring false positives for a specific code pattern | Add `severity_overrides` in org/repo config |

**Recommend only — do NOT modify prompts.**

## Phase 4: Post & Persist

### 4a. Post to PR

Post the final summary as a single comment via `stark-claude[bot]`:

```bash
$PYTHON $SCRIPTS/github_app.py --app stark-claude pr review {number} --comment --body "$summary"
```

Or via Python:

```python
import sys
sys.path.insert(0, os.path.expanduser("~/.claude/code-review/scripts"))
from github_app import pr_review
pr_review("org/repo", NUMBER, event="COMMENT", body=summary_body)
```

If posting fails, print the summary to terminal and warn. Do not fail.

### 4b. Save history

Write to `~/.claude/code-review/history/{org}/{repo}/{pr}/`:

| File | Content |
|------|---------|
| `summary.md` | Human-readable final summary (same as PR comment) |
| `rounds.json` | All rounds aggregated, all findings, all outcomes |
| `prompt-assessment.md` | Prompt improvement recommendations |

Create directories on demand. If saving fails, warn but don't fail.

## Phase 5: Cleanup

```bash
cd /original/working/dir
git worktree remove /tmp/review-{repo_slug}-pr{number}
git branch -D review/pr-{number}
```

Best-effort — don't fail if cleanup fails. If a crashed session left a worktree, the next invocation detects and reuses it (Phase 1.5).

## Review Guidelines

- Don't suggest adding tests unless there's a concrete logic bug risk
- Flag actual security issues (XSS, injection, auth bypass)
- Don't comment on missing JSDoc/comments
- Be specific: include file paths, line numbers, and concrete fix suggestions
- Distinguish between "this will break" (critical) and "this could be better" (suggestion/nit)
- If the project has PR review guidelines in CLAUDE.md, those take precedence
