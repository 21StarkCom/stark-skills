---
name: stark-phase-execute
description: >-
  Autonomously execute a dev phase: implement tasks, PR, review, fix, merge, release. Use for execute phase, run plan.
argument-hint: "<plan-slug-or-path> [--dry-run] [--skip-deploy] [--skip-release] [--start-from <issue-number>] [--rounds <N>] [--repo ORG/REPO]"
disable-model-invocation: true
context: fork
model: opus
revision: 63a8c794adafa2df8a713b4dcf9743a09e3c7cfc
revision_date: 2026-05-18T19:17:41Z
---

## Preflight

Run environment validation before proceeding:
```bash
node --experimental-strip-types ~/.claude/code-review/tools/preflight.ts --workflow stark-phase-execute --json
```
Parse the JSON result:
- If `overall` is "blocked": print the failing checks and stop. Do not proceed.
- If `overall` is "degraded": print a warning with the failing checks, then continue.
- If `overall` is "ready": continue silently.
- In non-interactive automation contexts, a blocked preflight must emit a `preflight_check` event with `status=blocked`, append an entry to `~/.claude/code-review/alerts.jsonl`, and exit non-zero so the trigger is marked failed.

# stark-phase-execute

Autonomous execution engine for development phases. Takes a plan slug (or plan file path), fetches all associated GitHub issues, and executes each one through a complete development lifecycle: branch → implement → test → PR → multi-agent review → fix → merge → next. If no issues exist yet, automatically runs `/stark-plan-to-tasks` to decompose the plan first.

After all tasks: regression tests, version bump, deploy, dashboard, memory update, prompt improvement detection.

**This skill overrides all user-confirmation gates in sub-workflows.** No "wait for approval", no "proceed anyway?", no "are you sure?" — every decision is made autonomously.

## Prerequisites

- Claude Code running with `--dangerouslySkipPermissions` or equivalent tool allowlists
- `gh auth status` shows an active user PAT
- `claude`, `codex`, `gemini`, `gh` are all in PATH
- GitHub Apps (stark-claude, stark-codex, stark-gemini) installed on the target repo

## Arguments

| Arg | Default | Description |
|-----|---------|-------------|
| `<plan-slug>` | required | Plan slug matching `plan:{SLUG}` label on issues. Can also be a path to a plan file (auto-detected). If no issues exist, auto-runs `/stark-plan-to-tasks`. |
| `--dry-run` | off | Walk the plan, show what would happen, don't execute |
| `--skip-deploy` | off | Skip deployment after release |
| `--skip-release` | off | Skip version bump and release |
| `--start-from <N>` | 1st issue | Resume from a specific issue number |
| `--rounds <N>` | 3 | Max review-fix rounds per PR |
| `--repo ORG/REPO` | auto-detect | Override repo detection from git remote |

**Raw input:** `$ARGUMENTS`

## Constants

```bash
SCRIPTS="${STARK_REVIEW_SCRIPTS:-$HOME/.claude/code-review/scripts}"
TOOLS="${STARK_REVIEW_TOOLS:-$HOME/.claude/code-review/tools}"
PYTHON="$SCRIPTS/.venv/bin/python3"
[ -x "$PYTHON" ] || PYTHON=python3
HISTORY="$HOME/.claude/code-review/history"
```

Detect repo (or use `--repo` override): parse `org/repo` from `git remote get-url origin`.

Resolve plan slug from argument:
- If the argument is a file path (contains `/` or ends in `.md`): store as `PLAN_FILE`, extract slug from filename: strip directory and `.md` extension, strip trailing `-design`, `-spec`, or `-plan` suffix, keep date prefix. If slug exceeds 50 characters, truncate to 47 and append first 3 chars of MD5 hash. Example: `docs/superpowers/plans/2026-03-23-stark-signals.md` → `SLUG=2026-03-23-stark-signals`. **MUST match `/stark-plan-to-tasks`** slug algorithm.
- Otherwise: treat as slug directly.

---

## Phase 0: Initialize

Capture T0. Create the observability log.

### 0.1 Validate environment

Pull latest main, verify clean state, confirm toolchain:

```bash
git checkout main && git pull --rebase origin main
git status --porcelain          # must be empty
git branch --show-current       # must be main
which gh claude codex gemini    # all must exist
gh auth status                  # must show active account
node --experimental-strip-types "$TOOLS/github_app.ts" --app stark-claude token >/dev/null
```

