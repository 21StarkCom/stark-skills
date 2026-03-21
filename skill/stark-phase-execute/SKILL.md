---
name: stark-phase-execute
description: >
  Autonomously execute all tasks in a development phase end-to-end — for each task: session start,
  implement, PR, multi-agent review with fix rounds, merge, session end. Then regression tests,
  version bump, deploy, dashboard, memory/docs update, and prompt improvement detection.
  Zero user intervention after trigger. Use when the user says "execute phase", "run phase",
  "stark-phase-execute", "execute these tasks", "implement this phase", "run the plan",
  "autopilot", or any variation of wanting to autonomously execute a set of planned GitHub issues.
  Also triggers on `/stark-phase-execute`. Proactively suggest this skill when the user has just
  run `/stark-plan-to-tasks` and has open phase issues.
argument-hint: "<plan-slug> [--dry-run] [--skip-deploy] [--skip-release] [--start-from <issue-number>] [--rounds <N>] [--repo ORG/REPO]"
---

# stark-phase-execute

Autonomous execution engine for development phases. Takes a plan slug (from `/stark-plan-to-tasks`), fetches all associated GitHub issues, and executes each one through a complete development lifecycle: branch → implement → test → PR → multi-agent review → fix → merge → next.

After all tasks: regression tests, version bump, deploy, dashboard, memory update, prompt improvement detection.

**This skill overrides all user-confirmation gates in sub-workflows.** No "wait for approval", no "proceed anyway?", no "are you sure?" — every decision is made autonomously. The user triggers it and walks away.

## Prerequisites

This skill requires full autonomy. Before triggering, ensure:
- Claude Code is running with `--dangerouslySkipPermissions` or equivalent tool allowlists
- `gh auth status` shows an active user PAT
- `claude`, `codex`, `gemini`, `gh` are all in PATH
- GitHub Apps (stark-claude, stark-codex, stark-gemini) are installed on the target repo

## Arguments

| Arg | Default | Description |
|-----|---------|-------------|
| `<plan-slug>` | required | Plan slug from `/stark-plan-to-tasks` — matches the `plan:{SLUG}` label on issues |
| `--dry-run` | off | Walk the plan, show what would happen, don't execute |
| `--skip-deploy` | off | Skip deployment after release |
| `--skip-release` | off | Skip version bump and release |
| `--start-from <N>` | 1st issue | Resume from a specific issue number |
| `--rounds <N>` | 3 | Max review-fix rounds per PR |
| `--repo ORG/REPO` | auto-detect | Override repo detection from git remote |

## Constants

```
SCRIPTS = ~/.claude/code-review/scripts
PYTHON  = $SCRIPTS/.venv/bin/python3
HISTORY = ~/.claude/code-review/history
```

Detect repo (or use `--repo` override):

```bash
REMOTE=$(git remote get-url origin)
ORG_REPO=<parse org/repo from REMOTE>
ORG=$(echo $ORG_REPO | cut -d/ -f1)
REPO=$(echo $ORG_REPO | cut -d/ -f2)
```

---

## Phase 0: Initialize

Capture T0. Create the observability log.

### 0.1 Validate environment

```bash
git checkout main && git pull --rebase origin main
git status --porcelain          # must be empty
git branch --show-current       # must be main
which gh claude codex gemini    # all must exist
gh auth status                  # must show active account
$PYTHON $SCRIPTS/github_app.py --app stark-claude token >/dev/null
```

If any check fails → stop and report. Don't proceed with a broken environment.

### 0.2 Fetch plan tasks

```bash
unset GH_TOKEN   # user's PAT for issue reads
gh api "/repos/${ORG_REPO}/issues?labels=plan:${SLUG}&state=open&sort=created&direction=asc&per_page=100" \
  --jq '.[] | {number, title, labels: [.labels[].name], body}'
```

