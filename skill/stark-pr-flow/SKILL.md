---
name: stark-pr-flow
description: End-to-end PR workflow for GetEvinced repos — push, create PR, post self-review via stark-claude bot, present summary, and squash-merge with --admin on approval. Use when the user says "open PR", "create PR", "merge this", "ship it", or "stark-pr-flow".
argument-hint: <optional: PR title override or "draft" to create as draft>
---

# Evinced PR

End-to-end PR workflow for GetEvinced repos: push -> PR -> self-review -> merge.
Wraps the GitHub App auth flow so you never deal with tokens manually.

## Prerequisites

```bash
# Ensure gh CLI uses the user's personal PAT (not a bot token)
unset GH_TOKEN
REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner)

# Bot token — used ONLY for posting review comments (Step 4)
BOT_TOKEN=$(~/git/Evinced/scripts/.venv/bin/python3 ~/git/Evinced/scripts/github_app.py token)

# Must be on a feature branch, not main
BRANCH=$(git branch --show-current)
```

**Auth split:** PR creation, merging, and all mutations use the user's PAT (via `gh` native auth). Only review comments use the bot token so they appear as `stark-claude[bot]`.

Abort if on `main` — PRs come from feature branches.
Abort if working tree has uncommitted changes — commit or stash first.

## Step 1: Prepare Branch

Ensure the branch is pushed and up to date:

```bash
git push -u origin $BRANCH
```

**On push failure (diverged):** `git fetch && git rebase origin/main`, resolve conflicts, then push.

---

## Step 2: Analyze Changes

Review what's being proposed:

```bash
# Commits on this branch not yet on main
git log main..$BRANCH --oneline

# Full diff for summary generation
git diff main...$BRANCH --stat
git diff main...$BRANCH
```

From the diff and commit history, generate:
- **PR title:** Under 70 characters, descriptive. Use conventional prefix (`feat:`, `fix:`, `chore:`, `docs:`, `refactor:`).
- **PR body:** Summary bullets, scope, validation steps.

If `$ARGUMENTS` contains a title override, use that instead of generating one.

---

## Step 3: Create PR

```bash
DRAFT_FLAG=""
# Only add --draft if user explicitly said "draft" in $ARGUMENTS
[[ "$ARGUMENTS" == *"draft"* ]] && DRAFT_FLAG="--draft"

gh pr create \
  --repo $REPO \
  --title "[generated or overridden title]" \
  $DRAFT_FLAG \
  --body "## Summary

- [bullet points from diff analysis]

## Scope

- In scope: [what this PR changes]
- Out of scope: [what is NOT changed]

## Validation

- [x] Tests pass locally
- [x] No secrets/tokens in code or logs

## Checklist

- [x] Follows project conventions (CLAUDE.md)
- [x] Self-review completed"
```

Capture `$PR_NUM` from output.

**PRs are NOT draft by default.** Only use `--draft` if the user explicitly asks.

**On `gh` auth failure:** Verify `gh auth status` shows an active account. The user's PAT handles PR creation, not the bot.

---

## Step 4: Self Code Review

Post a self-review via `stark-claude[bot]`:

1. Run `git diff main...$BRANCH` and review every changed line.
2. Check for:
   - Missing error handling
   - Type hint completeness
   - Import organization
   - Test coverage gaps
   - Hardcoded values that should be configurable
   - Security concerns (secrets, injection, auth)

3. Post the review:

```python
import sys, os
sys.path.insert(0, os.path.expanduser("~/git/Evinced/scripts"))

# Must use the scripts venv for dependencies
# Run via: ~/git/Evinced/scripts/.venv/bin/python3

from stark_claude import pr_review

review_body = """## Self-Review

[Structured findings from the diff review]

### Issues Found
- [any issues, or "None"]

### Notes
- [observations about the change]

Review by `stark-claude[bot]`"""

pr_review(REPO, PR_NUM, event="COMMENT", body=review_body)
```

If inline comments are warranted:
```python
pr_review(REPO, PR_NUM, event="COMMENT", body=review_body, comments=[
    {"path": "file.py", "line": 42, "body": "Consider handling the error case here"}
])
```