If any check fails → stop and report.

### 0.2 Fetch plan tasks

**Project-based (preferred):** If `.github/project-config.json` exists, use bot token and `node --experimental-strip-types "$TOOLS/github_projects.ts" get-items --project "$PROJECT_ID" --filter "Status=Ready for Agent"`. Filter by AI Suitability via an additional `--filter "AI Suitability=Autonomous"` or post-process the JSON output with `jq` for the Autonomous/Assisted union. Unset GH_TOKEN after.

**Label-based (fallback):**
```bash
unset GH_TOKEN
gh api "/repos/${ORG_REPO}/issues?labels=plan:${SLUG}&state=open&sort=created&direction=asc&per_page=100" \
  --jq '.[] | {number, title, labels: [.labels[].name], body}'
```

**Filter out phase tracking issues** (body starts with `- [ ] #NNN` checklist, no `## What` section). Only keep issues whose body contains `## What`.

Store raw issue count as `raw_issue_count`. Apply `--start-from` filter.

If no tasks found:
- `raw_issue_count > 0` → all filtered out (tracking issues or `--start-from`). Stop: "All {N} issues filtered out."
- `raw_issue_count == 0` → auto-decompose (see 0.3).

### 0.3 Auto-decompose plan (if no tasks exist)

1. **Locate plan file:** Use `PLAN_FILE` if set from argument, otherwise search `docs/` recursively for `*${SLUG}*.md` (not `*.review.md`). If not found → stop.

**If `--dry-run`:** report the plan file path but do NOT invoke `stark-plan-to-tasks`. Stop.

2. **Run `/stark-plan-to-tasks`:**
```
Invoke Skill: stark-plan-to-tasks ${PLAN_FILE}
```
> **Warning:** If `--repo` targets a different repo than the current directory, abort — cross-repo auto-decomposition is not supported.

3. Re-fetch tasks using 0.2 logic. If still no tasks → stop.

### 0.3b Approach Contract

```bash
python3 ~/.claude/code-review/scripts/approach_contract.py --plan-file <plan_path> --force-confirm
```

### 0.4 Phase briefing

```
[HH:MM:SS] === stark-phase-execute: {SLUG} ===
Tasks:       {N} task issues (of {M} total with label)
Repo:        {ORG_REPO}
Max rounds:  {ROUNDS} per PR
Dry run:     {yes/no}

  1. #{number} — {title} (sp:{N}, risk:{level})
  ...
```

Create a parent task for the phase with child tasks for each issue.

### 0.5 Initialize observability log

Write to `{HISTORY}/{ORG}/{REPO}/phase-{SLUG}-{YYYYMMDD-HHMMSS}.json` with phase, repo, started_at, dry_run, max_rounds, tasks (empty), summary (null). Updated incrementally as tasks complete.

---

## Phase 1: Task Loop

Execute each task sequentially. Each merges to main before the next begins.

### 1.1 Session start

Pull latest main and create feature branch:

```bash
git checkout main && git pull --rebase origin main
git checkout -b phase/{SLUG}/issue-{NUMBER}-{slugified-title}
```

If project config is loaded: use bot token, validate spec completeness via `node --experimental-strip-types "$TOOLS/github_projects.ts" check-spec-completeness --fields "$ITEM_FIELDS_JSON"`. If gate fails, log and skip to next task. Claim the task by transitioning Status: `node --experimental-strip-types "$TOOLS/github_projects.ts" transition-status --project "$PROJECT_ID" --item "$ITEM_ID" --status "Agent Working"`, then `set-field --project "$PROJECT_ID" --item "$ITEM_ID" --name "Agent" --value "Claude"`. Unset GH_TOKEN.

Log: `[HH:MM:SS]   ▸ Task #{NUMBER}: {title}`

### 1.2 Implement

Spawn a subagent (Agent tool, foreground):

```
You are implementing GitHub issue #{NUMBER} for repo {ORG_REPO}.
Issue title: {title}
Issue body: {body}
Branch: phase/{SLUG}/issue-{NUMBER}-{slugified-title}
Working directory: {repo root}

Instructions:
1. Read the issue. Understand what needs to change.
2. Explore the codebase for relevant code.
3. Implement the changes.
4. Run the project's test suite.
5. Stage and commit with: feat|fix|chore(scope): description (#{NUMBER})
6. Do NOT push — the orchestrator handles that.

If tests fail, fix them. If you can't resolve after 2 attempts, commit what you have and note the failure.
```

