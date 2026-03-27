---
name: stark-review-plan
description: >
  Multi-agent execution plan review using 3 LLMs × 10 adversarial domains with autonomous fix loop.
  Absorbs stark-review-deployment-plan. Use when the user says "review this plan",
  "review deployment plan", "review infra plan", "review migration plan", "audit deployment",
  or invokes /stark-review-plan. Also triggers on `/stark-review-plan <path>`.
argument-hint: "<path> [--rounds N] [--dry-run] [--force] [--tournament]"
---

# stark-review-plan

Multi-agent execution plan review: 3 LLMs (Claude, Codex, Gemini) × 10 adversarial domains
dispatched in parallel. Reviews quality of how a plan will be executed — can this plan actually
be carried out safely?

**This skill assumes the plan will fail and hunts for where it will break.**

Normal mode: 3 agents × 10 domains = 30 sub-agents in parallel.
Tournament mode (`--tournament`): 3 agents each independently review the full document across all
domains, then a judge evaluates and synthesizes the winner.

## Domains (10)

| # | Domain | Focus |
|---|--------|-------|
| 1 | general | Overall coherence, scope clarity, stated goals vs. actual steps |
| 2 | completeness | Missing prerequisites, undocumented assumptions, gaps in coverage |
| 3 | security | Identity lifecycle, least-privilege, secrets handling, blast radius |
| 4 | feasibility | Command validity, idempotency, human-executable steps, tooling availability |
| 5 | operability | Observability, alerting, runbooks, on-call impact, operator UX |
| 6 | sequencing | Dependency ordering, parallel vs. serial correctness, race conditions |
| 7 | rollback | Rollback completeness, partial-failure traps, state recovery |
| 8 | risk | Risk inventory, probability × impact, mitigations, residual risk |
| 9 | gates | Cutover criteria, go/no-go checks, validation evidence, sign-off |
| 10 | timeline | Duration estimates, critical path, buffer, deadline realism |

## Arguments

