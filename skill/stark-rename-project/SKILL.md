---
name: stark-rename-project
description: >
  Rename a project locally and on GitHub, update all references in sibling repos,
  and reinstall symlinks. Use when the user says "rename project", "rename repo",
  "rename this to", or invokes /stark-rename-project.
argument-hint: <old-name> <new-name> [--dry-run]
---

# rename-project

Rename a project both locally and on GitHub, propagate the name change across
sibling repos under the same parent directory, and reinstall symlinks.

## Arguments

- `<old-name>` — current project/repo name (e.g., `stark-review`)
- `<new-name>` — desired new name (e.g., `stark-skills`)
- `--dry-run` — preview all changes without executing any of them

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

### 1d. Standard validation

```bash
# Parse remote into components (not substring grep)
# SSH: git@github.com:GetEvinced/stark-skills.git → HOST=github.com ORG=GetEvinced REPO=stark-skills
# HTTPS: https://github.com/GetEvinced/stark-skills.git → same
# Confirm parsed REPO matches OLD_NAME
test "$REPO" = "$OLD_NAME" || error "Remote repo name '$REPO' doesn't match old-name '$OLD_NAME'"

# Confirm no uncommitted changes
test -z "$(git status --porcelain)" || error "Uncommitted changes — commit or stash first"

# Confirm new-name doesn't exist locally (skip for case-only renames)
if [ "$OLD_NAME" != "$NEW_NAME" ] || [ "$(echo "$OLD_NAME" | tr '[:upper:]' '[:lower:]')" != "$(echo "$NEW_NAME" | tr '[:upper:]' '[:lower:]')" ]; then
    test ! -d "$PARENT/$NEW_NAME" || error "Directory $PARENT/$NEW_NAME already exists"
fi

# Fetch and store current repo ID for collision/idempotency checks
CURRENT_REPO_ID=$(GH_TOKEN="$($PYTHON $SCRIPTS/github_app.py --app stark-claude token)" \
  gh api "/repos/$ORG/$OLD_NAME" --jq '.id')
```

For case-only renames (old and new differ only in case), skip the local
existence check — case-insensitive filesystems report the existing dir
as a match.

### 1e. Parse remote

Extract `HOST`, `ORG`, and repo name from the git remote URL:

```bash
REMOTE_URL=$(git remote get-url origin)
# SSH: git@github.com:GetEvinced/stark-skills.git
# HTTPS: https://github.com/GetEvinced/stark-skills.git
```

Parse HOST, ORG, OLD_NAME from the URL. All replacement patterns are
built from these parsed values — no hardcoded org/host literals.

### 1f. Permission pre-flight

```bash
GH_TOKEN="$($PYTHON $SCRIPTS/github_app.py --app stark-claude token)" \
  gh api "/repos/$ORG/$OLD_NAME" --jq '.permissions.admin'
```

If the result is not `true`, error:
"GitHub App lacks admin permission on $ORG/$OLD_NAME. Grant Administration:write."

### 1g. Check new-name availability on GitHub

```bash
GH_TOKEN="$($PYTHON $SCRIPTS/github_app.py --app stark-claude token)" \
  gh api "/repos/$ORG/$NEW_NAME" 2>/dev/null
```

If the API returns a repo AND its `id` differs from `$CURRENT_REPO_ID`,
error: "A different repo named $ORG/$NEW_NAME already exists on GitHub."

## Phase 2: Rename on GitHub

**Dry-run gate:** If `DRY_RUN=true`, print "Would rename $ORG/$OLD_NAME → $ORG/$NEW_NAME on GitHub" and skip to Phase 3.

**Idempotency:** Before calling PATCH, check if the repo is already named `$NEW_NAME`:
`GET /repos/$ORG/$NEW_NAME` → compare both repo ID AND exact `name` field.
If ID matches and name matches exactly (including case), skip to 2b.
If ID matches but name differs in case, still issue the PATCH (case-only rename).

### 2a. Rename the repository

```bash
GH_TOKEN="$($PYTHON $SCRIPTS/github_app.py --app stark-claude token)" \
  gh api -X PATCH "/repos/$ORG/$OLD_NAME" -f name="$NEW_NAME"
```

Verify the response: check that the returned `name` field matches `$NEW_NAME`.

