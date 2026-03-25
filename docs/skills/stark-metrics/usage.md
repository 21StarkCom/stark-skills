# stark-metrics

Aggregate performance metrics across all stark skill runs. Agent scorecards, finding quality, duration trends, prompt improvement impact, and actionable recommendations. Use when the user says "show metrics", "how are reviews performing", "agent stats", "review quality", or invokes /stark-metrics.

## Workflow Overview

```mermaid
graph TD
  A[User invokes /stark-metrics] --> B[Parse Arguments: --repo, --skill, --since, --json]
  B --> C[Execute metrics.py]
  C --> D{Check Exit Code}
  D -->|Exit 1| E[Error: No history found]
  D -->|Exit 2| F[Error: Argument error]
  D -->|Exit 0| G[Print Formatted Terminal Output]
  G --> H{Is --json flag set?}
  H -->|Yes| I[End Skill]
  H -->|No| J{Recommendations Found?}
  J -->|Yes| K[Prompt user to act: e.g., /stark-review-improvement]
  J -->|No| L[Process Meta-Observations]
  K --> L
  L --> M[Flag First-Time Usage]
  L --> N[Flag Improvements e.g., lower FP rate]
  L --> O[Flag Urgent Failures e.g., climbing error rate]
```

![A flowchart and usage guide for the stark-metrics skill showing the execution of metrics.py, terminal output presentation, recommendation handling, and meta-observation checks.](usage.png)

## When to Use

Aggregate performance metrics across all stark skill runs. Agent scorecards, finding quality, duration trends, prompt improvement impact, and actionable recommendations. Use when the user says "show metrics", "how are reviews performing", "agent stats", "review quality", or invokes /stark-metrics.

## Prerequisites

*See SKILL.md*

## Arguments

`[--repo REPO] [--skill SKILL] [--since DATE] [--json]`



## Quick Start

/stark-metrics

## Common Patterns



## Troubleshooting



## Related Skills


