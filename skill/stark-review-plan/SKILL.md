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
- Confirm file exists and is readable. If not found and path looks like a partial name (no directory separator), search for candidates:
  ```bash
  find docs/ -name "*${path}*" -o -name "*${path}*.md" 2>/dev/null | head -5
  ```
  If candidates found, list them and ask: "Did you mean one of these?" If no candidates, error and abort.
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

The dispatch script reads config internally. For the skill, read `max_rounds`:

```bash
# Default: 3 fix rounds. Override with --rounds N.
max_rounds=3
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

First, check dispatch health from the JSON output's `summary` field:
- If `summary.succeeded == 0` (all sub-agents failed): this is a **dispatch failure**, not a clean plan. Run diagnostics:
  ```bash
  which claude codex gemini  # verify CLIs are installed
  $PYTHON $SCRIPTS/plan_review_dispatch.py --file "$path" --round $round --agents claude --timeout 60  # single-agent probe
  ```
  Report the failure with stderr details. Do NOT treat zero findings as "clean." Skip remaining rounds and Phase 3 (re-dispatching will hit the same failure). Go directly to Phase 4 with a dispatch-failure summary.
- If `summary.succeeded > 0` but `summary.succeeded / summary.total_sub_agents < 0.5`: warn "Low coverage — only N/M sub-agents succeeded. Results may be incomplete." Continue normally.

If dispatch was healthy and this round produced zero findings classified as `fix` or `recurring`:
- Skip remaining fix rounds
- Go directly to Phase 3 (final review)

### 2e. Persist round (optional)

Write a temporary `in-progress.json` to `~/.claude/code-review/history/plan-reviews/{plan-filename}/` with the current round's data for crash recovery.

## Phase 3: Final Review

**Skip this phase if Phase 2 ended due to dispatch failure** (all sub-agents failed). Re-dispatching would hit the same failure.

Otherwise, run one more dispatch:

```bash
$PYTHON $SCRIPTS/plan_review_dispatch.py --file "$path" --round $((max_rounds + 1)) --timeout 300
```

This round is review-only — no fixes applied. The findings represent the final state of the plan.

- Zero findings at or above fix_threshold → plan is clean.
- Findings remain → reported as unresolved in the summary.

## Phase 4: Summary

Generate a consolidated markdown summary with these sections:

**If dispatch failure occurred**, use this template instead of the normal summary:

```markdown
## Plan Review — Dispatch Failure

**File:** {path}
**Status:** Review could not complete — {succeeded}/{total} sub-agents succeeded.

### Error Details
| Agent | Domain | Error | Stderr (truncated) |
|-------|--------|-------|-------------------|
(one row per failed sub-agent from the dispatch JSON)

### Diagnostics
- CLI availability: claude={yes/no}, codex={yes/no}, gemini={yes/no}
- Single-agent probe: {result of diagnostic dispatch}

### Recommendation
{e.g., "Check API keys/auth", "CLI not installed", "Network issue"}
```

**Otherwise, use the normal summary:**

### 4a. All Findings Table

| # | Round | Agent(s) | Domain | Severity | Section | Title | Outcome |
|---|-------|----------|--------|----------|---------|-------|---------|

### 4b. Fixed — findings addressed, grouped by round.

### 4c. Recurring — findings in 2+ rounds. Which round resolved them.

### 4d. Unresolved — findings from the final round that remain.

### 4e. False Positives & Noise — one-line reasoning per finding.

### 4f. Changes Made

Diff of plan changes across all fix rounds. Compare `original_content` with current file content.

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

Write `{plan-name}.review.md` alongside the original plan file. If the plan is `docs/specs/2026-03-13-design.md`, the review goes to `docs/specs/2026-03-13-design.review.md`.

### 5c. Post to PR (if PR detected and not --dry-run)

```bash
$PYTHON $SCRIPTS/github_app.py --app stark-claude pr review $pr_number --comment --body "$summary"
```

If posting fails, warn but don't fail.

### 5d. Save history

```bash
mkdir -p ~/.claude/code-review/history/plan-reviews/{plan-filename}
```

Write:
- `rounds.json` — all rounds: findings, classifications, outcomes
- `summary.md` — human-readable summary (same as PR comment)

Remove `in-progress.json` if it exists.

## Debugging Dispatch Failures

If sub-agents return 0 findings or errors, check the dispatch layer:

- **Orchestrator**: `$SCRIPTS/plan_review_dispatch.py` — dispatches 3 CLI agents in parallel via `subprocess.run`
- **CLI flags per agent**:
  - Claude: `claude -p - --output-format text --model claude-opus-4-6` (prompt via stdin)
  - Codex: `codex exec -c ... --ephemeral --json -o <tmpfile> -` (prompt via stdin, output from `-o` file)
  - Gemini: `gemini --model gemini-2.5-pro -p <instruction> -o json` (plan content via stdin, response in `{"response": "..."}` envelope, `GEMINI_CLI_HOME` tmpdir for isolation)
- **Error detection**: non-zero exit code → `cli_error`, empty output → `empty_output`. Check stderr in orchestrator output.
- **Smoke test**: `$PYTHON -m pytest $SCRIPTS/test_plan_review_dispatch.py::TestCLIFlagsSmoke -v` verifies each CLI accepts its flags
