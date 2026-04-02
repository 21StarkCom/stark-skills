---
name: stark-review-design
description: >-
  Multi-agent design/spec review: multi-LLM x 11 domains. Use for review design, review spec, review architecture.
argument-hint: "<path> [--rounds N] [--dry-run] [--force] [--tournament]"
disable-model-invocation: true
model: opus
---

# stark-review-design

Multi-agent architecture/spec review: N agents × 10 domain specializations dispatched in parallel
(default: 2 agents — Claude + Codex; configurable up to 3 with Gemini). Review-fix loop for up to
N rounds, then final review-only round. Answers the question: **"Is this the right system?"**

## Arguments

- `<path>` — path to design/spec/architecture markdown file (required)
- `--rounds N` — max fix cycles (default: 3, from config `design_review.max_rounds`)
- `--dry-run` — review only, no fixes, no PR posting, no review file
- `--force` — proceed even if design file has uncommitted changes
- `--tournament` — tournament mode: 3 agents each review ALL domains independently, evaluated by judge

**Raw input:** `$ARGUMENTS`

## Domains (10)

`general`, `completeness`, `security`, `scope`, `api-design`, `data-modeling`, `consistency`, `scalability`, `extensibility`, `resilience`

## Constants

```
SCRIPTS = ~/.claude/code-review/scripts
PYTHON  = $SCRIPTS/.venv/bin/python3
```

To call plan_review_dispatch.py: `$PYTHON $SCRIPTS/plan_review_dispatch.py --prompts-dir design-review <args>`
To call github_app.py: `$PYTHON $SCRIPTS/github_app.py <args>`

## Phase 1: Setup

### 1.1 Validate input

- Confirm `<path>` argument was provided. If not, error: "Usage: /stark-review-design <path>"
- Confirm file exists and is readable. If not found and path looks like a partial name (no directory separator), search for candidates:
  ```bash
  find docs/ -name "*${path}*" -o -name "*${path}*.md" 2>/dev/null | head -5
  ```
  If candidates found, list them and ask: "Did you mean one of these?" If no candidates, error and abort.
- Check if file has uncommitted changes:
  ```bash
  git diff --name-only -- "$path"
  ```
  If output is non-empty AND `--force` was not passed, warn: "Design file has uncommitted changes. Commit or stash first, or use --force." and abort.
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

## Tournament Mode (--tournament)

When `--tournament` is passed, skip the normal Phase 2 / Phase 3 loop and run this instead:

Each of the 3 agents (Claude, Codex, Gemini) independently reviews the **entire design document across ALL 11 domains** in a single comprehensive pass. Tournament mode does NOT use `plan_review_dispatch.py`'s normal per-domain dispatch pattern. Instead, the skill orchestrator:

1. Combines all 10 domain prompts into a single comprehensive prompt per agent
2. Dispatches each agent ONCE with the combined prompt (directly via CLI, not via plan_review_dispatch.py)
3. Collects 3 full review documents (one per agent)
4. Calls `evaluate_review()` from `tournament.py` to judge them

The 3 competing reviews are evaluated by `tournament.py`'s `evaluate_review()` function. The judge evaluates on:
- Coverage — did the agent find issues across all 11 domains?
- Severity accuracy — are severity ratings calibrated correctly?
- False positive rate — are flagged issues real?
- Actionability — are findings specific enough to act on?
- Specificity — are findings tied to the actual design content?

Position bias control: the judge runs twice with swapped agent order; numeric scores are averaged across both passes.

If the judge detects position bias (winner changes when review order is swapped), the result is a tie. In tie mode, no winner is declared — only the synthesized findings are used. The summary reports "Tournament result: tie (position bias detected)" and lists the synthesized findings.

Output: winner declared (or tie), synthesized best-of-all findings, tournament summary posted to PR (if PR detected).

### Tournament Fix Pass

After judging, unless `--dry-run` was passed, **fix all synthesized findings** in the design file (same approach as Phase 2c — edit directly). Then commit:

```bash
git add "$path"
git commit -m "docs: design review tournament fixes ($fix_count issues addressed)

stark-review-design tournament mode
Winner: $winner (or tie) | Scores: claude=$X, codex=$Y, gemini=$Z
Fixed: $fix_count findings across $domain_count domains
Agents: 3 dispatched, $succeeded succeeded

Co-Authored-By: stark-review-design <noreply@anthropic.com>"
```

After fixing and committing, proceed to Phase 4 (summary) and Phase 5 (output & persist). Use `design-reviews/tournament/` as the history subdirectory.

## Phase 2: Review-Fix Loop

If `--dry-run`: run Phase 2a once (round 1), skip fixing, go to Phase 4.

For round = 1 to max_rounds:

### 2a. Dispatch sub-agents

