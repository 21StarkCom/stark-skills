# rename-project Skill Design

## Overview

Shell-based skill that renames a project both locally and on GitHub, then propagates the name change across sibling repos and reinstalls symlinks.

## Inputs

Two positional arguments: `<old-name> <new-name>` (e.g., `stark-review stark-skills`). Optional `--dry-run` flag to preview changes without executing.

Context is inferred: org from git remote, sibling repos from parent directory.

## Execution Sequence

### Step 1: Validate

- Confirm current directory is the project being renamed (git remote matches `old-name`)
- Confirm no uncommitted changes in target project
- Confirm `new-name` doesn't already exist locally as a sibling directory
- Confirm `new-name` doesn't already exist on GitHub (API check)
- Scan sibling repos for uncommitted changes — refuse if any modified repo contains references to old name

### Step 2: GitHub Rename

- Call GitHub API via `github_app.py`: `PATCH /repos/{org}/{old-name}` with `{"name": "new-name"}`
- GitHub automatically creates a redirect from old URL to new URL

### Step 3: Update Git Remote

- `git remote set-url origin` to new repo URL (both SSH and HTTPS patterns)

### Step 4: Rename Local Directory

- `mv {parent}/{old-name} {parent}/{new-name}`
- Note: caller's cwd becomes invalid — skill must inform user to `cd` to new path

### Step 5: Self-Update

Grep-and-replace within the renamed project for path/repo references. The exhaustive pattern list (used in both Step 5 and Step 6):

1. `{parent-path}/{old-name}` → `{parent-path}/{new-name}` (covers `~/git/Evinced/stark-review` and any absolute path variations)
2. `GetEvinced/{old-name}` → `GetEvinced/{new-name}` (org/repo references)
3. `github.com:GetEvinced/{old-name}` → `github.com:GetEvinced/{new-name}` (SSH clone URLs)
4. `github.com/GetEvinced/{old-name}` → `github.com/GetEvinced/{new-name}` (HTTPS URLs)
5. Bare `{old-name}` in prose/comments where it refers to the project name (e.g., "Installing {old-name}", "the {old-name} repo") — but only when not preceded by `/` (which indicates a skill invocation)

**Exclusion rules (precise):**
- `/{old-name}` (slash-prefixed) — skill invocation name, preserved
- `name: {old-name}` in YAML/TOML frontmatter — skill identity, preserved
- GitHub App names (`stark-claude`, `stark-codex`, `stark-gemini`) — independent, preserved
- Historical document filenames — preserved (only file contents are updated, not filenames in `docs/`)
- Content inside `.git/` directory — git internals, preserved

### Step 6: Cross-Repo Update

- Discover sibling repos: all directories under the same parent that contain a `.git/` subdirectory
- For each sibling repo, search text files using the same exhaustive pattern list from Step 5
- Skip directories: `.git/`, `node_modules/`, `.venv/`, `__pycache__/`, `dist/`, `build/`
- Skip binary files
- Track every file modified for the summary

### Step 6.5: Uninstall Old Symlinks

- Run `install.sh --uninstall` from the new project location (the script uses relative paths so it can clean up stale symlinks that still point to the old directory)
- If `--uninstall` is not available, manually remove known symlink targets: `~/.claude/code-review/`, `~/.claude/skills/{old-name}*/`, and any org config symlinks
- This step is required because `install.sh` will not overwrite existing symlinks that point elsewhere

### Step 7: Reinstall

- Run `install.sh` from the new project location to recreate symlinks pointing to the new path
- If install.sh doesn't exist or fails, report the error but don't rollback

### Step 8: Summary

- List every file changed, grouped by repo
- Remind user to `cd` to the new directory path
- Note that GitHub redirects are in place for old URLs

## Replacement Rules

| Pattern | Replace? | Reason |
|---------|----------|--------|
| Folder paths containing old name | Yes | Paths must resolve |
| GitHub repo references (`org/name`) | Yes | API/clone URLs must work |
| Git clone/remote URLs | Yes | Git operations must work |
| Bare project name in prose/comments | Yes | Keeps docs accurate |
| `/{old-name}` (slash-prefixed invocations) | No | Skill invocation preserved |
| `name:` frontmatter fields | No | Skill identity preserved |
| GitHub App names | No | Independent of project name |
| Historical doc filenames | No | Historical record preserved |
| `~/.claude/code-review/` path | No | Does not contain project name |

## Edge Cases

- **cwd invalidation** — After `mv`, the shell's working directory is gone. Skill prints a clear message telling the user to `cd` to the new path.
- **Uncommitted changes** — Skill refuses to run if target project or affected sibling repos have uncommitted changes.
- **Stale symlinks** — Old symlinks at `~/.claude/` point to the now-nonexistent directory. Step 6.5 explicitly uninstalls them before Step 7 reinstalls.
- **install.sh failure** — Reported but not rolled back. The GitHub rename and local rename are already done; partial failure is better than a complex rollback that could leave things worse.
- **Partial failure recovery (Steps 2-4)** — If GitHub rename succeeds but local `mv` fails: the git remote is already updated and GitHub has redirects. Recovery: fix the permission/disk issue and re-run the skill (it will detect the GitHub name already matches and skip Step 2). If local `mv` succeeds but was preceded by a remote URL update failure: `git remote set-url` is idempotent, re-run is safe.
- **Org detection** — Parsed from `git remote get-url origin`. Supports both SSH (`git@github.com:Org/repo.git`) and HTTPS (`https://github.com/Org/repo.git`) formats.
- **Parent directory detection** — `dirname` of the current project path. Only sibling directories (same parent) are scanned.
- **Dry-run mode** — The skill accepts an optional `--dry-run` flag as a third argument. When set, it prints every change it would make (GitHub rename, file modifications, symlink updates) without executing any of them.

## What This Skill Does NOT Do

- Rename skills or their invocation commands
- Update CI/CD pipelines, GitHub Actions, or external systems
- Handle repos outside the parent directory
- Rename GitHub Apps or their credentials
- Modify binary files
- Create backups (git history serves as the backup)
