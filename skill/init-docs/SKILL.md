---
name: init-docs
description: >
  Scaffold dev docs structure into any repo. Modes: --template (empty skeleton),
  --backfill (generate from git history), --upgrade (migrate existing docs),
  --clean (remove skeleton). Use when the user says "init docs", "setup docs",
  "scaffold docs", or invokes /init-docs.
---

# init-docs

Scaffold a standardized developer documentation structure into any repository. Four modes that can be combined (e.g., `--upgrade --backfill`).

## Arguments

- `--template` — create empty docs skeleton with standard directories and config files
- `--backfill` — generate docs content from git history, merged PRs, and codebase analysis
- `--upgrade` — migrate existing scattered Markdown docs into standard layout
- `--clean` — remove skeleton files (preserves user-generated content)
- Modes are combinable: `--upgrade --backfill` migrates existing docs then generates new ones
- If no arguments given, show the four options and ask which mode to use

## Constants

```
TEMPLATES = ~/.claude/code-review/standards/templates/
```

## No-arg Mode

When invoked without arguments, display:

```
Available modes:
  --template   Create empty docs skeleton (dirs, config files, templates)
  --backfill   Generate docs from git history and codebase analysis (runs --template first)
  --upgrade    Migrate existing Markdown docs into standard layout (runs --template to fill gaps)
  --clean      Remove skeleton files (preserves user-generated content)

Modes can be combined: --upgrade --backfill

Which mode?
```

Wait for user response before proceeding.

## `--template` Mode

Create the standard docs structure. All operations are idempotent — skip files and directories that already exist.

### Step 1: Create directories

```bash
mkdir -p docs/{specs,plans,adr,guides,reference,architecture}
```

### Step 2: Copy templates

Copy from `$TEMPLATES` to the repo, substituting placeholders:

| Source | Destination | Substitutions |
|--------|-------------|---------------|
| `adr-template.md` | `docs/adr/0000-template.md` | none |
| `mkdocs.yml` | `mkdocs.yml` (repo root) | `__REPO_NAME__` → directory name of repo root |
| `pull_request_template.md` | `.github/pull_request_template.md` | none |
| `.doc-staleness.yml` | `.doc-staleness.yml` (repo root) | none |
| `index.md` | `docs/index.md` | `__REPO_NAME__` → directory name of repo root |

For each file: if the destination already exists, skip it and log "Skipping {path} (already exists)".

Create `.github/` directory if needed for the PR template.

### Step 3: CODEOWNERS

If `CODEOWNERS` or `.github/CODEOWNERS` does not exist:

```bash
git_user=$(git config user.name || echo "OWNER")
```

Create `.github/CODEOWNERS` with `__OWNER__` substituted with `$git_user`. If CODEOWNERS already exists anywhere in the repo, skip.

### Step 4: Commit

```bash
git add docs/ mkdocs.yml .doc-staleness.yml .github/pull_request_template.md .github/CODEOWNERS
git commit -m "docs: scaffold dev docs structure"
```

If nothing was added (all files already existed), skip the commit.

## `--backfill` Mode

Generate documentation content from repository history and codebase analysis.

### Step 1: Run `--template`

Execute the full `--template` mode first to ensure the directory structure exists.

### Step 2: Gather repository data

```bash
# Recent commit history
git log --oneline --all -200 > /tmp/init-docs-commits.txt

# Merged PRs (requires gh CLI)
gh pr list --state merged --limit 50 --json number,title,body,mergedAt > /tmp/init-docs-prs.json 2>/dev/null
```

If `gh` is not available or fails, warn "Could not fetch PR history, generating docs from commits and codebase only" and continue.

### Step 3: Analyze codebase

Read and analyze these files (if they exist):

| File | Extract |
|------|---------|
| `package.json` | Name, dependencies, scripts, engines |
| `requirements.txt` / `pyproject.toml` / `setup.py` | Python dependencies |
| `go.mod` | Go module path, dependencies |
| `Cargo.toml` | Rust crate info, dependencies |
| `Makefile` / `Taskfile.yml` | Build/run/test targets |
| `Dockerfile` / `docker-compose.yml` | Container setup, services |
| `.github/workflows/*.yml` | CI/CD pipelines |
| `.gitlab-ci.yml` | CI/CD pipelines |
| `Jenkinsfile` | CI/CD pipelines |

### Step 4: Generate ADRs

Be CONSERVATIVE. Only generate ADRs for major technology choices:

- Programming language(s)
- Web framework / application framework
- Database / data store
- Major libraries (ORM, auth, messaging, etc.)
- Infrastructure choices evident from config (containerization, CI platform)

Each ADR follows the template in `docs/adr/0000-template.md`. Number them starting from `0001`. Set status to "Accepted" and date to the earliest commit that introduced the technology (from git log).

Do NOT generate ADRs for:
- Dev dependencies (linters, formatters, test frameworks)
- Transitive dependencies
- Standard library usage
- Anything speculative

### Step 5: Generate stub specs from merged PRs

For merged PRs that represent significant features (not bug fixes, deps, or chores):

- Create a stub spec in `docs/specs/` named `{mergedAt-date}-{slug}.md`
- Include: title, date, PR link, summary from PR body
- Mark as "Implemented" with a link to the PR

