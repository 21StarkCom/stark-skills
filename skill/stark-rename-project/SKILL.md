---
name: stark-rename-project
description: >-
  Rename project locally and on GitHub, update sibling repo references, reinstall symlinks. Use for rename project/repo.
argument-hint: <old-name> <new-name> [--dry-run]
disable-model-invocation: true
model: opus
---

# rename-project

Rename a project both locally and on GitHub, propagate the name change across
sibling repos under the same parent directory, and reinstall symlinks.

## Arguments

- `<old-name>` — current project/repo name (e.g., `stark-team-review`)
- `<new-name>` — desired new name (e.g., `stark-skills`)
- `--dry-run` — preview all changes without executing any of them

**Raw input:** `$ARGUMENTS`

## Constants

```
SCRIPTS = ~/.claude/code-review/scripts
PYTHON  = $SCRIPTS/.venv/bin/python3
```

## Phase 1: Validate

### 1a. Parse and validate arguments

Confirm both `<old-name>` and `<new-name>` were provided. If not, error:
"Usage: /rename-project <old-name> <new-name> [--dry-run]"

Validate both names match `^[A-Za-z0-9._-]+$`. Reject any name containing
path separators, spaces, or shell metacharacters.

Check for `--dry-run` flag. If present, set `DRY_RUN=true` for all
subsequent phases.

### 1b. Establish repo root and check prerequisites

```bash
# Always operate from repo root, not a subdirectory
REPO_ROOT=$(git rev-parse --show-toplevel)
cd "$REPO_ROOT"
LOCAL_DIR=$(basename "$REPO_ROOT")
PARENT=$(dirname "$REPO_ROOT")

# Verify install.sh exists and is executable
test -x install.sh || echo "WARN: install.sh not found — symlink management will be manual"

# Verify install.sh supports --uninstall
grep -q '\-\-uninstall' install.sh && HAS_UNINSTALL=true || HAS_UNINSTALL=false
```

### 1c. Detect resumable state

Before standard validation, check if a previous run partially completed:

```bash
REMOTE_URL=$(git remote get-url origin)
```

| Remote contains | Local dir is | Resume from |
|-----------------|-------------|-------------|
| `new-name` | `old-name` | Phase 3 (local rename) |
| `old-name` | `new-name` | Phase 2 (GitHub rename) |
| `new-name` | `new-name` | Phase 3b (symlink cleanup) |

If none of the resume states match, proceed with standard validation.

### 1d–1g. Validate remote, permissions, and availability

Parse remote URL into HOST/ORG/REPO, confirm no uncommitted changes, check admin permissions, verify new-name availability. For validation code and error handling, see [references/validation-details.md](references/validation-details.md).

## Phase 2: Rename on GitHub

**Dry-run gate:** If `DRY_RUN=true`, print "Would rename $ORG/$OLD_NAME → $ORG/$NEW_NAME on GitHub" and skip to Phase 3.

**Idempotency:** Before calling PATCH, check if the repo is already named `$NEW_NAME`:
`GET /repos/$ORG/$NEW_NAME` → compare both repo ID AND exact `name` field.
If ID matches and name matches exactly (including case), skip to 2b.
If ID matches but name differs in case, still issue the PATCH (case-only rename).

### 2a–2b. Rename repo and update remote URLs

PATCH `/repos/$ORG/$OLD_NAME` to rename, then update local git remote URLs using Perl literal replacement. For API commands, error handling, and URL update code, see [references/validation-details.md](references/validation-details.md).

## Phase 3: Local Rename + Symlink Cleanup

**Dry-run gate:** If `DRY_RUN=true`, print "Would rename $PARENT/$OLD_NAME → $PARENT/$NEW_NAME" and list symlinks that would be removed. Skip to Phase 4.

**Idempotency:** If `$PARENT/$NEW_NAME` already exists and `$PARENT/$OLD_NAME` does not, skip 3a.

### 3a. Rename the local directory

```bash
PARENT=$(dirname "$PWD")
mv "$PARENT/$OLD_NAME" "$PARENT/$NEW_NAME"
cd "$PARENT/$NEW_NAME"
```

