---
name: stark-release
description: >-
  Cut a release: changelog review (auto-generating from git log if [Unreleased] is empty), version bump, git tag, GitHub Release. Use for release, tag, bump version.
argument-hint: [patch|minor|major] (optional — auto-detected if omitted)
disable-model-invocation: true
model: sonnet
revision: 8a249169623b83c1677dcda2bee230a3dd9fa8d1
revision_date: 2026-04-27T18:17:48Z
---

# Release Management

Reviews accumulated changes in CHANGELOG.md, bumps the version, creates a git tag,
and optionally publishes a GitHub Release. Version source of truth is git tags (semver).

## Prerequisites

Must be on a clean main branch:

```bash
# Use user's PAT for all release operations (PRs, tags, releases show as user)
unset GH_TOKEN
REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner)

git checkout main && git pull --rebase origin main
git status --porcelain  # must be empty
```

Abort if uncommitted changes or not on main. Stash or commit first.

## Versioning Rules

- **Source of truth:** Git tags. Format: `v{major}.{minor}.{patch}` (e.g., `v0.1.3`).
- **Version file(s):** Auto-detect and update every supported version file found in the repo (Python, Node, Rust). If no version file exists, the git tag alone carries the version.
- **Baseline:** If no tags exist, baseline is `0.1.0` from pyproject.toml.
- **Bump semantics:**
  - `patch` — bug fixes, small corrections (0.1.2 → 0.1.3)
  - `minor` — new features, session deliverables (0.1.3 → 0.2.0)
  - `major` — breaking changes, major milestones (0.2.0 → 1.0.0)

---

## Step 1: Pre-flight

```bash
git checkout main && git pull --rebase origin main
```

Verify clean tree:
```bash
git status --porcelain
```

If not clean → abort with message to user.

---

## Step 1.5: Pre-tag Terraform drift gate

Skip this step entirely if the repo has no `infra/terraform/` directory.

If commits since `$LAST_TAG` (or all commits if there is no tag yet) touched
`infra/terraform/`, an un-applied plan will block CD's drift gate AFTER
the migration has already run — leaving the env in a half-deployed state.
Catch it here, before the tag exists.

```bash
if [ -d infra/terraform ]; then
  # Self-contained: don't depend on $LAST_TAG being set yet (Step 2
  # owns it). Re-derive locally so the drift gate works even if a
  # caller runs Step 1.5 standalone.
  LAST_TAG_LOCAL=$(git tag --sort=-v:refname | head -1)
  if [ -n "$LAST_TAG_LOCAL" ]; then
    TF_TOUCHED=$(git diff --name-only "$LAST_TAG_LOCAL"..HEAD -- infra/terraform/ | head -1)
  else
    TF_TOUCHED=$(git ls-files infra/terraform/ | head -1)
  fi
  if [ -n "$TF_TOUCHED" ]; then
    echo "TF changes since ${LAST_TAG_LOCAL:-<root>} — running drift check before tagging…"
    pushd infra/terraform >/dev/null
    # Mirror the env CD's drift step uses (see .github/workflows/cd.yml
    # "Terraform drift check"); falling back to repo-detected defaults
    # when CD-specific TF_VARs aren't already in the env.
    export TF_IN_AUTOMATION=1 TF_INPUT=0
    : "${TF_VAR_project_id:=$(gcloud config get-value project 2>/dev/null)}"
    export TF_VAR_project_id
    terraform init -input=false >/dev/null
    set +e
    terraform plan -detailed-exitcode -input=false -no-color
    PLAN_EXIT=$?
    set -e
    popd >/dev/null
    # `terraform plan -detailed-exitcode`: 0=clean, 1=error, 2=diff.
    if [ "$PLAN_EXIT" -eq 2 ]; then
      cat <<'EOF'
ABORT: Terraform plan shows un-applied drift in infra/terraform/.

If you tag now, CD's migration step will run against prod, then the
drift gate will fail and the deploy will be skipped — leaving the DB
migrated but the app/jobs un-rolled.

Fix:
  cd infra/terraform
  terraform apply
…then re-run /stark-release.
EOF
      exit 1
    fi
    if [ "$PLAN_EXIT" -ne 0 ]; then
      echo "ABORT: terraform plan errored (exit $PLAN_EXIT). Investigate before tagging." >&2
      exit 1
    fi
  fi
fi
```

Why this is here, not in CD: CD's drift gate runs *after* the
`alembic upgrade head` step. By the time it fails, the DB is already
migrated and the only safe recovery is to apply TF and re-run the
deploy under time pressure (config caches expire in minutes). Catching
the drift before the tag exists keeps the migration + deploy atomic.

---

## Step 2: Determine Current Version

Get the latest tag:
```bash
git tag --sort=-v:refname | head -1
```

- If tags exist → parse into `major.minor.patch` and store the tag as `$LAST_TAG`.
- If no tags → baseline is `0.1.0` and leave `$LAST_TAG` empty.

Store as `$CURRENT_VERSION`.

---

## Step 3: Gather Unreleased Changes

```bash
TOOLS="$HOME/.claude/code-review/tools"
CHANGES_JSON=$(node --experimental-strip-types "$TOOLS/release_changelog.ts" --json)
```

The tool reads `CHANGELOG.md`, then falls back to `git log <last-tag>..HEAD`
when `[Unreleased]` is empty, and categorizes commits by Conventional Commits
prefix into Added / Fixed / Changed (with `**BREAKING:**` markers for breaking
changes). It also returns a `recommendedBump` field that Step 4 can use
directly.

JSON shape: `{ source, lastTag, added[], fixed[], changed[], hasBreaking,
totalEntries, recommendedBump }`. Source values: `changelog` (used existing
entries), `git-log` (auto-generated), `empty` (nothing to release).

