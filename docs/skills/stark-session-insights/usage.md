# stark-session-insights

Analyze Claude Code session history to extract usage patterns, skill invocations, action frequencies, corrections, and preferences — grouped by project. Reads ~/.claude/history.jsonl and generates per-project insight files. Use when the user says "session insights", "analyze sessions", "usage patterns", "what do I do most", or invokes /stark-session-insights.

## Workflow Overview

```mermaid
graph TD
    A[User invokes /stark-session-insights] --> B{Arguments provided?}
    B -->|--project <name>| C[Filter target projects]
    B -->|No arguments| D[Target all projects]
    
    C --> E[Load ~/.claude/history.jsonl]
    D --> E
    
    E --> F[Group entries by Project Slug]
    
    F --> G{--refresh used?}
    G -->|No| H{Does <slug>.md exist and match entry count?}
    H -->|Yes| I[Skip unchanged project]
    H -->|No| J[Run Data Analysis]
    G -->|Yes| J
    
    J --> K[Calculate Stats, Trends, & Session Shapes]
    K --> L[Extract Corrections & Frustrations]
    L --> M[Generate Narrative & Recommendations]
    
    M --> N[Write ~/.claude/code-review/insights/sessions/<slug>.md]
    I --> O[Update index.md]
    N --> O
    
    O --> P[Print execution summary to user]
```

![A usage-focused dashboard visualizing the stark-session-insights skill. It displays invocation commands, an execution flow diagram showing the parsing of history.jsonl into project insights, and feature cards detailing extracted metrics like work rhythms, skill usage, and AI-synthesized workflow corrections.](usage.png)

## When to Use

Analyze Claude Code session history to extract usage patterns, skill invocations, action frequencies, corrections, and preferences — grouped by project. Reads ~/.claude/history.jsonl and generates per-project insight files. Use when the user says "session insights", "analyze sessions", "usage patterns", "what do I do most", or invokes /stark-session-insights.

## Prerequisites

*See SKILL.md*

## Arguments

`[--project <name>] [--refresh]`



## Quick Start

/stark-session-insights

## Common Patterns



## Troubleshooting



## Related Skills