Handle errors:
| HTTP Status | Meaning | Action |
|-------------|---------|--------|
| 200 | Success | Continue |
| 403 | No admin permission | Error with permission instructions |
| 404 | Repo not found | Error — check org/name |
| 422 | Name already taken | Error — choose a different name |
| 5xx | GitHub error | Error — retry manually |

GitHub creates a redirect from the old URL to the new URL. Note: this
redirect breaks if a repo with the old name is later created.

### 2b. Update git remote URLs

```bash
# Read current URLs
FETCH_URL=$(git remote get-url origin)
PUSH_URL=$(git remote get-url --push origin 2>/dev/null || echo "$FETCH_URL")

# Replace only the repo-name component (not arbitrary substrings)
# Use Perl for literal replacement (sed treats . as regex wildcard)
NEW_FETCH=$(echo "$FETCH_URL" | perl -pe "s|\Q$OLD_NAME\E([.]git)?$|$NEW_NAME\$1|")
NEW_PUSH=$(echo "$PUSH_URL" | perl -pe "s|\Q$OLD_NAME\E([.]git)?$|$NEW_NAME\$1|")

git remote set-url origin "$NEW_FETCH"
if [ "$FETCH_URL" != "$PUSH_URL" ]; then
    git remote set-url --push origin "$NEW_PUSH"
fi

# Verify
git remote -v
```

Note: `\Q...\E` in Perl treats the old name as a literal string, not a
regex. This prevents `.` in repo names from matching arbitrary characters.

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

Run this BEFORE modifying any files — Phase 4 would change install.sh,
making uninstall look for wrong targets.

```bash
if [ "$HAS_UNINSTALL" = "true" ]; then
    ./install.sh --uninstall
else
    # Fallback: find stale symlinks across ALL known install destinations
    OLD_ABS="$PARENT/$OLD_NAME"
    for search_dir in ~/.claude ~/git/Evinced/.code-review; do
        [ -d "$search_dir" ] || continue
        find "$search_dir" -type l | while IFS= read -r link; do
            target=$(python3 -c "import os,sys; print(os.path.realpath(sys.argv[1]))" "$link")
            # Match exact old path or children, not substring
            if [ "$target" = "$OLD_ABS" ] || case "$target" in "$OLD_ABS/"*) true;; *) false;; esac; then
                rm "$link" && echo "Removed stale symlink: $link"
            fi
        done
    done
fi
```

Only remove symlinks whose resolved absolute targets are exactly the old
project path or rooted under it. Never delete non-symlink data.

## Phase 4: Update References in Renamed Project

**Dry-run gate:** If `DRY_RUN=true`, show diffs of what would change and skip to Phase 5.

Use `git grep -Il ""` to identify tracked text files (skips binary files).

Skip directories: `.git/`, `.github/workflows/`, `node_modules/`, `.venv/`,
`__pycache__/`, `dist/`, `build/`.

### 4a. Deterministic patterns (auto-applied to all tracked text files)

Apply these in order, most specific first. Treat `OLD_NAME` as a literal
string, not a regex.

1. `$PARENT/$OLD_NAME` → `$PARENT/$NEW_NAME` (absolute path references)
2. `$ORG/$OLD_NAME` → `$ORG/$NEW_NAME` (org/repo references)
3. `$HOST:$ORG/$OLD_NAME` → `$HOST:$ORG/$NEW_NAME` (SSH clone URLs)
4. `$HOST/$ORG/$OLD_NAME` → `$HOST/$ORG/$NEW_NAME` (HTTPS URLs)

Use Perl `\Q...\E` for literal matching (not regex). This prevents `.`
in repo names from matching arbitrary characters.

### 4b. Heuristic pattern (restricted scope)

5. Bare `$OLD_NAME` with repo-name-aware boundaries — only in `*.md`,
   `*.json`, `*.sh` files. Use custom lookarounds:
   `(?<![A-Za-z0-9._-])OLD_NAME(?![A-Za-z0-9._-])`

   This prevents matching inside longer identifiers like
   `stark-review-improvement`.

   Exclude `.github/workflows/` — CI/CD files are only scanned and
   reported, not auto-modified.

### 4c. Exclusion rules

