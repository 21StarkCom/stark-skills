# stark-rename-project — Internals

Rename a project locally and on GitHub, update all references in sibling repos, and reinstall symlinks. Use when the user says "rename project", "rename repo", "rename this to", or invokes /stark-rename-project.

## Architecture

```mermaid
graph TD
  A[Start / Validate Args] --> B{Detect Resumable State}
  B -->|Resume P3| G
  B -->|Resume P2| E
  B -->|Resume P3b| H
  B -->|No Resume| C[Pre-flight Checks]

  C --> D{Dry Run?}
  D -->|Yes| DRY[Skip to Summaries]
  D -->|No| E[Phase 2: GitHub Rename API]
  
  E --> F[Update Git Remotes via Perl]
  F --> G[Phase 3a: mv Local Directory]
  G --> H[Phase 3b: Uninstall Old Symlinks]
  H --> I[Phase 4: Update Internal Ref Patterns]
  
  I --> J{Errors in install.sh?}
  J -->|Yes| ERR[Halt Execution]
  J -->|No| K[Phase 5: Find Sibling Repos]
  
  K --> L[Update Sibling Ref Patterns]
  L --> M[Auto-commit Specific Files]
  M --> N[Phase 6: Reinstall Symlinks via install.sh]
  
  N --> O[Phase 7: Verify Links, Remotes, Residuals]
  O --> P[Phase 8: Summary Report]
```

![A technical HTML visualization containing an execution flow diagram, data patterns grid, and resumable state table mapping out the stark-rename-project skill's internal architecture.](internals.png)

## Phases

*See SKILL.md*

## Config

*No config*

## Failure Modes

*See SKILL.md*

## How to Modify This Skill

Edit `skill/stark-rename-project/SKILL.md`, then run `/stark-generate-docs --skill stark-rename-project` to regenerate documentation.
