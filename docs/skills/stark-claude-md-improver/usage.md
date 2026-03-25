# stark-claude-md-improver

Analyze and improve CLAUDE.md files for completeness, accuracy, and effectiveness. Use when the user says "improve claude.md", "review claude.md", "audit claude.md", "update claude.md", or "stark-claude-md-improver".

## Workflow Overview

```mermaid
graph TD
    Start([User triggers stark-claude-md-improver]) --> Discover[1. Discover CLAUDE.md & memory files]
    Discover --> Analyze[2. Analyze against 5 dimensions]
    Analyze --> Score[3. Generate scores, issues, and suggestions]
    Score --> Prompt{4. Ask: Apply improvements?}
    Prompt -- Yes --> Apply[5. Apply edits directly to files]
    Prompt -- No --> Skip[Skip modifications]
    Apply --> Metrics[Log Observability Metrics]
    Skip --> Metrics
    Metrics --> Finish([End])
```

![A workflow visualization of the stark-claude-md-improver skill showing the 5-step process of discovery, dimensional analysis, report generation, interactive user prompting, and file modification.](usage.png)

## When to Use

Analyze and improve CLAUDE.md files for completeness, accuracy, and effectiveness. Use when the user says "improve claude.md", "review claude.md", "audit claude.md", "update claude.md", or "stark-claude-md-improver".

## Prerequisites

*See SKILL.md*

## Arguments

`[path to CLAUDE.md] (optional — auto-discovers all CLAUDE.md files in project hierarchy)`



## Quick Start

/stark-claude-md-improver

## Common Patterns



## Troubleshooting



## Related Skills


