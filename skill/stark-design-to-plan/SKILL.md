---
name: stark-design-to-plan
description: >-
  Convert design docs into phased implementation plans via the enabled agents + cross-review. Use for plan from design/spec.
argument-hint: "<path> [--agents claude,codex,gemini] [--timeout N] [--dry-run] [--force]"
disable-model-invocation: true
model: opus
---

## Preflight

Run environment validation before proceeding:
```bash
python3 ~/.claude/code-review/scripts/preflight.py --workflow stark-design-to-plan --json
```
Parse the JSON result:
- If `overall` is "blocked": print the failing checks and stop. Do not proceed.
- If `overall` is "degraded": print a warning with the failing checks, then continue with available agents.
- If `overall` is "ready": continue silently.
- In non-interactive automation contexts, a blocked preflight must emit a `preflight_check` event with `status=blocked`, append an entry to `~/.claude/code-review/alerts.jsonl`, and exit non-zero so the trigger is marked failed.

# stark-design-to-plan

Generate a phased implementation plan from a design document. The enabled agents each independently
produce a plan, then each plan is cross-reviewed by the other enabled agents.
The highest-scoring plan becomes the base, synthesized with the best elements from the others.

Fills the pipeline gap: `/stark-review-design` → **`/stark-design-to-plan`** → `/stark-review-plan`

## Arguments

- `<path>` — path to design/spec markdown file (required)
- `--agents LIST` — comma-separated agent IDs (default: claude,codex,gemini)
- `--timeout N` — per-agent timeout in seconds (default: 600)
- `--dry-run` — generate plans and reviews but don't write output files
- `--force` — proceed even if design file has uncommitted changes

**Raw input:** `$ARGUMENTS`

## Constants

```
SCRIPTS = ~/.claude/code-review/scripts
PYTHON  = $SCRIPTS/.venv/bin/python3
```

## Phase 1: Setup

### 1.1 Validate input

- Confirm `<path>` argument was provided. If not, error: "Usage: /stark-design-to-plan <path>"
- Confirm file exists and is readable. If not found and path looks like a partial name (no directory separator), search:
  ```bash
  find docs/ -name "*${path}*" -o -name "*${path}*.md" 2>/dev/null | head -5
  ```
  If candidates found, list them and ask. If none, error and abort.
- Check uncommitted changes:
  ```bash
  git diff --name-only -- "$path"
  ```
  If dirty AND `--force` not passed, warn and abort.
- Read file content. Store as `design_content`.

### 1.2 Detect PR context

```bash
pr_number=$(gh pr view --json number --jq .number 2>/dev/null)
```

Store for Phase 5 if present.

### 1.3 Authenticate (only if PR detected)

```bash
export GH_TOKEN=$($PYTHON $SCRIPTS/github_app.py --app stark-claude token)
```

Auth failure → warn, continue without PR posting.

### 1.4 Approach Contract
Before dispatching agents, confirm the approach:
```bash
python3 ~/.claude/code-review/scripts/approach_contract.py --plan-file <path> --force-confirm
```

## Phase 2: Generate Plans

Dispatch the enabled agents in parallel. Each produces an implementation plan:

```bash
$PYTHON $SCRIPTS/design_to_plan_dispatch.py \
  --mode generate \
  --design-file "$path" \
  --timeout $timeout
```

Capture JSON output. Extract `results[].plan_content` for each agent.

**Minimum viable:** At least 2 enabled agents must succeed. If only 1 succeeds, warn and use that single plan (skip cross-review). If 0 succeed, abort with dispatch failure diagnostics.

Write each plan to a temp file for Phase 3 input:
```bash
mkdir -p /tmp/stark-d2p-$$
# Write plans as {agent}.md
```

Also write plans as a JSON file for the cross-review dispatch:
```bash
# /tmp/stark-d2p-$$/plans.json = {"claude": "...", "codex": "...", "gemini": "..."}
```

## Phase 3: Cross-Review Plans

Each plan gets reviewed by the other enabled agents (full 3-agent mode produces 6 reviews):

```bash
$PYTHON $SCRIPTS/design_to_plan_dispatch.py \
  --mode cross-review \
  --design-file "$path" \
  --plans-json /tmp/stark-d2p-$$/plans.json \
  --timeout $timeout
```

Capture JSON output. Parse:
- `results[]` — individual review scores, strengths, weaknesses
- `plan_averages` — average score per plan author
- `winner` — agent whose plan scored highest

Display the scorecard:

