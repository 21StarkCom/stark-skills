---
name: stark-review
description: >
  Multi-agent PR code review using 3 LLMs × N domains with autonomous fix loop.
  Use when the user says "stark review", "review this PR with all agents",
  "multi-agent review", or invokes /stark-review. Also triggers on
  `/stark-review` or `/stark-review <number>`.
argument-hint: "[PR_NUMBER] [--rounds N] [--dry-run] [--repo ORG/REPO]"
---

# stark-review

Multi-agent PR review: 3 LLMs (Claude, Codex, Gemini) × 6 domain specializations dispatched in parallel. Autonomous fix-review loop until clean or max rounds.

## Arguments

- `<number>` — PR number (e.g., `/stark-review 91`)
- `--rounds N` — max fix-review cycles (default: 3)
- `--repo ORG/REPO` — override repo detection
- `--dry-run` — review only, no fixes, no GitHub posting
- If number omitted, detect from current branch: `gh pr view --json number --jq .number`
- If detection fails (e.g., on `main`), list open PRs and ask: `gh pr list --json number,title,headRefName --jq '.[] | "#\(.number) \(.title) (\(.headRefName))"'`

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

If this fails → warn "stark-claude auth failed, degrading to local-only review." Set `auth_failed = true`. Continue — the review still runs because sub-agents use local `git diff`, not the GitHub API. Posting to the PR (Phase 4.1–4.3) and fetching PR body (spec context) will be skipped.

### 1.3 Fetch PR metadata

