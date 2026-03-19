# rename-project Skill Design

## Overview

Shell-based skill that renames a project both locally and on GitHub, then propagates the name change across sibling repos and reinstalls symlinks.

## Inputs

Two positional arguments: `<old-name> <new-name>` (e.g., `stark-review stark-skills`). Optional `--dry-run` flag to preview changes without executing.

Context is inferred: org and host from git remote, sibling repos from parent directory.

## Execution Sequence

### Step 1: Validate

- **Input format** — Both names must match `^[A-Za-z0-9._-]+$` (GitHub repo name rules). Reject path separators, spaces, and shell metacharacters.
- **Prerequisites** — Verify `install.sh` exists, is executable, and supports `--uninstall`. If missing, warn that symlink management will be manual.
- **Resumable state detection** — Before standard validation, check for partially-completed renames:
  - If remote URL already contains `new-name` but local dir is `old-name` → resume from Step 4
  - If local dir is already `new-name` but remote is still `old-name` → resume from Step 2
  - If local dir is already `new-name` and remote has `new-name` → resume from Step 4.5 (symlinks may still be stale)
- **Standard validation** (if not resuming):
  - Confirm current directory's git remote matches `old-name`
  - Confirm no uncommitted changes in target project
  - Confirm `new-name` doesn't already exist locally as a sibling directory
  - Confirm `new-name` doesn't already exist on GitHub as a *different* repo (API check)
- **Permission pre-flight** — Acquire a token via `github_app.py` and verify the App has `administration:write` on the target repo (`GET /repos/{org}/{old-name}` → check `permissions.admin`). Fail early if not.
- **Parse remote** — Extract `host`, `org`, `old_name` from `git remote get-url origin`. All replacement patterns are built from these parsed values (no hardcoded org/host literals).

### Step 2: GitHub Rename

Concrete invocation:
```bash
GH_TOKEN=$($PYTHON $SCRIPTS/github_app.py --app stark-claude token)
gh api -X PATCH "/repos/{org}/{old-name}" -f name="{new-name}"
```

- Verify response: check that returned `name` matches `new-name`
- Handle errors: 403 → "App lacks admin permission"; 404 → "Repo not found"; 422 → "Name already taken"; 5xx → "GitHub error, retry manually"
- On success, GitHub creates a redirect from old URL to new URL (note: redirect breaks if a new repo with the old name is later created)

### Step 3: Update Git Remote

- Read current fetch and push URLs via `git remote -v`
- Update both fetch URL and push URL (if different) preserving the original protocol (SSH/HTTPS)
- Verify with `git remote -v` after update

### Step 4: Rename Local Directory

- `mv {parent}/{old-name} {parent}/{new-name}`
- **Immediately** `cd {parent}/{new-name}` — the skill must operate from the new path for all subsequent steps. All paths from this point forward use absolute paths derived from the new location.

### Step 4.5: Uninstall Old Symlinks

Run this *before* modifying any files (Step 5 would change install.sh, making uninstall look for wrong targets):

- Run `install.sh --uninstall` from the new project location
- If `--uninstall` is not available, find stale symlinks dynamically:
  ```bash
  old_abs_path="{parent}/{old-name}"
  find ~/.claude -type l | while read link; do
    target=$(readlink -f "$link" 2>/dev/null || readlink "$link")
    case "$target" in "$old_abs_path"*) echo "$link" ;; esac
  done
  ```
  Remove only symlinks whose resolved targets are rooted under the old project's absolute path. Never delete non-symlink data (preserves `~/.claude/code-review/history/` and other local state).

### Step 5: Self-Update

Grep-and-replace within the renamed project. Skip directories: `.git/`, `.github/workflows/`, `node_modules/`, `.venv/`, `__pycache__/`, `dist/`, `build/`. Use `git grep -Il ""` to identify tracked text files (the `-I` flag skips binary files).

**Deterministic patterns (auto-applied):**

1. `{parent-path}/{old-name}` → `{parent-path}/{new-name}` (absolute path references)
2. `{org}/{old-name}` → `{org}/{new-name}` (org/repo references)
3. `{host}:{org}/{old-name}` → `{host}:{org}/{new-name}` (SSH clone URLs)
4. `{host}/{org}/{old-name}` → `{host}/{org}/{new-name}` (HTTPS URLs)

All patterns use the parsed `host`, `org` values from Step 1 — no hardcoded literals.

**Heuristic pattern (word-boundary, restricted scope):**

5. Bare `{old-name}` with repo-name-aware boundaries — only in known file types: `*.md`, `CLAUDE.md`, `*.json` (config files), `*.sh`. Use custom lookarounds `(?<![A-Za-z0-9._-]){old-name}(?![A-Za-z0-9._-])` instead of `\b`, because `\b` treats hyphens and dots as word boundaries and would incorrectly match inside `stark-review-improvement`. Exclude `.github/workflows/` from heuristic replacement (CI/CD files are only scanned and reported, not auto-modified).