Verify after completion: files changed (`git diff --stat HEAD`), no uncommitted changes (`git status --porcelain`). If no changes at all → log failure, skip to next task.

If subagent reports ambiguity and project config is loaded: use bot token, transition to 'Blocked', set blocked reason, post issue comment, skip to next task.

### 1.2b Validation chain

```bash
python3 $SCRIPTS/validation_gate.py --json --repo-root $(pwd)
```

- `overall=pass` → continue to 1.3.
- `overall=fail` → classify: `node --experimental-strip-types --no-warnings "$TOOLS/failure_classifier.ts" --stderr-file $STDERR_PATH --json`
  - If `pattern_id` non-null: attempt heal (max 2 attempts): `node --experimental-strip-types --no-warnings $HOME/.claude/code-review/tools/self_healer.ts --pattern-id $PATTERN_ID --stderr-file $STDERR_PATH --mode auto --json`. Re-run validation after each attempt.
  - After 2 failed heal attempts: escalate, set task status `blocked`, stop the phase.
  - If `pattern_id` null (UNCLASSIFIED): log and continue — agent code issue, not environment.

Log validation result in task observability: `{"validation": {"passed": true, "heal_attempts": 0, "pattern_id": null}}`

### 1.3 Push & create PR

```bash
unset GH_TOKEN
git push -u origin $(git branch --show-current)
```

Write PR body to a temp file (`mktemp`, `chmod 600`) — never interpolate LLM output in shell. Body includes: Summary implementing #{NUMBER}, Changes from `git diff --stat`, `Closes #{NUMBER}`, attribution line. Create PR with `gh pr create`, extract PR_NUM from URL. No draft PRs.

### 1.4 Multi-agent review (up to N rounds)

Create a review worktree:
```bash
git fetch origin refs/pull/${PR_NUM}/head
git worktree add /tmp/review-${REPO}-pr${PR_NUM} -b review/pr-${PR_NUM} FETCH_HEAD
```

**The round loop is managed by this skill, not by multi_review.py.** For round = 1 to MAX_ROUNDS:

1. Dispatch review: `$PYTHON $SCRIPTS/multi_review.py --pr $PR_NUM --base $merge_base --json-only --dry-run`
2. Classify each finding: `fix` (severity >= medium, issue exists), `false_positive`, `noise` (single-agent, style), `ignored` (low severity)
3. **Stop check:** zero `fix` findings or all FP/noise/ignored → stop (clean). Otherwise fix and continue.
4. Fix all `fix` findings. Spawn subagent for complex fixes.
5. Test — run `test_command` from config. Fix regressions.
6. Commit and push from worktree with message `fix: address review findings (round {N}) (#{NUMBER})`
7. If round >= MAX_ROUNDS → stop.

After loop, post review summary via stark-claude[bot]: `export GH_TOKEN=$(node --experimental-strip-types "$TOOLS/github_app.ts" --app stark-claude token)`, use `pr_review()`, then unset GH_TOKEN.

**Clean up worktree:** `git worktree remove /tmp/review-${REPO}-pr${PR_NUM} && git branch -D review/pr-${PR_NUM}`

### 1.5 Merge

> **Warning:** Do not update project Status here — the project-pr-sync GitHub Action handles transitions automatically.

```bash
unset GH_TOKEN
gh pr checks $PR_NUM --watch --fail-level all 2>/dev/null || true
gh pr merge $PR_NUM --squash --admin --delete-branch
git checkout main && git pull --rebase origin main && git fetch --prune
```

If CI fails: merge anyway with `--admin`, flag `ci_bypassed: true` in observability log.

### 1.6 Close issue

PR body contains `Closes #{NUMBER}` for auto-close. Verify closure:
```bash
unset GH_TOKEN
gh api "/repos/${ORG_REPO}/issues/${NUMBER}" --jq .state
```
If still open: `gh issue close $NUMBER --comment "Implemented and merged via PR #${PR_NUM}. Closed by stark-phase-execute."`

### 1.7 Log task result

