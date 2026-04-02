---
name: stark-housekeeping
description: >-
  Audit and clean up stale issues, dead branches, and worktree remnants. Use for cleanup, housekeeping, close stale issues.
argument-hint: "[--dry-run] [--repo ORG/REPO] [--aggressive]"
disable-model-invocation: true
model: sonnet
---

# stark-housekeeping

Audits and cleans up project state: closes stale issues, deletes merged branches, removes worktree remnants, and reports remaining open work. Everything is presented before acting — no silent deletions.

## Arguments

| Arg | Default | Description |
|-----|---------|-------------|
| `--dry-run` | off | Show what would be cleaned, don't execute |
| `--repo ORG/REPO` | auto-detect | Override repo detection from git remote |
| `--aggressive` | off | Also close issues with no activity in 30+ days |

**Raw input:** `$ARGUMENTS`

## Constants

```
SCRIPTS = ~/.claude/code-review/scripts
PYTHON  = $SCRIPTS/.venv/bin/python3
```

Detect repo (or use `--repo` override):

```bash
REMOTE=$(git remote get-url origin)
ORG_REPO=<parse org/repo from REMOTE>
ORG=$(echo $ORG_REPO | cut -d/ -f1)
REPO=$(echo $ORG_REPO | cut -d/ -f2)
```

---

## Phase 1: Issue Cleanup

### 1.1 Fetch all open issues

```bash
unset GH_TOKEN   # user's PAT for issue reads
gh api "/repos/${ORG_REPO}/issues?state=open&per_page=100&sort=created&direction=asc" \
  --paginate --jq '.[] | {number, title, body, labels: [.labels[].name], updated_at, pull_request}'
```

Filter out pull requests (GitHub API returns PRs in the issues endpoint). Store as `OPEN_ISSUES`.

### 1.2 Close phase-tracking parents with all children done

Phase-tracking issues are created by `/stark-plan-to-tasks`. They have a body starting with a task checklist (`- [ ] #NNN` or `- [x] #NNN`).

For each open issue whose body matches `^- \[[ x]\] #\d+`:

1. Extract all referenced issue numbers from the checklist
2. Check each referenced issue's state via `gh api`
3. If ALL referenced issues are closed → mark this issue for closing

Close with comment:
```
Closed by /stark-housekeeping — all child tasks are complete.
```

### 1.3 Close issues referenced by merged PRs

```bash
gh api "/repos/${ORG_REPO}/pulls?state=closed&per_page=100&sort=updated&direction=desc" \
  --paginate --jq '.[] | select(.merged_at != null) | {number, body, merged_at}'
```

For each merged PR, extract issue references from the body (`Closes #N`, `Fixes #N`, `Resolves #N` — case-insensitive). Cross-reference against `OPEN_ISSUES`. If an open issue is referenced by a merged PR but wasn't auto-closed (GitHub linking sometimes fails), mark it for closing.

Close with comment:
```
Closed by /stark-housekeeping — referenced by merged PR #{PR_NUM}.
```

### 1.4 Close plan parents where all siblings are done

Issues with `plan:` labels belong to a plan. For each unique `plan:*` label found on open issues:

1. Fetch ALL issues with that label (open + closed): `gh api "/repos/${ORG_REPO}/issues?labels=plan:{SLUG}&state=all&per_page=100"`
2. If all issues with this label are closed EXCEPT the current one, and the current issue is a phase-tracking issue (body starts with checklist) → mark for closing

Close with comment:
```
Closed by /stark-housekeeping — all issues in plan:{SLUG} are complete.
```

### 1.5 Detect duplicates

Group open issues by normalized title (lowercase, strip leading `Phase N —`, strip trailing issue numbers). If two or more issues share the same normalized title, flag them as potential duplicates.

**Report only** — don't close. Present as:
```
Potential duplicates:
  #{A} and #{B}: "{normalized title}"
```

### 1.6 Aggressive mode (--aggressive only)

If `--aggressive` is set, also find issues with no activity (no comments, no label changes, no referenced events) in the last 30 days.

```bash
gh api "/repos/${ORG_REPO}/issues?state=open&sort=updated&direction=asc&per_page=100" \
  --jq '.[] | select(.updated_at < "'$(date -v-30d +%Y-%m-%dT%H:%M:%SZ)'")'
```

