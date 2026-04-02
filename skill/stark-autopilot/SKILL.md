---
name: stark-autopilot
description: >-
  Autonomous tournament implementation: 3 agents compete in worktrees per step, best wins. Use for autopilot, multi-agent build.
argument-hint: '<plan-or-prompt> [--test-command CMD] [--agents claude,codex,gemini] [--timeout N] [--dry-run]'
disable-model-invocation: true
model: opus
---

# stark-autopilot

Autonomous implementation with tournament-per-step. Claude orchestrates while all 3 agents
(Claude, Codex, Gemini) compete on every implementation step. Each step:

1. Three agents implement in parallel git worktrees
2. Tournament evaluates the implementations (tests + semantic judging)
3. Winner's code gets applied to the main branch
4. Next step begins from the winner's foundation

This is the nuclear option — maximum quality through competition at every step.

## Arguments

- `<plan-or-prompt>` — path to implementation plan, or inline task description
- `--test-command CMD` — test command to run after each step (e.g., `npm test`, `pytest`)
- `--agents LIST` — comma-separated agent IDs (default: claude,codex,gemini)
- `--timeout N` — per-agent timeout in seconds (default: 900)
- `--dry-run` — show what would happen without executing

If no input provided, ask: "What should I build?"

**Raw input:** `$ARGUMENTS`

## Constants

```
SCRIPTS = ~/.claude/code-review/scripts
PYTHON  = $SCRIPTS/.venv/bin/python3
REPO_ROOT = $(git rev-parse --show-toplevel)
```

## Phase 1: Setup

### 1.1 Parse input

Two input modes:

**Plan file:** If input is a path to a markdown file (from `/stark-design-to-plan` or manual), read it and extract the step list. Each `## Phase N` or `### Task N` heading becomes a step.

**Inline prompt:** If input is a description, decompose it into steps yourself. For complex tasks, create 3-5 implementation steps that build on each other. For simple tasks, a single step is fine.

### 1.2 Extract steps

Parse the plan into an ordered list of steps. Each step needs:
- `step_id` — slug like `phase-1-task-1`
- `title` — human-readable name
- `prompt` — full implementation prompt (includes context from the plan + the step's specific tasks)
- `issue_numbers` — GitHub issue numbers referenced in the step (e.g., `[37, 38, 39]` from `#37`, `#38`, `#39`)

### 1.3 Detect test command

If `--test-command` provided, use it. Otherwise, auto-detect:
```bash
# Check for common test runners
[ -f "package.json" ] && grep -q '"test"' package.json && echo "npm test"
[ -f "pyproject.toml" ] && echo "pytest"
[ -f "Makefile" ] && grep -q '^test:' Makefile && echo "make test"
```

If no test command found, warn: "No test command detected. Tournament will use semantic evaluation only."

### 1.4 Show battle plan

```
stark-autopilot — Battle Plan
──────────────────────────────
Steps:       5
Agents:      claude, codex, gemini
Test command: pytest
Timeout:     900s per agent

Step 1: [title]
Step 2: [title]
...

Each step: 3 agents compete in parallel worktrees → tournament → winner merged
```

If `--dry-run`, stop here.

## Phase 2: Execute Steps

For each step (sequentially — each builds on the previous winner):

### 2a0. Transition issues to In Progress

Update issue status and project board. For commands, see [references/issue-management.md](references/issue-management.md).

### 2a. Build step prompt

Combine:
1. The agent's implementation prompt from `global/prompts/autopilot/{agent}/implement.md`
2. Context: what was already implemented in previous steps (file list + key decisions)
3. The step's specific task description from the plan
4. The test command if available

Write the combined prompt to a temp file.

### 2b. Dispatch tournament

```bash
$PYTHON $SCRIPTS/autopilot_dispatch.py \
  --repo-root $REPO_ROOT \
  --step-id "$step_id" \
  --prompt-file /tmp/stark-autopilot-$$/step-$step_id.md \
  --timeout $timeout \
  [--test-command "$test_command"]
```

Capture JSON output. This creates 3 worktrees, runs agents in parallel, collects diffs, and runs tests.

### 2c. Evaluate tournament

Read the diffs from the JSON output. For each agent's implementation:

**Test score (if tests available):**
- Tests pass: +50 points
- Tests fail: 0 points

For evaluation dimensions, scoring formula, and scorecard format, see [references/tournament-scoring.md](references/tournament-scoring.md).

### 2d. Verify winner (MANDATORY — do not skip)

Before applying, the winner's code must pass import checks, SDK API verification, and cross-module interface checks. For all gate details, see [references/verification-gates.md](references/verification-gates.md).

If a gate fails, disqualify the winner and fall back to the next-highest scorer.

### 2e. Apply winner

Apply the winning agent's diff to the main working tree:

```bash
$PYTHON $SCRIPTS/autopilot_dispatch.py \
  --repo-root $REPO_ROOT \
  --step-id "$step_id" \
  --cleanup
```

But first, extract the diff from the winner's worktree and apply it:

```bash
# The orchestrator applies the diff directly using git apply
git apply --3way <<< "$winner_diff"
```

If the diff fails to apply cleanly (shouldn't happen since worktrees started from the same HEAD), fall back to copying files from the winner's worktree.

### 2f. Commit step

```bash
git add -A
git commit -m "feat: [step title] (autopilot: $winner won $score/100)"
```

### 2f1. Transition issues to Done

Close issues with commit reference and update project board. For commands, see [references/issue-management.md](references/issue-management.md).

### 2g. Clean up worktrees

```bash
$PYTHON $SCRIPTS/autopilot_dispatch.py \
  --repo-root $REPO_ROOT \
  --step-id "$step_id" \
  --cleanup
```

### 2h. Log and continue

Print step summary, then move to next step. The next step's agents will work from the current HEAD, which includes the winner's changes.

## Phase 2.5: End-of-Run Verification (MANDATORY)

After ALL steps complete, run full import chain test, smoke test, and SDK API spot-check. For verification procedures, see [references/verification-gates.md](references/verification-gates.md).

If ANY check fails, fix before proceeding to Phase 3.

## Phase 3: Summary

Print step results, agent stats, and code output. For summary template, see [references/issue-management.md](references/issue-management.md).

## Phase 4: Persist

### 4a. Save history

```bash
mkdir -p ~/.claude/code-review/history/autopilot/{task-slug}
```

Write:
- `steps.json` — per-step results, winners, scores, diffs
- `summary.md` — human-readable summary
- `tournament-log.jsonl` — per-step tournament audit trail

### 4b. Post to PR (if PR detected)

Post the summary as a PR comment under stark-claude.

## Observability

For task templates, log line formats, and metrics block format, see [references/observability.md](references/observability.md).

## Failure Modes

For the failure/recovery table (13 scenarios including agent timeouts, import failures, and mid-run aborts), see [references/failure-modes.md](references/failure-modes.md).
