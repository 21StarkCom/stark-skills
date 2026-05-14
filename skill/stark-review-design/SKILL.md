---
name: stark-review-design
description: >-
  Multi-agent design/spec review: multi-LLM x 8 domains. Use for review design, review spec, review architecture.
argument-hint: "<path> [--rounds N] [--dry-run] [--force] [--tournament]"
disable-model-invocation: true
model: opus
revision: 7c91ffda1c063674729d3d8dddcf530bb937db53
revision_date: 2026-05-14T07:49:39Z
---

## Preflight

Run [standard preflight](../../standards/preflight.md) with `--workflow stark-review-design`.

# stark-review-design

Multi-agent architecture/spec review: N agents × 8 domain specializations dispatched in parallel
(default: 2 agents — Claude + Codex; configurable up to 3 with Gemini). Review-fix loop for up to
N rounds, then final review-only round. Answers the question: **"Is this the right system?"**

## Arguments

- `<path>` — path to design/spec/architecture markdown file (required)
- `--rounds N` — max fix cycles (default: 3, from config `design_review.max_rounds`)
- `--dry-run` — review only, no fixes, no PR posting, no review file
- `--force` — proceed even if design file has uncommitted changes
- `--tournament` — tournament mode: 3 agents each review ALL domains independently, evaluated by judge

**Raw input:** `$ARGUMENTS`

## Domains (8)

`completeness`, `security`, `scope`, `api-design`, `data-modeling`, `consistency`, `accessibility`, `test-plan`

## Constants

```bash
SCRIPTS="${STARK_REVIEW_SCRIPTS:-$HOME/.claude/code-review/scripts}"
PYTHON="$SCRIPTS/.venv/bin/python3"
[ -x "$PYTHON" ] || PYTHON=python3
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

Each of the 3 agents (Claude, Codex, Gemini) independently reviews the **entire design document across ALL 8 domains** in a single comprehensive pass. Tournament mode does NOT use `plan_review_dispatch.py`'s normal per-domain dispatch pattern. Instead, the skill orchestrator:

1. Combines all 8 domain prompts into a single comprehensive prompt per agent
2. Dispatches each agent ONCE with the combined prompt (directly via CLI, not via plan_review_dispatch.py)
3. Collects 3 full review documents (one per agent)
4. Calls `evaluate_review()` from `tournament.py` to judge them

The 3 competing reviews are evaluated by `tournament.py`'s `evaluate_review()` function. The judge evaluates on:
- Coverage — did the agent find issues across all 8 domains?
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
$PYTHON $SCRIPTS/triage_orchestrator.py --type design --file "$path" --round $round --json || $PYTHON $SCRIPTS/plan_review_dispatch.py --prompts-dir design-review --file "$path" --round $round --timeout 300
```

Capture stdout as JSON. The triage orchestrator runs domain triage first, then dispatches only relevant domains. If the orchestrator fails, the `||` fallback calls `plan_review_dispatch.py` directly with all domains (N agents × 8 domains, default N=2).

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

Run the [shared dispatch-failure check](../../standards/dispatch-failure.md)
against the round's `summary`. `<prompts-dir>` for the diagnostic probe is
`design-review`. On dispatch failure, jump straight to Phase 4 with the
dispatch-failure summary template.

If dispatch was healthy and this round produced zero findings classified as
`fix` or `recurring`, skip remaining fix rounds and go to Phase 3.

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

Build a `SummaryInput` JSON envelope from the round payloads (one entry per
round, each carrying `summary`, `findings` with the skill's `classification`
overlay, and optional `results` for the dispatch-failure path) plus the design
file's `git diff` if any fix commits landed:

```bash
TOOLS="$HOME/.claude/code-review/tools"
SUMMARY_MD=$(node --experimental-strip-types "$TOOLS/design_review_summary.ts" \
  --input rounds.json)
```

The tool emits the full Phase 4 markdown:

- **4a Headline counts** — issues vs noise vs ignored, signal-to-noise %.
- **4b All findings table** — sorted by round then severity, with classification.
- **4c Fixed** — grouped by round.
- **4d Recurring** — bucketed by `(section, domain)` across rounds.
- **4e Unresolved** — fix/recurring findings remaining in the final round.
- **4f Noise & false positives** — one line per finding with the recorded reason.
- **4g Misalignment Analysis** — emits a placeholder table; **the skill fills in counts and improvement actions** (LLM judgment required).
- **4h Changes Made** — fenced `git diff` of the design file across fix rounds (skipped if no diff).
- **4i Prompt Improvement Assessment** — emits a placeholder table; **the skill recommends levels (Global/Repo/Config)** based on patterns it observed.

If any round has `summary.succeeded == 0`, the tool swaps in the
**dispatch-failure template** (file path, per-agent error rows, CLI
availability if provided) and the skill should fill in the recommendation
line from its diagnostic probe.

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

For task templates, log line formats, checkpoint timing, metrics block format (standard + tournament), and improvement flags, see [references/observability.md](references/observability.md).

## Debugging Dispatch Failures

For dispatch troubleshooting (CLI flags per agent, error detection, smoke tests), see [references/debugging-dispatch.md](references/debugging-dispatch.md).
