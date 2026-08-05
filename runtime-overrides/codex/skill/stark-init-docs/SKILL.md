---
name: stark-init-docs
description: >-
  Scaffold dev docs structure (template/backfill/upgrade/clean modes). Use for init docs, setup docs, scaffold docs.
argument-hint: "[--template] [--backfill] [--upgrade] [--clean]"
disable-model-invocation: true
model: opus
revision: ea827b2dd463a563417f2dd86c31248eb42b5cfb
revision_date: 2026-04-10T17:10:53+03:00
---

## Help

If the invocation arguments contain a standalone `--help`, `-h`, or `help` token,
follow [standard help](../../standards/help.md): print this skill's purpose,
usage, and arguments, then stop — do not run preflight or any phase.

# init-docs

Scaffold a standardized developer documentation structure into any repository. Four modes that can be combined (e.g., `--upgrade --backfill`).

## Arguments

- `--template` — create empty docs skeleton with standard directories and config files
- `--backfill` — generate docs content from git history, merged PRs, and codebase analysis
- `--upgrade` — migrate existing scattered Markdown docs into standard layout
- `--clean` — remove skeleton files (preserves user-generated content)
- Modes are combinable: `--upgrade --backfill` migrates existing docs then generates new ones
- If no arguments given, show the four options and ask which mode to use

Parse mode flags directly from the user's current request after the explicitly
invoked skill name.

## Constants

```bash
if [ -d "skill/stark-init-docs" ] && [ -d "standards/templates" ]; then
  TEMPLATES="$(pwd)/standards/templates"
else
  ASSET_ROOT="${STARK_ASSET_ROOT:-${STARK_PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT:-}}}"
  TEMPLATES="${ASSET_ROOT:+$ASSET_ROOT/standards/templates}"
fi
[ -n "${TEMPLATES:-}" ] && [ -d "$TEMPLATES" ] || {
  echo "bundled standards/templates directory not found; reinstall the skill bundle" >&2
  exit 1
}
```

Resolve `TEMPLATES` at the point of use; do not assume a variable from an
earlier shell call still exists.

Before any mutating mode, require a git repository and check
`git diff --cached --quiet`. If unrelated changes are already staged, stop and
ask the user to commit or unstage them; this skill's commits must never absorb a
pre-existing index. Record the initial `git status --short` and preserve every
unrelated path.

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
mkdir -p docs/{adr,specs,retros,guides,reference,architecture}
```

### Step 2: Copy templates

Copy from `$TEMPLATES` to the repo, substituting placeholders:

| Source | Destination | Substitutions |
|--------|-------------|---------------|
| `adr-template.md` | `docs/adr/0000-template.md` | none |
| `mkdocs.yml` | `mkdocs.yml` (repo root) | `__REPO_NAME__` → directory name of repo root |
| `pull_request_template.md` | `.github/pull_request_template.md` | none |
| `doc-staleness.yml` | `.doc-staleness.yml` (repo root) | none |
| `docs-index.md` | `docs/index.md` | `__REPO_NAME__` → directory name of repo root |

For each file: if the destination already exists, skip it and log "Skipping {path} (already exists)".

Create `.github/` directory if needed for the PR template.

### Step 3: CODEOWNERS

If `CODEOWNERS` or `.github/CODEOWNERS` does not exist:

```bash
set -euo pipefail
if [ -d "standards/templates" ] && [ -f "skill/stark-init-docs/SKILL.md" ]; then
  TEMPLATES="$(pwd)/standards/templates"
else
  ASSET_ROOT="${STARK_ASSET_ROOT:-${STARK_PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT:-}}}"
  TEMPLATES="${ASSET_ROOT:+$ASSET_ROOT/standards/templates}"