Mark for closing with comment:
```
Closed by /stark-housekeeping (aggressive mode) — no activity for 30+ days. Reopen if still relevant.
```

### 1.7 Present and execute

Before closing anything, present the full list:

```
Issue cleanup (will close):
  #{N} — {title} (reason: all children done)
  #{N} — {title} (reason: referenced by merged PR #{M})
  #{N} — {title} (reason: all plan siblings done)
  #{N} — {title} (reason: no activity 30+ days) [aggressive]

Potential duplicates (report only):
  #{A} and #{B}: "{title}"
```

If `--dry-run`: stop here, don't close.

Otherwise, close each issue with its explanatory comment. Use user's PAT (`unset GH_TOKEN`).

---

## Phase 2: Branch Cleanup

### 2.1 Prune remote tracking refs

```bash
git fetch --prune
```

### 2.2 Delete local branches tracking merged remotes

```bash
git branch -vv | grep ': gone]'
```

For each branch where the remote tracking branch is gone (merged and deleted on remote), mark for deletion. Exclude the current branch and `main`/`master`.

### 2.3 Delete remote branches from merged PRs

```bash
gh api "/repos/${ORG_REPO}/pulls?state=closed&per_page=100&sort=updated&direction=desc" \
  --jq '.[] | select(.merged_at != null) | .head.ref'
```

Cross-reference against remote branches:

```bash
git branch -r --list 'origin/*' | sed 's|origin/||'
```

Branches that belong to merged PRs but still exist on the remote → mark for deletion. Exclude `main`, `master`, `develop`.

### 2.4 Clean worktree remnants

```bash
git worktree list --porcelain
```

Identify stale worktrees from multiple sources:
- `/tmp/review-${REPO}-*` — review worktrees from crashed sessions
- `.worktrees/` in the repo root — agent worktrees from autopilot/tournament runs
- Any worktree whose tracked branch has been deleted or whose directory no longer exists on disk

```bash
git worktree prune
```

Also check for leftover directories:

```bash
ls -d /tmp/review-${REPO}-* 2>/dev/null
ls -d .worktrees/* 2>/dev/null
```

For `.worktrees/` entries: check if the branch they track still exists. If the remote branch is gone and the worktree has no uncommitted changes, mark for cleanup.

### 2.5 Dangling skill symlinks

Check for broken symlinks in `~/.claude/skills/`:

```bash
find ~/.claude/skills/ -type l ! -exec test -e {} \; -print 2>/dev/null
```

These occur when a skill directory is deleted or renamed but the symlink wasn't cleaned up. Mark for removal.

### 2.6 Present and execute

```
Branch cleanup:
  Local (merged, remote gone):
    feature/old-thing
    phase/plan-slug/issue-42-title
  Remote (merged PR, not auto-deleted):
    origin/feature/old-thing
  Worktrees (stale):
    /tmp/review-repo-pr42 (branch deleted)
    .worktrees/autopilot-gemini-step3 (orphaned)
  Dangling symlinks:
    ~/.claude/skills/stark-old-name/SKILL.md → (deleted)
```

If `--dry-run`: stop here.

Otherwise:

```bash
# Local branches
git branch -d <branch>   # safe delete (only if fully merged)

# Remote branches
git push origin --delete <branch>

# Worktrees
git worktree remove <path> --force
rm -rf /tmp/review-${REPO}-*   # leftover dirs
```

Use `-d` (not `-D`) for local branches — if git refuses, the branch isn't fully merged and should be flagged instead of force-deleted.

---

## Phase 3: Label Hygiene

### 3.1 Orphaned plan labels

For each `plan:*` label found on any issue (open or closed):

```bash
gh api "/repos/${ORG_REPO}/issues?labels=plan:{SLUG}&state=open&per_page=1" --jq 'length'
```

If zero open issues remain with this label, report it:

```
Orphaned plan labels (no open issues):
  plan:2026-03-22-github-projects-integration (8 closed issues)
  plan:2026-03-24-skill-docs-viz (6 closed issues)
```

**Report only** — don't delete labels.

### 3.2 Duplicate / inconsistent labels

Fetch all labels and check for near-duplicates — labels that differ only by abbreviation or suffix:

```bash
gh api "/repos/${ORG_REPO}/labels?per_page=100" --paginate --jq '.[].name'
```

