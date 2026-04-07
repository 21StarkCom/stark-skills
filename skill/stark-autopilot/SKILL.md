---
name: stark-autopilot
description: >-
  Autonomous tournament implementation: enabled agents compete in worktrees per step, best wins. Use for autopilot, multi-agent build.
argument-hint: '<plan-or-prompt> [--plan-slug SLUG] [--test-command CMD] [--agents claude,codex,gemini] [--timeout N] [--dry-run]'
disable-model-invocation: true
model: opus
---

## Preflight

Run environment validation before proceeding:
```bash
python3 ~/.claude/code-review/scripts/preflight.py --workflow stark-autopilot --json
```
Parse the JSON result:
- If `overall` is "blocked": print the failing checks and stop. Do not proceed.
- If `overall` is "degraded": print a warning with the failing checks, then continue with available agents.
- If `overall` is "ready": continue silently.
- In non-interactive automation contexts, a blocked preflight must emit a `preflight_check` event with `status=blocked`, append an entry to `~/.claude/code-review/alerts.jsonl`, and exit non-zero so the trigger is marked failed.

# stark-autopilot

Autonomous implementation with tournament-per-step. Claude orchestrates while all enabled agents
compete on every implementation step. Each step:

1. Enabled agents implement in parallel git worktrees
2. Tournament evaluates the implementations (tests + semantic judging)
3. Winner's code gets applied to the main branch
4. Next step begins from the winner's foundation

This is the nuclear option — maximum quality through competition at every step.

## Arguments

- `<plan-or-prompt>` — path to implementation plan, or inline task description
- `--plan-slug SLUG` — fetch issues labeled `plan:{SLUG}` from GitHub and use as steps (alternative to plan file)
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

Three input modes, resolved in this order:

**Issue-driven (preferred — from `/stark-plan-to-tasks` output):** If `--plan-slug SLUG` is provided, or if the input is a `.md` file path, attempt to load steps from GitHub issues:

1. Derive `PLAN_SLUG`:
   - If `--plan-slug` was given, use it directly
   - If a plan file was given, derive from filename: strip `.md`, strip known suffixes (`-design`, `-spec`, `-plan`). Truncate to 47 chars + 3-char hash if >50. Same logic as `/stark-plan-to-tasks` §1.7.

2. Detect target repo (same as plan-to-tasks: frontmatter → body scan → `git remote -v` → ask user).

3. Fetch issues:
   ```bash
   unset GH_TOKEN
   gh issue list \
     --label "plan:$PLAN_SLUG" \
     --repo $ORG_REPO \
     --state all \
     --json number,title,body,labels,state \
     --limit 200
   ```

4. If issues found with that label: enter **issue-driven mode** (see §1.2).
5. If no issues found and input is a `.md` file: fall back to **plan-file mode** with a warning:
   > No issues found for `plan:{PLAN_SLUG}`. Falling back to plan-file parsing. Run `/stark-plan-to-tasks {path}` first for richer issue-driven execution.
6. If no issues found and `--plan-slug` was explicit: error and stop:
   > Error: No issues found with label `plan:{SLUG}` on `{ORG_REPO}`.

**Plan file (fallback):** If input is a `.md` file and no matching issues were found, read it and extract the step list. Each `## Phase N` or `### Task N` heading becomes a step.

**Inline prompt:** If input is a description (not a file path, no `--plan-slug`), decompose it into steps yourself. For complex tasks, create 3-5 implementation steps that build on each other. For simple tasks, a single step is fine.

When a plan file path is available, retain it as `plan_path` for the approach contract step.

### 1.2 Extract steps

**Issue-driven mode:**

Group fetched issues into phases and tasks:

1. **Identify phase tracking issues** — issues whose title starts with "Phase" and whose body contains a task checklist (`- [ ] #NNN`)
2. **Identify task issues** — all other issues with the `plan:{PLAN_SLUG}` label
3. **Group tasks under phases** by matching the phase reference in each task's Dependencies section or by the task checklist in the phase issue
4. **Order phases** by their dependency links (phase `depends_on` from the issue body)
5. **Filter by ai_suitability** (from the issue body metadata):
   - `autonomous` and `assisted` tasks → include in steps
   - `human-led` tasks → skip with warning:
     > Skipping human-led task #{number}: {title} — requires manual implementation
6. **Skip already-closed tasks** — if `state` is `CLOSED`, skip:
   > Skipping #{number}: {title} — already closed

Each phase becomes one step. A step contains:
- `step_id` — phase slug (e.g., `phase-1-data-model`)
- `title` — phase name
- `prompt` — composed from the task issue bodies: concatenate each task's What, Why, Where, How, and Acceptance Criteria sections. Include the plan file content as background context if available.
- `issue_numbers` — issue numbers of all included tasks in the phase

If ALL tasks in a phase are closed or human-led, skip the entire phase:
> Skipping phase {step_id}: all tasks are closed or human-led.

**Plan-file mode / Inline mode:**

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
Mode:        issue-driven (plan:widget-system, 12 tasks across 4 phases)
Steps:       4
Agents:      claude, codex, gemini
Test command: pytest
Timeout:     900s per agent
Skipped:     2 human-led, 1 already closed

Step 1: Data Model & Storage (#37, #38, #39)
Step 2: API Layer (#40, #41, #42)
...

Each step: 3 agents compete in parallel worktrees → tournament → winner merged
```

In plan-file or inline mode, replace the Mode line with `Mode: plan-file` or `Mode: inline`.

If `--dry-run`, stop here.

### 1.5 Approach Contract
Before dispatching agents, confirm the approach:
```bash
python3 ~/.claude/code-review/scripts/approach_contract.py --plan-file <plan_path> --force-confirm
```

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

### 2i. Session state update

After each step completes:
```bash
python3 ~/.claude/code-review/scripts/session_state.py --json 2>/dev/null || true
```
Call `add_task("{step_id}")` programmatically, or note the step completion in context. The session state tracks which autopilot steps have completed so a crashed session can identify what was already done.

Every `context_compaction.checkpoint_interval_minutes` minutes (from config, default 15), generate a checkpoint:
```bash
python3 ~/.claude/code-review/scripts/context_compactor.py --json 2>/dev/null || true
```
Track the last checkpoint time and skip if not enough time has elapsed.

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
