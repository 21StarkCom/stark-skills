# stark-release

Cut a new release — reviews unreleased `CHANGELOG.md` entries, auto-generates them from git log when needed, bumps version (patch/minor/major), creates git tag, and optionally creates a GitHub Release with notes. Use when the user says "release", "cut a version", "tag a release", "bump version", or invokes /stark-release.

## Workflow Overview

```mermaid
graph TD
    A["1. Pre-flight Check"] --> B{"Clean main branch?"}
    B -->|No| ABORT1["ABORT: Dirty tree or wrong branch"]
    B -->|Yes| C["2. Get Current Version from git tags"]
    C --> D["3. Gather unreleased changes"]
    D --> E{"CHANGELOG [Unreleased] has entries?"}
    E -->|Yes| F{"Bump type specified?"}
    E -->|No| G{"Commits since last tag?"}
    G -->|No| ABORT2["ABORT: Nothing to release"]
    G -->|Yes| H["3b. Auto-generate entries from git log"]
    H --> F
    F -->|Yes| I["4. Use provided bump type"]
    F -->|No| J["4. Auto-detect: Fixed→patch, Added→minor, Breaking→major"]
    I --> K["5. Update detected version file(s)"]
    J --> K
    K --> L["6. Update CHANGELOG: write release section"]
    L --> M["6b. Commit: release: vX.Y.Z"]
    M --> N["7. Create annotated git tag vX.Y.Z"]
    N --> O["8. Push main + tag to origin"]
    O --> P["9. gh release create vX.Y.Z"]
    P --> Q["10. Print release summary"]

    style A fill:#1e40af,color:#fff
    style C fill:#047857,color:#fff
    style D fill:#1e40af,color:#fff
    style F fill:#7c3aed,color:#fff
    style G fill:#7c3aed,color:#fff
    style H fill:#1e40af,color:#fff
    style I fill:#7c3aed,color:#fff
    style J fill:#7c3aed,color:#fff
    style K fill:#1e40af,color:#fff
    style L fill:#1e40af,color:#fff
    style M fill:#1e40af,color:#fff
    style N fill:#f59e0b,color:#1a1a1a
    style O fill:#e5e7eb,color:#666
    style P fill:#f59e0b,color:#1a1a1a
    style Q fill:#f59e0b,color:#1a1a1a
    style ABORT1 fill:#dc2626,color:#fff
    style ABORT2 fill:#dc2626,color:#fff
    style B fill:#7c3aed,color:#fff
    style E fill:#7c3aed,color:#fff
```

![Usage guide for the stark-release skill showing a 10-step vertical workflow diagram. Steps flow from pre-flight checks and version detection into change assembly from CHANGELOG or git log, then into bump selection, detected version-file updates, CHANGELOG release writing, commit, tag, push, GitHub Release creation, and a final summary. The failure branch only aborts when the branch is dirty or there is nothing to release after checking both CHANGELOG and git history.](usage.png)

## When to Use

Cut a new release — reviews unreleased `CHANGELOG.md` entries, auto-generates them from git log when needed, bumps version (patch/minor/major), creates git tag, and optionally creates a GitHub Release with notes. Use when the user says "release", "cut a version", "tag a release", "bump version", or invokes /stark-release.

## Prerequisites

Must be on a clean `main` branch with no uncommitted changes. `gh` CLI must be authenticated with the user's PAT (not a bot token). A `CHANGELOG.md` file must exist with an `[Unreleased]` section. Git tags must follow semver format `vX.Y.Z`, but the skill can fall back to full history when no tag exists yet.

## Arguments

`[patch|minor|major] (optional — auto-detected if omitted)`

| Argument | Required | Description |
|----------|----------|-------------|
| `patch` | No | Bug fixes, small corrections (0.1.2 → 0.1.3) |
| `minor` | No | New features, session deliverables (0.1.3 → 0.2.0) |
| `major` | No | Breaking changes, major milestones (0.2.0 → 1.0.0) |
| *(omitted)* | — | Auto-detects from assembled CHANGELOG or git-log categories |

## Quick Start

`/stark-release` — assembles release notes from CHANGELOG entries or git log, auto-detects the bump type, and cuts the release.

## Common Patterns

**Patch release after bug fix:**
`/stark-release patch`
Bumps patch version (e.g., 0.2.1 → 0.2.2), tags, and creates GitHub Release.

**Feature release with auto-detection:**
`/stark-release`
Reads `CHANGELOG.md` first; if `[Unreleased]` is empty, it backfills notes from git log before choosing the bump.

**Explicit major bump:**
`/stark-release major`
For breaking changes or major milestones (e.g., 0.3.0 → 1.0.0).

## Troubleshooting

**"Not on main" error:** Run `git checkout main && git pull --rebase origin main` first.

**"Empty [Unreleased]" case:** If there are commits since the last tag, the skill auto-generates release notes from git log. If there are no changelog entries and no commits, it aborts with nothing to release.

**"Tag already exists" error:** The version was already released — the skill will suggest the next available version.

**Push fails:** Run `git pull --rebase origin main` and retry. The tag and commit exist locally.

**GitHub Release not created:** Verify `gh auth status`. Ensure `GH_TOKEN` is unset so `gh` uses your native PAT.

## Related Skills

`/stark-pr-flow`, `/stark-session`, `/stark-phase-execute`