Limit to 10 most significant PRs. Skip PRs with trivial titles (bump, fix typo, update deps).

### Step 6: Generate guides

Analyze `Makefile`, `package.json` scripts, CI configs, and `Dockerfile` to generate:

- `docs/guides/getting-started.md` — setup instructions (clone, install deps, build, run)
- `docs/guides/development.md` — dev workflow (branch strategy, test commands, lint commands)
- `docs/guides/deployment.md` — only if CI/CD or Dockerfile exists

Each guide should reference actual commands found in the repo, not generic placeholders.

### Step 7: Wire mkdocs.yml navigation

Update `mkdocs.yml` to include all generated docs in the `nav` section:

```yaml
nav:
  - Home: index.md
  - Architecture:
    - ADRs:
      - "ADR-0001: Language Choice": adr/0001-language-choice.md
      # ... all generated ADRs
  - Specs:
    - "Feature Name": specs/2024-01-15-feature-name.md
    # ... all generated specs
  - Guides:
    - Getting Started: guides/getting-started.md
    - Development: guides/development.md
    # ... all generated guides
```

### Step 8: Commit

```bash
git add docs/ mkdocs.yml
git commit -m "docs: backfill docs from repo history"
```

## `--upgrade` Mode

Migrate existing scattered Markdown docs into the standard layout.

### Step 1: Scan for existing docs

Find all Markdown files outside `docs/` (excluding `node_modules`, `.git`, `vendor`, `CHANGELOG.md`, `LICENSE.md`):

```bash
git ls-files '*.md' ':!docs/**' ':!node_modules/**' ':!vendor/**' ':!CHANGELOG.md' ':!LICENSE.md' ':!LICENSE' ':!CONTRIBUTING.md'
```

Exclude `README.md` at repo root — it stays in place.

### Step 2: Classify each document

Read each Markdown file and classify by content:

| Classification | Signals |
|----------------|---------|
| `spec` | Requirements, user stories, acceptance criteria, "specification", API design |
| `adr` | "Decision", "Context", "Status: Accepted/Deprecated", "Consequences" |
| `guide` | How-to, setup instructions, step-by-step, tutorial, runbook |
| `reference` | API docs, config reference, glossary, data dictionary |
| `architecture` | System diagrams, component overview, data flow, "architecture" |

If uncertain, classify as `reference`.

### Step 3: Move files

For each classified file:

```bash
# Determine target path
target="docs/{classification}/{filename}"

# Create target directory if needed
mkdir -p "docs/{classification}"

# Move via git
git mv "{source}" "{target}"
```

Preserve original filenames. If a naming conflict exists, prefix with the source directory name.

### Step 4: Update internal links

After all moves, scan all Markdown files in the repo for broken internal links:

- Find links matching `[text](old/path.md)` where `old/path.md` was moved
- Update to the new path relative to the linking file
- Also update any relative image references

### Step 5: Update mkdocs.yml

If `mkdocs.yml` exists, update its `nav` section to reflect the new file locations. If it doesn't exist, `--template` will create it in the next step.

### Step 6: Run `--template` to fill gaps

Execute `--template` mode to create any missing directories and config files.

### Step 7: Commit

```bash
git add -A
git commit -m "docs: upgrade to standard doc structure"
```

## `--clean` Mode

Remove skeleton files while preserving user-generated content.

### Step 1: Confirm

Ask: "This will remove doc scaffold files (templates, empty dirs, mkdocs.yml, .doc-staleness.yml). User-generated content in docs/ will be preserved. Proceed? (y/n)"

Do NOT proceed without explicit confirmation.

### Step 2: Identify skeleton files

These are skeleton files — remove them:

- `docs/adr/0000-template.md` (the template, not numbered ADRs)
- `mkdocs.yml` (repo root)
- `.doc-staleness.yml` (repo root)
- `.github/pull_request_template.md`
- `.github/CODEOWNERS` (only if it was generated by this skill — check for the `__OWNER__` comment marker or if it's unmodified from the template)

### Step 3: Remove empty directories

```bash
# Remove docs subdirs only if empty
find docs/ -type d -empty -delete 2>/dev/null

# Remove docs/ itself only if empty
rmdir docs/ 2>/dev/null
```

### Step 4: Files to NEVER delete

- Any file in `docs/` subdirectories that is not a template (user-generated ADRs, specs, guides, etc.)
- `README.md`
- `CHANGELOG.md`
- `CONTRIBUTING.md`
- Any file with meaningful user content (check git log — if the file has commits beyond the initial scaffold commit, preserve it)

### Step 5: Commit

```bash
git add -A
git commit -m "docs: remove doc scaffold"
```

If nothing was removed, skip the commit.

## Error Handling

- If `$TEMPLATES` directory doesn't exist: error "Templates not found at ~/.claude/code-review/standards/templates/. Run install.sh first."
- If not in a git repo: error "Not a git repository."
- If `gh` CLI is unavailable during `--backfill`: warn and continue without PR data.
- If `git mv` fails during `--upgrade` (file already exists at target): warn, skip that file, continue.
- All modes: if nothing changed, skip the commit rather than creating an empty commit.