If `auth_failed`: skip API call. Fall back to local git:
```bash
base_ref=$(git log --oneline --merges -1 --format=%P HEAD | cut -d' ' -f1)  # or infer from branch name
head_ref=$(git branch --show-current)
head_sha=$(git rev-parse HEAD)
```
Set `pr_body = None` (spec context unavailable — do NOT flag "no spec found" as a red flag when it's due to auth failure).

If auth succeeded:
```bash
gh api repos/{repo}/pulls/{number}
```
Extract: `title`, `body`, `base.ref`, `head.ref`, `head.sha`, `head.repo.full_name`

### 1.4 Determine mode

- Fork PR (`head.repo.full_name != repo`) → **review-only**
- Read merged config via `$PYTHON $SCRIPTS/multi_review.py` internals or check for `.code-review/config.json` in repo. If `test_command` is NOT configured → **review-only**
- Otherwise → **full mode** (review + fix loop)

### 1.5 Push local changes

Before creating the worktree, ensure the remote PR branch includes all local work. The worktree is created from `FETCH_HEAD` (the remote PR head), so any uncommitted or unpushed changes would be invisible to the review agents.

```bash
current_branch=$(git branch --show-current)
if [ "$current_branch" = "{head_ref}" ]; then
    # Check for uncommitted changes
    if ! git diff --quiet || ! git diff --cached --quiet; then
        git add <changed files>
        git commit -m "fix: pre-review checkpoint"
    fi
    # Check for unpushed commits
    if [ "$(git rev-parse HEAD)" != "$(git rev-parse origin/{head_ref})" ]; then
        git push origin {head_ref}
    fi
fi
```

If on a different branch or detached HEAD, skip — the remote PR head is authoritative.

### 1.6 Create isolated worktree

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

### 1.7 Rebase over base branch

If the PR branch is not `main` (or whatever `base_ref` is), rebase over the latest base to incorporate any recently merged branches:

```bash
git fetch origin {base_ref}
git rebase origin/{base_ref}
```

If rebase conflicts → abort (`git rebase --abort`), warn in terminal, and continue with the un-rebased branch. The review still runs — conflicts just mean findings may overlap with already-merged code.

If rebase succeeds, update the merge base:

```bash
merge_base=$(git merge-base origin/{base_ref} HEAD)
```

### 1.8 Capture baseline (full mode only)

Run the configured `test_command` in the worktree. Parse output for failing test identifiers. Store as `baseline_failures` set. Pre-existing failures are not the skill's responsibility.

## Phase 1.9: Runtime Verification (MANDATORY before review)

Before dispatching review agents, verify the code actually runs. This catches interface mismatches and wrong SDK API calls that review agents consistently miss.

### 1.9a. Import chain test

Install deps in an isolated venv and import every module in the package:

```bash
[ -d /tmp/review-verify ] || python3 -m venv /tmp/review-verify
/tmp/review-verify/bin/pip install -q -r requirements.txt 2>/dev/null

/tmp/review-verify/bin/python3 -c "
import importlib, pathlib, sys
sys.path.insert(0, '.')
failures = []
for f in pathlib.Path('.').rglob('*.py'):
    if any(p in str(f) for p in ['test', 'venv', 'node_modules', '.git']): continue
    mod = str(f.with_suffix('')).replace('/', '.')
    try: importlib.import_module(mod)
    except Exception as e: failures.append((mod, str(e)[:100]))
for m, e in failures: print(f'IMPORT FAIL: {m} — {e}')
print(f'{len(failures)} import failures')
"
```

Import failures are **CRITICAL findings** — they mean the code crashes before any logic runs. Add them to the findings list with severity=critical, classified as `fix`. These take priority over anything the review agents find.

### 1.9b. SDK API spot-check

Scan the diff for imports of external SDKs. For each SDK imported, verify the methods called in our code exist:

```bash
# For each SDK class used in the diff, verify method signatures
/tmp/review-verify/bin/python3 -c "
import inspect
# Dynamically check methods based on what the diff uses
# Example: if diff imports AsyncTransaction and calls .begin(), verify it exists
from <sdk> import <Class>
for method in [<methods_called_in_diff>]:
    if not hasattr(<Class>, method):
        print(f'SDK MISMATCH: {Class.__name__}.{method}() does not exist')
"
```

SDK mismatches are **CRITICAL findings** — they cause `AttributeError` at runtime. This verification exists because in a real-world 8-round review, 5 consecutive attempts to fix a Firestore integration failed because every round guessed at the SDK API instead of checking the installed package.

**Rule: Never trust AI knowledge or documentation for SDK APIs. Install the package and run `inspect.signature()`.**

### 1.9c. Cross-module interface trace

For functions that cross module boundaries (detected from the diff), verify:
1. The callee's constructor/function signature accepts the args the caller passes
2. Return types match what the caller consumes
3. Config names (secrets, env vars) match between code and infrastructure definitions

Interface mismatches are the #1 source of bugs in AI-generated multi-module code. Each module is written independently and assumes interfaces it hasn't verified.

Add any mismatches as findings with severity=critical, classified as `fix`.

## Phase 2: Review-Fix Loop

**Review-only mode:** Run Phase 2a once, skip to Phase 3.

**Full mode:** For round = 1 to max_rounds (default 3):

### 2a. Run review

```bash
$PYTHON $SCRIPTS/multi_review.py --pr {number} --base {merge_base} --json-only --post-raw 2>/dev/null
```

Parse stdout as JSON. This is one call per round — `multi_review.py` runs all sub-agents in parallel, posts each agent's raw findings to the PR under its own bot identity (stark-claude, stark-codex, stark-gemini), and returns a JSON object with `rounds[0].results[]` containing findings per agent × domain.

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

### 2d. Build & Test

**Build check** — if `build_command` is configured, run it first. If not configured, try to infer from the project (`pnpm build`, `npm run build`, `mvn compile`, `go build ./...`, etc. based on what package manager / build files exist). If build fails, the fixes introduced compilation errors — fix them before proceeding.

**Test** — run `test_command`. Compare failures against `baseline_failures`. Only NEW failures (identifiers not in baseline) are regressions — fix them.

If fixing build or test regressions required code changes, re-run the build check to confirm no new compilation errors were introduced. Loop until build passes (max 3 attempts per round, then warn and proceed).

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

### Headline Counts

**Issues and noise are counted separately.** The headline count reflects only real issues — findings that were acted on or represent genuine problems in the code.

```markdown
## Review Summary

**Issues found:** {fix + recurring count} | **Noise:** {noise + false_positive count} | **Ignored:** {ignored count}
**Signal-to-noise:** {issues / (issues + noise) * 100}%
```

- **Issues** = findings classified as `fix` or `recurring` (real problems in the code)
- **Noise** = findings classified as `false_positive` or `noise` (not real problems)
- **Ignored** = below fix_threshold (not evaluated, listed for completeness)

Noise and false positives are never counted in the "issues found" number. They are tracked separately to measure review quality and drive prompt improvement.

### All Findings Table

```markdown
| # | Round | Agent(s) | Domain | Severity | File | Title | Outcome |
|---|-------|----------|--------|----------|------|-------|---------|
```

The `Outcome` column shows: `fixed`, `recurring`, `false_positive`, `noise`, or `ignored`.

### Fixed

Findings fixed, grouped by round. Include title, file, and commit SHA.

### Recurring

Findings that appeared in 2+ rounds or from 2+ agents. Note which round resolved them (or if they persisted).

### Noise & False Positives

One-line reasoning per finding explaining why it's not a real issue.

### Misalignment Analysis

For each noise/false_positive finding, analyze **why** the reviewer flagged it — what was missing from the review context that caused the misalignment. Group into root causes:

| Root Cause | Count | Improvement Action |
|------------|-------|--------------------|
| **Missing context in CLAUDE.md** | N | Reviewer didn't know about project convention X → add to CLAUDE.md |
| **Missing context in PR description** | N | Reviewer couldn't infer intent → document the "why" in PR body |
| **Overly aggressive prompt** | N | Domain prompt flags pattern X which is normal in this codebase → tune prompt or add `severity_overrides` |
| **Stack/framework mismatch** | N | Reviewer applied rules for framework Y to framework Z → add `disabled_domains` or stack-aware instructions |
| **Spec/design not referenced** | N | Reviewer didn't know the design choice was intentional → link spec/ADR in PR or CLAUDE.md |
| **Already covered by tooling** | N | Reviewer flagged what linter/CI already catches → exclude from review scope |

For each root cause with count > 0, provide a **concrete action** the user can take:

- **CLAUDE.md additions:** Write the exact lines to add (e.g., "Add to CLAUDE.md: `## Conventions\n- We use X pattern for Y because Z`")
- **PR template improvements:** Suggest what to include in PR descriptions to give reviewers enough context
- **Config changes:** Specific `disabled_domains`, `severity_overrides`, or `disabled_paths` entries for `.code-review/config.json`
- **Prompt tuning targets:** Which `global/prompts/{agent}/{domain}.md` file to adjust and what to change

The goal is to **shrink noise over time** by improving the context reviewers receive, not just ignoring false positives.

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

If `auth_failed`: skip all posting (4.1–4.3). Print summary to terminal with a note: "Review not posted to PR (auth failed). Copy the above to post manually." Jump to 4.4.

### 4.1 Per-agent raw findings (handled by multi_review.py)

Per-agent raw findings are posted automatically by `multi_review.py --post-raw` during Phase 2. Each agent's findings are posted as a separate PR comment under its own bot identity (stark-claude, stark-codex, stark-gemini). This happens mechanically in the Python script — the orchestrator skill does not need to post raw findings.

### 4.2 Post orchestrator summary

Post the classified summary (Phase 3 output) as `stark-claude[bot]`:

```bash
$PYTHON $SCRIPTS/github_app.py --app stark-claude pr review {number} --comment --body "$summary"
```

This comment contains headline counts, the full findings table with classifications (fix/noise/FP/ignored), noise reasoning, misalignment analysis, and prompt improvement assessment.

### 4.3 Create bug issues

For each finding that is (a) classified `fix` or `recurring`, (b) severity `critical` or `high`, and (c) still present after the final round — create a GitHub issue.

**Auth: user's PAT, not the bot.** Bug issues should show as created by the user:

```bash
unset GH_TOKEN  # Use native gh auth
```

**Labels** (auto-create if missing):

```bash
gh label create "stark-review" --repo {ORG}/{REPO} --color "7057ff" --force
gh label create "critical" --repo {ORG}/{REPO} --color "b60205" --force
gh label create "high" --repo {ORG}/{REPO} --color "d93f0b" --force
```

**IMPORTANT:** Do NOT use `type:bug`, `type:feature`, or `type:task` labels. Use the built-in GitHub Issue Type field instead (`--field type="Bug"`). Labels and Types are separate concepts — labels are for metadata like severity and source, Types are for categorization.

**Issue body:**

```bash
BODY_FILE=$(mktemp) && chmod 600 "$BODY_FILE"
cat > "$BODY_FILE" << 'ISSUE_EOF'
## Bug

{finding.description}

## Location

`{finding.file}:{finding.line}`

## Suggested Fix

{finding.suggestion}

## Context

- **Found by:** {finding.agent}/{finding.domain}
- **Severity:** {finding.severity}
- **PR:** #{pr_number}
- **Review round:** {round where first detected}
{if confirmed by multiple agents: "- **Confirmed by:** {list of agent/domain pairs}"}

---
_Created by `stark-review` · PR #{pr_number}_
ISSUE_EOF

TITLE_FILE=$(mktemp) && chmod 600 "$TITLE_FILE"
echo "bug: {finding.title}" > "$TITLE_FILE"

gh api /repos/{ORG}/{REPO}/issues \
  --method POST \
  --field title="$(cat $TITLE_FILE)" \
  --field body="$(cat $BODY_FILE)" \
  --field labels="[\"stark-review\",\"{finding.severity}\"]" \
  --field type="Bug"
rm -f "$BODY_FILE" "$TITLE_FILE"
```

**Shell injection prevention:** Title and body written to temp files (`chmod 600`) — LLM content never interpolated in shell.

**Deduplication:** Check for existing open issue with `stark-review` label matching same title + file path before creating.

**Cap:** Max 5 bug issues per review run. Overflow listed in PR comment.

**Include in summary:** "Bug Issues Created" section with issue numbers. If none qualify, omit.

### 4.4 Update review rounds tracking

Update the Review Rounds field on the linked issue's project item:

1. Load `.github/project-config.json`. If not found, skip.
2. Extract issue number from PR body (`Closes #N` / `Fixes #N`). If no linked issue, skip.
3. `export GH_TOKEN=$($PYTHON $SCRIPTS/github_app.py --app stark-claude token)`
4. Find project item via `github_projects.find_item_for_issue(...)`. If not found, skip.
5. If this round had findings > 0, increment Review Rounds field. If zero findings, don't increment.
6. `unset GH_TOKEN`

Failure in any step → log warning and continue.

### 4.5 Save history

Write to `~/.claude/code-review/history/{org}/{repo}/{pr}/`:

| File | Content |
|------|---------|
| `summary.md` | Human-readable final summary (same as PR comment) |
| `rounds.json` | All rounds, all findings, all outcomes, per-phase timing |
| `prompt-assessment.md` | Prompt improvement recommendations |

Create directories on demand. If saving fails, warn but don't fail.

## Phase 5: Cleanup

```bash
cd /original/working/dir
git worktree remove /tmp/review-{repo_slug}-pr{number}
git branch -D review/pr-{number}
```

Best-effort — don't fail if cleanup fails. If a crashed session left a worktree, the next invocation detects and reuses it (Phase 1.5).

## Observability

**You MUST implement all of the following.** This is not optional — the user relies on this output to understand what's happening during long-running reviews.

### Task-based progress (required)

At skill start, create these tasks to drive the Claude Code progress spinner:

```
TaskCreate: "Phase 1: Setup — auth, fetch PR, create worktree"
            activeForm: "Setting up review environment"
TaskCreate: "Phase 2: Review-Fix Loop (up to N rounds)"
            activeForm: "Running review-fix loop"
TaskCreate: "Phase 3: Final Summary"
            activeForm: "Generating summary"
TaskCreate: "Phase 4: Post & Persist"
            activeForm: "Posting to PR"
TaskCreate: "Phase 5: Cleanup"
            activeForm: "Cleaning up worktree"
```

Set each to `in_progress` BEFORE starting it, `completed` when done. Only one task `in_progress` at a time.

For Phase 2, create **child tasks dynamically** as each round begins:

```
TaskCreate: "Round 1: dispatch 18 sub-agents"
            activeForm: "Dispatching 18 sub-agents (round 1)"
TaskCreate: "Round 1: classify + fix"
            activeForm: "Classifying and fixing findings"
TaskCreate: "Round 1: build + test"
            activeForm: "Running build and tests"
```

Don't pre-create all rounds — the loop may exit early.

### Timestamped log lines (required)

Record `T0` at skill start. Print timestamped lines for every phase transition and key event:

```
[HH:MM:SS] === stark-review started ===
[HH:MM:SS] Phase 1: Setup — started
[HH:MM:SS] Phase 1: Setup — done (12s)
[HH:MM:SS] Phase 2: Review-Fix Loop — started
[HH:MM:SS]   ▸ Round 1: dispatching 18 sub-agents
[HH:MM:SS]   ▸ Round 1: 18 complete (14 succeeded, 4 failed: codex:scope, gemini:security, ...) — 127s
[HH:MM:SS]   ▸ Round 1: 7 fix, 3 false positive, 2 noise — fixing
[HH:MM:SS]   ▸ Round 1: build + test — passed
[HH:MM:SS]   ▸ Round 1: commit + push — done
[HH:MM:SS]   ▸ Round 2: dispatching 18 sub-agents
[HH:MM:SS]   ...
[HH:MM:SS] Phase 2: Review-Fix Loop — done (8m 43s)
[HH:MM:SS] Phase 3: Summary — done (5s)
[HH:MM:SS] Phase 4: Post & Persist — done (3s)
[HH:MM:SS] Phase 5: Cleanup — done (2s)
[HH:MM:SS] === stark-review completed ===
```

### 5-minute checkpoints (required for runs > 5 min)

If running for 5+ minutes, print a checkpoint at every 5-minute boundary:

```
[HH:MM:SS] ⏱ Checkpoint — 5m elapsed | Phase 2, Round 1 | 6/18 sub-agents complete
[HH:MM:SS] ⏱ Checkpoint — 10m elapsed | Phase 2, Round 2 | fixing 3 findings
```

### Metrics block at end (required)

After the skill completes (success or failure), print:

```
Metrics
───────
Total duration:     Xm Ys
Phases:
  Phase 1 (Setup):           12s
  Phase 2 (Review-Fix Loop): 8m 43s
    Round 1 dispatch:        2m 11s
    Round 1 classify+fix:    1m 22s
    Round 2 dispatch:        2m 05s
    Round 2 classify+fix:    1m 02s
    Build & test:            1m 43s
  Phase 3 (Summary):         5s
  Phase 4 (Post & Persist):  3s
  Phase 5 (Cleanup):         2s

Issues found:        14 (7 fixed, 5 recurring, 2 unresolved)
Noise:               7 (4 false positive, 3 noise)
Agents:              18 dispatched, 16 succeeded, 2 failed
Rounds:              2 fix + 1 final
Bug issues created:  N
```

### Improvement flags (required)

After the metrics, check and print if applicable:
- Any single phase > 70% of total time → flag as bottleneck
- Agent failure rate > 20% → flag with breakdown by agent
- A round produced 0 new actionable findings → suggest reducing rounds
- Build/test retries > 1 → flag fix quality issue
- Phase 1.9 found more critical issues than Phase 2 agents → flag "runtime verification was more valuable than review agents"
- Signal-to-noise < 20% → flag "review agents producing excessive noise — consider reducing domains or tightening prompts"

If none triggered: `No improvement opportunities detected.`

### Timing in history JSON

Include per-phase timing in `rounds.json`:

```json
{
  "timing": {
    "total_duration_s": 683,
    "phases": [
      {"name": "Setup", "duration_s": 12},
      {"name": "Review-Fix Loop", "duration_s": 523, "rounds": [
        {"round": 1, "dispatch_s": 131, "classify_fix_s": 82, "build_test_s": 45},
        {"round": 2, "dispatch_s": 125, "classify_fix_s": 62, "build_test_s": 38}
      ]},
      {"name": "Summary", "duration_s": 5},
      {"name": "Post & Persist", "duration_s": 3},
      {"name": "Cleanup", "duration_s": 2}
    ],
    "agents": {"dispatched": 18, "succeeded": 16, "failed": 2, "failed_agents": ["codex:scope", "gemini:security"]}
  }
}
```

### Event emission

After the metrics block, emit a completion event to stark-insights:

```bash
$SCRIPTS/stark-emit skill_invocation \
  skill=stark-review duration_s=$TOTAL_SECONDS success=$SUCCESS \
  pr_number=$PR findings_total=$TOTAL findings_fixed=$FIXED \
  noise_count=$NOISE agents_dispatched=$AGENTS rounds=$ROUNDS
```

Substitute actual values from the run. If stark-insights is not running, this fails silently.

### Observability in review-only / dry-run mode

When running in review-only mode (no fix loop), adapt the metrics:
- Skip "Rounds" line (there are no fix rounds)
- Show "Review-only mode — no fixes applied"
- Agent counts still apply

### Agent counting

Agent counts are **per-round** (27 dispatched = 3 agents × 9 domains per round). The metrics block shows the **last round's** agent counts. Total dispatches across all rounds go in the phase timing breakdown.

## Review Guidelines

- Don't suggest adding tests unless there's a concrete logic bug risk
- Flag actual security issues (XSS, injection, auth bypass)
- Don't comment on missing JSDoc/comments
- Be specific: include file paths, line numbers, and concrete fix suggestions
- Distinguish between "this will break" (critical) and "this could be better" (suggestion/nit)
- If the project has PR review guidelines in CLAUDE.md, those take precedence

### Signal-to-Noise Optimization (learned from real-world data)

In an 8-round review of a 12K-line PR, 18-agent dispatch produced 97 findings with ~10% signal-to-noise. Targeted 3-agent reviews with focused prompts found more real bugs per finding. Key learnings:

1. **Runtime verification catches more critical bugs than review agents.** Import checks and `inspect.signature()` on SDK calls found startup crashes, interface mismatches, and wrong API usage that all 18 agents missed.

2. **Cross-module interface mismatches are the #1 bug class** in AI-generated multi-module code. Each module is written independently and assumes interfaces it hasn't verified. Review agents read one file at a time and rarely trace call chains across module boundaries.

3. **SDK API assumptions are consistently wrong.** AI agents confidently call methods that don't exist. The only reliable verification is installing the package and inspecting it. This pattern repeated 5 times on a single Firestore function.

4. **When classifying findings, weigh runtime-verified findings highest.** A finding from Phase 1.9 (import/SDK check) is almost always a true positive. A finding from a review agent is ~30% true positive.

5. **Test-coverage and style findings are almost always noise.** Unless the PR introduces untested critical logic, suppress test-coverage domain findings to reduce noise.

## Debugging Dispatch Failures

If sub-agents return 0 findings or errors, check the dispatch layer:

- **Orchestrator**: `$SCRIPTS/multi_review.py` — dispatches 3 CLI agents in parallel via `subprocess.run`
- **CLI flags per agent**:
  - Claude: `claude -p - --output-format text --model claude-opus-4-6` (prompt via stdin)
  - Codex: `codex exec review -c ... --ephemeral --json -o <tmpfile> --base <ref> -` (prompt via stdin, output from `-o` file)
  - Gemini: `gemini --model gemini-2.5-pro -p <prompt> -o json --approval-mode plan` (response in `{"response": "..."}` envelope, `GEMINI_CLI_HOME` tmpdir for isolation)
- **Error detection**: non-zero exit code → `cli_error`, empty output → `empty_output`. Check stderr in orchestrator output.
- **Smoke test**: `$PYTHON -m pytest $SCRIPTS/test_multi_review.py::TestCLIFlagsSmoke -v` verifies each CLI accepts its flags
