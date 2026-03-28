---
name: stark-release
description: Cut a new release — reviews unreleased CHANGELOG entries, bumps version (patch/minor/major), creates git tag, and optionally creates a GitHub Release with notes. Use when the user says "release", "cut a version", "tag a release", "bump version", or invokes /stark-release.
argument-hint: [patch|minor|major] (optional — will ask if not provided)
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
- **Runtime version:** `src/infra_pulse/__init__.py` (`__version__`) — MUST be bumped to match the tag.
- **No pyproject.toml changes.** The `version = "0.1.0"` in pyproject.toml is static.
  If dynamic versioning is needed later, add `setuptools-scm`.
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

- If tags exist → parse into `major.minor.patch`.
- If no tags → baseline is `0.1.0`.

Store as `$CURRENT_VERSION`.

---

## Step 3: Review Unreleased Changes

Read `CHANGELOG.md` and extract the `## [Unreleased]` section.

**If CHANGELOG.md doesn't exist:** Abort — nothing to release. Tell user to run
`/fix-bug` or manually add CHANGELOG entries first.

**If `[Unreleased]` section is empty:** Abort — nothing to release.

Present the changes:
```
Unreleased changes since v${CURRENT_VERSION}:
──────────────────────────────────────────────

### Fixed
- Dashboard scope churn wrong for Core (#42)
- Sprint report missing committed points (#43)

### Added
- [any feature entries]

### Changed
- [any modification entries]
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

## Step 5: Bump `__version__`

Update `src/infra_pulse/__init__.py` to the new version:

```python
__version__ = "${NEXT_VERSION}"
```

This is the runtime version source of truth (displayed in UI, API, logs).

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

Commit both files together:
```bash
git add CHANGELOG.md src/infra_pulse/__init__.py
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
| Empty [Unreleased] | Abort — nothing to release |
| Tag already exists | Error — that version is taken, suggest next |
| Push fails | `git pull --rebase origin main`, retry |
| `gh` auth fails | Verify `gh auth status` — user's PAT must be active |

## Observability

Follow the [Skill Observability Protocol](~/.claude/code-review/standards/observability.md) for all timing, checkpoints, and metrics reporting.

Additional skill-specific metrics:
- Version: previous → new, bump type (patch/minor/major)
- CHANGELOG entries: count by category (Fixed/Added/Changed)
- Tag created, GitHub Release created (yes/no)
- Push duration

### Event emission

After the release summary, emit a completion event to stark-insights:

```bash
$SCRIPTS/stark-emit skill_invocation \
  skill=stark-release duration_s=$TOTAL_SECONDS success=$SUCCESS \
  version=$VERSION bump_type=$BUMP
```

Substitute actual values from the run. If stark-insights is not running, this fails silently.

## Mistakes to Avoid

- **Don't bump pyproject.toml.** Tags are the version source.
- **Always bump `src/infra_pulse/__init__.py`.** This is the runtime `__version__` — if you skip it, the deployed app still shows the old version.
- **Don't set GH_TOKEN.** Releases use the user's PAT via native `gh` auth. Releases should show as created by the user, not a bot.
- **Don't release with empty [Unreleased].** Always verify content exists.
- **Don't leave [Unreleased] content behind.** Move ALL entries to the versioned section.
- **Don't create the tag before committing CHANGELOG.** Commit first, then tag (so the
  tag points to the commit that contains the updated CHANGELOG).