- If CHANGELOG.md is missing → tool exits 2 with the missing-file message; abort.
- If `source == "empty"` → abort with "No commits to release."
- Otherwise present the categorized sections from the JSON.

When `source == "git-log"`, Step 6 will write these entries directly into the
new versioned section and leave `[Unreleased]` empty (same end state as when
entries came from the CHANGELOG).

---

## Step 4: Determine Bump Type

If `$ARGUMENTS` contains `patch`, `minor`, or `major` → use that.

Otherwise, analyze the unreleased changes and auto-select:
- Only `### Fixed` entries → `patch`
- Has `### Added` entries → `minor`
- Has `### Changed` with breaking changes → `major`

Calculate `$NEXT_VERSION` accordingly. Do NOT ask for confirmation — proceed automatically.

---

## Step 5: Bump Version in Source

```bash
BUMP_JSON=$(node --experimental-strip-types "$TOOLS/release_version_bump.ts" \
  --version "$NEXT_VERSION" --json)
```

The tool auto-detects every supported version file and rewrites each one:

- `src/*/__init__.py` or `*/__init__.py` containing `__version__` (Python)
- `pyproject.toml` with `version = "X.Y.Z"` (skipped when `[tool.setuptools-scm]` is present)
- `package.json` with `"version"` (Node — preserves indentation)
- `Cargo.toml` `[package]` `version =` (Rust — does NOT touch dep versions)
- Go projects have no version file; the git tag alone carries the version.

Receipt shape: `{ version, dryRun, filesUpdated[{path, ecosystem, previous}],
filesSkipped[{path, reason}] }`. If `filesUpdated` is empty AND `filesSkipped`
is empty, warn: "No version file detected — only the git tag will carry the
version." and continue.

For monorepos the tool updates ALL detected files for consistency.

---

## Step 6: Update CHANGELOG

Move `[Unreleased]` content to a new versioned section. The `[Unreleased]` section
stays but becomes empty.

Before:
```markdown
## [Unreleased]

### Fixed
- Bug A (#42)
- Bug B (#43)
```

After:
```markdown
## [Unreleased]

## [v0.1.3] - 2026-03-02

### Fixed
- Bug A (#42)
- Bug B (#43)
```

Commit the changelog and any updated version files together:
```bash
git add CHANGELOG.md ${VERSION_FILES}
git commit -m "release: v${NEXT_VERSION}

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

## Step 7: Create Tag

```bash
git tag -a v${NEXT_VERSION} -m "Release v${NEXT_VERSION}

Changes:
[bullet list from CHANGELOG for this version]"
```

---

## Step 8: Push

```bash
git push origin main
git push origin v${NEXT_VERSION}
```

---

## Step 9: GitHub Release

If the repo has a release-publishing workflow that triggers on `v*.*.*`
tag push (`.github/workflows/release.yml` with `on: push: tags: - "v*.*.*"`),
**skip this step** — the workflow creates the Release from the CHANGELOG
itself. Manually creating the release in parallel produces a `view → create`
race that fails the workflow run with HTTP 422 `already_exists` (see
stark-night-watch run 26380137617).

```bash
# Detect: does a tag-triggered release workflow exist?
if grep -lE '^\s*-\s*"v\*\.\*\.\*"' .github/workflows/*.y*ml 2>/dev/null | \
   xargs grep -l 'release create' 2>/dev/null | head -1; then
  echo "Tag-triggered release workflow detected — workflow will create the GH Release."
  RELEASE_URL="https://github.com/${REPO}/releases/tag/v${NEXT_VERSION}"
else
  gh release create v${NEXT_VERSION} \
    --repo $REPO \
    --title "v${NEXT_VERSION}" \
    --notes "[CHANGELOG content for this version, formatted as markdown]"
  RELEASE_URL="(from gh release create output)"
fi
```

Repos with a release workflow today: `stark-night-watch`.
Repos without one (skill still creates the release): everything else.

---

## Step 10: Summary

```
Release Complete
────────────────
Version:    v${NEXT_VERSION}
Tag:        v${NEXT_VERSION}
Previous:   v${CURRENT_VERSION}
Changes:    N fixed, N added, N changed
GH Release: [URL or "skipped"]
Commit:     [hash]
```

---

## Failure Modes

| Failure | Recovery |
|---------|----------|
| Not on main | Prompt to `git checkout main` |
| Dirty working tree | Prompt to stash or commit |
| No CHANGELOG.md | Abort — nothing to release |
| Empty [Unreleased] | Auto-generate entries from git log since last tag (see Step 3) |
| Empty [Unreleased] AND no commits since last tag | Abort — nothing to release |
| Tag already exists | Error — that version is taken, suggest next |
| Push fails | `git pull --rebase origin main`, retry |
| `gh` auth fails | Verify `gh auth status` — user's PAT must be active |
| Release workflow + skill both try to create the GH Release | Skill must skip Step 9 when `.github/workflows/*.yml` has a `v*.*.*` tag trigger that runs `gh release create`. See Step 9. |
| TF drift detected (Step 1.5) | `cd infra/terraform && terraform apply`, then re-run `/stark-release`. Do NOT skip — CD will fail the drift gate *after* migrating, leaving the env half-deployed. |

## Observability

Standard observability: create task, emit timestamped logs, record metrics block (version prev→new, bump type, CHANGELOG entries by category, tag/release created, push duration), emit: `$SCRIPTS/stark-emit skill_invocation skill=stark-release duration_s=... success=... version=... bump_type=...`. See [../../standards/observability.md](../../standards/observability.md).
