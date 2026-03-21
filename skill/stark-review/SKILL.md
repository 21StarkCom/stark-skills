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

If this fails → warn "stark-claude auth failed, degrading to local-only review." Set `auth_failed = true`. Continue — the review still runs because sub-agents use local `git diff`, not the GitHub API. Posting to the PR (Phase 4a) and fetching PR body (spec context) will be skipped.

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

## Phase 2: Review-Fix Loop

**Review-only mode:** Run Phase 2a once, skip to Phase 3.

**Full mode:** For round = 1 to max_rounds (default 3):

### 2a. Run review

```bash
$PYTHON $SCRIPTS/multi_review.py --pr {number} --base {merge_base} --json-only --dry-run 2>/dev/null
```

Parse stdout as JSON. This is one call per round — `multi_review.py` runs all sub-agents in parallel and returns a JSON object with `rounds[0].results[]` containing findings per agent × domain.

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

### 4a. Post to PR

If `auth_failed`: skip posting entirely. Print summary to terminal with a note: "Review not posted to PR (auth failed). Copy the above to post manually."

Otherwise, post the final summary as a single comment via `stark-claude[bot]`:

```bash
$PYTHON $SCRIPTS/github_app.py --app stark-claude pr review {number} --comment --body "$summary"
```

Or via Python:

```python
import sys
sys.path.insert(0, os.path.expanduser("~/.claude/code-review/scripts"))
from github_app import pr_review
pr_review("org/repo", NUMBER, event="COMMENT", body=summary_body)
```

If posting fails, print the summary to terminal and warn. Do not fail.

### 4b. Create bug issues for unfixed findings

After the review-fix loop, some real issues may remain unfixed — either because they're too complex to auto-fix, they require human judgment, or they persist across max_rounds. For each finding that meets ALL of these criteria, create a GitHub issue:

1. Classified as `fix` or `recurring` (real issue, not noise/FP)
2. Severity is `critical` or `high`
3. Still present after the final round (not resolved during the fix loop)

**Label setup** (auto-create if missing):
```bash
GH_TOKEN="$($PYTHON $SCRIPTS/github_app.py --app stark-claude token)" \
  gh label create "type:bug" --repo {ORG}/{REPO} --color "e11d48" --force
GH_TOKEN="$($PYTHON $SCRIPTS/github_app.py --app stark-claude token)" \
  gh label create "stark-review" --repo {ORG}/{REPO} --color "7057ff" --force
```

**For each qualifying finding**, create an issue:

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

GH_TOKEN="$($PYTHON $SCRIPTS/github_app.py --app stark-claude token)" \
  gh api /repos/{ORG}/{REPO}/issues \
  --method POST \
  --field title="bug: {finding.title}" \
  --field body="$(cat $BODY_FILE)" \
  --field labels='["type:bug","stark-review","{finding.severity}"]'
rm -f "$BODY_FILE"
```

**Shell injection prevention:** Same rules as stark-plan-to-tasks — write body to temp file, use `--field` for title.

**Deduplication:** Before creating, check if an open issue with label `stark-review` already exists for the same file+title pattern:
```bash
GH_TOKEN="$($PYTHON $SCRIPTS/github_app.py --app stark-claude token)" \
  gh api "/repos/{ORG}/{REPO}/issues?labels=stark-review&state=open" --jq '.[].title'
```
If a matching issue title exists, skip and note "Bug already tracked in #{existing}".

**Include in summary:** Add a "Bug Issues Created" section after the Misalignment Analysis listing each created issue with its number and title. If no bugs qualify, omit the section.

If `auth_failed` or issue creation fails, log the bug details in the summary comment instead — don't lose the information.

### 4c. Save history

Write to `~/.claude/code-review/history/{org}/{repo}/{pr}/`:

| File | Content |
|------|---------|
| `summary.md` | Human-readable final summary (same as PR comment) |
| `rounds.json` | All rounds aggregated, all findings, all outcomes |
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

Follow the [Skill Observability Protocol](~/.claude/code-review/standards/observability.md) for all timing, checkpoints, and metrics reporting.

Additional skill-specific metrics:
- Per-round: dispatch duration, classify+fix duration, build+test duration
- Per-agent: success/failure count, avg duration per agent (claude/codex/gemini)
- Finding lifecycle: total → fixed / false positive / noise / recurring / unresolved

## Review Guidelines

- Don't suggest adding tests unless there's a concrete logic bug risk
- Flag actual security issues (XSS, injection, auth bypass)
- Don't comment on missing JSDoc/comments
- Be specific: include file paths, line numbers, and concrete fix suggestions
- Distinguish between "this will break" (critical) and "this could be better" (suggestion/nit)
- If the project has PR review guidelines in CLAUDE.md, those take precedence

## Debugging Dispatch Failures

If sub-agents return 0 findings or errors, check the dispatch layer:

- **Orchestrator**: `$SCRIPTS/multi_review.py` — dispatches 3 CLI agents in parallel via `subprocess.run`
- **CLI flags per agent**:
  - Claude: `claude -p - --output-format text --model claude-opus-4-6` (prompt via stdin)
  - Codex: `codex exec review -c ... --ephemeral --json -o <tmpfile> --base <ref> -` (prompt via stdin, output from `-o` file)
  - Gemini: `gemini --model gemini-2.5-pro -p <prompt> -o json --approval-mode plan` (response in `{"response": "..."}` envelope, `GEMINI_CLI_HOME` tmpdir for isolation)
- **Error detection**: non-zero exit code → `cli_error`, empty output → `empty_output`. Check stderr in orchestrator output.
- **Smoke test**: `$PYTHON -m pytest $SCRIPTS/test_multi_review.py::TestCLIFlagsSmoke -v` verifies each CLI accepts its flags
