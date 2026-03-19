# rename-project Skill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create a Claude Code skill that renames a project locally and on GitHub, propagates references across sibling repos, and reinstalls symlinks.

**Architecture:** Single SKILL.md file containing the full prompt-driven workflow. The skill drives bash commands directly — no Python script needed. Install.sh registers the skill symlink.

**Tech Stack:** Markdown (SKILL.md), Bash (install.sh updates), JSON (evals)

**Spec:** `docs/superpowers/specs/2026-03-19-rename-project-design.md`

---

## File Map

| Action | Path | Purpose |
|--------|------|---------|
| Create | `skill/rename-project/SKILL.md` | Skill implementation |
| Create | `skill/evals/rename-project-evals.json` | Eval test cases |
| Modify | `install.sh` | Register skill symlink |
| Modify | `CLAUDE.md` | Add skill to skills list |

---

### Task 1: Create SKILL.md skeleton with frontmatter and constants

**Files:**
- Create: `skill/rename-project/SKILL.md`

- [ ] **Step 1: Create skill directory and SKILL.md with frontmatter + constants + arguments**

```markdown
---
name: rename-project
description: >
  Rename a project locally and on GitHub, update all references in sibling repos,
  and reinstall symlinks. Use when the user says "rename project", "rename repo",
  "rename this to", or invokes /rename-project.
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
```

- [ ] **Step 2: Verify file is valid markdown with frontmatter**

Run: `head -5 skill/rename-project/SKILL.md`
Expected: Shows `---`, `name: rename-project`, `description:` lines

- [ ] **Step 3: Commit**

```bash
git add skill/rename-project/SKILL.md
git commit -m "feat: scaffold rename-project skill with frontmatter"
```

---

### Task 2: Implement Phase 1 — Validation

**Files:**
- Modify: `skill/rename-project/SKILL.md`

- [ ] **Step 1: Add Phase 1 to SKILL.md**

Append after the Constants section:

```markdown
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
# SSH: git@github.com:GetEvinced/stark-review.git → HOST=github.com ORG=GetEvinced REPO=stark-review
# HTTPS: https://github.com/GetEvinced/stark-review.git → same
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
# SSH: git@github.com:GetEvinced/stark-review.git
# HTTPS: https://github.com/GetEvinced/stark-review.git
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
```

- [ ] **Step 2: Review the phase reads correctly as a coherent prompt section**

Read: `skill/rename-project/SKILL.md` — confirm Phase 1 flows logically

- [ ] **Step 3: Commit**

```bash
git add skill/rename-project/SKILL.md
git commit -m "feat(rename-project): add Phase 1 — validation"
```

---

### Task 3: Implement Phase 2 — GitHub Rename + Remote Update

**Files:**
- Modify: `skill/rename-project/SKILL.md`

- [ ] **Step 1: Add Phase 2 to SKILL.md**

```markdown
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
```

- [ ] **Step 2: Commit**

```bash
git add skill/rename-project/SKILL.md
git commit -m "feat(rename-project): add Phase 2 — GitHub rename + remote update"
```

---

### Task 4: Implement Phase 3 — Local Rename + Symlink Cleanup

**Files:**
- Modify: `skill/rename-project/SKILL.md`

- [ ] **Step 1: Add Phase 3 to SKILL.md**

```markdown
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

Run this BEFORE modifying any files — Step 4 would change install.sh,
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
```

- [ ] **Step 2: Commit**

```bash
git add skill/rename-project/SKILL.md
git commit -m "feat(rename-project): add Phase 3 — local rename + symlink cleanup"
```

---

### Task 5: Implement Phase 4 — Self-Update (file references)

**Files:**
- Modify: `skill/rename-project/SKILL.md`

- [ ] **Step 1: Add Phase 4 to SKILL.md**

```markdown
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
```

- [ ] **Step 2: Commit**

```bash
git add skill/rename-project/SKILL.md
git commit -m "feat(rename-project): add Phase 4 — self-update references"
```

---

### Task 6: Implement Phase 5 — Cross-Repo Update

**Files:**
- Modify: `skill/rename-project/SKILL.md`

- [ ] **Step 1: Add Phase 5 to SKILL.md**

```markdown
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
```

- [ ] **Step 2: Commit**

