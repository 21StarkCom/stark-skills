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

Detect repo (or use `--repo` override): parse `org/repo` from `git remote get-url origin`.

---

## Phase 1: Issue Cleanup

### 1.1 Fetch all open issues

```bash
unset GH_TOKEN
gh api "/repos/${ORG_REPO}/issues?state=open&per_page=100&sort=created&direction=asc" \
  --paginate --jq '.[] | {number, title, body, labels: [.labels[].name], updated_at, pull_request}'
```

Filter out pull requests (GitHub returns PRs in the issues endpoint). Store as `OPEN_ISSUES`.

### 1.2 Close phase-tracking parents with all children done

Phase-tracking issues have a body starting with `- [ ] #NNN` or `- [x] #NNN`. For each: extract all referenced issue numbers, check each via `gh api`. If ALL are closed → mark for closing with comment: `Closed by /stark-housekeeping — all child tasks are complete.`

### 1.3 Close issues referenced by merged PRs

Fetch merged PRs: `gh api "/repos/${ORG_REPO}/pulls?state=closed&per_page=100" --jq '.[] | select(.merged_at != null) | {number, body, merged_at}'`. Extract issue refs (`Closes #N`, `Fixes #N`, `Resolves #N` — case-insensitive). Cross-reference against `OPEN_ISSUES`. Close any that weren't auto-closed with comment: `Closed by /stark-housekeeping — referenced by merged PR #{PR_NUM}.`

### 1.4 Close plan parents where all siblings are done

For each unique `plan:*` label on open issues: fetch ALL issues with that label (open + closed). If all are closed except the current phase-tracking issue → mark for closing with comment: `Closed by /stark-housekeeping — all issues in plan:{SLUG} are complete.`

### 1.5 Detect duplicates

Group open issues by normalized title (lowercase, strip leading `Phase N —`, strip trailing issue numbers). Flag pairs with the same normalized title. **Report only** — don't close.

### 1.6 Aggressive mode (--aggressive only)

Find issues with no activity in the last 30 days: `gh api "/repos/${ORG_REPO}/issues?state=open&sort=updated&direction=asc&per_page=100" --jq '.[] | select(.updated_at < "<30-days-ago>")'`. Mark for closing with comment: `Closed by /stark-housekeeping (aggressive mode) — no activity for 30+ days. Reopen if still relevant.`

### 1.7 Present and execute

Print full list of what will be closed and potential duplicates. If `--dry-run` → stop here. Otherwise close each with its explanatory comment using user's PAT (`unset GH_TOKEN`).

---

## Phase 2: Branch Cleanup

### 2.1 Prune remote tracking refs

`git fetch --prune`

### 2.2 Delete local branches tracking merged remotes

`git branch -vv | grep ': gone]'` — mark branches where the remote is gone. Exclude current branch and `main`/`master`.

### 2.3 Delete remote branches from merged PRs

Get merged PR head refs: `gh api "/repos/${ORG_REPO}/pulls?state=closed&per_page=100" --jq '.[] | select(.merged_at != null) | .head.ref'`. Cross-reference against `git branch -r | sed 's|origin/||'`. Branches from merged PRs still on remote → mark for deletion. Exclude `main`, `master`, `develop`.

### 2.4 Clean worktree remnants

`git worktree list --porcelain` — identify stale entries:
- `/tmp/review-${REPO}-*` — review worktrees from crashed sessions
- `.worktrees/` in repo root — agent worktrees from autopilot/tournament

`git worktree prune`. Also check for leftover directories in `/tmp/review-${REPO}-*` and `.worktrees/`. For `.worktrees/` entries: if tracked branch is gone and no uncommitted changes → mark for cleanup.

### 2.5 Dangling skill symlinks

`find ~/.claude/skills/ -type l ! -exec test -e {} \; -print 2>/dev/null` — broken symlinks from deleted/renamed skill directories. Mark for removal.

### 2.6 Present and execute

Print branch cleanup summary (local, remote, worktrees, symlinks). If `--dry-run` → stop here. Otherwise:

```bash
git branch -d <branch>            # local (safe delete only)
git push origin --delete <branch> # remote
git worktree remove <path> --force
rm -rf /tmp/review-${REPO}-*
```

Use `-d` (not `-D`) for local branches. If git refuses, the branch isn't fully merged — flag instead of force-delete.

---

## Phase 3: Label Hygiene

### 3.1 Orphaned plan labels

For each `plan:*` label, query open issue count: `gh api "/repos/${ORG_REPO}/issues?labels=plan:{SLUG}&state=open&per_page=1" --jq 'length'`. If zero → report. **Report only** — don't delete labels.

### 3.2 Duplicate / inconsistent labels

Fetch all labels: `gh api "/repos/${ORG_REPO}/labels?per_page=100" --paginate --jq '.[].name'`. Flag near-duplicates within the same prefix group (e.g., `risk:med` vs `risk:medium`). **Report only** — don't rename or delete.

### 3.3 Unused default labels

Check GitHub default labels (`bug`, `documentation`, `duplicate`, `enhancement`, `good first issue`, `help wanted`, `invalid`, `question`, `wontfix`) for zero usage. **Report only** — don't delete.

