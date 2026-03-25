# stark-claude-md-improver

Analyze and improve CLAUDE.md files for completeness, accuracy, and effectiveness. Use when the user says "improve claude.md", "review claude.md", "audit claude.md", "update claude.md", or "stark-claude-md-improver".

## Workflow Overview

```mermaid
graph TD
    A["Invoke /stark-claude-md-improver [path]"] --> B{Path provided?}
    B -->|Yes| C[Read specified CLAUDE.md]
    B -->|No| D["Auto-discover: ~ → org → project → subdirs"]
    D --> E[Read all discovered CLAUDE.md files]
    C --> F[Read memory files for context]
    E --> F
    F --> G["Analyze: Structure & Clarity"]
    F --> H["Analyze: Completeness"]
    F --> I["Analyze: Accuracy & Freshness"]
    F --> J["Analyze: Effectiveness for AI"]
    F --> K["Analyze: Hierarchy Optimization"]
    G --> L[Generate Report]
    H --> L
    I --> L
    J --> L
    K --> L
    L --> M["Present: scores, issues, additions, removals, moves"]
    M --> N{Apply changes?}
    N -->|Yes| O[Edit CLAUDE.md files directly]
    N -->|No| P[Done — report for reference]
    O --> P

    style A fill:#047857,color:#fff
    style B fill:#7c3aed,color:#fff
    style N fill:#7c3aed,color:#fff
    style C fill:#1e40af,color:#fff
    style D fill:#1e40af,color:#fff
    style E fill:#1e40af,color:#fff
    style F fill:#1e40af,color:#fff
    style G fill:#1e40af,color:#fff
    style H fill:#1e40af,color:#fff
    style I fill:#1e40af,color:#fff
    style J fill:#1e40af,color:#fff
    style K fill:#1e40af,color:#fff
    style L fill:#f59e0b,color:#1a1a1a
    style M fill:#f59e0b,color:#1a1a1a
    style O fill:#1e40af,color:#fff
    style P fill:#e5e7eb,color:#666
```

![Usage diagram for stark-claude-md-improver skill showing a vertical workflow: invoke the skill with an optional path, discover CLAUDE.md files across the hierarchy, analyze each file across five dimensions (structure, completeness, accuracy, AI effectiveness, hierarchy optimization), generate a report with scores and suggestions, then optionally apply changes. Includes cards describing each analysis dimension, a table of report output sections, invocation triggers, and key rules about not over-adding content.](usage.png)

## When to Use

Analyze and improve CLAUDE.md files for completeness, accuracy, and effectiveness. Use when the user says "improve claude.md", "review claude.md", "audit claude.md", "update claude.md", or "stark-claude-md-improver".

## Prerequisites

No special prerequisites. Works in any project with at least one CLAUDE.md file. The skill auto-discovers CLAUDE.md files across the hierarchy (home, org, project, subdirectories).

## Arguments

`[path to CLAUDE.md] (optional — auto-discovers all CLAUDE.md files in project hierarchy)`

| Argument | Required | Description |
|----------|----------|-------------|
| `[path]` | No | Path to a specific CLAUDE.md file. If omitted, auto-discovers all CLAUDE.md files in the project hierarchy. |

## Quick Start

/stark-claude-md-improver

## Common Patterns

**Audit all CLAUDE.md files in a project:**
`/stark-claude-md-improver` — discovers and analyzes the full hierarchy.

**Target a specific file:**
`/stark-claude-md-improver ~/git/myproject/CLAUDE.md` — analyzes only that file.

**After onboarding a new project:**
Run after `/stark-onboard-project` to verify the generated CLAUDE.md is complete and effective.

## Troubleshooting

**No CLAUDE.md files found:** Ensure you're in a project directory or provide an explicit path. The skill searches ~ → org → project → subdirs.

**Stale references flagged:** The skill cross-references actual file paths and commands. If it flags something as missing, verify the file exists — it may have been renamed or moved.

**Low accuracy score:** Usually means build commands or file paths in CLAUDE.md are outdated. Update them to match current project state.

## Related Skills

`/stark-onboard-project`, `/stark-session`, `/stark-init-docs`
