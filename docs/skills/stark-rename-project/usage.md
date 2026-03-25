# stark-rename-project

Rename a project locally and on GitHub, update all references in sibling repos, and reinstall symlinks. Use when the user says "rename project", "rename repo", "rename this to", or invokes /stark-rename-project.

## Workflow Overview

```mermaid
graph TD
  A[Invoke /stark-rename-project] --> B{Dry Run?}
  B -- Yes --> C[Preview Changes & Exit]
  B -- No --> D[Phase 1: Validate & Pre-flight]
  D --> E[Phase 2: Rename on GitHub]
  E --> F[Phase 3: Local Rename & Clean Symlinks]
  F --> G[Phase 4: Update Project References]
  G --> H[Phase 5: Update Sibling Repos]
  H --> I[Phase 6: Reinstall Symlinks]
  I --> J[Phase 7: Verify]
  J --> K[Phase 8: Summary Report]
```

![A visual workflow diagram and usage guide for the stark-rename-project skill, showing the 8-phase process from validation to summary report, including dry-run paths, artifact updates, and safety checks.](usage.png)

## When to Use

Rename a project locally and on GitHub, update all references in sibling repos, and reinstall symlinks. Use when the user says "rename project", "rename repo", "rename this to", or invokes /stark-rename-project.

## Prerequisites

*See SKILL.md*

## Arguments

`<old-name> <new-name> [--dry-run]`



## Quick Start

/stark-rename-project

## Common Patterns



## Troubleshooting



## Related Skills