Common patterns to flag:
- `risk:med` vs `risk:medium`, `confidence:med` vs `confidence:medium`
- Any pair where one label is a substring/abbreviation of the other within the same prefix group

```
Duplicate labels (consolidation needed):
  risk:med (3 issues) ↔ risk:medium (12 issues) — recommend keeping risk:medium
  confidence:med (2 issues) ↔ confidence:medium (8 issues) — recommend keeping confidence:medium
```

**Report only** — don't rename or delete labels.

### 3.3 Unused default labels

GitHub creates default labels on every new repo (`bug`, `documentation`, `duplicate`, `enhancement`, `good first issue`, `help wanted`, `invalid`, `question`, `wontfix`). Check if any have zero issues (open or closed). If the repo uses custom labels instead (e.g., `type:bug` instead of `bug`), report the unused defaults.

```
Unused default labels (0 issues):
  documentation, duplicate, good first issue, help wanted, invalid, question, wontfix
```

**Report only** — don't delete.

### 3.4 Missing expected labels

Check open issues for expected label patterns. Report issues missing:
- `sp:` (story points) — only for issues with a `plan:` label
- `risk:` — only for issues with a `plan:` label

```
Issues missing labels:
  #49 — missing: sp:*, risk:* (has label: enhancement)
```

**Report only** — don't add labels.

---

## Phase 4: State Report

### 4.1 Unreleased commits

Check how many commits have landed since the last tag:

```bash
LAST_TAG=$(git describe --tags --abbrev=0 2>/dev/null)
if [ -n "$LAST_TAG" ]; then
  UNRELEASED=$(git rev-list ${LAST_TAG}..HEAD --count)
fi
```

If >50 unreleased commits, suggest running `/stark-release`.

### 4.2 Summary

Present a summary of all actions taken and remaining state.

```
/stark-housekeeping — {ORG_REPO}
{'DRY RUN — no changes made' if --dry-run}

Issues closed: {N}
  Phase parents:     {n} (all children done)
  PR-referenced:     {n} (merged PR, not auto-closed)
  Plan parents:      {n} (all siblings done)
  Aggressive:        {n} (30+ days inactive)

Branches deleted: {N}
  Local:   {n}
  Remote:  {n}

Worktrees cleaned: {N}

Remaining open issues: {N}
  {for each: #{number} — {title} ({labels})}

Orphaned plan labels: {N}
  {for each: plan:{slug} ({n} closed issues)}

Stale PRs (open > 7 days): {N}
  {for each: #{number} — {title} (opened {date})}

Unreleased commits: {N} since {last_tag}
  {if N > 50: "Consider running /stark-release"}

Dangling symlinks removed: {N}

Potential duplicates: {N}
  {for each: #{A} and #{B}: "{title}"}

Duplicate labels: {N} pairs
  {for each: {label_a} ↔ {label_b}}

Unused default labels: {N}
```

---

## Observability

Follow the [Skill Observability Protocol](~/.claude/code-review/standards/observability.md) for all timing, checkpoints, and metrics reporting.

Additional skill-specific metrics:
- Issues: scanned, closed (by category), duplicates flagged
- Branches: local deleted, remote deleted, worktrees cleaned
- Labels: orphaned plan labels, issues with missing labels
- Duration: per-phase timing

### Event emission

After the state report, emit a completion event:

```bash
$SCRIPTS/stark-emit skill_invocation \
  skill=stark-housekeeping duration_s=$TOTAL_SECONDS success=true \
  issues_closed=$CLOSED branches_deleted=$BRANCHES worktrees_cleaned=$WORKTREES \
  dry_run=$DRY_RUN aggressive=$AGGRESSIVE
```

If stark-insights is not running, this fails silently.

---

## Failure Modes

See [references/failure-modes.md](references/failure-modes.md) for the full recovery table.

## Mistakes to Avoid

- **Don't close issues without presenting them first** — always show the list, then act
- **Don't force-delete branches** — use `git branch -d`, not `-D`; flag unmerged branches instead
- **Don't delete labels** — report orphaned labels, never delete them
- **Don't modify issue content** — only close and add a closing comment
- **Don't touch open PRs** — only report stale ones
- **Don't use GitHub App bots** — housekeeping uses user's PAT via `gh`
- **Don't use `git status -uall`** — can cause memory issues on large repos
- **Don't close issues silently** — every close gets an explanatory comment
- **Don't close the current branch** — exclude it from branch cleanup
