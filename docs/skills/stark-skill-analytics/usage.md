# stark-skill-analytics

Analyze skill usage patterns and quality metrics across all Claude Code sessions. Reads ~/.claude/history.jsonl and skill run history files to produce adoption curves, usage rankings, quality signals, and recommendations. Use when the user says "skill analytics", "skill usage", "which skills are used", "adoption metrics", or invokes /stark-skill-analytics.

## Workflow Overview

```mermaid
graph TD
    A[Start: /stark-skill-analytics] --> B{Parse history.jsonl}
    B -->|Extract| C[Skill Invocations & Arguments]
    B -->|Extract| D[Timestamps & Projects]
    
    C --> E[Compute Usage Stats]
    D --> E
    
    F[code-review/history/] --> G{Parse Run History}
    G -->|Extract| H[Durations & Outcomes]
    G -->|Extract| I[Timeouts & Agent Data]
    
    H --> J[Compute Quality Stats]
    I --> J
    
    E --> K[Cross-Reference Analytics]
    J --> K
    L[Local CLAUDE.md] -->|Registered Skills| K
    
    K --> M{Format Argument?}
    M -->|--format table| N[Output Rankings Table Only]
    M -->|--format full| O{Skill Argument?}
    
    O -->|--skill <name>| P[Generate Single-Skill Report]
    O -->|None| Q[Generate Comprehensive Report]
    
    N --> R[Save Markdown & Print to Terminal]
    P --> R
    Q --> R
    
    R --> S[End]
```

![A user-focused HTML visualization documenting the stark-skill-analytics skill. It includes an overview, a visual execution flow mapping data extraction from history files to cross-referenced reporting, a table explaining CLI arguments, and a grid highlighting key report capabilities like Usage Rankings, Quality Signals, Workflow Sequences, and Actionable Recommendations.](usage.png)

## When to Use

Analyze skill usage patterns and quality metrics across all Claude Code sessions. Reads ~/.claude/history.jsonl and skill run history files to produce adoption curves, usage rankings, quality signals, and recommendations. Use when the user says "skill analytics", "skill usage", "which skills are used", "adoption metrics", or invokes /stark-skill-analytics.

## Prerequisites

*See SKILL.md*

## Arguments

`[--skill <name>] [--format table|full]`



## Quick Start

/stark-skill-analytics

## Common Patterns



## Troubleshooting



## Related Skills


