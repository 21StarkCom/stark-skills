---
name: stark-review-plan
description: >-
  Multi-agent plan review: multi-LLM x 10 adversarial domains with fix loop. Use for review plan, audit deployment plan.
argument-hint: "<path> [--rounds N] [--dry-run] [--force] [--tournament]"
disable-model-invocation: true
model: opus
---

# stark-review-plan

Multi-agent execution plan review: N agents × 10 adversarial domains dispatched in parallel
(default: 2 agents — Claude + Codex; configurable up to 3 with Gemini). Reviews quality of how
a plan will be executed — can this plan actually be carried out safely?

**This skill assumes the plan will fail and hunts for where it will break.**

Normal mode: N agents × 10 domains = N×10 sub-agents in parallel (default N=2).
Tournament mode (`--tournament`): 3 agents each independently review the full document across all
domains, then a judge evaluates and synthesizes the winner.

For domain definitions, finding classification criteria, and coverage matrix vectors, see [references/domain-definitions.md](references/domain-definitions.md).

## Arguments

- `<path>` — path to plan markdown file (required)
- `--rounds N` — max fix cycles (default: 3, from config `plan_review.max_rounds`)
- `--dry-run` — review only, no fixes, no PR posting, no review file
- `--force` — proceed even if plan has uncommitted changes
- `--tournament` — tournament mode: 3 full-document reviews evaluated by a judge

**Raw input:** `$ARGUMENTS`

## Constants

```
SCRIPTS = ~/.claude/code-review/scripts
PYTHON  = $SCRIPTS/.venv/bin/python3
```

To call plan_review_dispatch.py: `$PYTHON $SCRIPTS/plan_review_dispatch.py --prompts-dir plan-review <args>`
To call github_app.py: `$PYTHON $SCRIPTS/github_app.py <args>`
To call tournament.py: `$PYTHON $SCRIPTS/tournament.py <args>`

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

**If `--tournament` was passed, skip this phase entirely and go to Phase 2T (Tournament).**

If `--dry-run`: run Phase 2a once (round 1), skip fixing, go to Phase 4.

For round = 1 to max_rounds:

### 2a. Dispatch sub-agents

```bash
$PYTHON $SCRIPTS/triage_orchestrator.py --type plan --file "$path" --round $round --json || $PYTHON $SCRIPTS/plan_review_dispatch.py --prompts-dir plan-review --file "$path" --round $round --timeout 300
```

Capture stdout as JSON. The triage orchestrator runs domain triage first, then dispatches only relevant domains. If the orchestrator fails, the `||` fallback calls `plan_review_dispatch.py` directly with all domains (N agents × 10 domains, default N=2).

Parse the JSON output. Extract findings from `results[].findings[]`.

### 2b. Classify findings

Classify each finding as `fix`, `recurring`, `false_positive`, `noise`, or `ignored`. For classification criteria, see [references/domain-definitions.md](references/domain-definitions.md).

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
  $PYTHON $SCRIPTS/plan_review_dispatch.py --prompts-dir plan-review --file "$path" --round $round --agents claude --timeout 60  # single-agent probe
  ```
  Report the failure with stderr details. Do NOT treat zero findings as "clean." Skip remaining rounds and Phase 3 (re-dispatching will hit the same failure). Go directly to Phase 4 with a dispatch-failure summary.
- If `summary.succeeded > 0` but `summary.succeeded / summary.total_sub_agents < 0.5`: warn "Low coverage — only N/M sub-agents succeeded. Results may be incomplete." Continue normally.

If dispatch was healthy and this round produced zero findings classified as `fix` or `recurring`:
- Skip remaining fix rounds
- Go directly to Phase 3 (final review)

### 2e. Persist round (optional)

Write a temporary `in-progress.json` to `~/.claude/code-review/history/plan-reviews/{plan-filename}/` with the current round's data for crash recovery.

## Phase 2T: Tournament Mode

**Only runs when `--tournament` was passed. Replaces Phases 2 and 3.**

Each agent independently reviews the full document across ALL 10 domains in a single comprehensive prompt. No domain splitting — each agent gets one combined prompt. Tournament mode does NOT use `plan_review_dispatch.py`'s normal per-domain dispatch pattern. Instead:

### 2T.a. Dispatch 3 full-document reviews

1. Combine all 10 domain prompts into a single comprehensive prompt per agent
2. Dispatch each agent ONCE with the combined prompt (directly via CLI, not via plan_review_dispatch.py)
3. Collect 3 full review documents (one per agent)

Each agent receives a combined prompt that merges all 10 domain prompts. Output: 3 structured review documents (one per agent).

### 2T.b. Judge evaluation

Call `evaluate_review()` from `tournament.py` (Python API, not CLI) with the plan content and all 3 reviews. Judge runs twice with swapped order (position bias control). For evaluation criteria and tie handling, see [references/domain-definitions.md](references/domain-definitions.md).

### 2T.c. Synthesize winner

The tournament engine declares a winner (or tie) and synthesizes best-of-all findings:
- Winner's full review is the base (or all reviews equally in tie mode)
- Any high-confidence finding from a non-winner that the winner missed is merged in
- False positives from all reviews are excluded

Output: single synthesized review document. Skip Phase 3 (no fix rounds in tournament mode). Go to Phase 4.

## Phase 3: Final Review

**Skip this phase if:**
- `--tournament` was passed (tournament mode handles its own final state)
- Phase 2 ended due to dispatch failure (all sub-agents failed)

Otherwise, run one more dispatch:

```bash
$PYTHON $SCRIPTS/plan_review_dispatch.py --prompts-dir plan-review --file "$path" --round $((max_rounds + 1)) --timeout 300
```

This round is review-only — no fixes applied. The findings represent the final state of the plan.

- Zero findings at or above fix_threshold → plan is clean.
- Findings remain → reported as unresolved in the summary.

## Phase 4: Summary

Generate a consolidated markdown summary. For the full template with all sections (4a-4j), see [references/summary-template.md](references/summary-template.md).

## Phase 5: Output & Persist

### 5a. Terminal — print the consolidated summary.

### 5b. Review file (skipped in --dry-run)

Write `{plan-name}.review.md` alongside the original plan file. If the plan is `docs/specs/2026-03-13-design.md`, the review goes to `docs/specs/2026-03-13-design.review.md`.

### 5c. Post per-agent raw findings to PR (if PR detected and not --dry-run)

Post each agent's findings under its bot identity, then the orchestrator summary. For posting commands and details, see [references/pr-posting.md](references/pr-posting.md).

### 5d. Save history

```bash
mkdir -p ~/.claude/code-review/history/plan-reviews/{plan-filename}
```

Write:
- `rounds.json` — all rounds: findings, classifications, outcomes
- `summary.md` — human-readable summary (same as PR comment)
- `tournament.json` — tournament scores and synthesis (tournament mode only)

Remove `in-progress.json` if it exists.

## Observability

For task templates, log line formats, checkpoint timing, metrics block format, and improvement flags, see [references/observability.md](references/observability.md).

## Debugging Dispatch Failures

For dispatch troubleshooting (CLI flags, error detection, smoke tests), see [references/debugging-dispatch.md](references/debugging-dispatch.md).