```bash
git add skill/rename-project/SKILL.md
git commit -m "feat(rename-project): add Phase 5 — cross-repo update"
```

---

### Task 7: Implement Phase 6 — Reinstall + Verify + Summary

**Files:**
- Modify: `skill/rename-project/SKILL.md`

- [ ] **Step 1: Add Phase 6 to SKILL.md**

```markdown
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
find ~/.claude -type l | while read link; do
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
```

- [ ] **Step 2: Commit**

```bash
git add skill/rename-project/SKILL.md
git commit -m "feat(rename-project): add Phases 6-8 — reinstall, verify, summary"
```

---

### Task 8: Register skill in install.sh

**Files:**
- Modify: `install.sh`

- [ ] **Step 1: Read install.sh to find the skill registration section**

Look for the block that registers other skills (around lines 113-161).

- [ ] **Step 2: Add rename-project registration**

After the last skill registration block (before the closing of the install section), add:

```bash
mkdir -p "$HOME/.claude/skills/rename-project"
if [ -f "$REPO_DIR/skill/rename-project/SKILL.md" ]; then
    link_dir "$REPO_DIR/skill/rename-project/SKILL.md" \
             "$HOME/.claude/skills/rename-project/SKILL.md" \
             "Skill: rename-project"
else
    warn "Skill file not found at $REPO_DIR/skill/rename-project/SKILL.md"
fi
```

- [ ] **Step 3: Add uninstall entry**

In the `uninstall()` function, add:

```bash
unlink_dir "$HOME/.claude/skills/rename-project/SKILL.md" "Skill: rename-project"
```

- [ ] **Step 4: Add status check entry**

In the `status()` function, add:

```bash
check_dir "$HOME/.claude/skills/rename-project/SKILL.md" "Skill: rename-project"
```

- [ ] **Step 5: Run install and verify**

```bash
./install.sh --status
```

Expected: Shows "Skill: rename-project" as either linked or not found.

- [ ] **Step 6: Commit**

```bash
git add install.sh
git commit -m "feat(rename-project): register skill in install.sh"
```

---

### Task 9: Add skill to CLAUDE.md

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Read CLAUDE.md and find the Skills section**

Look for the section that lists `/stark-review`, `/stark-review-improvement`, etc.

- [ ] **Step 2: Add rename-project entry**

Add to the skills list:

```markdown
- `/rename-project <old-name> <new-name> [--dry-run]` — rename project locally and on GitHub, update references across sibling repos, reinstall symlinks
```

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: add rename-project to CLAUDE.md skills list"
```

---

### Task 10: Create eval test cases

**Files:**
- Create: `skill/evals/rename-project-evals.json`

- [ ] **Step 1: Write eval file**

```json
{
  "skill_name": "rename-project",
  "evals": [
    {
      "id": 1,
      "prompt": "rename stark-review to stark-skills",
      "expected_output": "Validates inputs, renames on GitHub via gh api PATCH, updates git remote, renames local directory, uninstalls old symlinks, updates references in project and sibling repos, reinstalls symlinks, verifies, prints summary",
      "files": [],
      "assertions": [
        {"name": "validates_name_format", "check": "Validates both names match ^[A-Za-z0-9._-]+$"},
        {"name": "parses_remote", "check": "Extracts host, org, repo from git remote get-url origin"},
        {"name": "checks_admin_permission", "check": "Verifies GitHub App has administration:write before renaming"},
        {"name": "renames_on_github", "check": "Calls gh api -X PATCH /repos/{org}/{old-name} -f name={new-name}"},
        {"name": "updates_remote_url", "check": "Runs git remote set-url origin with new repo name"},
        {"name": "renames_local_dir", "check": "Runs mv and cd to new directory path"},
        {"name": "uninstalls_before_modify", "check": "Runs install.sh --uninstall BEFORE modifying any files"},
        {"name": "uses_custom_lookarounds", "check": "Uses (?<![A-Za-z0-9._-]) boundaries, not \\b"},
        {"name": "skips_workflows", "check": "Does NOT auto-modify .github/workflows/ files"},
        {"name": "commits_sibling_specific_files", "check": "Uses git add <files> && git commit, not git commit -am"},
        {"name": "runs_install", "check": "Runs install.sh after modifications to recreate symlinks"},
        {"name": "verifies_result", "check": "Runs git ls-remote origin and checks for stale symlinks"}
      ]
    },
    {
      "id": 2,
      "prompt": "rename stark-review to stark-skills --dry-run",
      "expected_output": "Shows all changes that would be made without executing any of them",
      "files": [],
      "assertions": [
        {"name": "no_github_rename", "check": "Does NOT call gh api -X PATCH"},
        {"name": "no_file_modifications", "check": "Does NOT modify any files on disk"},
        {"name": "shows_preview", "check": "Prints list of files and patterns that would be changed"}
      ]
    },
    {
      "id": 3,
      "prompt": "rename stark-review to Stark-Review",
      "expected_output": "Handles case-only rename with two-step mv via temp name",
      "files": [],
      "assertions": [
        {"name": "detects_case_only", "check": "Detects case-only rename and skips local existence check"},
        {"name": "two_step_rename", "check": "Uses mv old temp && mv temp new for case-insensitive FS"}
      ]
    },
    {
      "id": 4,
      "prompt": "rename stark-review to stark-skills (with uncommitted changes)",
      "expected_output": "Refuses to run with clear error message",
      "files": [],
      "assertions": [
        {"name": "refuses_dirty", "check": "Detects uncommitted changes and aborts before any mutation"},
        {"name": "clear_error", "check": "Tells user to commit or stash first"}
      ]
    },
    {
      "id": 5,
      "prompt": "rename stark-review to stark-skills (resume after partial failure)",
      "expected_output": "Detects partially-completed rename and resumes from correct step",
      "files": [],
      "assertions": [
        {"name": "detects_partial", "check": "Checks remote URL and local dir name to find resume point"},
        {"name": "skips_completed_steps", "check": "Does not re-run GitHub rename if already done"}
      ]
    },
    {
      "id": 6,
      "prompt": "rename stark-review to scripts (name already taken on GitHub by different repo)",
      "expected_output": "Refuses to rename with clear error about name collision",
      "files": [],
      "assertions": [
        {"name": "checks_collision", "check": "Compares repo IDs to detect different repo with same name"},
        {"name": "aborts_before_mutation", "check": "Does not call PATCH or modify any files"}
      ]
    },
    {
      "id": 7,
      "prompt": "rename stark-review to stark-skills (GitHub App lacks admin permission)",
      "expected_output": "Fails with clear error about missing admin permission",
      "files": [],
      "assertions": [
        {"name": "checks_permission", "check": "Calls GET /repos/{org}/{name} and checks permissions.admin"},
        {"name": "fails_early", "check": "Aborts in validation phase, before any mutation"}
      ]
    }
  ]
}
```

- [ ] **Step 2: Validate JSON syntax**

Run: `python3 -m json.tool skill/evals/rename-project-evals.json > /dev/null`
Expected: No output (valid JSON)

- [ ] **Step 3: Commit**

```bash
git add skill/evals/rename-project-evals.json
git commit -m "test: add rename-project eval test cases"
```

---

### Task 11: Install and smoke test

**Files:** None (verification only)

- [ ] **Step 1: Run install.sh**

```bash
./install.sh
```

Expected: "Skill: rename-project" shows as linked.

- [ ] **Step 2: Verify symlink exists**

```bash
ls -la ~/.claude/skills/rename-project/SKILL.md
```

Expected: Symlink pointing to repo's `skill/rename-project/SKILL.md`

- [ ] **Step 3: Verify skill is loadable**

```bash
head -10 ~/.claude/skills/rename-project/SKILL.md
```

Expected: Shows frontmatter with `name: rename-project`

- [ ] **Step 4: Run install --status**

```bash
./install.sh --status
```

Expected: All skills including rename-project show as linked.

- [ ] **Step 5: Test uninstall/reinstall cycle**

```bash
./install.sh --uninstall
ls ~/.claude/skills/rename-project/SKILL.md 2>/dev/null && echo "FAIL: still exists" || echo "PASS: removed"
./install.sh
ls -la ~/.claude/skills/rename-project/SKILL.md
```

Expected: Uninstall removes symlink, reinstall recreates it.

- [ ] **Step 6: Final commit**

```bash
git add -A
git commit -m "feat: rename-project skill complete — ready for use"
```