fi
[ -f "$TEMPLATES/CODEOWNERS" ] || { echo "CODEOWNERS template missing" >&2; exit 1; }
if [ ! -e CODEOWNERS ] && [ ! -e .github/CODEOWNERS ]; then
  owner="$(gh api user --jq .login 2>/dev/null || printf 'OWNER')"
  mkdir -p .github
  sed "s/__OWNER__/$owner/g" "$TEMPLATES/CODEOWNERS" > .github/CODEOWNERS
fi
```

The GitHub login is a valid CODEOWNERS token; a display name from
`git config user.name` may contain spaces and is not. If CODEOWNERS already
exists anywhere in the repo, skip.

### Step 4: Commit

```bash
set -euo pipefail
paths=(docs mkdocs.yml .doc-staleness.yml .github/pull_request_template.md .github/CODEOWNERS)
existing=()
for path in "${paths[@]}"; do [ -e "$path" ] && existing+=("$path"); done
[ "${#existing[@]}" -gt 0 ] && git add -- "${existing[@]}"
git diff --cached --quiet || git commit -m "docs: scaffold dev docs structure"
```

If nothing was added (all files already existed), skip the commit.

## `--backfill` Mode

Generate documentation content from repository history and codebase analysis.

### Step 1: Run `--template`

Execute the full `--template` mode first to ensure the directory structure exists.

### Step 2: Gather repository data

```bash
set -euo pipefail
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/stark-init-docs.XXXXXX")"
git log --oneline --all -200 > "$TMP_DIR/commits.txt"
if command -v gh >/dev/null && \
   gh pr list --state merged --limit 50 --json number,title,body,mergedAt \
     > "$TMP_DIR/prs.json" 2>/dev/null; then
  :
else
  printf '[]\n' > "$TMP_DIR/prs.json"
  echo "Could not fetch PR history; continuing with commits and codebase only" >&2
fi
printf '%s\n' "$TMP_DIR"
```

Record the printed temporary directory for this run; do not assume a shell
variable survives into a later call.

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

For ADRs going forward, prefer `brain adr new "<title>"` (the `stark-adr` skill), which auto-numbers and renders this same template; this backfill step is only for bootstrapping historical decisions. The layout follows the doc convention `docs/{adr,specs,retros}/` (folder per type — `adr` stays the established acronym, the rest are plural; see `stark-2nd-brain-cli/docs/CONVENTIONS.md`). There is **no `docs/plans/`** — the spec carries the plan.

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
set -euo pipefail
paths=(docs mkdocs.yml)
existing=()
for path in "${paths[@]}"; do [ -e "$path" ] && existing+=("$path"); done
[ "${#existing[@]}" -gt 0 ] && git add -- "${existing[@]}"
git diff --cached --quiet || git commit -m "docs: backfill docs from repo history"
```

## `--upgrade` Mode

Migrate existing scattered Markdown docs into the standard layout.

### Step 1: Scan for existing docs

Build a candidate list from tracked Markdown outside `docs/`. The following are
**immutable locations**, not migration candidates:

- every `AGENTS.md` and `CLAUDE.md`, at any depth;
- generated or vendored trees whose path contains `generated/`, `vendor/`,
  `catalog/`, or `dist/`;
- build/dependency output such as `node_modules/`, `build/`, `target/`,
  `coverage/`, and `.next/`;
- host/repository control directories such as `.github/`, `.openai/`,
  `.claude/`, and `.codex/`;
- root policy/community files: `README.md`, `CHANGELOG.md`, `CONTRIBUTING.md`,
  and license files.

Use explicit exclude pathspecs rather than scanning broadly and relying only on
later classification:

```bash
git ls-files '*.md' \
  ':(exclude)docs/**' \
  ':(exclude)AGENTS.md' ':(exclude)CLAUDE.md' \
  ':(exclude)**/AGENTS.md' ':(exclude)**/CLAUDE.md' \
  ':(exclude)generated/**' ':(exclude)**/generated/**' \
  ':(exclude)vendor/**' ':(exclude)**/vendor/**' \
  ':(exclude)catalog/**' ':(exclude)**/catalog/**' \
  ':(exclude)dist/**' ':(exclude)**/dist/**' \
  ':(exclude)node_modules/**' ':(exclude)**/node_modules/**' \
  ':(exclude)build/**' ':(exclude)**/build/**' \
  ':(exclude)target/**' ':(exclude)**/target/**' \
  ':(exclude)coverage/**' ':(exclude)**/coverage/**' \
  ':(exclude).next/**' ':(exclude)**/.next/**' \
  ':(exclude).github/**' ':(exclude).openai/**' \
  ':(exclude).claude/**' ':(exclude).codex/**' \
  ':(exclude)README.md' ':(exclude)CHANGELOG.md' \
  ':(exclude)CONTRIBUTING.md' ':(exclude)LICENSE.md' ':(exclude)LICENSE'
```

Before classification, also skip any candidate whose first 20 lines contain a
generated-file marker such as `DO NOT EDIT`, `Code generated`, or `Generated by`.
These content guards are additive: no later instruction may override the path
exclusions above.

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
set -euo pipefail
source="<candidate-from-step-1>"
classification="<adr|spec|guide|reference|architecture>"
base="$(basename -- "$source")"
case "$base" in
  AGENTS.md|CLAUDE.md) echo "Skipping protected $source"; exit 0 ;;
esac
case "/$source/" in
  */generated/*|*/vendor/*|*/catalog/*|*/dist/*)
    echo "Skipping generated/vendor path $source"; exit 0 ;;
esac
if sed -n '1,20p' "$source" | grep -Eqi 'DO NOT EDIT|Code generated|Generated by'; then
  echo "Skipping generated file $source"; exit 0
fi
case "$classification" in
  spec) target_dir="specs" ;;
  guide) target_dir="guides" ;;
  adr|reference|architecture) target_dir="$classification" ;;
  *) echo "Unknown classification: $classification" >&2; exit 1 ;;
esac
target="docs/$target_dir/$base"
mkdir -p "$(dirname -- "$target")"
git mv -- "$source" "$target"
```

Replace the two placeholders before running. Preserve original filenames. If a
naming conflict exists, prefix with the source directory name. Re-run the same
protected-path checks after choosing the target; never move a protected file
because classification or collision handling changed its name.

### Step 4: Update internal links

After all moves, scan all Markdown files in the repo for broken internal links:

- Find links matching a moved Markdown path, for example `text -> docs/old-path.md`
- Update to the new path relative to the linking file
- Also update any relative image references
- Never rewrite files in the immutable locations from Step 1; report a stale
  generated/vendor link for its owner to regenerate instead.

### Step 5: Update mkdocs.yml

If `mkdocs.yml` exists, update its `nav` section to reflect the new file locations. If it doesn't exist, `--template` will create it in the next step.

### Step 6: Run `--template` to fill gaps

Execute `--template` mode to create any missing directories and config files.

### Step 7: Commit

Stage only the exact source/target paths moved by Step 3, the exact hand-authored
Markdown files changed in Step 4, and scaffold files created by `--template`.
Never use `git add -A`: unrelated or generated work may already be present.
Commit those staged paths as `docs: upgrade to standard doc structure`. If the
staged set is empty, skip the commit.

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

Stage only the scaffold paths actually removed in Step 2 and commit them as
`docs: remove doc scaffold`. Never use `git add -A`.

If nothing was removed, skip the commit.

## Error Handling

- If the resolved templates directory doesn't exist: stop and ask the user to
  reinstall or update the bundle using the current host runtime's package
  mechanism. Do not guess a Claude-only install path or command.
- If not in a git repo: error "Not a git repository."
- If `gh` CLI is unavailable during `--backfill`: warn and continue without PR data.
- If `git mv` fails during `--upgrade` (file already exists at target): warn, skip that file, continue.
- All modes: if nothing changed, skip the commit rather than creating an empty commit.