**Filter out phase tracking issues.** `/stark-plan-to-tasks` creates two types of issues with the `plan:` label: phase tracking issues (parent issues with task checklists) and task issues (implementable work). Phase tracking issues have a body starting with a task checklist (`- [ ] #NNN`) and no `## What` section. Skip them — only keep issues whose body contains `## What` (the task body format from plan-to-tasks).

Parse remaining issues into ordered task list. Extract from labels: story points (`sp:N`), risk (`risk:*`), type (`type:*`).

If `--start-from` is set, skip tasks before that issue number.

If no tasks found → stop: "No open task issues with label `plan:{SLUG}`".

### 0.3 Phase briefing

```
[HH:MM:SS] === stark-phase-execute: {SLUG} ===
Tasks:       {N} task issues (of {M} total with label)
Repo:        {ORG_REPO}
Max rounds:  {ROUNDS} per PR
Dry run:     {yes/no}

  1. #{number} — {title} (sp:{N}, risk:{level})
  2. #{number} — {title} (sp:{N}, risk:{level})
  ...
```

Create a parent task for the phase. Create child tasks for each issue.

### 0.4 Initialize observability log

Write to `{HISTORY}/{ORG}/{REPO}/phase-{SLUG}-{YYYYMMDD-HHMMSS}.json`:

```json
{
  "phase": "{SLUG}",
  "repo": "{ORG_REPO}",
  "started_at": "ISO8601",
  "dry_run": false,
  "max_rounds": 3,
  "tasks": [],
  "summary": null
}
```

Updated incrementally as tasks complete.

---

## Phase 1: Task Loop

Execute each task sequentially. Each merges to main before the next begins.

For each task (issue):

### 1.1 Session start

Pull latest main, create feature branch:

```bash
git checkout main && git pull --rebase origin main
git checkout -b phase/{SLUG}/issue-{NUMBER}-{slugified-title}
```

Log: `[HH:MM:SS]   ▸ Task #{NUMBER}: {title}`

### 1.2 Implement

Spawn a subagent (Agent tool, foreground) with this prompt:

```
You are implementing GitHub issue #{NUMBER} for repo {ORG_REPO}.

Issue title: {title}
Issue body:
{body}

Branch: phase/{SLUG}/issue-{NUMBER}-{slugified-title}
Working directory: {repo root}

Instructions:
1. Read the issue carefully. Understand what needs to change.
2. Explore the codebase to understand relevant code.
3. Implement the changes described in the issue.
4. Run the project's test suite to verify.
5. Stage and commit with: feat|fix|chore(scope): description (#{NUMBER})
6. Do NOT push — the orchestrator handles that.

If the issue references other issues or specs, read them for context.
If tests fail, fix them. If you can't resolve after 2 attempts, commit what you have and note the failure.
```

When the subagent completes, verify:
- Files changed? (`git diff --stat HEAD`)
- Uncommitted changes? (`git status --porcelain` → commit them)
- No changes at all? → log failure, skip to next task

### 1.3 Push & create PR

```bash
unset GH_TOKEN   # user's PAT for PR creation
git push -u origin $(git branch --show-current)
```

Generate PR body, write to temp file (never interpolate LLM output in shell):

```bash
BODY_FILE=$(mktemp) && chmod 600 "$BODY_FILE"
cat > "$BODY_FILE" << 'PREOF'
## Summary
Implements #{NUMBER}: {title}

## Changes
{from git diff --stat}

Closes #{NUMBER}

🤖 Auto-generated by stark-phase-execute
PREOF

PR_URL=$(gh pr create \
  --title "feat: {title} (#{NUMBER})" \
  --body "$(cat $BODY_FILE)" \
  --base main \
  --head $(git branch --show-current))
PR_NUM=$(echo $PR_URL | grep -o '[0-9]*$')
rm -f "$BODY_FILE"
```

**No draft PRs.** No user confirmation before creation.

### 1.4 Multi-agent review (up to N rounds)

Create an isolated worktree for review, matching stark-review's approach:

```bash
git fetch origin refs/pull/${PR_NUM}/head
git worktree add /tmp/review-${REPO}-pr${PR_NUM} -b review/pr-${PR_NUM} FETCH_HEAD
cd /tmp/review-${REPO}-pr${PR_NUM}
git fetch origin main
merge_base=$(git merge-base origin/main HEAD)
```

**The round loop is managed by this skill, not by multi_review.py.** `multi_review.py` does not have a `--rounds` flag — it runs one round of 18 sub-agents and returns JSON.

For round = 1 to MAX_ROUNDS:

1. **Dispatch review** — run one round of all sub-agents:
   ```bash
   $PYTHON $SCRIPTS/multi_review.py --pr $PR_NUM --base $merge_base --json-only --dry-run
   ```
   The `--dry-run` flag prevents multi_review.py from posting to GitHub (this skill posts manually). `--json-only` returns structured findings.

2. **Classify** each finding by reading the referenced `file:line` in the worktree:
   - `fix` — severity >= medium AND issue exists in code
   - `false_positive` — described problem doesn't exist
   - `noise` — subjective/style, or single-agent contradicted by other 2
   - `ignored` — below fix threshold (low severity)

3. **Stop check** (before fixing):
   - Zero `fix` findings → **stop** (clean)
   - All findings are FP/noise/ignored → **stop** (nothing fixable)
   - Otherwise → fix and continue

4. **Fix** all `fix` findings in the worktree. Spawn a subagent if needed for complex fixes.

5. **Test** — run `test_command` from config in the worktree. Fix regressions.

6. **Commit + push** from the worktree:
   ```bash
   git add <changed files>
   git commit -m "fix: address review findings (round {N}) (#{NUMBER})"
   git push origin review/pr-${PR_NUM}:$(original branch name)
   ```

7. If round >= MAX_ROUNDS → **stop** (max reached)

After the loop, **post the review summary** to the PR via stark-claude[bot]:

```bash
export GH_TOKEN=$($PYTHON $SCRIPTS/github_app.py --app stark-claude token)
```

Use `pr_review()` from `github_app.py` or `stark_claude.py` to post the consolidated findings as a PR comment. Then unset GH_TOKEN.

**Clean up worktree:**

```bash
cd {original working dir}
git worktree remove /tmp/review-${REPO}-pr${PR_NUM}
git branch -D review/pr-${PR_NUM}
```

### 1.5 Merge

Before merging, verify CI status:

```bash
unset GH_TOKEN   # user's PAT for merge
gh pr checks $PR_NUM --watch --fail-level all 2>/dev/null || true
```

If CI passes or no required checks exist:
```bash
gh pr merge $PR_NUM --squash --admin --delete-branch
```

If CI fails: log the failing checks, merge anyway with `--admin` (autonomous mode), but flag it in the observability log as `ci_bypassed: true`.

```bash
git checkout main && git pull --rebase origin main
```

**No waiting for approval.** Merge immediately after review completes.

### 1.6 Close issue

The PR body contains `Closes #{NUMBER}`, so GitHub auto-closes on merge. Verify closure:

```bash
unset GH_TOKEN
gh api "/repos/${ORG_REPO}/issues/${NUMBER}" --jq .state
```