---

## Step 5: Present Summary — STOP

```
PR Summary
──────────
PR:        #PR_NUM — [title]
Branch:    $BRANCH → main
Repo:      $REPO
URL:       [PR URL]

Changes:
- [file]: [what changed]
- [file]: [what changed]

Self-Review: Posted via stark-claude[bot]

Ready to squash-merge?
```

**STOP HERE. Wait for explicit user approval.**

User may:
- Approve → proceed to Step 7
- Request changes → apply them, push, re-check reviews
- Reject → leave PR open or close it

Do NOT merge without "yes", "merge it", "go ahead", "ship it", or equivalent.

---

### Documentation State Check (advisory)

Before merging, check the linked issue's Documentation State in the project:

1. Load `.github/project-config.json`. If not found, skip this check.
2. Extract issue number from PR body (`Closes #N` / `Fixes #N`)
3. Use bot token: `export GH_TOKEN=$($PYTHON $SCRIPTS/github_app.py --app stark-claude token)`
4. Find project item: `github_projects.find_item_for_issue(ORG, REPO, issue_number, config['project_id'])`
5. Read fields: `github_projects.get_item_fields(item_id)`
6. Check Documentation State:
   - If `Complete` or `Reviewed` → proceed silently
   - If `Not Started` or `Drafted` → print warning:
     ```
     ⚠️ Documentation State is '{state}' — consider updating docs before merge.
     ```
   - If field is missing → skip (no warning)
7. `unset GH_TOKEN`

**This check is advisory only — it NEVER blocks the merge.**

---

## Step 6: Merge & Clean Up

```bash
gh pr merge ${PR_NUM} --repo $REPO --squash --admin

git checkout main && git pull --rebase origin main
git branch -D $BRANCH
git push origin --delete $BRANCH
```

Final confirmation:

```
Merged
──────
PR #PR_NUM squash-merged to main
Branch $BRANCH deleted (local + remote)
```

---

## Failure Modes

| Failure | Recovery |
|---------|----------|
| Not on a feature branch | Abort — tell user to create a branch first |
| Dirty working tree | Abort — commit or stash first |
| Push diverged | Rebase on main, resolve, push |
| `gh` auth fails for PR ops | Verify `gh auth status` — user's PAT must be active. Run `gh auth login` if needed |
| Bot review post fails | Re-run `BOT_TOKEN=$(github_app.py token)` — bot auth is only for review comments |
| `stark_claude.py` fails | Check Python venv deps (PyJWT, requests, cryptography). Use `~/git/Evinced/scripts/.venv/bin/python3` |
| Merge conflict | Rebase on main, resolve, re-push, retry merge |
| PR checks failing | Show check status to user, ask whether to force-merge with `--admin` or fix first |
| User rejects PR | Leave PR open for revision or close it per user instruction |

## Observability

Follow the [Skill Observability Protocol](~/.claude/code-review/standards/observability.md) for all timing, checkpoints, and metrics reporting.

Additional skill-specific metrics:
- Push duration, PR creation duration, self-review duration, merge duration
- PR number and URL
- Merge strategy used, admin bypass used (yes/no)

## Mistakes to Avoid

- **Don't create draft PRs unless explicitly asked.** PRs are NOT draft by default.
- **Don't `git add -A`.** Always add specific files.
- **Don't set GH_TOKEN for PR/merge operations.** Use the user's native `gh` auth for creating and merging PRs. Only set `GH_TOKEN=$BOT_TOKEN` for review comment posting.
- **Don't merge without user approval.** Always present summary and wait.
- **Don't post reviews via `gh api`.** Always use `stark_claude.py` so reviews appear as `stark-claude[bot]`.
- **Don't hardcode repo names.** Auto-detect from `gh repo view`.
- **Don't skip the self-review.** Every PR gets a stark-claude review before merge.
- **Always use `--admin` on merge.** Squash-and-merge workflow with admin bypass.
- **Use `~/git/Evinced/scripts/.venv/bin/python3`** for running scripts. System Python lacks the required dependencies.
