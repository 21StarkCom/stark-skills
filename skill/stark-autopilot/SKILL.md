---
name: stark-autopilot
description: >
  Autonomous multi-agent implementation with tournament at every step. Claude leads, dispatching
  Claude + Codex + Gemini to compete on each implementation step in parallel git worktrees. Best
  implementation wins via tournament evaluation, gets merged, and the next step begins. Use when
  the user wants to build something end-to-end with all 3 agents competing, says "autopilot",
  "build this with all agents", "tournament implementation", "let all 3 agents compete on building
  this", or invokes /stark-autopilot. This is the most powerful execution mode — use it for
  significant features, not one-line fixes.
argument-hint: '<plan-or-prompt> [--test-command CMD] [--agents claude,codex,gemini] [--timeout N] [--dry-run]'
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

**Semantic evaluation (always):**
Read each agent's diff and evaluate on 5 dimensions (1-10 each, max 50 points):
- **Correctness** — does the code do what the step asked for?
- **Quality** — is the code clean, well-structured, following conventions?
- **Completeness** — are edge cases handled, tests written?
- **Integration** — does it work with the existing codebase?
- **Simplicity** — is it the simplest correct solution?

Total score: test score (0 or 50) + semantic score (0-50) = 0-100.

Display the scorecard:

```
Step 1: [title] — Tournament Results
─────────────────────────────────────
              Tests  Correct  Quality  Complete  Integrate  Simple  Total
  claude      PASS     9        8        9          8         8     92 ★
  codex       PASS     8        9        7          9         9     92
  gemini      FAIL     9        7        8          7         8     39

Winner: claude (92/100) — tie-broken by correctness
```

### 2d. Apply winner

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

### 2e. Commit step

```bash
git add -A
git commit -m "feat: [step title] (autopilot: $winner won $score/100)"
```

### 2f. Clean up worktrees

```bash
$PYTHON $SCRIPTS/autopilot_dispatch.py \
  --repo-root $REPO_ROOT \
  --step-id "$step_id" \
  --cleanup
```

### 2g. Log and continue

Print step summary, then move to next step. The next step's agents will work from the current HEAD, which includes the winner's changes.

## Phase 3: Summary

After all steps complete:

```
stark-autopilot — Complete
──────────────────────────
Steps:    5/5 completed
Duration: 45m 12s

Step Results:
  1. [title] — claude won (92/100)
  2. [title] — codex won (88/100)
  3. [title] — claude won (95/100)
  4. [title] — gemini won (91/100)
  5. [title] — claude won (89/100)

Agent Stats:
  claude:  3 wins, avg 92.0/100
  codex:   1 win,  avg 85.3/100
  gemini:  1 win,  avg 82.7/100

Files changed: 23 (+1,450 / -200)
Commits: 5
```

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

### Task-based progress (required)

At start:
```
TaskCreate: "Phase 1: Setup — parse plan, detect tests"
            activeForm: "Setting up autopilot"
```

Per step (dynamic):
```
TaskCreate: "Step 1: [title] — 3 agents competing"
            activeForm: "Step 1: tournament in progress"
```

### Timestamped log lines (required)

```
[HH:MM:SS] === stark-autopilot started ===
[HH:MM:SS] Phase 1: Setup — 5 steps, pytest detected
[HH:MM:SS] Step 1: [title] — dispatching 3 agents
[HH:MM:SS]   ▸ claude: done — 8 files, +245/-30 [180s]
[HH:MM:SS]   ▸ codex: done — 6 files, +198/-25 [220s]
[HH:MM:SS]   ▸ gemini: done — 7 files, +210/-28 [150s]
[HH:MM:SS]   ▸ Tests: claude=PASS, codex=PASS, gemini=FAIL
[HH:MM:SS]   ▸ Winner: claude (92/100)
[HH:MM:SS]   ▸ Applied + committed
[HH:MM:SS] Step 2: [title] — dispatching 3 agents
...
[HH:MM:SS] === stark-autopilot completed (5/5 steps, 45m 12s) ===
```

### Metrics block at end (required)

```
Metrics
───────
Total duration:     45m 12s
Steps completed:    5/5
Tournaments run:    5
Total agent runs:   15 (5 steps × 3 agents)

Per-agent wins:
  claude:  3 (60%)
  codex:   1 (20%)
  gemini:  1 (20%)

Per-agent avg score:
  claude:  92.0/100
  codex:   85.3/100
  gemini:  82.7/100

Test results:
  Total runs:    15
  Passed:        12 (80%)
  Failed:         3 (20%)

Code output:
  Files changed:  23
  Lines added:    1,450
  Lines removed:  200
  Commits:        5
```

## Failure Modes

| Failure | Recovery |
|---------|----------|
| No input | Ask: "What should I build?" |
| 0/3 agents succeed on a step | Abort step, report error, ask user how to proceed |
| 1/3 agents succeed | Use that agent's output, warn about no tournament |
| 2/3 agents succeed | Tournament between 2, warn about reduced competition |
| Diff fails to apply | Copy files from winner's worktree directly |
| Tests fail for all agents | Use semantic-only scoring, warn "no agent passed tests" |
| Worktree creation fails | Try without worktrees (sequential, same branch) |
| Agent timeout | Disqualify, continue with remaining agents |
| Mid-run abort (user Ctrl+C) | Clean up all worktrees before exiting |