Append to observability JSON:
```json
{
  "issue_number": 42, "title": "...", "branch": "...", "pr_number": 57,
  "status": "merged", "ci_bypassed": false,
  "started_at": "ISO8601", "finished_at": "ISO8601", "duration_seconds": 342,
  "review_rounds": 2,
  "findings": {"total": 8, "by_severity": {"critical":0,"high":2,"medium":4,"low":2},
    "fixed": 6, "noise": 2, "by_agent": {"claude":3,"codex":3,"gemini":2}},
  "error": null
}
```

Print: `[HH:MM:SS]   ✓ Task #{NUMBER} merged (PR #{PR_NUM}, {rounds} rounds, {duration})`

### 1.7b Session state update

After each merge, record completed task and check for checkpoint interval:
```bash
node --experimental-strip-types --no-warnings ~/.claude/code-review/tools/session_state.ts --json 2>/dev/null || true
node --experimental-strip-types --no-warnings ~/.claude/code-review/tools/context_compactor.ts --json 2>/dev/null || true
```
Both are best-effort — wrap in `|| true`. Never block task execution.

### 1.8 Error handling

If any step fails for a task: log error, set task `failed`, switch back to main, remove lingering worktree, delete remote branch (`git push origin --delete ... 2>/dev/null || true`). Print: `[HH:MM:SS]   ✗ Task #{NUMBER} failed: {error}`. **Continue to next task** — never block the phase.

---

## Phase 2: Regression Testing

```bash
git checkout main && git pull --rebase origin main && git fetch --prune
```

Detect test command from config hierarchy (fall back to auto-detect from `package.json`, `pyproject.toml`, `Makefile`). Run full suite. Log exit code, duration, pass/fail/skip counts. If tests fail, log and continue — dashboard surfaces them.

---

## Phase 3: Release & Deploy

Skip if `--skip-release`.

### 3.1 Update CHANGELOG

For each merged task, add an entry under `## [Unreleased]`: Feature → `### Added`, Bug → `### Fixed`, Task → `### Changed`. Format: `- {task title} (#{issue_number})`. Create `CHANGELOG.md` with Keep a Changelog format if missing.

### 3.2 Version bump & release

Determine bump: Feature → minor, Bug/Task only → patch, breaking change noted → major.

```
Invoke Skill: stark-release {bump_type}
```

### 3.3 Deploy

Skip if `--skip-deploy`. Read `deploy_command` from config. If not configured, skip. Run `${DEPLOY_COMMAND}`.

---

## Phase 4: Dashboard

Present a comprehensive summary after everything completes. See [references/dashboard-format.md](references/dashboard-format.md) for table formats (task summary, aggregate stats, agent scorecard, failed tasks).

After all tasks complete, suggest follow-up skills:
```bash
node --experimental-strip-types --no-warnings ~/.claude/code-review/tools/skill_router.ts --context implementation --json 2>/dev/null || true
```
Display at most 2 suggestions. Skip silently if command fails.

---

## Phase 5: Housekeeping

### 5.1 Update memory

Save a project memory summarizing the phase execution: what was accomplished, surprises, decisions made. Only non-obvious information useful in future conversations.

### 5.2 Update docs

If the project has docs (`docs/`, `mkdocs.yml`): update architecture docs affected by the phase changes.

### 5.3 Prompt improvement detection

Read review history from this phase's PRs. Check for patterns:

| Signal | Threshold | Action |
|--------|-----------|--------|
| False positive rate for any agent | > 20% | Flag: tune `global/prompts/{agent}/{domain}.md` |
| Same finding type across multiple tasks | 3+ occurrences | Flag: prompt may need clarification |
| Agent consistently missing issues others find | 2+ misses | Flag: prompt weak in that domain |
| Unparseable output from an agent | any | Flag: fix `global/prompts/{agent}/agent.md` |

Log recommendations to observability file. Suggest `/stark-review-improvement` if any threshold exceeded.

---

## Observability

Standard observability: create task, emit timestamped progress logs, record metrics block (phase, repo, task counts, duration, findings per task, agent scores, ci_bypassed, improvement flags), emit completion event via `$SCRIPTS/stark-emit`. See [references/observability.md](references/observability.md) for the full protocol.

---

## Dry Run Mode

When `--dry-run`: fetch and display all tasks, print branch/title/labels/steps for each, verify `multi_review.py --help`, show planned review config and release/deploy preview. Do NOT create branches, PRs, or make any changes.

---

## Failure Modes

See [references/failure-modes.md](references/failure-modes.md) for the full recovery table.