### 3.4 Missing expected labels

Check open issues with `plan:` labels for missing `sp:*` and `risk:*`. **Report only** — don't add labels.

---

## Phase 4: State Report

### 4.1 Unreleased commits

`LAST_TAG=$(git describe --tags --abbrev=0 2>/dev/null)` then `git rev-list ${LAST_TAG}..HEAD --count`. If > 50, suggest `/stark-release`.

### 4.2 Summary

```
/stark-housekeeping — {ORG_REPO}
{'DRY RUN — no changes made' if --dry-run}

Issues closed: {N}  (Phase parents: {n}, PR-referenced: {n}, Plan parents: {n}, Aggressive: {n})
Branches deleted: {N}  (Local: {n}, Remote: {n})
Worktrees cleaned: {N}
Dangling symlinks removed: {N}
Session files removed: {N}
Checkpoint files removed: {N}
Stale locks removed: {N}
Logs rotated: {N}
Validation logs removed: {N}
Artifacts archived: {N} files into {M} archives

Remaining open issues: {N}  {for each: #{number} — {title} ({labels})}
Orphaned plan labels: {N}  {for each: plan:{slug} ({n} closed issues)}
Potential duplicates: {N}  {for each: #{A} and #{B}: "{title}"}
Duplicate labels: {N} pairs
Stale PRs (open > 7 days): {N}
Unreleased commits: {N} since {last_tag}
```

---

## Phase 5: Infrastructure Cleanup

### 5.1 Session file cleanup

Find and remove `~/.claude/code-review/sessions/*.json` files older than 30 days. Present list. If `--dry-run` → stop here. Otherwise delete.

### 5.2 Checkpoint cleanup

Find and remove `~/.claude/code-review/sessions/**/checkpoint-*.md` files older than 7 days. Present list. If `--dry-run` → stop here. Otherwise delete.

### 5.3 Stale lock cleanup

Use `lock_helpers.is_lock_stale()` to identify stale `.lock` files in `~/.claude/code-review/` and `/tmp/`:
```bash
$PYTHON -c "
import sys, pathlib; sys.path.insert(0, '$SCRIPTS')
import lock_helpers
for d in [pathlib.Path.home()/'.claude/code-review', pathlib.Path('/tmp')]:
    for f in (d.glob('*.lock') if d.exists() else []):
        if lock_helpers.is_lock_stale(str(f)): print(f)
" 2>/dev/null
```
Present list. If `--dry-run` → stop. Otherwise delete.

### 5.4 Log rotation

Keep the last 1000 lines of each log file if it exceeds that length:
- `~/.claude/code-review/healer.jsonl`
- `~/.claude/code-review/preflight.jsonl`
- `~/.claude/code-review/approach-contracts.jsonl`

For each: `tail -1000 "$LOG" > "${LOG}.tmp" && mv "${LOG}.tmp" "$LOG"`. If `--dry-run`, report files with > 1000 lines without modifying.

### 5.5 Validation log cleanup

Find and remove `~/.claude/code-review/logs/*.stderr` files older than 14 days. Present list. If `--dry-run` → stop. Otherwise delete.

### 5.6 Artifact archival

Archive files older than 30 days from `automation/logs/` and `~/.claude/code-review/history/autopilot/` into `~/.claude/code-review/archives/{source-slug}-{YYYY-MM}.tar.gz` (one per source per month). Group by month of last modification. Use `tar -rf` to append to existing archives.

```bash
ARCHIVE_DIR=~/.claude/code-review/archives && mkdir -p "$ARCHIVE_DIR"
# For each source and month group:
tar -czf "$ARCHIVE_DIR/{slug}-{YYYY-MM}.tar.gz" -C <parent> <files...>
tar -tzf "$ARCHIVE_DIR/{slug}-{YYYY-MM}.tar.gz" > /dev/null  # verify
rm <files...>  # only after successful verification
```

If archive creation or verification fails, leave originals and report the error.

---

## Observability

Standard observability: create task, emit timestamped progress logs, record metrics block (issues closed by category, branches deleted, worktrees cleaned, per-phase timing), emit completion event via `emit_queue.py`:

```bash
$SCRIPTS/stark-emit skill_invocation \
  skill=stark-housekeeping duration_s=$TOTAL_SECONDS success=true \
  issues_closed=$CLOSED branches_deleted=$BRANCHES worktrees_cleaned=$WORKTREES \
  session_files_removed=$SESSION_FILES checkpoint_files_removed=$CHECKPOINT_FILES \
  stale_locks_removed=$STALE_LOCKS logs_rotated=$LOGS_ROTATED \
  validation_logs_removed=$VALIDATION_LOGS \
  artifacts_archived_files=$ARCHIVED_FILES artifacts_archived_count=$ARCHIVED_COUNT \
  dry_run=$DRY_RUN aggressive=$AGGRESSIVE
```

See [../../standards/observability.md](../../standards/observability.md) for the full protocol.

## Failure Modes

See [references/failure-modes.md](references/failure-modes.md) for the full recovery table.