If still open (e.g., the `Closes` keyword didn't trigger), close explicitly:
```bash
gh issue close $NUMBER --comment "Implemented and merged via PR #${PR_NUM}. Closed by stark-phase-execute."
```

### 1.7 Log task result

Append to the observability JSON:

```json
{
  "issue_number": 42,
  "title": "Add retry logic to API client",
  "branch": "phase/observability-v2/issue-42-add-retry-logic",
  "pr_number": 57,
  "status": "merged",
  "ci_bypassed": false,
  "started_at": "ISO8601",
  "finished_at": "ISO8601",
  "duration_seconds": 342,
  "review_rounds": 2,
  "findings": {
    "total": 8,
    "by_severity": {"critical": 0, "high": 2, "medium": 4, "low": 2},
    "fixed": 6,
    "noise": 2,
    "by_agent": {"claude": 3, "codex": 3, "gemini": 2}
  },
  "error": null
}
```

Print: `[HH:MM:SS]   ✓ Task #{NUMBER} merged (PR #{PR_NUM}, {rounds} rounds, {duration})`

### 1.8 Error handling

If any step fails for a task:

1. Log the error with full context
2. Set task status to `failed` with error message
3. Cleanup: switch back to main, remove any lingering worktree
4. Clean up remote branch if PR was created but not merged:
   ```bash
   git push origin --delete phase/{SLUG}/issue-{NUMBER}-{slugified-title} 2>/dev/null || true
   ```
5. Print: `[HH:MM:SS]   ✗ Task #{NUMBER} failed: {error}`
6. **Continue to next task** — never block the phase

---

## Phase 2: Regression Testing

After all tasks complete (or fail):

```bash
git checkout main && git pull --rebase origin main
```

Detect test command from config hierarchy (`.code-review/config.json` → `~/.claude/code-review/config.json`). Fallback: detect from `package.json` (npm test), `pyproject.toml` (pytest), `Makefile`, etc.

Run the full suite. Log:

```json
{
  "test_command": "pytest",
  "exit_code": 0,
  "duration_seconds": 87,
  "passed": 142,
  "failed": 0,
  "skipped": 3
}
```

If tests fail, log failures but continue — the dashboard will surface them.

---

## Phase 3: Release & Deploy

Skip if `--skip-release`.

### 3.1 Update CHANGELOG

Before bumping the version, ensure CHANGELOG has content. For each merged task in this phase, add an entry under `## [Unreleased]` in CHANGELOG.md:

- `type:feature` tasks → `### Added` section
- `type:fix` tasks → `### Fixed` section
- `type:task` tasks → `### Changed` section

Entry format: `- {task title} (#{issue_number})`

If CHANGELOG.md doesn't exist, create one with standard Keep a Changelog format.

### 3.2 Version bump

Determine bump from task labels:
- Any `type:feature` → minor
- Only `type:fix` or `type:chore` → patch
- Any `type:breaking` → major

**Implement the release inline** (don't delegate to `/stark-release` which has user-confirmation gates):

1. Get current version from git tags: `git tag --sort=-v:refname | head -1`
2. If no tags → baseline `0.1.0`
3. Calculate next version based on bump type
4. Detect version file: look for `__version__` in Python files, `version` in `package.json`, or similar. Update it.
5. Move CHANGELOG `[Unreleased]` content to versioned section `[v{NEXT}] - {YYYY-MM-DD}`
6. Commit:
   ```bash
   git add CHANGELOG.md {version_file}
   git commit -m "release: v${NEXT_VERSION}"
   ```
7. Tag: `git tag -a v${NEXT_VERSION} -m "Release v${NEXT_VERSION}"`
8. Push:
   ```bash
   unset GH_TOKEN   # user's PAT
   git push origin main
   git push origin v${NEXT_VERSION}
   ```
9. Create GitHub Release:
   ```bash
   gh release create v${NEXT_VERSION} --title "v${NEXT_VERSION}" --notes "{CHANGELOG content}"
   ```

**No asking for bump confirmation or release confirmation.** Auto-determine and execute.

### 3.3 Deploy

Skip if `--skip-deploy`.

Read `deploy_command` from config. If not configured, skip and note in log.

```bash
${DEPLOY_COMMAND}
```

---

## Phase 4: Dashboard

Present a comprehensive summary after everything completes.

### Task Summary Table

```
┌─────┬────────┬──────────────────────────────────┬────────┬─────────┬──────────┬───────┬────────┐
│  #  │ Issue  │ Title                            │ PR     │ Status  │ Duration │ Finds │ Fixed  │
├─────┼────────┼──────────────────────────────────┼────────┼─────────┼──────────┼───────┼────────┤
│  1  │ #42    │ Add retry logic to API client     │ #57    │ merged  │ 5m 42s   │ 8     │ 6/8    │
│  2  │ #43    │ Instrument request tracing        │ #58    │ merged  │ 8m 15s   │ 12    │ 10/12  │
│  3  │ #44    │ Add health check endpoint         │ #59    │ failed  │ 3m 20s   │ —     │ —      │
└─────┴────────┴──────────────────────────────────┴────────┴─────────┴──────────┴───────┴────────┘
```

### Aggregate Stats

```
Phase: {SLUG}
Duration: {total}
Tasks: {completed}/{total} ({failed} failed, {skipped} skipped)
PRs merged: {N}
Review findings: {total} ({critical} crit, {high} high, {medium} med, {low} low)
Fix rate: {fixed}/{actionable} ({pct}%)
Noise rate: {noise}/{total} ({pct}%)
Regression: {passed}/{total} tests passing
Release: v{version} ({bump_level})
Deploy: {status}
```

### Agent Scorecard

```
┌─────────┬──────────┬───────┬───────┬─────────┬───────────┐
│ Agent   │ Findings │ Fixed │ Noise │ Unique  │ Accuracy  │
├─────────┼──────────┼───────┼───────┼─────────┼───────────┤
│ Claude  │ 15       │ 12    │ 3     │ 5       │ 80%       │
│ Codex   │ 12       │ 10    │ 2     │ 3       │ 83%       │
│ Gemini  │ 11       │ 9     │ 2     │ 4       │ 82%       │
└─────────┴──────────┴───────┴───────┴─────────┴───────────┘
```

### Failed Tasks

For each failed task: error message, which step failed, suggested recovery action.

---

## Phase 5: Housekeeping

### 5.1 Update memory

Save a project memory summarizing the phase execution — what was accomplished, surprises, decisions made. Only non-obvious information useful in future conversations.

### 5.2 Update docs

If the project has docs (`docs/`, `mkdocs.yml`):
- Update architecture docs affected by the phase changes

### 5.3 Prompt improvement detection

Read review history from this phase's PRs. Check for patterns:

| Signal | Threshold | Action |
|--------|-----------|--------|
| False positive rate for any agent | > 20% | Flag: tune `global/prompts/{agent}/{domain}.md` |
| Same finding type across multiple tasks | 3+ occurrences | Flag: prompt may need clarification |
| Agent consistently missing issues others find | 2+ misses | Flag: prompt weak in that domain |
| Unparseable output from an agent | any | Flag: fix `global/prompts/{agent}/agent.md` |

Log recommendations to the observability file. Suggest running `/stark-review-improvement` if any threshold exceeded.

---

## Observability

Follow the [Skill Observability Protocol](~/.claude/code-review/standards/observability.md).

### Task-based progress

```
TaskCreate: "Phase 0: Initialize"
            activeForm: "Initializing phase execution"
TaskCreate: "Phase 1: Task Loop ({N} tasks)"
            activeForm: "Executing task loop"
TaskCreate: "Phase 2: Regression Testing"
            activeForm: "Running regression tests"
TaskCreate: "Phase 3: Release & Deploy"
            activeForm: "Releasing and deploying"
TaskCreate: "Phase 4: Dashboard"
            activeForm: "Generating dashboard"
TaskCreate: "Phase 5: Housekeeping"
            activeForm: "Updating memory and docs"
```

Create child tasks dynamically per issue as each begins. Only one task `in_progress` at a time.

### Timestamped logs

```
[09:15:00] === stark-phase-execute: observability-v2 ===
[09:15:02]   Phase 0: Initialize (5 tasks, repo: GetEvinced/infra-pulse)
[09:15:05]   ▸ Task #42: Add retry logic to API client
[09:15:05]     Branch: phase/observability-v2/issue-42-add-retry-logic
[09:17:30]     Implementation complete (2m 25s)
[09:17:35]     PR #57 created
[09:17:40]     Worktree: /tmp/review-infra-pulse-pr57
[09:18:00]     Review round 1: 8 findings (2 high, 4 medium, 2 low)
[09:19:15]     Review round 2: 2 findings (2 low — noise)
[09:19:18]     Worktree cleaned up
[09:19:20]     ✓ Merged PR #57 (4m 15s)
[09:19:22]   ▸ Task #43: Instrument request tracing
...
[09:45:00]   Phase 2: Regression — 142/142 tests passing
[09:45:10]   Phase 3: CHANGELOG updated (3 added, 1 fixed)
[09:45:30]   Phase 3: Release v1.4.0 (minor)
[09:46:00] === Phase complete: 4/5 tasks merged, 1 failed ===
```

### 5-minute checkpoints

At each phase transition where wall time > 5 minutes since T0, print:

```
[09:20:00] ⏱ Checkpoint: 5m elapsed, task 2/5 in progress (review round 1)
```

### Metrics block

Printed as part of the dashboard (Phase 4). Includes per-phase timing breakdown, agent stats, and improvement flags per the observability protocol.

### Improvement flags

- Any single phase > 70% of total time → flag as bottleneck
- Task failure rate > 30% → flag with breakdown
- Agent failure rate > 20% → flag with agent breakdown
- A review round produced 0 new actionable findings → suggest reducing rounds
- CI bypassed on any merge → flag with details

---

## Dry Run Mode

When `--dry-run` is set:

1. Fetch and display all tasks (same as normal), including filtering out tracking issues
2. For each task: print branch name, issue title, labels, estimated steps
3. Verify `multi_review.py` is accessible: `$PYTHON $SCRIPTS/multi_review.py --help >/dev/null 2>&1`
4. Show the planned review configuration (rounds, agents)
5. Show what release/deploy would do (detected bump type, current version → next)
6. **Do NOT create branches, PRs, or make any changes**

---

## Mistakes to Avoid

- **Don't use `git add -A`** — always add specific files by name
- **Don't forget auth split** — unset GH_TOKEN for PR/issue/merge ops, export bot token only for review comments
- **Don't block on failures** — log and continue to next task
- **Don't create draft PRs** — PRs are not draft by default
- **Don't interpolate LLM output in shell** — always use temp files for PR/issue bodies
- **Don't skip regression tests** — even if all tasks merged cleanly, regressions can emerge from interactions
- **Don't amend commits** — always create new commits
- **Don't push to main directly** — everything goes through PR
- **Don't wait for user approval** — this skill is fully autonomous
- **Don't ask questions** — make the best autonomous decision and log the reasoning
- **Don't pass `--rounds` to multi_review.py** — it doesn't accept that flag; manage the round loop in this skill
- **Don't skip worktree isolation** — always create a worktree for review, clean up after
- **Don't skip CHANGELOG entries** — the release step depends on them
- **Don't try to implement phase tracking issues** — filter them out in 0.2

## Failure Modes

| Failure | Recovery |
|---------|----------|
| Not on main at start | `git checkout main && git pull` |
| Dirty working tree | Stash automatically, log warning |
| Task implementation produces no changes | Log as skipped, continue |
| PR creation fails | Retry once after push; if still fails, log and continue |
| multi_review.py dispatch fails | Log agent failures, proceed with available findings |
| Worktree already exists (crashed session) | Reuse existing: `cd /tmp/review-*` |
| Merge conflict | Rebase on main, resolve, re-push, retry merge |
| Merge fails (checks, permissions) | Force with `--admin`; if still fails, log and continue |
| Test suite fails | Log failures, continue to next phase |
| Release fails (no CHANGELOG, tag exists) | Log and skip deploy |
| GitHub API rate limit | Wait 60s, retry once; if still limited, log and continue |
| Subagent timeout | Log timeout, skip task, continue |
| Stale remote branch from failed task | Clean up in error handler (1.8) |
