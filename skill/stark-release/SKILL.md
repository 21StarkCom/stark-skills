---
name: stark-release
description: >-
  Cut a release: changelog review (auto-generating from git log if [Unreleased] is empty), version bump, git tag, GitHub Release. Use for release, tag, bump version.
argument-hint: [patch|minor|major] (optional — auto-detected if omitted)
disable-model-invocation: true
model: sonnet
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

Read `CHANGELOG.md` and extract the `## [Unreleased]` section.

**If CHANGELOG.md doesn't exist:** Abort — tell user to create one or run `/fix-bug` first.

**If `[Unreleased]` section has entries:** Use them as-is and skip to presentation below.

**If `[Unreleased]` section is empty:** Auto-generate entries from commits since the last tag, or from full repo history if no tag exists yet. Do **NOT** abort.

```bash
if [ -n "$LAST_TAG" ]; then
  git log "$LAST_TAG"..HEAD --no-merges --format='%s%n%b%x1e'
else
  git log --no-merges --format='%s%n%b%x1e'
fi
```

Parse each record as:
- first line = subject
- remaining lines = body

Categorize each commit by its Conventional Commits subject prefix:

| Prefix | CHANGELOG category |
|--------|-------------------|
| `feat(…)` / `feat:` | `### Added` |
| `fix(…)` / `fix:` | `### Fixed` |
| `refactor`, `chore`, `docs`, `style`, `perf`, `build`, `ci`, `test` | `### Changed` |
| `feat!`, `fix!`, or body contains `BREAKING CHANGE:` | `### Changed` with bullet prefixed `**BREAKING:**` |
| Anything else (no recognizable prefix) | `### Changed` |

For each commit:
1. Strip the leading `<type>(<scope>)?!?:\s*` prefix.
2. Keep any trailing `(#NNN)` PR references intact.
3. Retain the scope (e.g. `calendar: …`) as a short prefix so readers see which subsystem was touched.
4. Write as a bullet under the appropriate category.

Example — `feat(calendar): read vacations from personAbsences (#341) (#348)` becomes:
```
### Added
- calendar: read vacations from personAbsences (#341) (#348)
```

**If both the `[Unreleased]` section AND the git log are empty** → Abort with "No commits to release."

When auto-generated, Step 6 will write these entries directly into the new versioned section and leave `[Unreleased]` empty (same end state as when entries came from the CHANGELOG).

**Present the assembled changes** (whether read from CHANGELOG or generated):
```
Unreleased changes since v${CURRENT_VERSION}:
──────────────────────────────────────────────
[source: CHANGELOG | auto-generated from git log]

### Added
- ...

### Fixed
- ...

### Changed
- ...
```

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

Auto-detect the project's version file and update it. Check in this order (stop at first match):

| Ecosystem | File Pattern | Version Pattern |
|-----------|-------------|-----------------|
| Python | `src/*/__init__.py` or `*/__init__.py` with `__version__` | `__version__ = "X.Y.Z"` |
| Python | `pyproject.toml` with `version = "X.Y.Z"` (only if `[tool.setuptools-scm]` is NOT present) | `version = "X.Y.Z"` |
| Node | `package.json` with `"version"` | `"version": "X.Y.Z"` |
| Rust | `Cargo.toml` with `version =` | `version = "X.Y.Z"` |
| Go | No version file bump needed — Go uses git tags exclusively | skip |

```bash
# Python: search for __version__
grep -rl '__version__' src/ *.py 2>/dev/null | head -1

# Node: check package.json
[ -f package.json ] && grep -q '"version"' package.json && echo "package.json"

# Rust: check Cargo.toml
[ -f Cargo.toml ] && grep -q '^version' Cargo.toml && echo "Cargo.toml"
```

Update the detected file to `${NEXT_VERSION}`. If no version file is found, warn: "No version file detected — only the git tag will carry the version." and skip this step.

If multiple version files exist (e.g., both `__init__.py` and `package.json` in a monorepo), update ALL of them for consistency.

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

Always create a GitHub Release — no confirmation needed:

```bash
gh release create v${NEXT_VERSION} \
  --repo $REPO \
  --title "v${NEXT_VERSION}" \
  --notes "[CHANGELOG content for this version, formatted as markdown]"
```

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

## Observability

Standard observability: create task, emit timestamped logs, record metrics block (version prev→new, bump type, CHANGELOG entries by category, tag/release created, push duration), emit: `$SCRIPTS/stark-emit skill_invocation skill=stark-release duration_s=... success=... version=... bump_type=...`. See [../../standards/observability.md](../../standards/observability.md).