```bash
$PYTHON $SCRIPTS/plan_review_dispatch.py --prompts-dir design-review --file "$path" --round $round --timeout 300
```

Capture stdout as JSON. This dispatches all N×11 sub-agents (N agents × 11 domains, default N=2) in parallel and returns structured results.

Parse the JSON output. Extract findings from `results[].findings[]`.

### 2b. Classify findings

For each finding in the JSON output, read the referenced section in the design file. Classify:

| Status | Criteria |
|--------|----------|
| `fix` | Severity >= fix_threshold (default: medium) AND the issue actually exists in the design |
| `recurring` | Same section + same domain as a finding from a previous round that was supposedly fixed |
| `false_positive` | The described problem doesn't exist in the design or is already addressed |
| `noise` | Subjective, stylistic, or single-agent finding contradicted by the other 2 |
| `ignored` | Below fix_threshold (low severity when threshold is medium) |

Cross-reference: 2+ agents flagging the same section with the same concern = `high_confidence`.

### 2c. Fix the design

Edit the design file directly to address all `fix` and `recurring` findings:
- Add missing sections or details (e.g., missing error handling, data retention policy, auth model)
- Clarify ambiguous interfaces or contracts
- Add edge cases, failure modes, rollback strategies
- Fix contradictions between sections
- Trim out-of-scope or over-engineered elements

**Commit after fixing.** Every fix round MUST be committed for research traceability:

```bash
git add "$path"
git commit -m "docs: design review round $round fixes ($fix_count issues addressed)

stark-review-design fix round $round
Fixed: $fix_count findings | Recurring: $recurring_count
Domains: [list of domains with fixes]

Co-Authored-By: stark-review-design <noreply@anthropic.com>"
```

This creates a per-round commit trail. Researchers can `git log --oneline -- <path>` to see how the design evolved through review rounds, and `git diff <round1>..<round2>` to see what each round changed.

### 2d. Early termination check

First, check dispatch health from the JSON output's `summary` field:
- If `summary.succeeded == 0` (all sub-agents failed): this is a **dispatch failure**, not a clean design. Run diagnostics:
  ```bash
  which claude codex gemini  # verify CLIs are installed
  $PYTHON $SCRIPTS/plan_review_dispatch.py --prompts-dir design-review --file "$path" --round $round --agents claude --timeout 60  # single-agent probe
  ```
  Report the failure with stderr details. Do NOT treat zero findings as "clean." Skip remaining rounds and Phase 3 (re-dispatching will hit the same failure). Go directly to Phase 4 with a dispatch-failure summary.
- If `summary.succeeded > 0` but `summary.succeeded / summary.total_sub_agents < 0.5`: warn "Low coverage — only N/M sub-agents succeeded. Results may be incomplete." Continue normally.

If dispatch was healthy and this round produced zero findings classified as `fix` or `recurring`:
- Skip remaining fix rounds
- Go directly to Phase 3 (final review)

### 2e. Persist round (optional)

Write a temporary `in-progress.json` to `~/.claude/code-review/history/design-reviews/{design-filename}/` with the current round's data for crash recovery.

## Phase 3: Final Review

**Skip this phase if Phase 2 ended due to dispatch failure** (all sub-agents failed). Re-dispatching would hit the same failure.

Otherwise, run one more dispatch:

```bash
$PYTHON $SCRIPTS/plan_review_dispatch.py --prompts-dir design-review --file "$path" --round $((max_rounds + 1)) --timeout 300
```

This round is review-only — no fixes applied. The findings represent the final state of the design.

- Zero findings at or above fix_threshold → design is clean.
- Findings remain → reported as unresolved in the summary.

## Phase 4: Summary

Generate a consolidated markdown summary with these sections:

**If dispatch failure occurred**, use this template instead of the normal summary:

```markdown
## Design Review — Dispatch Failure

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

### 4a. Headline Counts

**Issues and noise are counted separately.** The headline reflects only real issues.

```markdown
**Issues found:** {fix + recurring count} | **Noise:** {noise + false_positive count} | **Ignored:** {ignored count}
**Signal-to-noise:** {issues / (issues + noise) * 100}%
```

- **Issues** = findings classified as `fix` or `recurring` (real problems in the design)
- **Noise** = `false_positive` or `noise` (not real problems — do not count as issues)
- **Ignored** = below fix_threshold

### 4b. All Findings Table

| # | Round | Agent(s) | Domain | Severity | Section | Title | Outcome |
|---|-------|----------|--------|----------|---------|-------|---------|

### 4c. Fixed — findings addressed, grouped by round.

### 4d. Recurring — findings in 2+ rounds. Which round resolved them.

### 4e. Unresolved — findings from the final round that remain.

### 4f. Noise & False Positives — one-line reasoning per finding.

### 4g. Misalignment Analysis

For each noise/false_positive finding, analyze **why** the reviewer flagged it and what context was missing. Group into root causes:

| Root Cause | Count | Improvement Action |
|------------|-------|--------------------|
| **Missing context in design** | N | Design didn't explain rationale for choice X → add a "## Design Decisions" or "## Rationale" section |
| **Overly aggressive prompt** | N | Domain prompt flags pattern X which is valid for this design type → tune prompt |
| **Scope mismatch** | N | Reviewer applied production-system criteria to prototype → add context-awareness to prompt |
| **Already addressed elsewhere** | N | Finding refers to something covered in a different section → improve cross-references in the design |

For each root cause, provide a concrete action: what to add to the design, which prompt to tune, or what config to change.

### 4h. Changes Made

Diff of design changes across all fix rounds. Compare `original_content` with current file content.

### 4i. Prompt Improvement Assessment

Analyze patterns across all rounds:

| Signal | Recommended Level | File |
|--------|-------------------|------|
| Agent X false positives in domain Y across designs | **Global** | `global/prompts/design-review/{agent}/{domain}.md` |
| Agent X false positives only for this repo | **Repo** | `{repo}/.code-review/design-prompts/{agent}/{domain}.md` |
| All agents miss same issue found during fixing | **Global** (all agents) | `global/prompts/design-review/*/{domain}.md` |
| Findings irrelevant to design type | **Repo config** | `disabled_domains` in config |

Recommend only — do NOT modify prompts.

## Phase 5: Output & Persist

### 5a. Terminal — print the consolidated summary.

### 5b. Review file (skipped in --dry-run)

Write `{design-name}.design-review.md` alongside the original design file. If the design is `docs/specs/2026-03-13-auth.md`, the review goes to `docs/specs/2026-03-13-auth.design-review.md`.

### 5b2. Commit review file (skipped in --dry-run)

Commit the review file alongside any previously uncommitted fix commits:

```bash
git add "{design-name}.design-review.md"
git commit -m "docs: add design review for {design-name}

stark-review-design complete
Issues: $total_issues ($fixed fixed, $unresolved unresolved)
Noise: $noise_count | Signal-to-noise: $signal_pct%
Mode: {standard|tournament} | Rounds: $rounds

Co-Authored-By: stark-review-design <noreply@anthropic.com>"
```

This ensures the full review trail — fix commits + review file — is in git history. Researchers can see the complete review lifecycle via `git log`.

### 5c. Post per-agent raw findings to PR (if PR detected and not --dry-run)

**Every agent's raw findings MUST be posted to the PR under that agent's bot identity.** GitHub serves as the permanent data store for learning and analysis.

For each agent that returned findings, post a separate comment under that agent's bot:

```bash
$PYTHON $SCRIPTS/github_app.py --app stark-claude pr review $pr_number --comment --body "$claude_findings"
$PYTHON $SCRIPTS/github_app.py --app stark-codex pr review $pr_number --comment --body "$codex_findings"
$PYTHON $SCRIPTS/github_app.py --app stark-gemini pr review $pr_number --comment --body "$gemini_findings"
```

Each agent's comment should list its raw findings in a table. If an agent returned 0 findings or failed, still post a short status comment under its identity.

Then post the orchestrator's classified summary as `stark-claude[bot]`:

```bash
$PYTHON $SCRIPTS/github_app.py --app stark-claude pr review $pr_number --comment --body "$summary"
```

If posting fails for a specific agent, warn and continue.

### 5d. Save history

```bash
mkdir -p ~/.claude/code-review/history/design-reviews/{design-filename}
```

Write:
- `rounds.json` — all rounds: findings, classifications, outcomes
- `summary.md` — human-readable summary (same as PR comment)

Remove `in-progress.json` if it exists.

## Observability

**You MUST implement all of the following.** The user relies on this output during long-running design reviews.

### Task-based progress (required)

At skill start, create tasks for the progress spinner:

```
TaskCreate: "Phase 1: Setup — validate design, check history"
            activeForm: "Setting up design review"
TaskCreate: "Phase 2: Review-Fix Loop (up to N rounds)"
            activeForm: "Running review-fix loop"
TaskCreate: "Phase 3: Final Review"
            activeForm: "Running final review round"
TaskCreate: "Phase 4: Summary"
            activeForm: "Generating summary"
TaskCreate: "Phase 5: Output & Persist"
            activeForm: "Writing results"
```

Set each to `in_progress` BEFORE starting, `completed` when done.

For Phase 2, create child tasks dynamically per round:

```
TaskCreate: "Round 1: dispatch N×10 sub-agents"
            activeForm: "Dispatching N×10 sub-agents (round 1)"
TaskCreate: "Round 1: classify + fix"
            activeForm: "Classifying and fixing findings"
```

For tournament mode, replace Phase 2 / Phase 3 tasks with:

```
TaskCreate: "Tournament: dispatch 3 comprehensive reviews"
            activeForm: "Running 3-agent tournament"
TaskCreate: "Tournament: judge evaluation"
            activeForm: "Evaluating competing reviews"
```

### Timestamped log lines (required)

Record `T0` at skill start. Print for every phase transition and key event:

```
[HH:MM:SS] === stark-review-design started ===
[HH:MM:SS] Phase 1: Setup — done (3s)
[HH:MM:SS] Phase 2: Review-Fix Loop — started
[HH:MM:SS]   ▸ Round 1: dispatching N×10 sub-agents
[HH:MM:SS]   ▸ Round 1: N×10 succeeded — 180s
[HH:MM:SS]   ▸ Round 1: 15 fix, 6 noise, 4 FP — fixing design
[HH:MM:SS]   ▸ Round 1: done
[HH:MM:SS]   ▸ Round 2: dispatching N×10 sub-agents
[HH:MM:SS]   ...
[HH:MM:SS] Phase 2: done (11m 30s)
[HH:MM:SS] Phase 3: Final Review — N×10 sub-agents — done (3m 10s)
[HH:MM:SS] Phase 4: Summary — done (5s)
[HH:MM:SS] Phase 5: Output — done (3s)
[HH:MM:SS] === stark-review-design completed ===
```

For tournament mode:

```
[HH:MM:SS] === stark-review-design (tournament) started ===
[HH:MM:SS]   ▸ Dispatching 3 comprehensive reviews (all 11 domains)
[HH:MM:SS]   ▸ All 3 agents returned — 240s
[HH:MM:SS]   ▸ Judge evaluation pass 1
[HH:MM:SS]   ▸ Judge evaluation pass 2 (order swapped)
[HH:MM:SS]   ▸ Winner: {agent} (score: X.XX)
[HH:MM:SS] === stark-review-design (tournament) completed ===
```

### 5-minute checkpoints (required for runs > 5 min)

```
[HH:MM:SS] ⏱ Checkpoint — 5m elapsed | Phase 2, Round 1 | 18/N×10 sub-agents complete
```

### Metrics block at end (required)

```
Metrics
───────
Total duration:     Xm Ys
Phases:
  Phase 1 (Setup):        3s
  Phase 2 (Review-Fix):   11m 30s
    Round 1 dispatch:     3m 00s
    Round 1 classify+fix: 2m 00s
    Round 2 dispatch:     2m 55s
    Round 2 classify+fix: 1m 45s
  Phase 3 (Final):        3m 10s
  Phase 4 (Summary):      5s
  Phase 5 (Output):       3s

Issues found:        10 (7 fixed, 3 unresolved)
Noise:               11 (7 false positive, 4 noise)
Agents:              30 dispatched, 28 succeeded, 2 failed
Rounds:              2 fix + 1 final
```

For tournament mode:

```
Metrics
───────
Mode:               tournament
Total duration:     Xm Ys
  Agent reviews:    4m 05s
  Judge (pass 1):   45s
  Judge (pass 2):   42s

Winner:             {agent}
Scores:             claude={X.XX}, codex={X.XX}, gemini={X.XX}
Findings (winner):  N total, M high/critical
```

### Improvement flags (required)

Check and print:
- Any phase > 70% of total → bottleneck
- Agent failure rate > 20% → flag by agent
- A round produced 0 new findings → suggest reducing rounds
- Dispatch health < 50% → warn about low coverage

If none: `No improvement opportunities detected.`

## Debugging Dispatch Failures

If sub-agents return 0 findings or errors, check the dispatch layer:

- **Orchestrator**: `$SCRIPTS/plan_review_dispatch.py` — dispatches 3 CLI agents in parallel via `subprocess.run`
- **Prompts dir**: `--prompts-dir design-review` — loads from `global/prompts/design-review/{agent}/`
- **CLI flags per agent**:
  - Claude: `claude -p - --output-format text --model claude-opus-4-6` (prompt via stdin)
  - Codex: `codex exec -c ... --ephemeral --json -o <tmpfile> -` (prompt via stdin, output from `-o` file)
  - Gemini: `gemini --model gemini-2.5-pro -p <instruction> -o json` (design content via stdin, response in `{"response": "..."}` envelope, `GEMINI_CLI_HOME` tmpdir for isolation)
- **Error detection**: non-zero exit code → `cli_error`, empty output → `empty_output`. Check stderr in orchestrator output.
- **Smoke test**: `$PYTHON -m pytest $SCRIPTS/test_plan_review_dispatch.py::TestCLIFlagsSmoke -v` verifies each CLI accepts its flags