For case-only renames, use a two-step rename via a temp name:
```bash
TEMP_NAME="${OLD_NAME}-rename-temp-$$"
mv "$PARENT/$OLD_NAME" "$PARENT/$TEMP_NAME"
mv "$PARENT/$TEMP_NAME" "$PARENT/$NEW_NAME"
cd "$PARENT/$NEW_NAME"
```

**CRITICAL:** All subsequent steps MUST use absolute paths derived from
the new location. The skill's working directory is now `$PARENT/$NEW_NAME`.

### 3b. Uninstall old symlinks

Run `install.sh --uninstall` BEFORE modifying any files. For fallback symlink cleanup code, see [references/validation-details.md](references/validation-details.md).

## Phase 4: Update References in Renamed Project

**Dry-run gate:** If `DRY_RUN=true`, show diffs of what would change and skip to Phase 5.

Use `git grep -Il ""` to identify tracked text files (skips binary files).

Skip directories: `.git/`, `.github/workflows/`, `node_modules/`, `.venv/`,
`__pycache__/`, `dist/`, `build/`.

### 4a-4d. Apply replacement patterns

Apply deterministic patterns (absolute paths, org/repo, SSH/HTTPS URLs) and heuristic bare-name pattern with exclusion rules. For the full pattern list, exclusion rules, and post-update validation, see [references/replacement-patterns.md](references/replacement-patterns.md).

## Phase 5: Update References in Sibling Repos

**Dry-run gate:** If `DRY_RUN=true`, show list of sibling repos that would be modified and the files/patterns that would change. Skip to Phase 6.

### 5a. Discover sibling repos

Find all directories under `$PARENT` with a `.git/` subdirectory.

Filter: only include repos whose `origin` remote points to the same
`$HOST` and `$ORG`. Skip repos belonging to other orgs or hosts.

### 5b. Pre-flight checks per repo

Before modifying any sibling repo, verify it has no staged or unstaged
tracked changes:
```bash
cd "$SIBLING_DIR"
test -z "$(git status --porcelain)" || { echo "SKIPPED $SIBLING — uncommitted changes"; continue; }
```

### 5c. Apply replacements

Apply the same pattern list and exclusion rules from Phase 4.

Skip directories: `.git/`, `.github/workflows/`, `node_modules/`, `.venv/`,
`__pycache__/`, `dist/`, `build/`.

Use `git grep -Il ""` to identify tracked text files.

### 5d. Auto-commit

Commit only the specific files modified, not `-am`. Use `--` to prevent
filenames starting with `-` from being interpreted as options:
```bash
git add -- "${CHANGED_FILES[@]}"
git commit -m "chore: update references from $OLD_NAME to $NEW_NAME"
```

Track changed files as an array, not a space-delimited string, to handle
paths with spaces or special characters safely.

Track every file modified across all repos for the summary.

## Phase 6: Reinstall Symlinks

**Dry-run gate:** If `DRY_RUN=true`, print "Would run install.sh to recreate symlinks" and skip to Phase 7.

```bash
cd "$PARENT/$NEW_NAME"
./install.sh
```

If install.sh doesn't exist or fails, report the error with
actionable instructions:
"install.sh failed — run manually from $PARENT/$NEW_NAME after fixing"

## Phase 7: Verify

Run post-rename checks: remote URL, symlink resolution, residual references, CI/CD workflow scan. For the full verification checklist, see [references/verification-checks.md](references/verification-checks.md).

## Phase 8: Summary

Print results: files changed per repo, verification pass/fail, residual references, CI/CD files needing manual update, sibling repos skipped. For the complete summary checklist, see [references/verification-checks.md](references/verification-checks.md).

## Observability

Standard observability: record metrics block (GitHub rename duration, files modified per repo, symlinks removed/recreated, verification checks passed/failed, residual references). See [../../standards/observability.md](../../standards/observability.md).

## Scope & Pitfalls

For limitations (what this skill does NOT do) and common mistakes to avoid, see [references/mistakes-to-avoid.md](references/mistakes-to-avoid.md).