```
Cross-Review Scorecard
──────────────────────
              Complete  Feasible  Phasing  Risk  Testable  Avg
  claude        8.5       9.0      8.0     7.5    8.0     8.2 ★
  codex         7.5       8.5      7.0     8.0    7.5     7.7
  gemini        8.0       7.0      8.5     7.0    8.0     7.7

Winner: claude (8.2/10)
```

Each score in the table is the average of the 2 cross-reviews for that plan.

If the top 2 plans are within 0.5 points, declare a tie and note it:
```
Winner: tie (claude 8.2, gemini 7.9) — synthesizing both equally
```

## Phase 4: Synthesize

This phase runs in the Claude Code orchestrator (not dispatched to a sub-agent).

Read:
1. The winning plan (or both plans in a tie)
2. All 6 cross-reviews (scores, strengths, weaknesses)
3. The original design document

Synthesis rules:
1. **Winner as base:** Start with the winning plan's structure and content
2. **Merge superior elements:** For each section where a non-winning plan scored higher on a specific dimension (based on cross-review feedback), incorporate that plan's approach for that section
3. **Address weaknesses:** For each weakness flagged by cross-reviewers, fix it in the synthesis
4. **Discard confirmed problems:** If both reviewers of a plan flagged the same weakness, do not carry that element into the synthesis
5. **Preserve specificity:** Keep concrete file paths, function names, commands. Don't generalize what the plans made specific

Output: a single markdown implementation plan document.

### Synthesis Quality Check

After generating the synthesis, verify:
- Every section of the design document has corresponding plan tasks
- No phase depends on a later phase
- Verification criteria exist for every phase
- Rollback procedure exists for every phase
- No orphaned tasks (tasks that no phase contains)

If issues found, fix them inline.

## Phase 5: Output & Persist

### 5a. Terminal

Print the synthesis summary:
```
Design-to-Plan Complete
───────────────────────
Design:    {path}
Plans:     3 generated (claude, codex, gemini)
Reviews:   6 cross-reviews
Winner:    {agent} ({score}/10)
Output:    {output_path}
```

### 5b. Write plan file (skip in --dry-run)

Write the synthesized plan alongside the design file:
- If design is `docs/specs/2026-03-27-auth-design.md`
- Plan goes to `docs/specs/2026-03-27-auth-plan.md`

Naming: replace `-design.md` with `-plan.md`. If the design filename doesn't end with `-design.md`, append `.plan.md`.

### 5c. Write review summary (skip in --dry-run)

Write cross-review details to `{design-name}.d2p-review.md` alongside the design file.

Contents:
- Scorecard table (from Phase 3)
- Per-plan strengths/weaknesses (from cross-reviews)
- Synthesis decisions (which elements came from which plan)

### 5d. Post to PR (if PR detected and not --dry-run)

Post the scorecard and synthesis summary under stark-claude:

```bash
$PYTHON $SCRIPTS/github_app.py --app stark-claude pr review $pr_number --comment --body "$summary"
```

### 5e. Save history

```bash
mkdir -p ~/.claude/code-review/history/design-to-plan/{design-filename}
```

Write:
- `generate.json` — raw plan outputs from all 3 agents
- `cross-review.json` — all 6 review outputs with scores
- `synthesis.md` — final synthesized plan
- `summary.md` — human-readable summary

### 5f. Cleanup

```bash
rm -rf /tmp/stark-d2p-$$
```

## Observability

Standard observability: create task per phase, emit timestamped progress logs (`[HH:MM:SS] Phase N: ...`), record metrics block (plans generated N/3, reviews N/6, winner agent + score, runner-up, synthesis merges, output path, per-phase durations), emit completion event via `emit_queue.py`.

Improvement flags: plan generation > 5 min → flag slow agent; cross-review parse failure → flag parse issue; score gap < 0.5 → "close race"; any dimension < 5 in winning plan → "weak spots in {dimension}"; agent generation failure → "only N/3 plans".

## Failure Modes

| Failure | Recovery |
|---------|----------|
| No path provided | "Usage: /stark-design-to-plan <path>" |
| File not found | Search docs/ for candidates |
| Uncommitted changes | "Commit or stash first, or use --force" |
| 0/3 plans generated | Abort with dispatch diagnostics |
| 1/3 plans generated | Use single plan, skip cross-review, warn |
| 2/3 plans generated | Cross-review with available plans (4 reviews instead of 6) |
| Cross-review parse failure | Use raw output, score manually in synthesis |
| All cross-reviews fail | Use plan line counts and structure as quality heuristic |
| Script not found | "Run install.sh to set up stark-skills" |