- `<path>` — path to plan markdown file (required)
- `--rounds N` — max fix cycles (default: 3, from config `plan_review.max_rounds`)
- `--dry-run` — review only, no fixes, no PR posting, no review file
- `--force` — proceed even if plan has uncommitted changes
- `--tournament` — tournament mode: 3 full-document reviews evaluated by a judge

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
$PYTHON $SCRIPTS/plan_review_dispatch.py --prompts-dir plan-review --file "$path" --round $round --timeout 300
```

Capture stdout as JSON. This dispatches all 30 sub-agents (3 agents × 10 domains) in parallel and returns structured results.

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

Call `evaluate_review()` from `tournament.py` (Python API, not CLI):

```python
from tournament import evaluate_review
result = evaluate_review(
    document=plan_content,
    reviews={"claude": claude_review, "codex": codex_review, "gemini": gemini_review},
)
```

The judge runs twice with swapped order (position bias control). Numeric scores are averaged across both passes for more robust scoring.

Evaluation criteria:
- **Coverage** — what fraction of real issues did the agent find?
- **Severity accuracy** — were critical issues called critical, not just "medium"?
- **False positive rate** — how many findings were noise or not real?
- **Actionability** — can an engineer act on each finding without guessing?
- **Specificity** — does each finding cite exact sections, commands, or line numbers?

If the judge detects position bias (winner changes when review order is swapped), the result is a tie. In tie mode, no winner is declared — only the synthesized findings are used. The summary reports "Tournament result: tie (position bias detected)" and lists the synthesized findings.

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

### 4a. Headline Counts

**Issues and noise are counted separately.** The headline reflects only real issues.

```markdown
**Issues found:** {fix + recurring count} | **Noise:** {noise + false_positive count} | **Ignored:** {ignored count}
**Signal-to-noise:** {issues / (issues + noise) * 100}%
```

- **Issues** = findings classified as `fix` or `recurring` (real problems in the plan)
- **Noise** = `false_positive` or `noise` (not real problems — do not count as issues)
- **Ignored** = below fix_threshold

In tournament mode, also include:
```markdown
**Tournament winner:** {agent} (score: {score}/100)
**Runner-up:** {agent} (score: {score}/100)
**Merged findings:** {count from non-winner reviews added to synthesis}
```

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
| **Missing context in spec/plan** | N | Spec didn't explain rationale for choice X → add a "## Rationale" or "## Design Decisions" section |
| **Overly aggressive prompt** | N | Domain prompt flags pattern X which is valid for this plan type → tune prompt |
| **Scope mismatch** | N | Reviewer applied production-system criteria to dev tooling → add context-awareness to prompt |
| **Already addressed elsewhere** | N | Finding refers to something covered in a different section → improve cross-references in the plan |

For each root cause, provide a concrete action: what to add to the plan, which prompt to tune, or what config to change.

### 4h. Coverage Matrix

Maps the deployment-plan failure vectors (A-J) to the 10 adversarial domains. Populated from actual findings.

| Vector | Domain | Status | Evidence |
|--------|--------|--------|----------|
| A) Partial-Failure Trap | rollback, sequencing | {found/clean/not-applicable} | {section or finding ref} |
| B) Imperative Idempotency | feasibility | {found/clean/not-applicable} | {section or finding ref} |
| C) Blank-Slate IaC | completeness | {found/clean/not-applicable} | {section or finding ref} |
| D) Dependency Sequencing | sequencing | {found/clean/not-applicable} | {section or finding ref} |
| E) Reality Drift | operability | {found/clean/not-applicable} | {section or finding ref} |
| F) Command Validation | feasibility | {found/clean/not-applicable} | {section or finding ref} |
| G) Cutover Gates | gates, rollback | {found/clean/not-applicable} | {section or finding ref} |
| H) API Prerequisites | completeness, sequencing | {found/clean/not-applicable} | {section or finding ref} |
| I) Identity Lifecycle | security | {found/clean/not-applicable} | {section or finding ref} |
| J) Evidence Strictness | general | {found/clean/not-applicable} | {section or finding ref} |

### 4i. Changes Made

Diff of plan changes across all fix rounds. Compare `original_content` with current file content.

### 4j. Prompt Improvement Assessment

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

### 5c. Post per-agent raw findings to PR (if PR detected and not --dry-run)

**Every agent's raw findings MUST be posted to the PR under that agent's bot identity.** GitHub serves as the permanent data store for learning and analysis.

For each agent that returned findings, post a separate comment under that agent's bot:

```bash
$PYTHON $SCRIPTS/github_app.py --app stark-claude pr review $pr_number --comment --body "$claude_findings"
$PYTHON $SCRIPTS/github_app.py --app stark-codex pr review $pr_number --comment --body "$codex_findings"
$PYTHON $SCRIPTS/github_app.py --app stark-gemini pr review $pr_number --comment --body "$gemini_findings"
```

Each agent's comment should list its raw findings in a table. If an agent returned 0 findings or failed, still post a short status comment under its identity.

In tournament mode, also post the tournament scorecard under stark-claude:
```bash
$PYTHON $SCRIPTS/github_app.py --app stark-claude pr review $pr_number --comment --body "$tournament_scorecard"
```

Then post the orchestrator's classified summary as `stark-claude[bot]`:

```bash
$PYTHON $SCRIPTS/github_app.py --app stark-claude pr review $pr_number --comment --body "$summary"
```

If posting fails for a specific agent, warn and continue.

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

**You MUST implement all of the following.** The user relies on this output during long-running plan reviews.

### Task-based progress (required)

At skill start, create tasks for the progress spinner:

```
TaskCreate: "Phase 1: Setup — validate plan, check history"
            activeForm: "Setting up plan review"
TaskCreate: "Phase 2: Review-Fix Loop (up to N rounds)"   [or "Phase 2T: Tournament" if --tournament]
            activeForm: "Running review-fix loop"
TaskCreate: "Phase 3: Final Review"                        [skip if --tournament]
            activeForm: "Running final review round"
TaskCreate: "Phase 4: Summary"
            activeForm: "Generating summary"
TaskCreate: "Phase 5: Output & Persist"
            activeForm: "Writing results"
```

Set each to `in_progress` BEFORE starting, `completed` when done.

For Phase 2, create child tasks dynamically per round:

```
TaskCreate: "Round 1: dispatch 30 sub-agents"
            activeForm: "Dispatching 30 sub-agents (round 1)"
TaskCreate: "Round 1: classify + fix"
            activeForm: "Classifying and fixing findings"
```

For Phase 2T (tournament):

```
TaskCreate: "Tournament: dispatch 3 full-document reviews"
            activeForm: "Dispatching tournament competitors"
TaskCreate: "Tournament: judge evaluation"
            activeForm: "Judge evaluating reviews (2 passes)"
TaskCreate: "Tournament: synthesize winner"
            activeForm: "Synthesizing best-of-all findings"
