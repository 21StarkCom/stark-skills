# stark-release

Cut a new release — reviews unreleased CHANGELOG entries, bumps version (patch/minor/major), creates git tag, and optionally creates a GitHub Release with notes. Use when the user says "release", "cut a version", "tag a release", "bump version", or invokes /stark-release.

## Workflow Overview

```mermaid
graph TD
  Start([User invokes /stark-release]) --> Preflight{Clean main branch?}
  
  Preflight -- No --> Abort1((Abort & Prompt User))
  Preflight -- Yes --> GetTag[Get Latest Tag / Baseline 0.1.0]
  
  GetTag --> CheckCL{CHANGELOG valid<br>& unreleased items?}
  
  CheckCL -- No --> Abort2((Abort: Nothing to Release))
  CheckCL -- Yes --> DetBump[Determine Next Version<br>Auto-detect or Apply Arg]
  
  DetBump --> UpdateFiles[Bump __init__.py<br>& update CHANGELOG.md]
  UpdateFiles --> Commit[Commit Changes]
  Commit --> Tag[Create Git Tag]
  
  Tag --> Push[git push origin main<br>& push tag]
  Push --> GHRel[Create GitHub Release<br>using user PAT]
  GHRel --> End([Show Execution Summary])
```

![A documentation page titled 'stark-release - Skill Visualization' showing a flowchart of the release management process including pre-flight checks, changelog review, file updates, and GitHub release creation, alongside rules and failure modes.](usage.png)

## When to Use

Cut a new release — reviews unreleased CHANGELOG entries, bumps version (patch/minor/major), creates git tag, and optionally creates a GitHub Release with notes. Use when the user says "release", "cut a version", "tag a release", "bump version", or invokes /stark-release.

## Prerequisites

*See SKILL.md*

## Arguments

`[patch|minor|major] (optional — will ask if not provided)`



## Quick Start

/stark-release

## Common Patterns



## Troubleshooting



## Related Skills