**Exclusion rules:**
- `/{old-name}` (slash-prefixed) — skill invocation name, preserved
- `name:\s*['"]?{old-name}['"]?` in frontmatter — skill identity, preserved
- GitHub App names (`stark-claude`, `stark-codex`, `stark-gemini`) — independent, preserved
- Historical document filenames — preserved (only file contents are updated, not filenames)
- Content inside `.git/` directory

**Pattern application:** Patterns 1-4 are applied first (most specific), then pattern 5 on remaining matches. Each replacement operates on the result of the previous, in a single pass. Replacements treat `old-name` as a literal string, not a regex.

**Post-update validation:** Run `bash -n install.sh` to verify the modified script has no syntax errors before it's executed in Step 7.

### Step 6: Cross-Repo Update

- Discover sibling repos: directories under the same parent with a `.git/` subdirectory
- **Scope restriction:** Only update repos whose `origin` remote points to the same `{host}` and `{org}`. Skip repos belonging to other orgs or hosts.
- **Cleanliness check:** Before modifying any sibling repo, verify it has no staged or unstaged tracked changes. Skip repos with dirty worktrees and report them as "skipped — has uncommitted changes".
- Apply the same pattern list and exclusion rules from Step 5
- Skip directories: `.git/`, `.github/workflows/`, `node_modules/`, `.venv/`, `__pycache__/`, `dist/`, `build/`
- Use `git ls-files` per repo to restrict to tracked text files; use `git grep -Il` to filter to text-only files
- Track every file modified for the summary
- **Auto-commit** changes in each modified sibling repo using specific files, not `-am`: `git add <changed-files> && git commit -m "chore: update references from {old-name} to {new-name}"`. This prevents sweeping unrelated changes into the commit.

### Step 7: Reinstall

- Run `install.sh` from the new project location to recreate symlinks pointing to the new path
- If install.sh doesn't exist or fails, report the error with actionable instructions

### Step 8: Verify

Post-rename checks:
- `git ls-remote origin` succeeds (remote URL works)
- Symlinks under `~/.claude/` resolve to valid targets
- Grep for remaining references using all 5 patterns across the renamed project — report any residual matches as "may need manual review"
- Scan `.github/workflows/*.yml` in renamed project and sibling repos for old-name references — report as "CI/CD files that may need manual update"

### Step 9: Summary

- List every file changed, grouped by repo
- List verification results (pass/fail)
- List any residual old-name references that need manual review
- List any CI/CD workflow files with old-name references
- Print `cd {parent}/{new-name}` command for the user
- Note that GitHub redirects are in place (but will break if a repo with the old name is created later)

## Replacement Rules

| Pattern | Replace? | Reason |
|---------|----------|--------|
| Absolute paths containing old name | Yes | Paths must resolve |
| `{org}/{old-name}` repo references | Yes | API/clone URLs must work |
| Git clone/remote URLs (SSH + HTTPS) | Yes | Git operations must work |
| Bare `{old-name}` in .md/.json/.sh (custom lookarounds) | Yes | Keeps docs/config accurate |
| `/{old-name}` (slash-prefixed invocations) | No | Skill invocation preserved |
| `name:` frontmatter fields | No | Skill identity preserved |
| GitHub App names | No | Independent of project name |
| Historical doc filenames | No | Historical record preserved |
| `~/.claude/code-review/` path | No | Does not contain project name |
| Substrings of longer identifiers | No | Custom lookarounds prevent |
| `.github/workflows/*.yml` | No | CI/CD reported, not auto-modified |

## Edge Cases

- **cwd invalidation** — Step 4 explicitly `cd`s to the new path before continuing. Step 9 prints the `cd` command for the user's shell.
- **Uncommitted changes** — Skill refuses to run if target project has uncommitted changes. Sibling repos must have clean worktrees before modification; dirty sibling repos are skipped and reported.
- **Stale symlinks** — Step 4.5 uninstalls old symlinks *before* Step 5 modifies install.sh, ensuring correct cleanup.
- **install.sh safety** — Step 5 runs `bash -n install.sh` after modifications to catch syntax errors before Step 7 executes it.
- **Partial failure recovery** — Step 1 detects partially-completed renames by checking current remote URL and directory name, then resumes from the appropriate step. Each step is idempotent: Step 2 checks if repo already renamed, Step 3 checks if remote already correct, Step 4 checks if directory already moved.
- **Org/host detection** — Parsed from `git remote get-url origin`. All replacement patterns are derived from parsed values, not hardcoded.
- **Parent directory detection** — `dirname` of the current project path. Only sibling directories (same parent, same org) are scanned.
- **Dry-run mode** — Prints every change it would make without executing. File modifications shown as diffs.
- **Case-only renames** — If old and new names differ only in case, use a two-step rename via a temp name to handle case-insensitive filesystems (macOS default).

## What This Skill Does NOT Do

- Rename skills or their invocation commands
- Update CI/CD pipelines or GitHub Actions (but *does* scan and report them)
- Handle repos outside the parent directory
- Rename GitHub Apps or their credentials
- Modify binary files or untracked files
- Update external webhooks, Slack integrations, or Jira links (reports known integration points)
- Create backups (git history + auto-commits serve as the backup)