```

### Timestamped log lines (required)

Record `T0` at skill start. Print for every phase transition and key event:

```
[HH:MM:SS] === stark-review-plan started ===
[HH:MM:SS] Phase 1: Setup — done (3s)
[HH:MM:SS] Phase 2: Review-Fix Loop — started
[HH:MM:SS]   ▸ Round 1: dispatching 30 sub-agents
[HH:MM:SS]   ▸ Round 1: 27/30 succeeded — 145s
[HH:MM:SS]   ▸ Round 1: 12 fix, 5 noise, 3 FP — fixing plan
[HH:MM:SS]   ▸ Round 1: done
[HH:MM:SS]   ▸ Round 2: dispatching 30 sub-agents
[HH:MM:SS]   ...
[HH:MM:SS] Phase 2: done (9m 12s)
[HH:MM:SS] Phase 3: Final Review — 30 sub-agents — done (2m 30s)
[HH:MM:SS] Phase 4: Summary — done (5s)
[HH:MM:SS] Phase 5: Output — done (3s)
[HH:MM:SS] === stark-review-plan completed ===
```

In tournament mode:

```
[HH:MM:SS] Phase 2T: Tournament — started
[HH:MM:SS]   ▸ Dispatching 3 full-document reviews
[HH:MM:SS]   ▸ Reviews complete — claude: 180s, codex: 210s, gemini: 195s
[HH:MM:SS]   ▸ Judge evaluation pass 1 — done (45s)
[HH:MM:SS]   ▸ Judge evaluation pass 2 (swapped order) — done (42s)
[HH:MM:SS]   ▸ Winner: {agent} (score: {score}/100)
[HH:MM:SS]   ▸ Synthesis: {N} findings merged from non-winner reviews
[HH:MM:SS] Phase 2T: done (7m 12s)
```

### 5-minute checkpoints (required for runs > 5 min)

```
[HH:MM:SS] ⏱ Checkpoint — 5m elapsed | Phase 2, Round 1 | 18/30 sub-agents complete
```

### Metrics block at end (required)

```
Metrics
───────
Total duration:     Xm Ys
Mode:               normal | tournament
Phases:
  Phase 1 (Setup):        3s
  Phase 2 (Review-Fix):   9m 12s
    Round 1 dispatch:     2m 25s
    Round 1 classify+fix: 1m 30s
    Round 2 dispatch:     2m 20s
    Round 2 classify+fix: 1m 15s
  Phase 3 (Final):        2m 30s
  Phase 4 (Summary):      5s
  Phase 5 (Output):       3s

Issues found:        8 (5 fixed, 3 unresolved)
Noise:               9 (6 false positive, 3 noise)
Agents:              30 dispatched, 27 succeeded, 3 failed
Rounds:              2 fix + 1 final
Domains:             10
```

In tournament mode, replace Agents/Rounds rows with:

```
Tournament winner:   {agent} ({score}/100)
Runner-up:           {agent} ({score}/100)
Merged findings:     {N} from non-winner reviews
```

### Improvement flags (required)

Check and print:
- Any phase > 70% of total → bottleneck
- Agent failure rate > 20% → flag by agent
- A round produced 0 new findings → suggest reducing rounds
- Dispatch health < 50% → warn about low coverage
- Tournament: score gap < 5 points → "results too close to call — review manually"

If none: `No improvement opportunities detected.`

## Debugging Dispatch Failures

If sub-agents return 0 findings or errors, check the dispatch layer:

- **Orchestrator**: `$SCRIPTS/plan_review_dispatch.py` — dispatches 3 CLI agents in parallel via `subprocess.run`
- **CLI flags per agent**:
  - Claude: `claude -p - --output-format text --model claude-opus-4-6` (prompt via stdin)
  - Codex: `codex exec -c ... --ephemeral --json -o <tmpfile> -` (prompt via stdin, output from `-o` file)
  - Gemini: `gemini --model gemini-2.5-pro -p <instruction> -o json` (plan content via stdin, response in `{"response": "..."}` envelope, `GEMINI_CLI_HOME` tmpdir for isolation)
- **Error detection**: non-zero exit code → `cli_error`, empty output → `empty_output`. Check stderr in orchestrator output.
- **Smoke test**: `$PYTHON -m pytest $SCRIPTS/test_plan_review_dispatch.py::TestCLIFlagsSmoke -v` verifies each CLI accepts its flags