Do NOT replace:
- `/{old-name}` (slash-prefixed) — skill invocation name
- `name:\s*['"]?{old-name}['"]?` in frontmatter — skill identity
- Installed skill paths like `~/.claude/skills/stark-review/` — these are skill identity, not repo name
- Skill labels like `"Skill: stark-review"` in install.sh — stable identifiers
- GitHub App names (`stark-claude`, `stark-codex`, `stark-gemini`)
- Historical document filenames (e.g., `2026-03-16-stark-review-skill-design.md`) — only update content, not filenames
- `~/.claude/code-review/` path — does not contain project name, should never be modified
- Content inside `.git/` directory

### 4d. Post-update validation

```bash
bash -n install.sh || error "install.sh has syntax errors after modification"
```

Track every file modified for the summary.

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

Post-rename checks:

```bash
# Remote URL works
git ls-remote origin >/dev/null 2>&1 || echo "FAIL: git ls-remote origin failed"

# Symlinks resolve to new path
find ~/.claude -type l | while IFS= read -r link; do
    target=$(python3 -c "import os,sys; print(os.path.realpath(sys.argv[1]))" "$link")
    case "$target" in "$PARENT/$OLD_NAME"*) echo "STALE: $link → $target" ;; esac
done
```

Grep for remaining references using all 5 patterns across the renamed
project. Apply the same exclusion rules from Phase 4 so intentionally
preserved references (skill invocations, frontmatter names) don't show
as false positives. Report only unexpected residual matches.

Scan `.github/workflows/*.yml` in renamed project and sibling repos for
old-name references — report as "CI/CD files that may need manual update".

## Phase 8: Summary

Print:
- Every file changed, grouped by repo
- Verification results (pass/fail for each check)
- Residual old-name references that need manual review
- CI/CD workflow files with old-name references
- Sibling repos skipped due to dirty worktrees
- The `cd` command: `cd $PARENT/$NEW_NAME`
- Known integration points that may need manual update (webhooks, Slack, Jira)
- Note: GitHub redirects are in place but break if a repo with the old
  name is created later

## What This Skill Does NOT Do

- Rename skills or their invocation commands (e.g., `/stark-review` stays `/stark-review`)
- Update CI/CD pipelines or GitHub Actions (scans and reports them only)
- Handle repos outside the parent directory
- Rename GitHub Apps or their credentials
- Modify binary files or untracked files
- Update external webhooks, Slack integrations, or Jira links

## Observability

Follow the [Skill Observability Protocol](~/.claude/code-review/standards/observability.md) for all timing, checkpoints, and metrics reporting.

Additional skill-specific metrics:
- GitHub rename: API call duration, success/failure
- Files modified: count in renamed project, count per sibling repo
- Symlinks: removed (old), recreated (new)
- Verification: checks passed/failed, residual references found

## Mistakes to Avoid

| Mistake | Why it's wrong | Do this instead |
|---------|---------------|-----------------|
| Using `\b` word boundaries | Hyphens/dots are word boundaries in regex — matches inside `stark-review-improvement` | Use `(?<![A-Za-z0-9._-])..(?![A-Za-z0-9._-])` |
| Using sed for replacements | `sed` treats `.` as regex wildcard — `foo.bar` matches `fooXbar` | Use Perl `\Q...\E` for literal matching |
| Replacing skill paths in install.sh | `~/.claude/skills/stark-review/` is a skill identity, not a repo reference | Add explicit exclusion for installed skill paths |
| Unquoted file lists in git add | Paths with spaces/dashes can break shell or git | Use arrays: `git add -- "${files[@]}"` |
| Running `git commit -am` in sibling repos | Sweeps unrelated changes into the commit | `git add <specific-files> && git commit` |
| Modifying files before uninstalling symlinks | install.sh references change, uninstall can't find old targets | Uninstall first (Phase 3b), then modify (Phase 4) |
| Using `readlink -f` on macOS | Not available on macOS | Use `python3 -c "import os; print(os.path.realpath(...))"` |
| Replacing inside `.github/workflows/` | CI/CD files should be reported, not auto-modified | Skip workflows, report in summary |
| Hardcoding `GetEvinced` or `github.com` | Won't work for other orgs/hosts | Parse from `git remote get-url origin` |
| Forgetting to `cd` after `mv` | All subsequent commands operate from invalid cwd | `cd $PARENT/$NEW_NAME` immediately after mv |
